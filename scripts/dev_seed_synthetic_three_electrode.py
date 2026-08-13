"""Dev-only affordance: seed one synthetic three-electrode Cell for manual
browser verification of the Spec 040.4 Time/Capacity voltage-channel
selector.

Why this exists
----------------
No shipped adapter populates `working_potential_v` / `counter_potential_v`
(Parent 040 built the canonical/cache/Time-Capacity path; a real
three-electrode parser is Parent 041's job). That means the multi-voltage
selector cannot be exercised in a real running app today without synthetic
data. This script writes ONE synthetic three-electrode Cell directly into an
isolated `CELLXPLORER_DATA` root's real SQLite database and cache directory
— the same primitives `tests/test_analysis_engine.py`'s
`synth_three_electrode_raw` uses for backend tests, just persisted so a real
dev server + browser can render it.

Safety
------
This writes into a real SQLite database file, not a test harness. To avoid
ever touching a real library:

- `CELLXPLORER_DATA` MUST already be set in the environment before running
  this script. It is never inferred or defaulted.
- The target directory must NOT already contain `cellxplorer.db`. This
  script only initializes a *fresh* data root; it refuses to run against an
  existing one, seeded or not.
- The resolved path's directory name must not be exactly `.cellxplorer` or
  `.cellxplorer-beta` (CellXplorer's real default Stable/Beta data roots),
  even if `CELLXPLORER_DATA` was pointed at one explicitly.

Usage (PowerShell)
-------------------
    $env:CELLXPLORER_DATA = "C:\\Users\\<you>\\cellxplorer-devtest-3e"
    python scripts\\dev_seed_synthetic_three_electrode.py
    .\\scripts\\start-webapp.cmd

Then open the seeded Cell ("Synthetic three-electrode demo") in the app,
open its Time/Capacity tab, switch the plot quantity to Voltage/Current, and
the voltage-channel selector should offer Cell / Working potential / Counter
potential. Discard the throwaway directory afterward; nothing here is meant
to persist.

The seeded source has no real backing file (`SourceFile.path` is a
placeholder string), so some views may show a harmless "source offline"-style
badge for it — expected for a synthetic demo, not a bug. It renders entirely
from the cache this script writes; nothing ever re-parses it.
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))


def _fail(message: str) -> None:
    print(f"REFUSING TO RUN: {message}", file=sys.stderr)
    raise SystemExit(1)


def _check_environment_is_safe() -> Path:
    raw = os.environ.get("CELLXPLORER_DATA", "").strip()
    if not raw:
        _fail(
            "CELLXPLORER_DATA is not set. Set it to a throwaway directory before running "
            "this script — it is never inferred or defaulted, specifically so this cannot "
            "accidentally seed a real library."
        )
    target = Path(raw)
    if target.name in {".cellxplorer", ".cellxplorer-beta"}:
        _fail(
            f"CELLXPLORER_DATA resolves to '{target.name}', CellXplorer's real default "
            "Stable/Beta data root name. Point it at a dedicated throwaway directory instead."
        )
    if (target / "cellxplorer.db").exists():
        _fail(
            f"{target / 'cellxplorer.db'} already exists. This script only initializes a "
            "FRESH data root; point CELLXPLORER_DATA at an empty/new directory."
        )
    return target


def _build_synthetic_three_electrode_raw(n_cycles: int = 5, cap0: float = 2.0, fade: float = 0.01):
    """Same shape as `tests/test_analysis_engine.py::synth_three_electrode_raw`:
    known working/counter potentials with `voltage_v = working - counter`."""
    import pandas as pd

    rows: list[dict[str, object]] = []
    idx = 0
    t = 0.0
    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    for cyc in range(1, n_cycles + 1):
        cap = cap0 * (1 - fade) ** (cyc - 1)
        for status, sign in (("CC_Chg", 1), ("CC_DChg", -1)):
            for frac in (0.5, 1.0):
                idx += 1
                t += 1800
                working = 3.5 + sign * 0.2
                counter = 0.1
                rows.append(
                    {
                        "record_index": idx,
                        "cycle": cyc,
                        "step": cyc * 2 + (0 if sign > 0 else 1),
                        "step_index": (1 if cyc % 2 else 3) if sign > 0 else 2,
                        "status": status,
                        "time_s": 1800.0 * frac,
                        "voltage_v": working - counter,
                        "working_potential_v": working,
                        "counter_potential_v": counter,
                        "current_ma": sign * 1000.0,
                        "charge_capacity_mah": cap * frac if sign > 0 else cap,
                        "discharge_capacity_mah": 0.0 if sign > 0 else cap * frac * 0.99,
                        "charge_energy_mwh": cap * frac * 3.5 if sign > 0 else cap * 3.5,
                        "discharge_energy_mwh": 0.0 if sign > 0 else cap * frac * 3.2,
                        "timestamp": base + timedelta(seconds=t),
                    }
                )
    return pd.DataFrame(rows)


def main() -> None:
    data_root = _check_environment_is_safe()
    os.environ["CELLXPLORER_DATA"] = str(data_root)

    from app import db  # noqa: E402
    from app.models import Cell, SourceFile, Test, TestFile  # noqa: E402
    from app.services import cache, canonical_cycling, calc, parsing  # noqa: E402

    status = db.initialize_database()
    if not status.compatible:
        _fail(f"fresh database initialization reported incompatible: {status}")

    raw = _build_synthetic_three_electrode_raw()
    canonical_cycling.validate_raw_timeseries(raw)
    cycles = calc.per_cycle(raw)

    file_hash = (
        "syn3e"
        + __import__("hashlib").sha256(b"cellxplorer-dev-synthetic-three-electrode-demo").hexdigest()[:59]
    )
    identity = parsing.current_parser_identity_for_extension("ndax") or parsing.PARSER_VERSION

    cache_dir = cache.raw_path(file_hash, identity).parent
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache._write_atomic(raw, cache.raw_path(file_hash, identity))
    cache._write_atomic(cycles, cache.cycles_path(file_hash, identity))
    totals = cache.capacity_totals(cycles)

    session = db.SessionLocal()
    try:
        source = SourceFile(
            hash=file_hash,
            path="<synthetic:three-electrode-demo, no backing file>",
            filename="synthetic_three_electrode_demo.ndax",
            size=0,
            ext="ndax",
            location_status="online",
            parse_status="parsed",
            parser_version=identity,
            row_count=len(raw),
            cycle_count=int(raw["cycle"].nunique()),
            capacity_summary_status="ready",
            **totals,
        )
        cell = Cell(name="Synthetic three-electrode demo")
        session.add_all([cell, source])
        session.flush()
        test = Test(cell_id=cell.id, name="internal source chain")
        session.add(test)
        session.flush()
        session.add(TestFile(test_id=test.id, file_id=source.id, position=0))
        session.commit()
        print(f"Seeded Cell id={cell.id} '{cell.name}' into {data_root}")
        print(f"  source hash={file_hash[:16]}... parser_version={identity}")
        print("Start the app with this CELLXPLORER_DATA and open the Cell's Time/Capacity tab.")
    finally:
        session.close()


if __name__ == "__main__":
    main()
