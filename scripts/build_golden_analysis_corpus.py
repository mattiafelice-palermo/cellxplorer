#!/usr/bin/env python3
"""Build or verify the golden analysis regression corpus (Spec 015)."""
from __future__ import annotations

import argparse
import json
import shutil
import sqlite3
import sys
import tempfile
from copy import deepcopy
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "tests"))

from golden_analysis_support import (  # noqa: E402
    GoldenFixtureEnvironment,
    bind_isolated_data_root,
    compare_values,
    comparison_profile,
    load_manifest,
    sha256_file,
    trim_cell_metadata,
    verify_source_binaries,
)
from app.services import analysis_engine as engine  # noqa: E402
from app.services import parsing, protocol  # noqa: E402

FIXTURE = ROOT / "tests" / "fixtures" / "golden_analysis"

FIXTURE_ROLES = {
    "cycles": {
        "key": "cycles_time_steps",
        "fixture_name": "cycles_time_steps.ndax",
        "fixture_cell_id": 101,
        "fixture_cell_name": "golden-cycles-cell",
        "families": ["cycles", "time_capacity", "steps"],
    },
    "dcir": {
        "key": "dcir",
        "fixture_name": "dcir_source.ndax",
        "fixture_cell_id": 102,
        "fixture_cell_name": "golden-dcir-cell",
        "families": ["dcir"],
    },
    "chargeability": {
        "key": "chargeability",
        "fixture_name": "chargeability_source.ndax",
        "fixture_cell_id": 103,
        "fixture_cell_name": "golden-chargeability-cell",
        "families": ["chargeability"],
    },
    "rate_capability": {
        "key": "rate_capability",
        "fixture_name": "rate_capability_source.ndax",
        "fixture_cell_id": 103,
        "distinct_fixture_cell_id": 104,
        "fixture_cell_name": "golden-rate-capability-cell",
        "families": ["rate_capability"],
    },
}

DEFAULT_PLOT_NAMES = {
    "cycles": "Charge capacity (mAh/g) comparison test",
    "time_capacity": "Time / capacity comparison",
    "steps": "Steps view",
    "dcir": "DCIR comparison 0.7C",
    "chargeability": "Chargeability comparison",
    "rate_capability": "Rate capability comparison",
}

DCIR_CHARGE_SEGMENT_ID = "b1c2d3e4-f5a6-7890-bcde-f12345678901"
DCIR_CHARGE_SERIES_ID = "c2d3e4f5-a6b7-8901-cdef-123456789012"
DCIR_DISCHARGE_SERIES_ID = "6f7320cb-60cb-4ae0-87fe-9cab3df421cf"

DEFAULT_ELECTRODE_AREA_CM2 = 1.96
CYCLES_STEPS_SEGMENT_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
CYCLES_STEPS_SERIES_ID = "e01df301-bc03-414a-a70f-affe5f5a057e"


def snapshot_db(source: Path) -> Path:
    tmp = Path(tempfile.mkdtemp(prefix="cellxplorer-golden-export-")) / "snapshot.db"
    with sqlite3.connect(source) as src_conn, sqlite3.connect(tmp) as dst_conn:
        src_conn.backup(dst_conn)
    return tmp


def resolve_analysis_id(
    conn: sqlite3.Connection,
    *,
    title: str | None,
    analysis_id: int | None,
) -> tuple[int, str]:
    if analysis_id is not None:
        row = conn.execute("SELECT id, title FROM analyses WHERE id = ?", (analysis_id,)).fetchone()
        if row is None:
            raise SystemExit(f"Analysis id {analysis_id} not found in snapshot")
        return int(row[0]), str(row[1])

    if not title:
        raise SystemExit("Analysis title or id is required")

    rows = conn.execute("SELECT id, title FROM analyses WHERE title = ?", (title,)).fetchall()
    if not rows:
        raise SystemExit(f"No analysis titled {title!r}")
    if len(rows) > 1:
        ids = ", ".join(str(row[0]) for row in rows)
        raise SystemExit(f"Ambiguous analysis title {title!r}; specify an id. Matches: {ids}")
    return int(rows[0][0]), str(rows[0][1])


