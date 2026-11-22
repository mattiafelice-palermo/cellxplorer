"""Compare a 4608 channel file with its matching Maccor minute/Ah/Wh text export."""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def read_export(path: Path, binary: Path) -> pd.DataFrame:
    with path.open(encoding="utf-8-sig", errors="replace") as stream:
        name = stream.readline().rstrip().split("\t")
        if len(name) != 2 or name[0] != "Name:" or Path(name[1]).name.casefold() != binary.name.casefold():
            raise ValueError("The export must name the supplied binary as its source.")
        for index, line in enumerate(stream, 1):
            if line.startswith("Rec\t"):
                break
        else:
            raise ValueError("Missing Maccor record header.")
    frame = pd.read_csv(path, sep="\t", skiprows=index, encoding="cp1252", index_col=False)
    frame["DPT Time"] = pd.to_datetime(frame["DPT Time"], format="%d/%m/%Y %H:%M:%S")
    np.testing.assert_array_equal(frame["Cycle P"], 0)
    return frame


def verify(binary: Path, export: Path) -> dict:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session
    from backend.app.db import Base
    from backend.app.models import Cell, Test, TestFile
    from backend.app.services import analysis_engine, cache, scanner

    ref = read_export(export, binary)
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        source = scanner.ingest_path(db, binary, parse_now=True)
        if source.parse_status != "parsed":
            raise ValueError(f"Binary parse failed: {source.parse_error}")
        cell = Cell(name="Maccor pair verification")
        db.add(TestFile(test=Test(cell=cell, name="internal source chain"), file=source, position=0))
        db.commit()
        raw = cache.load_raw(source.hash, source.parser_version)
        cycles = cache.load_cycles(source.hash, source.parser_version, cache.CALC_VERSION).set_index("cycle")
        spec = analysis_engine.default_spec("Maccor pair verification")
        spec["selection"]["entries"] = [{"kind": "cell", "ref_id": cell.id}]
        tc = spec["computation"].setdefault("time_capacity", {})
        tc.update(cycle_start=int(ref["Cycle C"].min()), cycle_end=int(ref["Cycle C"].max()))
        trace = analysis_engine.compute_time_capacity(db, spec, None, precision="full")["cell_traces"][0]
        tc["x_axis"] = "capacity_mah"
        capacity = analysis_engine.compute_time_capacity(db, spec, None, precision="full")["cell_traces"][0]
    engine.dispose()

    for field, column in (("Rec", "record_index"), ("Cycle C", "cycle"), ("Step", "step_index"),
                          ("Md", "maccor_mode"), ("ES", "maccor_end_status")):
        np.testing.assert_array_equal(raw[column], ref[field], err_msg=field)
    np.testing.assert_array_equal(raw.timestamp.dt.floor("s"), ref["DPT Time"])
    current_sign = np.where(ref.Md.eq("D"), -1, 1)
    max_error = {}

    def check(label, actual, expected, tolerance):
        delta = np.abs(np.asarray(actual) - np.asarray(expected))
        if not np.all(delta <= np.asarray(tolerance) + 1e-12):
            raise AssertionError(f"{label} exceeds export precision (max difference {np.max(delta):.10g})")
        max_error[label] = max(max_error.get(label, 0), float(np.max(delta)))

    # Maccor prints these four engineering values after conversion to binary32.
    # The native reader retains the resolution of the ADCs and integer counters.
    bounds = {}
    for label, native, printed, digits in (
        ("voltage_v", raw.voltage_v, ref["Voltage [V]"], 4),
        ("current_a", raw.current_ma / 1000, current_sign * ref["Current [A]"], 8),
        ("capacity_ah", raw.maccor_capacity_ah, ref["Cap. [Ah]"], 8),
        ("energy_wh", raw.maccor_energy_wh, ref["Ener. [Wh]"], 8),
    ):
        formatted = np.round(np.asarray(native, dtype="float32").astype("float64"), digits)
        np.testing.assert_array_equal(formatted, printed, err_msg=label)
        decimal_error = 0.5 * 10**-digits
        ulp = float(np.spacing(np.float32(printed.abs().max() + decimal_error)))
        bounds[label] = decimal_error + ulp / 2
        check(label, native, printed, bounds[label])
    check("test_minutes", raw.total_time_s / 60, ref.TestTime, 5e-7)
    check("step_minutes", raw.time_s / 60, ref.StepTime, 5e-7)
    for column, values in (("voltage_v", raw.voltage_v), ("current_ma", raw.current_ma),
                           ("time_s", raw.total_time_s), ("source_cycle", ref["Cycle C"])):
        np.testing.assert_allclose(trace[column], values, atol=1e-9, rtol=1e-12)

    # Segment the original text by its reported cycle and programmed step.
    # This reference does not call the application adapter or cycle calculator.
    run = ref[["Cycle C", "Step"]].ne(ref[["Cycle C", "Step"]].shift()).any(axis=1).cumsum()
    by_run = ref.groupby(run, sort=False)
    spans = (by_run[["Cap. [Ah]", "Ener. [Wh]"]].last() - by_run[["Cap. [Ah]", "Ener. [Wh]"]].first()) * 1000
    steps = by_run.first()[["Cycle C", "Md", "ES"]].join(spans)
    steps["closed"] = steps.ES.eq(0) & by_run.ES.last().isin((129, 132, 133))
    steps["measured"] = by_run["Current [A]"].max().gt(0)
    steps["hours"] = by_run.StepTime.max() / 60
    progress = ref["Cap. [Ah]"] * 1000 - by_run["Cap. [Ah]"].transform("first") * 1000
    progress += run.map(spans["Cap. [Ah]"].cumsum().shift(fill_value=0))
    check("plotted_capacity_mah", capacity["display_x"], progress, run * 2000 * bounds["capacity_ah"])
    complete = []
    for label, records in ref.groupby("Cycle C", sort=False):
        active = steps[steps["Cycle C"].eq(label) & steps.Md.isin(("C", "D"))]
        if set(active.loc[active.measured, "Md"]) != {"C", "D"} or not active.closed.all():
            continue
        complete.append(label)
        summary = cycles.loc[label]
        limits = {}
        for mode, phase in (("C", "charge"), ("D", "discharge")):
            block = active[active.Md.eq(mode)]
            for field, quantity in (("Cap. [Ah]", "capacity_mah"), ("Ener. [Wh]", "energy_mwh")):
                key = f"{phase}_{quantity}"
                error = bounds["capacity_ah" if quantity == "capacity_mah" else "energy_wh"]
                value, bound = block[field].sum(), len(block) * 2000 * error
                check(key, summary[key], value, bound)
                limits[key] = (value - bound, value + bound)
            check(f"{phase}_time_h", summary[f"{phase}_time_h"], block.hours.sum(), len(block) * 5e-7 / 60)
            volts = records.loc[records.Md.eq(mode), "Voltage [V]"]
            for kind, expected in (("first", volts.iloc[0]), ("last", volts.iloc[-1]), ("mean", volts.mean())):
                key = f"{kind}_{phase}_voltage_v"
                check(key, summary[key], expected, bounds["voltage_v"])
        for field, quantity in (("coulombic_efficiency_pct", "capacity_mah"), ("energy_efficiency_pct", "energy_mwh")):
            lo, hi = limits[f"charge_{quantity}"]
            dlo, dhi = limits[f"discharge_{quantity}"]
            if lo <= 0:
                raise ValueError("A charge total is too close to zero to validate efficiency at export precision.")
            if not 100 * dlo / hi <= summary[field] <= 100 * dhi / lo:
                raise AssertionError(f"{field} outside the exported counter bounds in cycle {label}.")
        dates = records["DPT Time"]
        assert summary.start_timestamp.floor("s") == dates.min()
        check("cycle_duration_s", summary.cycle_duration_h * 3600, (dates.max() - dates.min()).total_seconds(), 1.0)
    np.testing.assert_array_equal(cycles.index, complete)
    np.testing.assert_array_equal(raw.cycle_complete, ref["Cycle C"].isin(complete))
    assert cycles.filter(regex="^cv_").isna().all().all()
    return dict(binary=binary.name, reference=export.name, records=len(raw), executed_steps=len(steps),
                complete_cycles=len(complete), incomplete_cycles=sorted(set(ref["Cycle C"]) - set(complete)),
                plotted_points=len(trace["voltage_v"]), standby_records=int(ref.Md.eq("SBw").sum()),
                first_cycle=cycles.iloc[0][["charge_capacity_mah", "discharge_capacity_mah"]].astype(float).to_dict(),
                largest_absolute_differences=max_error)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("export", type=Path)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="mb") as scratch:
        os.environ["CELLXPLORER_DATA"] = scratch
        report = verify(args.binary.resolve(), args.export.resolve())
    print(json.dumps(report, indent=2))
