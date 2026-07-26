#!/usr/bin/env python3
"""Regenerate golden fixture expected JSON from committed sources and specs."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests" / "fixtures" / "golden_analysis"
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "tests"))

from golden_analysis_support import (  # noqa: E402
    GoldenFixtureEnvironment,
    fixture_root,
    load_manifest,
    trim_cell_metadata,
)
from app.services import parsing, protocol  # noqa: E402

CYCLES_PROTOCOL_SIGNATURE = "01f4668b624ca93c50878291c0e231de263d17aa5c9ebf41228af5b80c977b25"
STEPS_SEGMENT_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
STEPS_SERIES_ID = "e01df301-bc03-414a-a70f-affe5f5a057e"
DEFAULT_ELECTRODE_AREA_CM2 = 1.96


def cycles_steps_protocol_segment() -> dict:
    return {
        "id": STEPS_SEGMENT_ID,
        "name": "Initial CC charge block",
        "targets": [
            {
                "protocol_signature": CYCLES_PROTOCOL_SIGNATURE,
                "step_indices": [2, 3, 4],
            }
        ],
    }


def patch_specs() -> None:
    steps_path = FIXTURE / "specs" / "steps_baseline.json"
    steps = json.loads(steps_path.read_text(encoding="utf-8"))
    steps["protocol_segments"] = [cycles_steps_protocol_segment()]
    steps.setdefault("computation", {}).setdefault("steps", {})["series"] = [
        {
            "id": STEPS_SERIES_ID,
            "cell_id": 101,
            "segment_id": STEPS_SEGMENT_ID,
        }
    ]
    steps_path.write_text(json.dumps(steps, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    derivative_path = FIXTURE / "specs" / "time_capacity_derivative.json"
    derivative = json.loads(derivative_path.read_text(encoding="utf-8"))
    tc = derivative.setdefault("computation", {}).setdefault("time_capacity", {})
    tc["view"] = "dqdv"
    tc.setdefault("derivative_phase", "both")
    tc.setdefault("derivative_specific", False)
    tc.setdefault("derivative_absolute_discharge", True)
    tc.setdefault("smoothing_window", 7)
    derivative_path.write_text(json.dumps(derivative, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    baseline_path = FIXTURE / "specs" / "time_capacity_baseline.json"
    baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
    tc_base = baseline.setdefault("computation", {}).setdefault("time_capacity", {})
    tc_base["electrode_area_cm2"] = DEFAULT_ELECTRODE_AREA_CM2
    tc_base["max_points_per_cell"] = 500000
    baseline_path.write_text(json.dumps(baseline, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def trim_manifest(manifest: dict) -> dict:
    trimmed_sources = []
    for source in manifest.get("sources", []):
        entry = {key: source[key] for key in source if key != "metadata"}
        trimmed_sources.append(entry)

    cells = []
    for cell in manifest.get("entities", {}).get("cells", []):
        cells.append(
            {
                "id": cell["id"],
                "name": cell["name"],
                "description": cell.get("description"),
                "metadata": trim_cell_metadata(cell.get("metadata") or {}),
            }
        )

    cases = []
    for case in manifest.get("cases", []):
        updated = dict(case)
        if case["id"] == "cycles_baseline":
            updated["projection"] = "cycles_absolute"
        elif case["id"] == "cycles_normalization":
            updated["projection"] = "cycles_specific"
        if case["id"] == "steps_baseline":
            updated["source_plot"] = "Initial CC charge block"
        cases.append(updated)

    return {
        "schema_version": manifest.get("schema_version", 1),
        "description": manifest.get("description"),
        "sources": trimmed_sources,
        "entities": {"cells": cells, "replicate_groups": []},
        "cases": cases,
        "comparison_profiles": manifest.get("comparison_profiles") or {},
    }


def main() -> None:
    patch_specs()
    manifest = load_manifest()
    manifest = trim_manifest(manifest)

    manifest_path = FIXTURE / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer-golden-regen"))
    with GoldenFixtureEnvironment.create(manifest_path) as env:
        for case in manifest["cases"]:
            result = env.run_case(case)
            out_path = FIXTURE / case["expected_path"]
            out_path.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
            print(f"Wrote {case['id']}")

    # sanity checks
    steps = json.loads((FIXTURE / "expected/steps_baseline.json").read_text(encoding="utf-8"))
    assert steps["cell_series"][0]["n_blocks"] > 0, "steps must have blocks"
    dcir = json.loads((FIXTURE / "expected/dcir_baseline.json").read_text(encoding="utf-8"))
    assert dcir["cell_series"][0]["n_measurements"] > 0, "dcir must have measurements"
    deriv = json.loads((FIXTURE / "expected/time_capacity_derivative.json").read_text(encoding="utf-8"))
    traces = deriv["cell_traces"][0]
    assert traces.get("derivative_y"), "derivative must have y values"
    norm = json.loads((FIXTURE / "expected/cycles_normalization.json").read_text(encoding="utf-8"))
    base = json.loads((FIXTURE / "expected/cycles_baseline.json").read_text(encoding="utf-8"))
    assert norm != base, "normalization projection must differ from baseline"
    print("Sanity checks passed.")


if __name__ == "__main__":
    main()