def load_analysis_spec(conn: sqlite3.Connection, analysis_id: int) -> dict:
    row = conn.execute("SELECT spec FROM analyses WHERE id = ?", (analysis_id,)).fetchone()
    if row is None:
        raise SystemExit(f"Analysis id {analysis_id} not found in snapshot")
    return json.loads(row[0])


def load_cell_metadata(conn: sqlite3.Connection, cell_id: int) -> dict[str, str]:
    rows = conn.execute(
        "SELECT key, value FROM cell_metadata WHERE cell_id = ?",
        (cell_id,),
    ).fetchall()
    return trim_cell_metadata({key: value for key, value in rows})


def primary_cell_id(conn: sqlite3.Connection, analysis_id: int) -> int:
    spec = load_analysis_spec(conn, analysis_id)
    for entry in spec.get("selection", {}).get("entries", []):
        if entry.get("kind") == "cell" and entry.get("ref_id") is not None:
            return int(entry["ref_id"])
    raise SystemExit(f"Analysis {analysis_id} has no selected cell")


def cell_source_path(conn: sqlite3.Connection, cell_id: int) -> Path:
    row = conn.execute(
        """
        SELECT sf.path
        FROM tests t
        JOIN test_files tf ON tf.test_id = t.id
        JOIN source_files sf ON sf.id = tf.file_id
        WHERE t.cell_id = ?
        ORDER BY tf.position
        LIMIT 1
        """,
        (cell_id,),
    ).fetchone()
    if row is None:
        raise SystemExit(f"Cell {cell_id} has no source file")
    return Path(row[0])


def pick_cycles_cell(conn: sqlite3.Connection, analysis_id: int, min_cycles: int = 150) -> int:
    spec = load_analysis_spec(conn, analysis_id)
    best: tuple[int, int] | None = None
    for entry in spec.get("selection", {}).get("entries", []):
        if entry.get("kind") != "cell":
            continue
        cell_id = int(entry["ref_id"])
        row = conn.execute(
            """
            SELECT sf.cycle_count
            FROM tests t
            JOIN test_files tf ON tf.test_id = t.id
            JOIN source_files sf ON sf.id = tf.file_id
            WHERE t.cell_id = ?
            ORDER BY tf.position
            LIMIT 1
            """,
            (cell_id,),
        ).fetchone()
        cycles = int(row[0] or 0) if row else 0
        if cycles >= min_cycles and (best is None or cycles < best[1]):
            best = (cell_id, cycles)
    if best is None:
        raise SystemExit(
            f"No cell in analysis {analysis_id} has at least {min_cycles} parsed cycles"
        )
    return best[0]


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


def saved_plot_by_name(analysis_spec: dict, plot_name: str) -> dict:
    for plot in analysis_spec.get("saved_plots") or []:
        if plot.get("name") == plot_name:
            return plot
    names = [plot.get("name") for plot in analysis_spec.get("saved_plots") or []]
    raise SystemExit(f"Saved plot {plot_name!r} not found. Available: {names}")


def cycles_steps_protocol_segment(source_path: Path) -> dict:
    meta = parsing.read_header_metadata(source_path)
    signature = protocol.reconstruct_protocol(
        meta.get("raw") or {},
        meta.get("nominal_capacity_mah"),
    ).get("signature")
    if not signature:
        raise SystemExit(f"Could not derive protocol signature from {source_path}")
    return {
        "id": CYCLES_STEPS_SEGMENT_ID,
        "name": "Initial CC charge block",
        "targets": [{"protocol_signature": signature, "step_indices": [2, 3, 4]}],
    }


def inspect_source(path: Path) -> dict:
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


def analysis_title(conn: sqlite3.Connection, analysis_id: int) -> str:
    return str(conn.execute("SELECT title FROM analyses WHERE id = ?", (analysis_id,)).fetchone()[0])


