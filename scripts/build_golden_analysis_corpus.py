#!/usr/bin/env python3
"""Build or verify the golden analysis regression corpus (Spec 015)."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import sys
import tempfile
from copy import deepcopy
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "tests"))

os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))

from golden_analysis_support import (  # noqa: E402
    GoldenFixtureEnvironment,
    compare_values,
    comparison_profile,
    fixture_root,
    load_manifest,
    project_result,
    sha256_file,
    verify_source_binaries,
)
from app.services import analysis_engine as engine  # noqa: E402

FIXTURE = ROOT / "tests" / "fixtures" / "golden_analysis"

SOURCE_SELECTION = {
    "cycles_time_steps": {
        "analysis_title": "Test analysis",
        "cell_id": 22,
        "source_path": Path(
            r"C:\Users\matti\Downloads\MoLs\LPMoL_613\ME_20260512_LFP_LPMoL_613_FM+CYFC_25C.ndax"
        ),
        "fixture_name": "cycles_time_steps.ndax",
        "fixture_cell_id": 101,
        "fixture_cell_name": "golden-cycles-cell",
    },
    "dcir": {
        "analysis_title": "DCIR test",
        "cell_id": 31,
        "source_path": Path(r"C:\Users\matti\Downloads\NG_20260609_LFP_LP_MoL_673_FM_CY.ndax"),
        "fixture_name": "dcir_source.ndax",
        "fixture_cell_id": 102,
        "fixture_cell_name": "golden-dcir-cell",
    },
    "chargeability": {
        "analysis_title": "Chargeability test",
        "cell_id": 30,
        "source_path": Path(r"C:\Users\matti\Downloads\NG_20260706_LP_MoL_715_chargeabilityCY.ndax"),
        "fixture_name": "chargeability_source.ndax",
        "fixture_cell_id": 103,
        "fixture_cell_name": "golden-chargeability-cell",
    },
    "rate_capability": {
        "analysis_title": "Chargeability test",
        "cell_id": 30,
        "source_path": Path(r"C:\Users\matti\Downloads\NG_20260706_LP_MoL_715_chargeabilityCY.ndax"),
        "fixture_name": "rate_capability_source.ndax",
        "fixture_cell_id": 103,
        "fixture_cell_name": "golden-chargeability-cell",
    },
}

CASE_DEFINITIONS = [
    {
        "id": "cycles_baseline",
        "kind": "cycles",
        "analysis_id": 9,
        "plot_name": "Charge capacity (mAh/g) comparison test",
        "source_keys": ["cycles_time_steps"],
        "source_analysis": "Test analysis",
        "source_plot": "Charge capacity (mAh/g) comparison test",
        "cell_id": 22,
        "fixture_cell_id": 101,
    },
    {
        "id": "cycles_normalization",
        "kind": "cycles",
        "analysis_id": 9,
        "plot_name": "Charge capacity (mAh/g) comparison test",
        "source_keys": ["cycles_time_steps"],
        "source_analysis": "Test analysis",
        "source_plot": "Charge capacity (mAh/g) comparison test",
        "cell_id": 22,
        "fixture_cell_id": 101,
        "normalize_by_mass": True,
    },
    {
        "id": "time_capacity_baseline",
        "kind": "time_capacity",
        "analysis_id": 9,
        "plot_name": "Time / capacity comparison",
        "source_keys": ["cycles_time_steps"],
        "source_analysis": "Test analysis",
        "source_plot": "Time / capacity comparison",
        "cell_id": 22,
        "fixture_cell_id": 101,
        "request_options": {
            "viewport_width": 1200,
            "precision": "full",
            "compact": False,
            "max_points_per_cell": 500000,
        },
    },
    {
        "id": "time_capacity_derivative",
        "kind": "time_capacity",
        "analysis_id": 9,
        "plot_name": "Time / capacity comparison",
        "source_keys": ["cycles_time_steps"],
        "source_analysis": "Test analysis",
        "source_plot": "Time / capacity comparison",
        "cell_id": 22,
        "fixture_cell_id": 101,
        "derivative_view": "dqdv",
        "request_options": {
            "viewport_width": 1200,
            "precision": "full",
            "compact": False,
            "max_points_per_cell": 500000,
        },
    },
    {
        "id": "steps_baseline",
        "kind": "steps",
        "analysis_id": 20,
        "plot_name": "Steps view",
        "source_keys": ["cycles_time_steps"],
        "source_analysis": "Test analysis",
        "source_plot": "Steps view",
        "cell_id": 30,
        "fixture_cell_id": 101,
        "use_analysis_protocol_segments": True,
    },
    {
        "id": "dcir_baseline",
        "kind": "dcir",
        "analysis_id": 21,
        "plot_name": "DCIR comparison 0.7C",
        "source_keys": ["dcir"],
        "source_analysis": "DCIR test",
        "source_plot": "DCIR comparison 0.7C",
        "cell_id": 31,
        "fixture_cell_id": 102,
    },
    {
        "id": "chargeability_baseline",
        "kind": "chargeability",
        "analysis_id": 20,
        "plot_name": "Chargeability comparison",
        "source_keys": ["chargeability"],
        "source_analysis": "Chargeability test",
        "source_plot": "Chargeability comparison",
        "cell_id": 30,
        "fixture_cell_id": 103,
    },
    {
        "id": "rate_capability_baseline",
        "kind": "rate_capability",
        "analysis_id": 20,
        "plot_name": "Rate capability comparison",
        "source_keys": ["rate_capability"],
        "source_analysis": "Chargeability test",
        "source_plot": "Rate capability comparison",
        "cell_id": 30,
        "fixture_cell_id": 103,
    },
]


def snapshot_db(source: Path) -> Path:
    tmp = Path(tempfile.mkdtemp(prefix="cellxplorer-golden-export-")) / "snapshot.db"
    with sqlite3.connect(source) as src_conn, sqlite3.connect(tmp) as dst_conn:
        src_conn.backup(dst_conn)
    return tmp


def load_analysis_spec(db_path: Path, analysis_id: int) -> dict:
    row = sqlite3.connect(db_path).execute(
        "SELECT spec FROM analyses WHERE id = ?", (analysis_id,)
    ).fetchone()
    if row is None:
        raise SystemExit(f"Analysis id {analysis_id} not found in snapshot")
    return json.loads(row[0])


def load_cell_metadata(db_path: Path, cell_id: int) -> dict[str, str]:
    rows = sqlite3.connect(db_path).execute(
        "SELECT key, value FROM cell_metadata WHERE cell_id = ?", (cell_id,)
    ).fetchall()
    return {key: value for key, value in rows}


def merge_saved_plot_spec(analysis_spec: dict, saved_plot: dict) -> dict:
    spec = deepcopy(analysis_spec)
    spec.pop("saved_plots", None)
    spec.pop("draft_plots", None)
    spec.pop("draft_plot", None)
    selection = deepcopy(spec.get("selection") or {})
    saved_selection = saved_plot.get("selection") or {}
    selection["exclusions"] = deepcopy(saved_selection.get("exclusions") or [])
    selection["hidden_replicate_group_ids"] = deepcopy(
        saved_selection.get("hidden_replicate_group_ids") or []
    )
    spec["selection"] = selection
    spec["computation"] = deepcopy(saved_plot.get("computation") or spec.get("computation") or {})
    spec["aggregation"] = deepcopy(saved_plot.get("aggregation") or spec.get("aggregation") or {})
    spec["presentation"] = deepcopy(saved_plot.get("presentation") or spec.get("presentation") or {})
    return spec


def remap_spec_cells(spec: dict, cell_map: dict[int, int]) -> dict:
    next_spec = deepcopy(spec)
    entries = []
    for entry in next_spec.get("selection", {}).get("entries", []):
        if entry.get("kind") == "cell" and entry.get("ref_id") in cell_map:
            entries.append({"kind": "cell", "ref_id": cell_map[entry["ref_id"]]})
    next_spec.setdefault("selection", {})["entries"] = entries

    def remap_id(value):
        if isinstance(value, dict):
            return {key: remap_id(item) for key, item in value.items()}
        if isinstance(value, list):
            return [remap_id(item) for item in value]
        if value in cell_map:
            return cell_map[value]
        return value

    for key in ("computation", "aggregation", "presentation"):
        next_spec[key] = remap_id(next_spec.get(key) or {})
    return next_spec


def build_case_spec(db_path: Path, case: dict) -> dict:
    analysis_spec = load_analysis_spec(db_path, case["analysis_id"])
    saved_plot = next(
        plot
        for plot in analysis_spec.get("saved_plots") or []
        if plot.get("name") == case["plot_name"]
    )
    spec = merge_saved_plot_spec(analysis_spec, saved_plot)
    cell_map = {case["cell_id"]: case["fixture_cell_id"]}
    spec = remap_spec_cells(spec, cell_map)

    if case.get("normalize_by_mass"):
        spec.setdefault("presentation", {})["normalize_by_mass"] = True

    if case.get("derivative_view"):
        tc = spec.setdefault("presentation", {}).setdefault("time_capacity", {})
        tc["view"] = case["derivative_view"]
        tc.setdefault("derivative_phase", "both")
        tc.setdefault("derivative_specific", False)
        tc.setdefault("derivative_absolute_discharge", True)

    if case["kind"] == "steps" and case.get("use_analysis_protocol_segments"):
        # Keep protocol segment definitions from the chargeability analysis.
        chargeability_spec = load_analysis_spec(db_path, 20)
        spec["protocol_segments"] = deepcopy(chargeability_spec.get("protocol_segments") or [])

    if case["kind"] == "time_capacity":
        comp = spec.setdefault("computation", {}).setdefault("time_capacity", {})
        options = case.get("request_options") or {}
        comp["max_points_per_cell"] = options.get("max_points_per_cell", 500000)

    if case["kind"] == "dcir":
        dcir_spec = load_analysis_spec(db_path, case["analysis_id"])
        spec["dcir_segments"] = deepcopy(dcir_spec.get("dcir_segments") or [])

    spec["spec_version"] = analysis_spec.get("spec_version") or engine.default_spec("golden")["spec_version"]
    return spec


def inspect_source(path: Path) -> dict:
    from app.services import parsing

    if not path.is_file():
        raise SystemExit(f"Source file not found: {path}")
    digest = sha256_file(path)
    size = path.stat().st_size
    raw = parsing.parse_timeseries(str(path))
    cycle_count = int(raw["cycle"].max()) if not raw.empty and "cycle" in raw.columns else 0
    return {
        "sha256": digest,
        "file_size_bytes": size,
        "row_count": int(len(raw)),
        "cycle_count": cycle_count,
    }


def build_manifest_sources(db_path: Path) -> list[dict]:
    sources = []
    seen_hashes: dict[str, str] = {}
    for key, info in SOURCE_SELECTION.items():
        stats = inspect_source(info["source_path"])
        if stats["sha256"] in seen_hashes and seen_hashes[stats["sha256"]] != key:
            # Same bytes, separate manifest entry.
            pass
        seen_hashes[stats["sha256"]] = key
        metadata = load_cell_metadata(db_path, info["cell_id"])
        sources.append(
            {
                "key": key,
                "binary_path": f"sources/{info['fixture_name']}",
                "sha256": stats["sha256"],
                "file_size_bytes": stats["file_size_bytes"],
                "row_count": stats["row_count"],
                "cycle_count": stats["cycle_count"],
                "source_analysis": info["analysis_title"],
                "fixture_cell_id": info["fixture_cell_id"],
                "families": {
                    "cycles_time_steps": ["cycles", "time_capacity", "steps"],
                    "dcir": ["dcir"],
                    "chargeability": ["chargeability"],
                    "rate_capability": ["rate_capability"],
                }[key],
                "metadata": metadata,
            }
        )
    return sources


def build_entities(sources: list[dict]) -> dict:
    cells = []
    seen: set[int] = set()
    for source in sources:
        cell_id = source["fixture_cell_id"]
        if cell_id in seen:
            continue
        seen.add(cell_id)
        info = next(item for item in SOURCE_SELECTION.values() if item["fixture_cell_id"] == cell_id)
        cells.append(
            {
                "id": cell_id,
                "name": info["fixture_cell_name"],
                "description": "Golden analysis fixture cell",
                "metadata": source.get("metadata") or {},
            }
        )
    return {"cells": cells, "replicate_groups": []}


def copy_sources(output: Path) -> None:
    dest = output / "sources"
    dest.mkdir(parents=True, exist_ok=True)
    for key, info in SOURCE_SELECTION.items():
        target = dest / info["fixture_name"]
        shutil.copy2(info["source_path"], target)


def export_corpus(output: Path, data_root: Path, replace: bool) -> None:
    if output.exists():
        if not replace:
            raise SystemExit(f"Output directory already exists: {output}. Pass --replace to overwrite.")
        shutil.rmtree(output)
    output.mkdir(parents=True)

    db_path = snapshot_db(data_root / "cellxplorer.db")
    copy_sources(output)

    sources = build_manifest_sources(db_path)
    entities = build_entities(sources)
    cases = []
    case_specs: list[tuple[dict, dict]] = []

    for case_def in CASE_DEFINITIONS:
        spec = build_case_spec(db_path, case_def)
        spec_path = Path("specs") / f"{case_def['id']}.json"
        expected_path = Path("expected") / f"{case_def['id']}.json"
        (output / spec_path).parent.mkdir(parents=True, exist_ok=True)
        (output / expected_path).parent.mkdir(parents=True, exist_ok=True)
        (output / spec_path).write_text(json.dumps(spec, indent=2, sort_keys=True), encoding="utf-8")
        case = {
            "id": case_def["id"],
            "kind": case_def["kind"],
            "spec_path": str(spec_path).replace("\\", "/"),
            "expected_path": str(expected_path).replace("\\", "/"),
            "source_keys": case_def["source_keys"],
            "source_analysis": case_def["source_analysis"],
            "source_plot": case_def.get("source_plot"),
            "comparison_profile": "scientific_default",
        }
        if case_def.get("request_options"):
            case["request_options"] = case_def["request_options"]
        cases.append(case)
        case_specs.append((case, spec))

    manifest = {
        "schema_version": 1,
        "description": "CellXplorer golden analysis regression corpus",
        "sources": sources,
        "entities": entities,
        "cases": cases,
        "comparison_profiles": {"scientific_default": {"relative_tolerance": 1e-7, "absolute_tolerance": 1e-9}},
    }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    os.environ["CELLXPLORER_DATA"] = str(output / "_data")
    with GoldenFixtureEnvironment.create(output / "manifest.json") as env:
        for case, _spec in case_specs:
            result = env.run_case(case)
            (output / case["expected_path"]).write_text(
                json.dumps(result, indent=2, sort_keys=True),
                encoding="utf-8",
            )
            print(f"Generated expected output for {case['id']}")

    print(f"Exported golden corpus candidate to {output}")


def verify_corpus(manifest_path: Path) -> None:
    manifest = load_manifest(manifest_path)
    root = manifest_path.parent
    verify_source_binaries(manifest, root)
    with GoldenFixtureEnvironment.create(manifest_path) as env:
        for case in manifest.get("cases", []):
            expected = json.loads((root / case["expected_path"]).read_text(encoding="utf-8"))
            actual = env.run_case(case)
            profile = comparison_profile(manifest, case)
            compare_values(expected, actual, profile=profile)
            print(f"PASS {case['id']}")
    print("Golden corpus verification passed.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Build or verify the golden analysis corpus.")
    sub = parser.add_subparsers(dest="command", required=True)

    export_parser = sub.add_parser("export", help="Export a candidate corpus from the local database.")
    export_parser.add_argument("--data-root", type=Path, default=Path.home() / ".cellxplorer")
    export_parser.add_argument("--output", type=Path, required=True)
    export_parser.add_argument("--replace", action="store_true")

    verify_parser = sub.add_parser("verify", help="Verify a committed corpus manifest and expected outputs.")
    verify_parser.add_argument("--manifest", type=Path, default=FIXTURE / "manifest.json")

    args = parser.parse_args()
    if args.command == "export":
        if args.output.resolve() == args.data_root.resolve():
            raise SystemExit("Refusing to write corpus output into the live data root.")
        export_corpus(args.output, args.data_root, args.replace)
    elif args.command == "verify":
        verify_corpus(args.manifest)


if __name__ == "__main__":
    main()
