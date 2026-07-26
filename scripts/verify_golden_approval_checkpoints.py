#!/usr/bin/env python3
"""Independent scientific checkpoint verification for the golden analysis corpus."""
from __future__ import annotations

import json
import math
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "tests"))

import numpy as np
import pandas as pd

from golden_analysis_support import GoldenFixtureEnvironment, fixture_root, load_manifest

FIXTURE = fixture_root()


def _load_expected(name: str) -> dict:
    return json.loads((FIXTURE / "expected" / name).read_text(encoding="utf-8"))


def _raw_for_key(env: GoldenFixtureEnvironment, source_key: str) -> pd.DataFrame:
    source = next(item for item in env.manifest["sources"] if item["key"] == source_key)
    from golden_analysis_support import cache, sha256_file

    digest = source["sha256"]
    binary = FIXTURE / source["binary_path"]
    env.ensure_sources_parsed()
    raw_path = cache.raw_path(digest)
    return pd.read_parquet(raw_path)


def _charge_mask(df: pd.DataFrame) -> pd.Series:
    if "current_ma" not in df.columns:
        return pd.Series(False, index=df.index)
    return pd.to_numeric(df["current_ma"], errors="coerce") > 0


def _discharge_mask(df: pd.DataFrame) -> pd.Series:
    if "current_ma" not in df.columns:
        return pd.Series(False, index=df.index)
    return pd.to_numeric(df["current_ma"], errors="coerce") < 0


def _phase_total(df: pd.DataFrame, col: str, mask: pd.Series, cycle: int) -> float:
    sub = df.loc[mask & (df["cycle"] == cycle), ["step", col]]
    if sub.empty:
        return 0.0
    per_step = sub.groupby("step", sort=False)[col].agg(["min", "max"])
    return float((per_step["max"] - per_step["min"]).clip(lower=0.0).sum())


def checkpoint_cc_cv_capacity(raw: pd.DataFrame, expected: dict) -> dict:
    cycle = 1
    chg = _charge_mask(raw)
    manual = _phase_total(raw, "charge_capacity_mah", chg, cycle)
    golden = expected["cell_series"][0]["quantities"]["charge_capacity_mah"][0]
    return {
        "case": "cycles_baseline",
        "cycle": cycle,
        "formula": "sum over charge steps of max(charge_capacity_mah)-min(charge_capacity_mah)",
        "unit": "mAh",
        "independent_mah": manual,
        "golden_mah": golden,
        "abs_diff_mah": abs(manual - golden),
        "match": math.isclose(manual, golden, rel_tol=1e-6, abs_tol=1e-6),
    }


def checkpoint_efficiency(raw: pd.DataFrame, expected: dict) -> dict:
    cycle = 1
    chg = _charge_mask(raw)
    dchg = _discharge_mask(raw)
    chg_cap = _phase_total(raw, "charge_capacity_mah", chg, cycle)
    dchg_cap = _phase_total(raw, "discharge_capacity_mah", dchg, cycle)
    chg_e = _phase_total(raw, "charge_energy_mwh", chg, cycle)
    dchg_e = _phase_total(raw, "discharge_energy_mwh", dchg, cycle)
    manual_ce = dchg_cap / chg_cap * 100.0 if chg_cap else float("nan")
    manual_ee = dchg_e / chg_e * 100.0 if chg_e else float("nan")
    metrics = expected["cell_series"][0]["metrics"]
    golden_ce = metrics["first_cycle_ce_pct"]
    golden_ee = expected["cell_series"][0]["quantities"]["energy_efficiency_pct"][0]
    return {
        "case": "cycles_baseline",
        "cycle": cycle,
        "ce_formula": "discharge_capacity_mah / charge_capacity_mah * 100",
        "ee_formula": "discharge_energy_mwh / charge_energy_mwh * 100",
        "independent_ce_pct": manual_ce,
        "golden_ce_pct": golden_ce,
        "independent_ee_pct": manual_ee,
        "golden_ee_pct": golden_ee,
        "ce_match": math.isclose(manual_ce, golden_ce, rel_tol=1e-6, abs_tol=1e-4),
        "ee_match": math.isclose(manual_ee, golden_ee, rel_tol=1e-6, abs_tol=1e-4),
    }