def ensure_dcir_charge_coverage(spec: dict, source_path: Path) -> dict:
    """Guarantee at least one charge and one discharge DCIR series for the golden case."""
    from app.services import dcir

    next_spec = deepcopy(spec)
    segments = list(next_spec.get("dcir_segments") or [])
    series = list((next_spec.get("computation") or {}).get("dcir", {}).get("series") or [])

    def directions() -> set[str]:
        by_id = {segment["id"]: segment for segment in segments}
        found: set[str] = set()
        for item in series:
            segment = by_id.get(item.get("segment_id"))
            if not segment:
                continue
            for target in segment.get("targets") or []:
                direction = target.get("direction")
                if direction in {"charge", "discharge"}:
                    found.add(str(direction))
        return found

    present = directions()
    if "charge" in present and "discharge" in present:
        return next_spec

    meta = parsing.read_header_metadata(source_path)
    reconstructed = protocol.reconstruct_protocol(meta.get("raw") or {}, meta.get("nominal_capacity_mah"))
    candidates = dcir.detect_candidates(reconstructed)
    signature = reconstructed.get("signature")
    fixture_cell_id = FIXTURE_ROLES["dcir"]["fixture_cell_id"]

    if "discharge" not in present:
        discharge = next((c for c in candidates if c.get("direction") == "discharge"), None)
        if discharge is None:
            raise SystemExit(f"No discharge DCIR candidate found in {source_path}")
        segment_id = "a4d9e24f-fd93-4e79-a36c-b30d9ba19a0b"
        segments.append(
            {
                "id": segment_id,
                "name": "Discharge 0.701C",
                "targets": [
                    {
                        "protocol_signature": signature,
                        "direction": "discharge",
                        "c_rate": discharge.get("c_rate"),
                        "current_ma": discharge.get("current_ma"),
                        "pulse_duration_s": discharge.get("pulse_duration_s"),
                        "pulse_step_index": discharge.get("pulse_step_index"),
                        "rest_duration_s": discharge.get("rest_duration_s"),
                        "rest_step_index": discharge.get("rest_step_index"),
                    }
                ],
            }
        )
        series.append(
            {"id": DCIR_DISCHARGE_SERIES_ID, "cell_id": fixture_cell_id, "segment_id": segment_id}
        )

    if "charge" not in present:
        charge = next(
            (
                c
                for c in candidates
                if c.get("direction") == "charge"
                and abs(float(c.get("c_rate") or 0) - 0.7) < 0.05
            ),
            next((c for c in candidates if c.get("direction") == "charge"), None),
        )
        if charge is None:
            raise SystemExit(f"No charge DCIR candidate found in {source_path}")
        segments.append(
            {
                "id": DCIR_CHARGE_SEGMENT_ID,
                "name": "Charge 0.701C",
                "targets": [
                    {
                        "protocol_signature": signature,
                        "direction": "charge",
                        "c_rate": charge.get("c_rate"),
                        "current_ma": charge.get("current_ma"),
                        "pulse_duration_s": charge.get("pulse_duration_s"),
                        "pulse_step_index": charge.get("pulse_step_index"),
                        "rest_duration_s": charge.get("rest_duration_s"),
                        "rest_step_index": charge.get("rest_step_index"),
                    }
                ],
            }
        )
        series.append(
            {
                "id": DCIR_CHARGE_SERIES_ID,
                "cell_id": fixture_cell_id,
                "segment_id": DCIR_CHARGE_SEGMENT_ID,
            }
        )

    next_spec["dcir_segments"] = segments
    next_spec.setdefault("computation", {}).setdefault("dcir", {})["series"] = series
    return next_spec


def build_case_definitions(
    conn: sqlite3.Connection,
    *,
    cycles_analysis_id: int,
    dcir_analysis_id: int,
    chargeability_analysis_id: int,
    rate_analysis_id: int,
    cycles_cell_id: int,
    dcir_cell_id: int,
    chargeability_cell_id: int,
    rate_cell_id: int,
    rate_fixture_cell_id: int,
    plot_names: dict[str, str],
) -> list[dict]:
    cycles_spec = load_analysis_spec(conn, cycles_analysis_id)
    dcir_spec = load_analysis_spec(conn, dcir_analysis_id)
    chargeability_spec = load_analysis_spec(conn, chargeability_analysis_id)
    rate_spec = load_analysis_spec(conn, rate_analysis_id)

    cycles_plot = saved_plot_by_name(cycles_spec, plot_names["cycles"])
    time_plot = saved_plot_by_name(cycles_spec, plot_names["time_capacity"])
    dcir_plot = saved_plot_by_name(dcir_spec, plot_names["dcir"])
    charge_plot = saved_plot_by_name(chargeability_spec, plot_names["chargeability"])
    rate_plot = saved_plot_by_name(rate_spec, plot_names["rate_capability"])
    steps_plot_name = plot_names["steps"]
    # Steps plot may live on the chargeability analysis; validate when present.
    if any(plot.get("name") == steps_plot_name for plot in chargeability_spec.get("saved_plots") or []):
        saved_plot_by_name(chargeability_spec, steps_plot_name)

    return [
        {
            "id": "cycles_baseline",
            "kind": "cycles",
            "analysis_id": cycles_analysis_id,
            "plot_name": cycles_plot["name"],
            "source_keys": ["cycles_time_steps"],
            "source_analysis": analysis_title(conn, cycles_analysis_id),
            "source_plot": cycles_plot["name"],
            "cell_id": cycles_cell_id,
            "fixture_cell_id": FIXTURE_ROLES["cycles"]["fixture_cell_id"],
            "projection": "cycles_absolute",
        },
        {
            "id": "cycles_normalization",
            "kind": "cycles",
            "analysis_id": cycles_analysis_id,
            "plot_name": cycles_plot["name"],
            "source_keys": ["cycles_time_steps"],
            "source_analysis": analysis_title(conn, cycles_analysis_id),
            "source_plot": cycles_plot["name"],
            "cell_id": cycles_cell_id,
            "fixture_cell_id": FIXTURE_ROLES["cycles"]["fixture_cell_id"],
            "projection": "cycles_specific",
        },
        {
            "id": "time_capacity_baseline",
            "kind": "time_capacity",
            "analysis_id": cycles_analysis_id,
            "plot_name": time_plot["name"],
            "source_keys": ["cycles_time_steps"],
            "source_analysis": analysis_title(conn, cycles_analysis_id),
            "source_plot": time_plot["name"],
            "cell_id": cycles_cell_id,
            "fixture_cell_id": FIXTURE_ROLES["cycles"]["fixture_cell_id"],
            "electrode_area_cm2": DEFAULT_ELECTRODE_AREA_CM2,
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
            "analysis_id": cycles_analysis_id,
            "plot_name": time_plot["name"],
            "source_keys": ["cycles_time_steps"],
            "source_analysis": analysis_title(conn, cycles_analysis_id),
            "source_plot": time_plot["name"],
            "cell_id": cycles_cell_id,
            "fixture_cell_id": FIXTURE_ROLES["cycles"]["fixture_cell_id"],
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
            "analysis_id": chargeability_analysis_id,
            "plot_name": steps_plot_name,
            "source_keys": ["cycles_time_steps"],
            "source_analysis": analysis_title(conn, cycles_analysis_id),
            "source_plot": "Initial CC charge block",
            "cell_id": cycles_cell_id,
            "fixture_cell_id": FIXTURE_ROLES["cycles"]["fixture_cell_id"],
            "cycles_source_path": None,
        },
        {
            "id": "dcir_baseline",
            "kind": "dcir",
            "analysis_id": dcir_analysis_id,
            "plot_name": dcir_plot["name"],
            "source_keys": ["dcir"],
            "source_analysis": analysis_title(conn, dcir_analysis_id),
            "source_plot": dcir_plot["name"],
            "cell_id": dcir_cell_id,
            "fixture_cell_id": FIXTURE_ROLES["dcir"]["fixture_cell_id"],
        },
        {
            "id": "chargeability_baseline",
            "kind": "chargeability",
            "analysis_id": chargeability_analysis_id,
            "plot_name": charge_plot["name"],
            "source_keys": ["chargeability"],
            "source_analysis": analysis_title(conn, chargeability_analysis_id),
            "source_plot": charge_plot["name"],
            "cell_id": chargeability_cell_id,
            "fixture_cell_id": FIXTURE_ROLES["chargeability"]["fixture_cell_id"],
        },
        {
            "id": "rate_capability_baseline",
            "kind": "rate_capability",
            "analysis_id": rate_analysis_id,
            "plot_name": rate_plot["name"],
            "source_keys": ["rate_capability"],
            "source_analysis": analysis_title(conn, rate_analysis_id),
            "source_plot": rate_plot["name"],
            "cell_id": rate_cell_id,
            "fixture_cell_id": rate_fixture_cell_id,
        },
    ]