def checkpoint_time_capacity_reset(raw: pd.DataFrame, expected: dict, cycles_expected: dict) -> dict:
    """Demonstrate CC→CV counter reset on cycle 1 and cumulative charge capacity."""
    cycle = 1
    chg = _charge_mask(raw) & (raw["cycle"] == cycle)
    sub = raw.loc[chg, ["step", "charge_capacity_mah"]].copy()
    sub["charge_capacity_mah"] = pd.to_numeric(sub["charge_capacity_mah"], errors="coerce")
    per_step = sub.groupby("step", sort=False)["charge_capacity_mah"].agg(["min", "max", "count"])
    per_step["delta_mah"] = (per_step["max"] - per_step["min"]).clip(lower=0.0)
    reset_steps = [int(step) for step in per_step.index if per_step.loc[step, "min"] <= 1e-9]
    cumulative = float(per_step["delta_mah"].sum())
    golden = cycles_expected["cell_series"][0]["quantities"]["charge_capacity_mah"][0]
    return {
        "case": "time_capacity_baseline",
        "cycle": cycle,
        "steps_with_counter_reset": reset_steps,
        "per_step_deltas_mah": {
            int(step): float(per_step.loc[step, "delta_mah"]) for step in per_step.index
        },
        "independent_cumulative_charge_mah": cumulative,
        "golden_charge_capacity_mah": golden,
        "note": "Per-step delta sum handles Neware counter resets at CC→CV boundaries.",
        "match": math.isclose(cumulative, golden, rel_tol=1e-5, abs_tol=1e-3),
    }


def checkpoint_steps_duration(raw: pd.DataFrame, expected: dict) -> dict:
    block = expected["cell_series"][0]["block_meta"][0]
    cycle_start = block["cycle_start"]
    step_start = block["step_start"]
    step_end = block["step_end"]
    step_col = "step_index" if "step_index" in raw.columns else "step"
    mask = (
        (raw["cycle"] >= cycle_start)
        & (raw["cycle"] <= block["cycle_end"])
        & (raw[step_col] >= step_start)
        & (raw[step_col] <= step_end)
    )
    sub = raw.loc[mask]
    if "timestamp" in sub.columns:
        stamps = pd.to_datetime(sub["timestamp"], errors="coerce").dropna()
        manual_h = float((stamps.max() - stamps.min()).total_seconds() / 3600.0)
    else:
        per_step = sub.groupby([step_col], sort=False)["time_s"].max()
        manual_h = float(per_step.sum() / 3600.0)
    golden_h = expected["cell_series"][0]["quantities"]["block_duration_h"][0]
    return {
        "case": "steps_baseline",
        "raw_rows": f"cycle {cycle_start}, {step_col} {step_start}-{step_end}",
        "formula": "timestamp span of block rows / 3600 (matches step_blocks.block_duration_h)",
        "unit": "h",
        "independent_h": manual_h,
        "golden_h": golden_h,
        "abs_diff_h": abs(manual_h - golden_h),
        "match": math.isclose(manual_h, golden_h, rel_tol=1e-6, abs_tol=1e-3),
    }


def checkpoint_dcir(expected: dict) -> dict:
    results = []
    for series in expected["cell_series"]:
        direction = series["direction"]
        meta = series["measurement_meta"][0]
        v_rest = meta["v_rest_v"]
        v_pulse = meta["v_pulse_v"]
        current_ma = meta["current_ma"]
        delta_v = v_rest - v_pulse if direction == "discharge" else v_pulse - v_rest
        manual_mohm = 1_000_000.0 * delta_v / current_ma
        golden_mohm = series["quantities"]["dcir_mohm"][0]
        results.append(
            {
                "direction": direction,
                "cycle": meta["cycle"],
                "formula": "1e6 * (V_rest - V_pulse) / I_mA for discharge; reversed for charge",
                "unit": "mOhm",
                "independent_mohm": manual_mohm,
                "golden_mohm": golden_mohm,
                "match": math.isclose(manual_mohm, golden_mohm, rel_tol=1e-6, abs_tol=1e-3),
            }
        )
    return {"case": "dcir_baseline", "measurements": results}