def build_case_spec(
    conn: sqlite3.Connection,
    case: dict,
    *,
    cycles_source_path: Path | None = None,
) -> dict:
    analysis_spec = load_analysis_spec(conn, case["analysis_id"])
    saved_plot = saved_plot_by_name(analysis_spec, case["plot_name"])
    spec = merge_saved_plot_spec(analysis_spec, saved_plot)
    cell_map = {case["cell_id"]: case["fixture_cell_id"]}
    spec = remap_spec_cells(spec, cell_map)

    if case.get("derivative_view"):
        tc = spec.setdefault("computation", {}).setdefault("time_capacity", {})
        tc["view"] = case["derivative_view"]
        tc.setdefault("derivative_phase", "both")
        tc.setdefault("derivative_specific", False)
        tc.setdefault("derivative_absolute_discharge", True)
        tc.setdefault("smoothing_window", 7)

    if case["kind"] == "steps":
        if cycles_source_path is None:
            raise SystemExit("cycles_source_path is required for steps case export")
        spec["protocol_segments"] = [cycles_steps_protocol_segment(cycles_source_path)]
        spec.setdefault("computation", {}).setdefault("steps", {})["series"] = [
            {
                "id": CYCLES_STEPS_SERIES_ID,
                "cell_id": case["fixture_cell_id"],
                "segment_id": CYCLES_STEPS_SEGMENT_ID,
            }
        ]

    if case["kind"] == "time_capacity":
        comp = spec.setdefault("computation", {}).setdefault("time_capacity", {})
        options = case.get("request_options") or {}
        comp["max_points_per_cell"] = options.get("max_points_per_cell", 500000)
        if case.get("electrode_area_cm2") is not None:
            comp["electrode_area_cm2"] = case["electrode_area_cm2"]

    if case["kind"] == "dcir":
        dcir_spec = load_analysis_spec(conn, case["analysis_id"])
        spec["dcir_segments"] = deepcopy(dcir_spec.get("dcir_segments") or [])
        dcir_source = case.get("dcir_source_path")
        if dcir_source is not None:
            spec = ensure_dcir_charge_coverage(spec, Path(dcir_source))

    spec["spec_version"] = analysis_spec.get("spec_version") or engine.default_spec("golden")["spec_version"]
    return spec


def refuse_committed_fixture_output(output: Path) -> None:
    if output.resolve() == FIXTURE.resolve():
        raise SystemExit(
            "Refusing to write into the committed fixture tree "
            f"({FIXTURE}). Export/refresh to a candidate directory, then copy after review."
        )


def write_expected_outputs(manifest_path: Path, output_root: Path) -> None:
    manifest = load_manifest(manifest_path)
    export_data = output_root / "_data"
    bind_isolated_data_root(export_data)
    with GoldenFixtureEnvironment.create(manifest_path, data_root=export_data) as env:
        for case in manifest.get("cases", []):
            result = env.run_case(case)
            target = output_root / case["expected_path"]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
            print(f"Generated expected output for {case['id']}")


def summarize_candidate_diff(committed: Path, candidate: Path) -> None:
    print("\nCandidate vs committed expected digests:")
    for expected in sorted((candidate / "expected").glob("*.json")):
        committed_path = committed / "expected" / expected.name
        if not committed_path.is_file():
            print(f"  NEW  {expected.name}")
            continue
        same = sha256_file(expected) == sha256_file(committed_path)
        print(f"  {'SAME' if same else 'DIFF'} {expected.name}")


def export_corpus(
    output: Path,
    data_root: Path,
    replace: bool,
    *,
    cycles_analysis: str,
    dcir_analysis: str,
    chargeability_analysis: str,
    rate_analysis: str,
    cycles_analysis_id: int | None,
    dcir_analysis_id: int | None,
    chargeability_analysis_id: int | None,
    rate_analysis_id: int | None,
    plot_names: dict[str, str],
) -> None:
    refuse_committed_fixture_output(output)
    if output.exists():
        if not replace:
            raise SystemExit(f"Output directory already exists: {output}. Pass --replace to overwrite.")
        shutil.rmtree(output)
    output.mkdir(parents=True)

    db_path = snapshot_db(data_root / "cellxplorer.db")
    conn = sqlite3.connect(db_path)

    cycles_id, _ = resolve_analysis_id(conn, title=cycles_analysis, analysis_id=cycles_analysis_id)
    dcir_id, _ = resolve_analysis_id(conn, title=dcir_analysis, analysis_id=dcir_analysis_id)
    charge_id, _ = resolve_analysis_id(
        conn, title=chargeability_analysis, analysis_id=chargeability_analysis_id
    )
    rate_id, _ = resolve_analysis_id(conn, title=rate_analysis, analysis_id=rate_analysis_id)

    cycles_cell = pick_cycles_cell(conn, cycles_id)
    dcir_cell = primary_cell_id(conn, dcir_id)
    charge_cell = primary_cell_id(conn, charge_id)
    rate_cell = primary_cell_id(conn, rate_id)

    resolved_paths = {
        cycles_cell: cell_source_path(conn, cycles_cell),
        dcir_cell: cell_source_path(conn, dcir_cell),
        charge_cell: cell_source_path(conn, charge_cell),
        rate_cell: cell_source_path(conn, rate_cell),
    }

    rate_shares_chargeability = rate_cell == charge_cell
    rate_fixture_cell_id = (
        FIXTURE_ROLES["chargeability"]["fixture_cell_id"]
        if rate_shares_chargeability
        else FIXTURE_ROLES["rate_capability"]["distinct_fixture_cell_id"]
    )
    rate_fixture_name = (
        FIXTURE_ROLES["chargeability"]["fixture_cell_name"]
        if rate_shares_chargeability
        else FIXTURE_ROLES["rate_capability"]["fixture_cell_name"]
    )

    sources = []
    for role_name, analysis_id, cell_id, fixture_cell_id in (
        ("cycles", cycles_id, cycles_cell, FIXTURE_ROLES["cycles"]["fixture_cell_id"]),
        ("dcir", dcir_id, dcir_cell, FIXTURE_ROLES["dcir"]["fixture_cell_id"]),
        ("chargeability", charge_id, charge_cell, FIXTURE_ROLES["chargeability"]["fixture_cell_id"]),
        ("rate_capability", rate_id, rate_cell, rate_fixture_cell_id),
    ):
        role = FIXTURE_ROLES[role_name]
        stats = inspect_source(resolved_paths[cell_id])
        sources.append(
            {
                "key": role["key"],
                "binary_path": f"sources/{role['fixture_name']}",
                "sha256": stats["sha256"],
                "file_size_bytes": stats["file_size_bytes"],
                "row_count": stats["row_count"],
                "cycle_count": stats["cycle_count"],
                "source_analysis": analysis_title(conn, analysis_id),
                "fixture_cell_id": fixture_cell_id,
                "families": role["families"],
            }
        )

    dest = output / "sources"
    dest.mkdir(parents=True, exist_ok=True)
    shutil.copy2(resolved_paths[cycles_cell], dest / FIXTURE_ROLES["cycles"]["fixture_name"])
    shutil.copy2(resolved_paths[dcir_cell], dest / FIXTURE_ROLES["dcir"]["fixture_name"])
    shutil.copy2(resolved_paths[charge_cell], dest / FIXTURE_ROLES["chargeability"]["fixture_name"])
    shutil.copy2(resolved_paths[rate_cell], dest / FIXTURE_ROLES["rate_capability"]["fixture_name"])

    metadata_by_fixture = {
        FIXTURE_ROLES["cycles"]["fixture_cell_id"]: load_cell_metadata(conn, cycles_cell),
        FIXTURE_ROLES["dcir"]["fixture_cell_id"]: load_cell_metadata(conn, dcir_cell),
        FIXTURE_ROLES["chargeability"]["fixture_cell_id"]: load_cell_metadata(conn, charge_cell),
    }
    cells = [
        {
            "id": FIXTURE_ROLES["cycles"]["fixture_cell_id"],
            "name": FIXTURE_ROLES["cycles"]["fixture_cell_name"],
            "description": "Golden analysis fixture cell",
            "metadata": metadata_by_fixture[FIXTURE_ROLES["cycles"]["fixture_cell_id"]],
        },
        {
            "id": FIXTURE_ROLES["dcir"]["fixture_cell_id"],
            "name": FIXTURE_ROLES["dcir"]["fixture_cell_name"],
            "description": "Golden analysis fixture cell",
            "metadata": metadata_by_fixture[FIXTURE_ROLES["dcir"]["fixture_cell_id"]],
        },
        {
            "id": FIXTURE_ROLES["chargeability"]["fixture_cell_id"],
            "name": FIXTURE_ROLES["chargeability"]["fixture_cell_name"],
            "description": "Golden analysis fixture cell",
            "metadata": metadata_by_fixture[FIXTURE_ROLES["chargeability"]["fixture_cell_id"]],
        },
    ]
    if not rate_shares_chargeability:
        cells.append(
            {
                "id": rate_fixture_cell_id,
                "name": rate_fixture_name,
                "description": "Golden analysis fixture cell",
                "metadata": load_cell_metadata(conn, rate_cell),
            }
        )
    entities = {"cells": cells, "replicate_groups": []}

    case_defs = build_case_definitions(
        conn,
        cycles_analysis_id=cycles_id,
        dcir_analysis_id=dcir_id,
        chargeability_analysis_id=charge_id,
        rate_analysis_id=rate_id,
        cycles_cell_id=cycles_cell,
        dcir_cell_id=dcir_cell,
        chargeability_cell_id=charge_cell,
        rate_cell_id=rate_cell,
        rate_fixture_cell_id=rate_fixture_cell_id,
        plot_names=plot_names,
    )

    cases = []
    for case_def in case_defs:
        if case_def["kind"] == "dcir":
            case_def["dcir_source_path"] = resolved_paths[dcir_cell]
        spec = build_case_spec(
            conn,
            case_def,
            cycles_source_path=resolved_paths[cycles_cell],
        )
        spec_path = Path("specs") / f"{case_def['id']}.json"
        expected_path = Path("expected") / f"{case_def['id']}.json"
        (output / spec_path).parent.mkdir(parents=True, exist_ok=True)
        (output / expected_path).parent.mkdir(parents=True, exist_ok=True)
        (output / spec_path).write_text(json.dumps(spec, indent=2, sort_keys=True) + "\n", encoding="utf-8")
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
        if case_def.get("projection"):
            case["projection"] = case_def["projection"]
        if case_def.get("request_options"):
            case["request_options"] = case_def["request_options"]
        cases.append(case)

    manifest = {
        "schema_version": 1,
        "description": "CellXplorer golden analysis regression corpus",
        "sources": sources,
        "entities": entities,
        "cases": cases,
        "comparison_profiles": {
            "scientific_default": {"relative_tolerance": 1e-7, "absolute_tolerance": 1e-9}
        },
    }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    write_expected_outputs(output / "manifest.json", output)
    summarize_candidate_diff(FIXTURE, output)
    conn.close()
    print(f"Exported golden corpus candidate to {output}")