def checkpoint_chargeability(expected: dict) -> dict:
    candidate = expected["candidates"][0]
    match = expected["matches"][0]
    nominal = 51.37
    ref_cap = nominal * (candidate["initial_soc_pct"] / 100.0)
    return {
        "case": "chargeability_baseline",
        "protocol_fields": {
            "condition": candidate["condition"],
            "initial_soc_pct": candidate["initial_soc_pct"],
            "final_soc_pct": candidate["final_soc_pct"],
            "target_voltage_v": candidate["target_voltage_v"],
            "current_ceiling_c": candidate["current_ceiling_c"],
        },
        "reference_capacity_formula": "nominal_capacity_mah * initial_soc_pct / 100",
        "nominal_capacity_mah": nominal,
        "independent_reference_mah": ref_cap,
        "golden_initial_soc_pct": candidate["initial_soc_pct"],
        "golden_final_soc_pct": candidate["final_soc_pct"],
        "golden_delivered_capacity_mah": match["delivered_capacity_mah"],
        "soc_window_match": candidate["initial_soc_pct"] <= 20.0 and candidate["final_soc_pct"] >= 80.0,
    }


def checkpoint_rate_capability(raw: pd.DataFrame, expected: dict) -> dict:
    point = expected["blocks"][0]["points"][0]
    cycle = point["cycle"]
    measurement_step = point["measurement_step_index"]
    frame = raw.loc[
        (raw["cycle"] == cycle) & (raw["step_index"] == measurement_step),
        "charge_capacity_mah",
    ]
    values = pd.to_numeric(frame, errors="coerce")
    manual_cc = float(values.max()) if values.notna().any() else float("nan")
    golden = point["capacity_mah"]
    cv_step = point["charge_step_indices"][-1]
    cv_frame = raw.loc[
        (raw["cycle"] == cycle) & (raw["step_index"] == cv_step),
        "charge_capacity_mah",
    ]
    cv_values = pd.to_numeric(cv_frame, errors="coerce")
    cv_max = float(cv_values.max()) if cv_values.notna().any() else None
    return {
        "case": "rate_capability_baseline",
        "point_cycle": cycle,
        "charge_rate_c": point["charge_rate_c"],
        "reference_rate_c": point["retention_reference_rate_c"],
        "fixed_rate_c": point["fixed_rate_c"],
        "measurement_step_index": measurement_step,
        "cv_step_index": cv_step,
        "formula": "max charge_capacity_mah on CC measurement step only (excludes CV hold step)",
        "independent_capacity_mah": manual_cc,
        "cv_step_max_capacity_mah": cv_max,
        "golden_capacity_mah": golden,
        "match": math.isclose(manual_cc, golden, rel_tol=1e-5, abs_tol=1e-3),
    }


def main() -> None:
    manifest = load_manifest()
    with tempfile.TemporaryDirectory(prefix="golden-approval-") as tmp:
        from golden_analysis_support import bind_isolated_data_root

        data_root = Path(tmp)
        bind_isolated_data_root(data_root)
        with GoldenFixtureEnvironment.create(data_root=data_root) as env:
            cycles_raw = _raw_for_key(env, "cycles_time_steps")
            rate_raw = _raw_for_key(env, "rate_capability")
            cycles_expected = _load_expected("cycles_baseline.json")
            report = {
                "checkpoint_1_cc_cv_capacity": checkpoint_cc_cv_capacity(
                    cycles_raw, cycles_expected
                ),
                "checkpoint_2_efficiency": checkpoint_efficiency(
                    cycles_raw, cycles_expected
                ),
                "checkpoint_3_time_capacity_reset": checkpoint_time_capacity_reset(
                    cycles_raw, _load_expected("time_capacity_baseline.json"), cycles_expected
                ),
                "checkpoint_4_steps_duration": checkpoint_steps_duration(
                    cycles_raw, _load_expected("steps_baseline.json")
                ),
                "checkpoint_5_dcir": checkpoint_dcir(_load_expected("dcir_baseline.json")),
                "checkpoint_6_chargeability": checkpoint_chargeability(
                    _load_expected("chargeability_baseline.json")
                ),
                "checkpoint_7_rate_capability": checkpoint_rate_capability(
                    rate_raw, _load_expected("rate_capability_baseline.json")
                ),
            }
    print(json.dumps(report, indent=2, sort_keys=True))
    failures = []
    for key, value in report.items():
        if isinstance(value.get("match"), bool) and not value["match"]:
            failures.append(key)
        if "measurements" in value:
            for item in value["measurements"]:
                if not item.get("match"):
                    failures.append(f"{key}:{item['direction']}")
    if failures:
        raise SystemExit(f"Checkpoint verification failed: {failures}")


if __name__ == "__main__":
    main()