def refresh_expected(source: Path, output: Path, replace: bool) -> None:
    """Copy an existing corpus tree and regenerate expected JSON into a candidate directory."""
    refuse_committed_fixture_output(output)
    if source.resolve() == output.resolve():
        raise SystemExit("Source and output directories must differ.")
    if output.exists():
        if not replace:
            raise SystemExit(f"Output directory already exists: {output}. Pass --replace to overwrite.")
        shutil.rmtree(output)
    shutil.copytree(source, output, ignore=shutil.ignore_patterns("_data", "__pycache__"))
    # Drop stale expected files so regeneration is explicit.
    expected_dir = output / "expected"
    if expected_dir.exists():
        shutil.rmtree(expected_dir)
    expected_dir.mkdir(parents=True, exist_ok=True)
    write_expected_outputs(output / "manifest.json", output)
    summarize_candidate_diff(source if source.resolve() != FIXTURE.resolve() else FIXTURE, output)
    print(f"Refreshed expected outputs into candidate {output}")
    print("Review the DIFF lines, then copy approved files into the committed fixture tree.")


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
    export_parser.add_argument("--cycles-analysis", default="Test analysis")
    export_parser.add_argument("--dcir-analysis", default="DCIR test")
    export_parser.add_argument("--chargeability-analysis", default="Chargeability test")
    export_parser.add_argument("--rate-analysis", default="Chargeability test")
    export_parser.add_argument("--cycles-analysis-id", type=int, default=None)
    export_parser.add_argument("--dcir-analysis-id", type=int, default=None)
    export_parser.add_argument("--chargeability-analysis-id", type=int, default=None)
    export_parser.add_argument("--rate-analysis-id", type=int, default=None)
    export_parser.add_argument("--cycles-plot", default=DEFAULT_PLOT_NAMES["cycles"])
    export_parser.add_argument("--time-plot", default=DEFAULT_PLOT_NAMES["time_capacity"])
    export_parser.add_argument("--steps-plot", default=DEFAULT_PLOT_NAMES["steps"])
    export_parser.add_argument("--dcir-plot", default=DEFAULT_PLOT_NAMES["dcir"])
    export_parser.add_argument("--chargeability-plot", default=DEFAULT_PLOT_NAMES["chargeability"])
    export_parser.add_argument("--rate-plot", default=DEFAULT_PLOT_NAMES["rate_capability"])

    refresh_parser = sub.add_parser(
        "refresh-expected",
        help="Regenerate expected JSON for an existing corpus into a candidate directory.",
    )
    refresh_parser.add_argument("--source", type=Path, default=FIXTURE)
    refresh_parser.add_argument("--output", type=Path, required=True)
    refresh_parser.add_argument("--replace", action="store_true")

    verify_parser = sub.add_parser("verify", help="Verify a committed corpus manifest and expected outputs.")
    verify_parser.add_argument("--manifest", type=Path, default=FIXTURE / "manifest.json")

    args = parser.parse_args()
    if args.command == "export":
        if args.output.resolve() == args.data_root.resolve():
            raise SystemExit("Refusing to write corpus output into the live data root.")
        export_corpus(
            args.output,
            args.data_root,
            args.replace,
            cycles_analysis=args.cycles_analysis,
            dcir_analysis=args.dcir_analysis,
            chargeability_analysis=args.chargeability_analysis,
            rate_analysis=args.rate_analysis,
            cycles_analysis_id=args.cycles_analysis_id,
            dcir_analysis_id=args.dcir_analysis_id,
            chargeability_analysis_id=args.chargeability_analysis_id,
            rate_analysis_id=args.rate_analysis_id,
            plot_names={
                "cycles": args.cycles_plot,
                "time_capacity": args.time_plot,
                "steps": args.steps_plot,
                "dcir": args.dcir_plot,
                "chargeability": args.chargeability_plot,
                "rate_capability": args.rate_plot,
            },
        )
    elif args.command == "refresh-expected":
        refresh_expected(args.source, args.output, args.replace)
    elif args.command == "verify":
        verify_corpus(args.manifest)


if __name__ == "__main__":
    main()
