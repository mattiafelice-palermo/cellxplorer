"""Profile the current production route for the Spec 050.17 families.

This is a bounded developer diagnostic.  It calls the real analysis routers in
the disposable golden-analysis environment, separates persisted result misses
from exact body hits, and records a common timing hierarchy.  The six-Cell
workload uses source-distinct copies of one committed fixture source; it does
not invent a new protocol or touch the user's application database.

The output is intentionally disposable JSON under ``tmp``.  It is not a
scientific result cache and it does not change ordinary request behavior.
"""
from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from contextlib import ExitStack, contextmanager
from copy import deepcopy
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import statistics
import sys
import tempfile
from time import perf_counter
from typing import Any
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "tests"))

from golden_analysis_support import GoldenFixtureEnvironment, load_case_spec  # noqa: E402


FAMILIES = (
    "cycles",
    "steps",
    "dcir",
    "chargeability",
    "rate_capability",
)
REFERENCE_FAMILIES = ("time_capacity",)
AVAILABLE_FAMILIES = FAMILIES + REFERENCE_FAMILIES
FAMILY_CASES = {
    "cycles": ("cycles_baseline", 101),
    "time_capacity": ("time_capacity_baseline", 101),
    "steps": ("steps_baseline", 101),
    "dcir": ("dcir_baseline", 102),
    "chargeability": ("chargeability_baseline", 103),
    "rate_capability": ("rate_capability_baseline", 103),
}
COMMON_STAGES = (
    "route_setup",
    "selection_context",
    "cache_key",
    "exact_cache_lookup",
    "protocol_reconstruction",
    "data_access_materialization",
    "scientific_extraction",
    "cross_cell_aggregation_comparison",
    "result_provenance_assembly",
    "cache_persistence",
    "json_serialization",
    "response_assembly",
)
ROOT_STAGES = {
    "selection_context",
    "cache_key",
    "exact_cache_lookup",
    "legacy_cache_lookup",
    "scientific_compute",
    "cache_persistence",
    "json_serialization",
    "response_assembly",
}
REPETITIONS = 3


def _median(values: Iterable[float]) -> float | None:
    values = [float(value) for value in values]
    return statistics.median(values) if values else None


def _projection(value: Any) -> Any:
    """Remove route/cache volatility while retaining scientific order/content."""

    if isinstance(value, dict):
        return {
            key: _projection(item)
            for key, item in value.items()
            if key not in {
                "computed_at",
                "cache_status",
                "data_signature",
                "source_data_signature",
                "current_parser_version",
                "current_calc_version",
                "profiling",
            }
        }
    if isinstance(value, list):
        return [_projection(item) for item in value]
    return value


def _digest(value: Any) -> str:
    body = json.dumps(
        _projection(value),
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(body).hexdigest()


def _series_order(value: Mapping[str, Any]) -> list[tuple[int, str | None]]:
    for key in ("cell_series", "cell_traces"):
        entries = value.get(key)
        if not isinstance(entries, list):
            continue
        return [
            (int(item["cell_id"]), item.get("series_id"))
            for item in entries
            if isinstance(item, Mapping) and item.get("cell_id") is not None
        ]
    entries = value.get("cells")
    if isinstance(entries, list):
        return [
            (int(item["cell_id"]), None)
            for item in entries
            if isinstance(item, Mapping) and item.get("cell_id") is not None
        ]
    return []


def _case(manifest: Mapping[str, Any], case_id: str) -> dict[str, Any]:
    for case in manifest.get("cases") or []:
        if isinstance(case, Mapping) and case.get("id") == case_id:
            return dict(case)
    raise RuntimeError(f"Golden fixture case not found: {case_id}")


class _Recorder:
    """Small request-local timer/counter sink used only by this script.

    Timers retain both inclusive and exclusive elapsed time.  The active call
    stack supplies the observed parent, so a helper and its descendants cannot
    later be mistaken for non-overlapping siblings during attribution.
    """

    def __init__(self) -> None:
        self.elapsed_ms: dict[str, float] = {}
        self.exclusive_ms: dict[str, float] = {}
        self.calls: dict[str, int] = {}
        self.parents: dict[str, str | None] = {}
        self.parent_edges: dict[str, set[str | None]] = {}
        self._active: list[dict[str, Any]] = []

    def add(
        self,
        name: str,
        elapsed_ms: float,
        *,
        parent: str | None = None,
        exclusive_ms: float | None = None,
    ) -> None:
        actual_parent = self._active[-1]["name"] if self._active else parent
        self.elapsed_ms[name] = self.elapsed_ms.get(name, 0.0) + float(elapsed_ms)
        self.exclusive_ms[name] = self.exclusive_ms.get(name, 0.0) + float(
            exclusive_ms if exclusive_ms is not None else elapsed_ms
        )
        self.calls[name] = self.calls.get(name, 0) + 1
        self.parent_edges.setdefault(name, set()).add(actual_parent)
        self.parents.setdefault(name, actual_parent)

    @contextmanager
    def span(self, name: str, *, parent: str | None = None):
        frame = {"name": name, "child_ms": 0.0}
        self._active.append(frame)
        started = perf_counter()
        try:
            yield
        finally:
            elapsed_ms = (perf_counter() - started) * 1000.0
            self._active.pop()
            self.add(
                name,
                elapsed_ms,
                parent=parent,
                exclusive_ms=max(0.0, elapsed_ms - frame["child_ms"]),
            )
            if self._active:
                self._active[-1]["child_ms"] += elapsed_ms

    def hierarchy(self) -> dict[str, dict[str, Any]]:
        def parent_key(value: str | None) -> tuple[int, str]:
            return (value is not None, value or "")

        records: dict[str, dict[str, Any]] = {}
        for name in sorted(self.elapsed_ms):
            parents = sorted(
                self.parent_edges.get(name, {self.parents.get(name)}),
                key=parent_key,
            )
            records[name] = {
                "inclusive_ms": self.elapsed_ms[name],
                "exclusive_ms": self.exclusive_ms.get(name, self.elapsed_ms[name]),
                "calls": self.calls.get(name, 0),
                "parent": parents[0] if len(parents) == 1 else None,
                "parents": parents,
            }
        return records

    def timed(
        self,
        name: str,
        original: Callable[..., Any],
        *,
        parent: str | None = None,
        observe: Callable[[Any], None] | None = None,
    ) -> Callable[..., Any]:
        def wrapped(*args: Any, **kwargs: Any) -> Any:
            with self.span(name, parent=parent):
                result = original(*args, **kwargs)
            if observe is not None:
                observe(result)
            return result

        return wrapped


def _stage_record(
    recorder: _Recorder,
    name: str,
    total_ms: float,
) -> dict[str, Any]:
    elapsed = recorder.elapsed_ms.get(name)
    calls = recorder.calls.get(name, 0)
    return {
        "ms": float(elapsed) if calls else None,
        "share_of_route": (
            float(elapsed) / total_ms if calls and total_ms > 0 else None
        ),
        "calls": calls,
        "available": bool(calls),
        "parent": recorder.parents.get(name),
    }


def _reconcile_root_stages(
    total_ms: float,
    stage_ms: Mapping[str, float | None],
) -> dict[str, float | bool]:
    """Reconcile only sibling/root timers; nested helper timers are excluded."""

    root_sum = sum(
        float(value)
        for name, value in stage_ms.items()
        if name in ROOT_STAGES and isinstance(value, (int, float))
    )
    return {
        "route_ms": float(total_ms),
        "root_stage_sum_ms": root_sum,
        "unattributed_residual_ms": max(0.0, float(total_ms) - root_sum),
        "root_overlap_ms": max(0.0, root_sum - float(total_ms)),
        "within_root_hierarchy": root_sum <= float(total_ms) + 1.0,
    }


def _exact_hit_is_clean(metrics: Mapping[str, Any]) -> bool:
    """Return whether an exact hit avoided family compute and raw access."""

    return (
        metrics.get("cache_status") == "hit"
        and metrics.get("calls", {}).get("scientific_compute", 0) == 0
        and metrics.get("counts", {}).get("raw_load_calls", 0) == 0
    )


def _numeric_summary(samples: list[Mapping[str, Any]], key: str) -> dict[str, Any]:
    values = [
        float(sample[key])
        for sample in samples
        if isinstance(sample.get(key), (int, float))
        and not isinstance(sample.get(key), bool)
    ]
    return {
        "samples": values,
        "p50": _median(values),
        "min": min(values) if values else None,
        "max": max(values) if values else None,
    }


def _metric_p50(samples: list[Mapping[str, Any]], key: str) -> float | None:
    values = [
        float(sample.get("counts", {}).get(key))
        for sample in samples
        if isinstance(sample.get("counts", {}).get(key), (int, float))
        and not isinstance(sample.get("counts", {}).get(key), bool)
    ]
    return _median(values)


def _source_file_count(files: Any) -> int:
    if not isinstance(files, (list, tuple)):
        return 0
    return len(files)


def _clone_cells(
    env: GoldenFixtureEnvironment,
    family: str,
    source_cell_id: int,
    count: int,
) -> list[int]:
    """Create relationally real, source-distinct copies of one fixture Cell."""

    from app.config import CALC_VERSION
    from app.models import Cell, CellMetadata, SourceFile, Test, TestFile
    from app.services import analysis_engine, cache, parsing

    source_cell = env.db.get(Cell, source_cell_id)
    if source_cell is None:
        raise RuntimeError(f"Golden source Cell {source_cell_id} not found")
    analysis_engine.preload_cell_sources(env.db, [source_cell])
    _hashes, files = analysis_engine.cell_ordered_hashes(env.db, source_cell)
    if len(files) != 1:
        raise RuntimeError(f"Expected one source for cloned fixture Cell {source_cell_id}")
    source = files[0]
    parser_version = (
        parsing.current_parser_identity_for_extension(source.ext)
        or source.parser_version
    )
    if not parser_version:
        raise RuntimeError(f"No parser identity for fixture source {source.filename}")
    raw = cache.load_raw(source.hash, parser_version)
    if raw is None:
        raise RuntimeError(f"Raw fixture cache unavailable for {source.filename}")
    scalar_values = {
        entry.key: entry.value
        for entry in source_cell.metadata_entries
        if entry.key in {
            "active_material_mg",
            "active_mass_mg",
            "nominal_capacity_mah",
            "nominal_capacity",
            "electrode_area_cm2",
        }
    }
    clone_ids = [source_cell_id]
    for index in range(1, count):
        cell = Cell(name=f"050.17-{family}-fixture-cell-{index + 1}")
        env.db.add(cell)
        env.db.flush()
        for key, value in scalar_values.items():
            env.db.add(CellMetadata(cell_id=cell.id, key=key, value=str(value)))

        clone_hash = hashlib.sha256(
            f"cellxplorer-050.17:{family}:{source_cell_id}:{index}".encode("utf-8")
        ).hexdigest()
        clone_source = SourceFile(
            hash=clone_hash,
            path=clone_hash,
            filename=f"050.17-{family}-{index + 1}.ndax",
            size=source.size,
            ext=source.ext,
            header_meta=deepcopy(source.header_meta),
            nominal_capacity_mah=source.nominal_capacity_mah,
            row_count=source.row_count,
            cycle_count=source.cycle_count,
            parse_status="parsed",
            parser_version=parser_version,
        )
        env.db.add(clone_source)
        env.db.flush()
        cache._publish_optimized_raw(
            raw.copy(deep=True),
            cache.raw_path(clone_hash, parser_version),
            parser_version,
        )
        # Warm all cache families used by the required route matrix.  This is
        # derived from the copied raw cache and never reopens the fixture source.
        cache.load_cycles(clone_hash, parser_version, CALC_VERSION)
        cache.prepare_time_capacity_derived(
            clone_hash,
            parser_version,
            raw_frame=raw.copy(deep=True),
        )
        test = Test(cell_id=cell.id, name=f"050.17-{family}-fixture-test-{index + 1}")
        env.db.add(test)
        env.db.flush()
        env.db.add(TestFile(test_id=test.id, file_id=clone_source.id, position=0))
        clone_ids.append(cell.id)
    env.db.commit()
    return clone_ids


def _scaled_spec(base: Mapping[str, Any], family: str, cell_ids: list[int]) -> dict[str, Any]:
    spec = deepcopy(dict(base))
    spec.setdefault("selection", {})["entries"] = [
        {"kind": "cell", "ref_id": cell_id} for cell_id in cell_ids
    ]
    computation = spec.setdefault("computation", {})
    if family in {"steps", "dcir"}:
        configured = computation.setdefault(family, {}).get("series") or []
        templates = [item for item in configured if isinstance(item, dict)]
        series: list[dict[str, Any]] = []
        for cell_id in cell_ids:
            for index, template in enumerate(templates):
                item = deepcopy(template)
                item["cell_id"] = cell_id
                item["id"] = f"050.17-{family}-{cell_id}-{index}"
                series.append(item)
        computation[family]["series"] = series
    return spec


def _route_for(family: str) -> Callable[..., Any]:
    from app.routers import analyses

    return {
        "cycles": analyses.compute_analysis,
        "time_capacity": analyses.compute_time_capacity_analysis,
        "steps": analyses.compute_steps_analysis,
        "dcir": analyses.compute_dcir_analysis,
        "chargeability": analyses.compute_chargeability_analysis,
        "rate_capability": analyses.compute_rate_capability_analysis,
    }[family]


def _analysis_cache_root(cache_root: Path):
    from app.services import analysis_cache

    values = {
        "_ROOT": cache_root,
        "_RESULTS": cache_root / "results",
        "_ARTIFACTS": cache_root / "artifacts",
        "_THUMBNAILS": cache_root / "thumbnails",
        "_THUMBNAIL_INDEXES": cache_root / "thumbnail-index",
        "_PREPARED": cache_root / "prepared",
        "_budget_total": None,
    }
    with ExitStack() as stack:
        for name, value in values.items():
            stack.enter_context(patch.object(analysis_cache, name, value))
        yield


_analysis_cache_root = contextmanager(_analysis_cache_root)


def _response_counts(payload: Mapping[str, Any], family: str) -> dict[str, Any]:
    traces = payload.get("cell_series") or payload.get("cell_traces") or []
    cell_entries = payload.get("cells") or []
    source_entries = payload.get("sources") or []
    cell_ids = {
        int(item["cell_id"])
        for item in [*traces, *cell_entries]
        if isinstance(item, Mapping) and item.get("cell_id") is not None
    }
    source_files = 0
    source_hashes: set[str] = set()
    for entry in source_entries:
        if not isinstance(entry, Mapping):
            continue
        files = entry.get("files") or []
        source_files += _source_file_count(files)
        for file in files:
            if isinstance(file, Mapping) and file.get("hash"):
                source_hashes.add(str(file["hash"]))
        for value in entry.get("file_hashes") or []:
            source_hashes.add(str(value))

    if family == "time_capacity":
        points = (payload.get("rendering") or {}).get("total_points")
    elif family == "rate_capability":
        points = len(payload.get("points") or [])
    elif family == "chargeability":
        points = len(payload.get("matches") or [])
    else:
        points = 0
        for trace in traces:
            if not isinstance(trace, Mapping):
                continue
            candidates = [
                trace.get("x"),
                trace.get("x_occurrence"),
                trace.get("x_cycle"),
                trace.get("occurrence"),
                (trace.get("quantities") or {}).get("dcir_mohm")
                if isinstance(trace.get("quantities"), Mapping)
                else None,
            ]
            lengths = [len(item) for item in candidates if isinstance(item, list)]
            points += max(lengths, default=0)
    return {
        "resolved_cells": len(cell_ids),
        "trace_count": len(traces) if isinstance(traces, list) and traces else None,
        "source_files": source_files or None,
        "source_hashes": len(source_hashes) or None,
        "final_response_points": int(points) if isinstance(points, int) else None,
    }


def _observe_source(metrics: dict[str, Any], result: Any) -> None:
    if not isinstance(result, tuple) or len(result) < 2:
        return
    files = result[1]
    metrics.setdefault("source_hashes", set()).update(
        str(file.hash) for file in files if getattr(file, "hash", None)
    )
    metrics.setdefault("source_files_seen", 0)
    metrics["source_files_seen"] += len(files)


def _observe_frame(metrics: dict[str, Any], result: Any, *, physical: bool = False) -> None:
    if result is None or not hasattr(result, "__len__"):
        return
    try:
        rows = int(len(result))
    except (TypeError, ValueError):
        return
    metrics["raw_load_calls"] = metrics.get("raw_load_calls", 0) + 1
    metrics["raw_rows_loaded"] = metrics.get("raw_rows_loaded", 0) + rows
    if physical:
        metrics["raw_rows_returned"] = metrics.get("raw_rows_returned", 0) + rows
    attrs = getattr(result, "attrs", {})
    metrics["raw_rows_read_physical"] = metrics.get("raw_rows_read_physical", 0) + int(
        attrs.get("_raw_step_rows_read") or 0
    )
    metrics["raw_row_groups_read"] = metrics.get("raw_row_groups_read", 0) + len(
        attrs.get("_raw_step_row_groups") or ()
    )


def _observe_stitched(metrics: dict[str, Any], result: Any) -> None:
    if isinstance(result, tuple) and result and result[0] is not None:
        frame = result[0]
        metrics["raw_rows_stitched"] = metrics.get("raw_rows_stitched", 0) + len(frame)


def _observe_protocol(metrics: dict[str, Any], result: Any) -> None:
    if isinstance(result, Mapping):
        metrics["protocol_steps"] = metrics.get("protocol_steps", 0) + len(
            result.get("steps") or []
        )


def _observe_rate_pairs(metrics: dict[str, Any], result: Any) -> None:
    if isinstance(result, list):
        metrics["rate_pairs"] = metrics.get("rate_pairs", 0) + len(result)


def _observe_executions(metrics: dict[str, Any], result: Any) -> None:
    if not isinstance(result, list):
        return
    metrics["execution_rows"] = metrics.get("execution_rows", 0) + len(result)
    metrics["execution_groups"] = metrics.get("execution_groups", 0) + len({
        (
            row.get("source_hash"),
            row.get("pair_ordinal"),
            row.get("family"),
            row.get("cycle"),
        )
        for row in result
        if isinstance(row, Mapping)
    })


def _observe_blocks(metrics: dict[str, Any], result: Any, family: str) -> None:
    if isinstance(result, list):
        metrics[f"detected_blocks_{family}"] = (
            metrics.get(f"detected_blocks_{family}", 0) + len(result)
        )


def _observe_rate_comparison(metrics: dict[str, Any], result: Any) -> None:
    if isinstance(result, tuple) and len(result) > 1 and isinstance(result[1], Mapping):
        metrics["comparison_points"] = metrics.get("comparison_points", 0) + len(
            result[1].get("points") or []
        )


def _taxonomy_stage_ms(
    recorder: _Recorder,
    family: str,
    rate_profile: Mapping[str, Any] | None,
) -> dict[str, float | None]:
    """Project implementation timers into the common 050.17 taxonomy."""

    rate_stages = rate_profile.get("stages_ms", {}) if rate_profile else {}
    return {
        "route_setup": None,
        "selection_context": recorder.elapsed_ms.get("selection_context")
        or recorder.elapsed_ms.get("resolve_selection"),
        "cache_key": recorder.elapsed_ms.get("cache_key"),
        "exact_cache_lookup": recorder.elapsed_ms.get("exact_cache_lookup"),
        "protocol_reconstruction": recorder.elapsed_ms.get("protocol_reconstruction")
        or rate_stages.get("protocol_reconstruction"),
        "data_access_materialization": recorder.elapsed_ms.get("data_access_materialization")
        or recorder.elapsed_ms.get("load_indexed_time_capacity_raw"),
        "scientific_extraction": recorder.elapsed_ms.get("scientific_compute"),
        "cross_cell_aggregation_comparison": recorder.elapsed_ms.get(
            "cross_cell_aggregation_comparison"
        )
        or recorder.elapsed_ms.get("common_rate_comparison")
        or rate_stages.get("common_rate_comparison"),
        "result_provenance_assembly": recorder.elapsed_ms.get("result_provenance_assembly")
        or rate_stages.get("result_provenance_assembly"),
        "cache_persistence": recorder.elapsed_ms.get("cache_persistence"),
        "json_serialization": recorder.elapsed_ms.get("json_serialization"),
        "response_assembly": recorder.elapsed_ms.get("response_assembly"),
    }


def _request_for(family: str, analyses: Any, recompute: bool, *, profile: bool = False) -> Any:
    if family == "time_capacity":
        return analyses.ComputeRequest(
            recompute=recompute,
            viewport_width=1200,
            precision="full",
            compact=False,
            profile=profile,
            profile_request_id="050.17-profiler",
        )
    return analyses.ComputeRequest(recompute=recompute)


def _profile_route(
    env: GoldenFixtureEnvironment,
    analysis_id: int,
    family: str,
    *,
    recompute: bool,
    cache_root: Path,
    instrumented: bool,
) -> tuple[dict[str, Any], dict[str, Any]]:
    from app.routers import analyses
    from app.services import (
        analysis_cache,
        analysis_engine,
        cache,
        chargeability,
        dcir as dcir_service,
        protocol,
        rate_capability,
        step_blocks,
        stitch,
        time_capacity_path,
        time_capacity_workers,
        time_capacity_profiling,
    )

    recorder = _Recorder()
    metrics: dict[str, Any] = {
        "route_state_requested": "forced_miss" if recompute else "exact_hit",
        "calls": {},
        "counts": {},
        "nested_stages_ms": {},
        "source_hashes": set(),
    }
    route = _route_for(family)
    request = _request_for(family, analyses, recompute)
    rate_profile: dict[str, Any] = {}
    sql_profile = time_capacity_profiling.SQLProfile(env.db) if instrumented else None

    def timed(
        name: str,
        original: Callable[..., Any],
        *,
        parent: str | None = "scientific_compute",
        observe: Callable[[Any], None] | None = None,
    ) -> Callable[..., Any]:
        return recorder.timed(name, original, parent=parent, observe=observe)

    try:
        with ExitStack() as stack:
            stack.enter_context(_analysis_cache_root(cache_root))
            if instrumented:
                key_name = "time_capacity_keys" if family == "time_capacity" else "result_key"
                stack.enter_context(
                    patch.object(
                        analysis_cache,
                        key_name,
                        timed("cache_key", getattr(analysis_cache, key_name), parent=None),
                    )
                )
                stack.enter_context(
                    patch.object(
                        analysis_cache,
                        "load_result_body",
                        timed("exact_cache_lookup", analysis_cache.load_result_body, parent=None),
                    )
                )
                stack.enter_context(
                    patch.object(
                        analysis_cache,
                        "load_result",
                        timed("legacy_cache_lookup", analysis_cache.load_result, parent=None),
                    )
                )
                stack.enter_context(
                    patch.object(
                        analysis_cache,
                        "store_result",
                        timed("cache_persistence", analysis_cache.store_result, parent=None),
                    )
                )
                stack.enter_context(
                    patch.object(
                        analysis_cache,
                        "splice_result_body",
                        timed("response_assembly", analysis_cache.splice_result_body, parent=None),
                    )
                )
                stack.enter_context(
                    patch.object(
                        analyses,
                        "fast_json",
                        timed("json_serialization", analyses.fast_json, parent=None),
                    )
                )
                stack.enter_context(
                    patch.object(
                        analysis_engine,
                        "build_analysis_request_context",
                        timed("selection_context", analysis_engine.build_analysis_request_context, parent=None),
                    )
                )

                for name in (
                    "resolve_selection",
                    "preload_cell_sources",
                    "load_scalar_metadata",
                    "cell_ordered_hashes",
                    "resolve_source_parser_versions",
                ):
                    original = getattr(analysis_engine, name)
                    observer = _observe_source if name == "cell_ordered_hashes" else None
                    if observer is not None:
                        callback = lambda result, observer=observer: observer(metrics, result)
                    else:
                        callback = None
                    stack.enter_context(
                        patch.object(
                            analysis_engine,
                            name,
                            timed(name, original, observe=callback),
                        )
                    )
                stack.enter_context(
                    patch.object(
                        protocol,
                        "reconstruct_protocol",
                        timed(
                            "protocol_reconstruction",
                            protocol.reconstruct_protocol,
                            observe=lambda result: _observe_protocol(metrics, result),
                        ),
                    )
                )
                for name, observer in (
                    ("load_raw", lambda result: _observe_frame(metrics, result)),
                    ("load_raw_columns", lambda result: _observe_frame(metrics, result)),
                    ("load_cycles", lambda result: _observe_frame(metrics, result)),
                    ("load_raw_cycles", lambda result: _observe_frame(metrics, result)),
                    ("load_raw_step_rows", lambda result: _observe_frame(metrics, result, physical=True)),
                ):
                    if hasattr(cache, name):
                        stage = "data_access_materialization"
                        stack.enter_context(
                            patch.object(
                                cache,
                                name,
                                timed(stage, getattr(cache, name), observe=observer),
                            )
                        )
                for name in ("stitch_cycles", "stitch_raw", "stitch_raw_steps"):
                    if hasattr(stitch, name):
                        stack.enter_context(
                            patch.object(
                                stitch,
                                name,
                                timed(
                                    name,
                                    getattr(stitch, name),
                                    observe=lambda result: _observe_stitched(metrics, result),
                                ),
                            )
                        )
                if family == "time_capacity":
                    for module, name in (
                        (time_capacity_path, "load_indexed_time_capacity_raw"),
                        (time_capacity_path, "load_indexed_time_capacity_derived"),
                        (time_capacity_workers, "_build_jobs"),
                    ):
                        if hasattr(module, name):
                            stack.enter_context(
                                patch.object(
                                    module,
                                    name,
                                    timed(name, getattr(module, name), parent="scientific_compute"),
                                )
                            )

                if family == "cycles" and hasattr(analysis_engine, "aggregate_series"):
                    stack.enter_context(
                        patch.object(
                            analysis_engine,
                            "aggregate_series",
                            timed(
                                "cross_cell_aggregation_comparison",
                                analysis_engine.aggregate_series,
                            ),
                        )
                    )

                family_helpers: list[tuple[Any, str, str]] = []
                if family == "cycles":
                    family_helpers.append(
                        (analysis_engine, "cell_metrics", "cycle_scientific_extraction")
                    )
                elif family == "steps":
                    family_helpers.append(
                        (step_blocks, "per_block", "step_block_extraction")
                    )
                elif family == "dcir":
                    family_helpers.append(
                        (dcir_service, "per_occurrence", "dcir_occurrence_extraction")
                    )
                elif family == "chargeability":
                    family_helpers.extend(
                        [
                            (
                                chargeability,
                                "detect_candidates",
                                "chargeability_candidate_detection",
                            ),
                            (
                                chargeability,
                                "_occurrence_rows",
                                "chargeability_occurrence_extraction",
                            ),
                        ]
                    )
                for module, name, stage in family_helpers:
                    if hasattr(module, name):
                        stack.enter_context(
                            patch.object(
                                module,
                                name,
                                timed(stage, getattr(module, name)),
                            )
                        )

                compute_module: Any
                compute_name: str
                if family == "cycles":
                    compute_module, compute_name = analysis_engine, "compute"
                elif family == "time_capacity":
                    compute_module, compute_name = analysis_engine, "compute_time_capacity"
                elif family == "steps":
                    compute_module, compute_name = analysis_engine, "compute_steps"
                elif family == "dcir":
                    compute_module, compute_name = analysis_engine, "compute_dcir"
                elif family == "chargeability":
                    compute_module, compute_name = chargeability, "compute"
                else:
                    compute_module, compute_name = rate_capability, "compute"
                original_compute = getattr(compute_module, compute_name)
                if family == "rate_capability":
                    def call_rate(*args: Any, **kwargs: Any) -> Any:
                        kwargs["profiling"] = rate_profile
                        return original_compute(*args, **kwargs)

                    compute_wrapper = timed(
                        "scientific_compute",
                        call_rate,
                        parent=None,
                    )
                else:
                    compute_wrapper = timed(
                        "scientific_compute",
                        original_compute,
                        parent=None,
                    )
                stack.enter_context(patch.object(compute_module, compute_name, compute_wrapper))

                if family == "rate_capability":
                    for name, observer in (
                        ("build_rate_pairs", _observe_rate_pairs),
                        ("extract_pair_executions", _observe_executions),
                    ):
                        if hasattr(rate_capability, name):
                            stage = {
                                "build_rate_pairs": "rate_pair_building",
                                "extract_pair_executions": "execution_extraction",
                            }[name]
                            callback = (
                                lambda result, observer=observer: observer(metrics, result)
                                if observer is not None
                                else None
                            )
                            stack.enter_context(
                                patch.object(
                                    rate_capability,
                                    name,
                                    timed(stage, getattr(rate_capability, name), observe=callback),
                                )
                            )
                    original_detect = rate_capability.detect_sweep_blocks

                    def detect_wrapper(*args: Any, **kwargs: Any) -> Any:
                        family_name = str(args[1]) if len(args) > 1 else str(kwargs.get("family"))
                        with recorder.span(
                            f"sweep_detection_{family_name}",
                            parent="scientific_compute",
                        ):
                            result = original_detect(*args, **kwargs)
                        _observe_blocks(metrics, result, family_name)
                        return result

                    stack.enter_context(
                        patch.object(
                            rate_capability,
                            "detect_sweep_blocks",
                            detect_wrapper,
                        )
                    )

            started = perf_counter()
            response = route(analysis_id, request, env.db)
            metrics["complete_route_ms"] = (perf_counter() - started) * 1000.0
            metrics["body_bytes"] = len(response.body or b"")
    finally:
        if sql_profile is not None:
            sql_profile.finish(metrics)

    payload = json.loads(response.body)
    metrics["cache_status"] = payload.get("cache_status")
    metrics["scientific_digest"] = _digest(payload)
    metrics["series_order"] = _series_order(payload)
    metrics["counts"].update(_response_counts(payload, family))
    metrics["counts"]["cells"] = metrics["counts"].get("resolved_cells")
    metrics["counts"]["source_files"] = metrics["counts"].get("source_files") or len(
        metrics.get("source_hashes", set())
    )
    metrics["counts"]["source_hashes"] = len(metrics.get("source_hashes", set()))
    metrics["counts"]["raw_rows_loaded"] = metrics.get("raw_rows_loaded", 0)
    metrics["counts"]["raw_rows_returned"] = metrics.get("raw_rows_returned", 0)
    metrics["counts"]["raw_rows_read_physical"] = metrics.get("raw_rows_read_physical", 0)
    metrics["counts"]["raw_row_groups_read"] = metrics.get("raw_row_groups_read", 0)
    metrics["counts"]["raw_load_calls"] = metrics.get("raw_load_calls", 0)
    metrics["nested_stages_ms"] = dict(sorted(recorder.elapsed_ms.items()))
    metrics["stage_hierarchy"] = recorder.hierarchy()
    metrics["calls"] = dict(sorted(recorder.calls.items()))
    metrics["root_stage_ms"] = {
        name: recorder.elapsed_ms.get(name)
        for name in sorted(ROOT_STAGES)
        if name in recorder.elapsed_ms
    }
    metrics["reconciliation"] = _reconcile_root_stages(
        float(metrics["complete_route_ms"]), metrics["root_stage_ms"]
    )
    metrics["rate_deep"] = rate_profile or None
    metrics["taxonomy_stage_ms"] = _taxonomy_stage_ms(recorder, family, rate_profile)
    metrics["source_hashes"] = sorted(metrics.get("source_hashes", set()))
    return payload, metrics


def _profile_route_simple(
    env: GoldenFixtureEnvironment,
    analysis_id: int,
    family: str,
    *,
    recompute: bool,
    cache_root: Path,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Unprofiled control with the same route/cache state."""

    from app.routers import analyses

    route = _route_for(family)
    request = _request_for(family, analyses, recompute)
    with _analysis_cache_root(cache_root):
        started = perf_counter()
        response = route(analysis_id, request, env.db)
        elapsed = (perf_counter() - started) * 1000.0
    payload = json.loads(response.body)
    return payload, {
        "complete_route_ms": elapsed,
        "body_bytes": len(response.body or b""),
        "cache_status": payload.get("cache_status"),
        "scientific_digest": _digest(payload),
        "series_order": _series_order(payload),
    }


def _family_workload(
    env: GoldenFixtureEnvironment,
    family: str,
    count: int,
) -> tuple[int, list[int]]:
    case_id, source_cell_id = FAMILY_CASES[family]
    case = _case(env.manifest, case_id)
    if count == 1:
        cell_ids = [source_cell_id]
    else:
        cell_ids = _clone_cells(env, family, source_cell_id, count)
    spec = _scaled_spec(load_case_spec(env.root, case), family, cell_ids)
    from app.models import Analysis

    analysis = Analysis(title=f"050.17 profiler {family} {count}", spec=spec)
    env.db.add(analysis)
    env.db.commit()
    return analysis.id, cell_ids


def _sql_summary(samples: list[Mapping[str, Any]]) -> dict[str, Any]:
    profiles = [
        sample.get("sql")
        for sample in samples
        if isinstance(sample.get("sql"), Mapping)
    ]
    kinds = sorted({
        str(kind)
        for profile in profiles
        for kind in (profile.get("statements_by_kind") or {})
    })

    def metric(name: str) -> dict[str, Any]:
        values = [
            float(profile.get(name))
            for profile in profiles
            if isinstance(profile.get(name), (int, float))
            and not isinstance(profile.get(name), bool)
        ]
        return {
            "samples": values,
            "p50": _median(values),
        }

    return {
        "available": bool(profiles),
        "sample_count": len(profiles),
        "statement_count": metric("statement_count"),
        "cumulative_sql_ms": metric("cumulative_sql_ms"),
        "source_header_lazy_loads": metric("source_header_lazy_loads"),
        "statements_by_kind_p50": {
            kind: _median([
                float((profile.get("statements_by_kind") or {}).get(kind, 0))
                for profile in profiles
            ])
            for kind in kinds
        },
    }


def _summarize_samples(samples: list[dict[str, Any]], family: str) -> dict[str, Any]:
    total = [float(sample["complete_route_ms"]) for sample in samples]
    p50_total = _median(total)
    stage_names = set(COMMON_STAGES)
    stage_names.update(
        name
        for sample in samples
        for name in sample.get("root_stage_ms", {})
    )
    nested_names = {
        name
        for sample in samples
        for name in sample.get("nested_stages_ms", {})
    }
    nested_names.update(
        name
        for sample in samples
        for name in sample.get("stage_hierarchy", {})
    )
    stages = {}
    for name in sorted(stage_names):
        values = [
            float(sample["taxonomy_stage_ms"][name])
            for sample in samples
            if isinstance(sample.get("taxonomy_stage_ms", {}).get(name), (int, float))
        ]
        calls = [sample.get("calls", {}).get(name, 0) for sample in samples]
        stages[name] = {
            "ms": _median(values),
            "share_of_route": (
                _median(values) / p50_total
                if values and p50_total and p50_total > 0
                else None
            ),
            "calls_p50": _median([float(value) for value in calls]),
            "available": bool(values),
            "parent": None,
        }
    nested = {}
    for name in sorted(nested_names):
        values = [
            float(sample["nested_stages_ms"][name])
            for sample in samples
            if isinstance(sample.get("nested_stages_ms", {}).get(name), (int, float))
        ]
        hierarchy_records = [
            sample.get("stage_hierarchy", {}).get(name)
            for sample in samples
            if isinstance(sample.get("stage_hierarchy", {}).get(name), Mapping)
        ]
        inclusive_values = [
            float(record["inclusive_ms"])
            for record in hierarchy_records
            if isinstance(record.get("inclusive_ms"), (int, float))
        ]
        if not inclusive_values:
            inclusive_values = values
        exclusive_values = [
            float(record["exclusive_ms"])
            for record in hierarchy_records
            if isinstance(record.get("exclusive_ms"), (int, float))
        ]
        parents = {
            record.get("parent")
            for record in hierarchy_records
            if "parent" in record
        }
        nested[name] = {
            "ms": _median(inclusive_values),
            "share_of_route": (
                _median(inclusive_values) / p50_total
                if inclusive_values and p50_total and p50_total > 0
                else None
            ),
            "calls_p50": _median([
                float(sample.get("calls", {}).get(name, 0)) for sample in samples
            ]),
            "available": bool(inclusive_values),
            "inclusive_ms": _median(inclusive_values),
            "exclusive_ms": _median(exclusive_values) if exclusive_values else None,
            "parent": next(iter(parents)) if len(parents) == 1 else None,
            "parents": sorted(
                parents,
                key=lambda value: (value is not None, value or ""),
            ),
        }
    count_names = {
        name
        for sample in samples
        for name in sample.get("counts", {})
    }
    counts = {
        name: _metric_p50(samples, name)
        for name in sorted(count_names)
    }
    reconciliations = [sample["reconciliation"] for sample in samples]
    return {
        "complete_route_ms": {
            "samples": total,
            "p50": p50_total,
            "min": min(total) if total else None,
            "max": max(total) if total else None,
        },
        "response_bytes": _numeric_summary(samples, "body_bytes"),
        "stages": stages,
        "outer_stages_ms": stages,
        "nested_stages_ms": nested,
        "stage_hierarchy": nested,
        "reconciliation": {
            "p50_route_ms": _median([float(item["route_ms"]) for item in reconciliations]),
            "p50_root_stage_sum_ms": _median([
                float(item["root_stage_sum_ms"]) for item in reconciliations
            ]),
            "p50_unattributed_residual_ms": _median([
                float(item["unattributed_residual_ms"]) for item in reconciliations
            ]),
            "p50_root_overlap_ms": _median([
                float(item.get("root_overlap_ms", 0.0)) for item in reconciliations
            ]),
            "all_within_root_hierarchy": all(
                bool(item["within_root_hierarchy"]) for item in reconciliations
            ),
        },
        "sql": _sql_summary(samples),
        "counts": counts,
        "scientific_digests": sorted({sample["scientific_digest"] for sample in samples}),
        "series_order": samples[0].get("series_order", []) if samples else [],
        "cache_statuses": sorted({sample.get("cache_status") for sample in samples}),
        "samples": samples,
        "frontend": {
            "status": "NOT RUN",
            "reason": "Browser/Plotly timing was excluded by explicit user instruction.",
            "trace_count": counts.get("trace_count"),
            "point_count": counts.get("final_response_points"),
            "json_parse_ms": None,
        },
    }


RATE_EXECUTION_CHILDREN = (
    "measurement_filtering_grouping",
    "execution_phase_row_filtering",
    "execution_cutoff_validation",
    "capacity_extraction",
    "current_extraction",
    "rate_normalization",
)


def _rate_deep_summary(samples: list[dict[str, Any]]) -> dict[str, Any] | None:
    profiles = [sample.get("rate_deep") for sample in samples if sample.get("rate_deep")]
    if not profiles:
        return None

    def stage_record(name: str) -> dict[str, Any]:
        values = [
            float(profile.get("stages_ms", {}).get(name, 0.0))
            for profile in profiles
            if isinstance(profile.get("stages_ms", {}).get(name), (int, float))
        ]
        calls = [
            float(profile.get("calls", {}).get(name, 0))
            for profile in profiles
        ]
        return {
            "p50": _median(values),
            "calls_p50": _median(calls),
            "available": bool(values),
            "parent": "execution_extraction" if name in RATE_EXECUTION_CHILDREN else (
                "scientific_compute" if name in {
                    "protocol_reconstruction",
                    "rate_pair_building",
                    "execution_extraction",
                    "sweep_detection_charge",
                    "sweep_detection_discharge",
                    "candidate_selection_and_selected_rate_filtering",
                    "common_rate_comparison",
                    "invalid_neighbour_execution_validation",
                    "result_provenance_assembly",
                }
                else None
            ),
        }

    stage_names = {
        name for profile in profiles for name in profile.get("stages_ms", {})
    }
    count_names = {name for profile in profiles for name in profile.get("counts", {})}
    stages = {name: stage_record(name) for name in sorted(stage_names)}

    reconciliation_samples = []
    for profile in profiles:
        stage_ms = profile.get("stages_ms", {})
        parent_ms = stage_ms.get("execution_extraction")
        child_sum = sum(
            float(stage_ms.get(name, 0.0))
            for name in RATE_EXECUTION_CHILDREN
            if isinstance(stage_ms.get(name), (int, float))
        )
        parent = float(parent_ms) if isinstance(parent_ms, (int, float)) else 0.0
        reconciliation_samples.append({
            "execution_extraction_ms": parent,
            "child_sum_ms": child_sum,
            "residual_ms": max(0.0, parent - child_sum),
            "overlap_ms": max(0.0, child_sum - parent),
        })

    def common_stage(name: str) -> dict[str, Any]:
        values = [
            float(sample.get("taxonomy_stage_ms", {}).get(name))
            for sample in samples
            if isinstance(sample.get("taxonomy_stage_ms", {}).get(name), (int, float))
        ]
        return {"p50_ms": _median(values), "available": bool(values)}

    required_names = (
        "protocol_reconstruction",
        "rate_pair_building",
        "execution_extraction",
        *RATE_EXECUTION_CHILDREN,
        "sweep_detection_charge",
        "sweep_detection_discharge",
        "candidate_selection_and_selected_rate_filtering",
        "common_rate_comparison",
        "invalid_neighbour_execution_validation",
        "result_provenance_assembly",
    )
    required_decomposition = {
        name: {
            "p50_ms": stages.get(name, {}).get("p50"),
            "calls_p50": stages.get(name, {}).get("calls_p50"),
            "available": stages.get(name, {}).get("available", False),
        }
        for name in required_names
    }
    required_decomposition["owner_context_scalar_resolution"] = common_stage(
        "selection_context"
    )
    required_decomposition["raw_materialization"] = common_stage(
        "data_access_materialization"
    )
    required_decomposition["cache_persistence_serialization"] = {
        "cache_persistence": common_stage("cache_persistence"),
        "json_serialization": common_stage("json_serialization"),
        "response_assembly": common_stage("response_assembly"),
    }
    return {
        "stages_ms": stages,
        "counts": {
            name: _median([
                float(profile.get("counts", {}).get(name, 0))
                for profile in profiles
            ])
            for name in sorted(count_names)
        },
        "execution_children": list(RATE_EXECUTION_CHILDREN),
        "execution_extraction_reconciliation": {
            "samples": reconciliation_samples,
            "p50_execution_extraction_ms": _median([
                item["execution_extraction_ms"] for item in reconciliation_samples
            ]),
            "p50_child_sum_ms": _median([
                item["child_sum_ms"] for item in reconciliation_samples
            ]),
            "p50_residual_ms": _median([
                item["residual_ms"] for item in reconciliation_samples
            ]),
            "p50_overlap_ms": _median([
                item["overlap_ms"] for item in reconciliation_samples
            ]),
            "all_non_overlapping": all(
                item["overlap_ms"] <= 1.0 for item in reconciliation_samples
            ),
        },
        "required_decomposition": required_decomposition,
    }


def _time_specialist_profile(
    env: GoldenFixtureEnvironment,
    analysis_id: int,
    cache_root: Path,
) -> dict[str, Any] | None:
    """Capture the existing opt-in Time/Capacity diagnostics once per workload."""

    from app.routers import analyses

    with _analysis_cache_root(cache_root):
        response = _route_for("time_capacity")(
            analysis_id,
            _request_for("time_capacity", analyses, True, profile=True),
            env.db,
        )
    payload = json.loads(response.body)
    profile = payload.get("profiling")
    return dict(profile) if isinstance(profile, Mapping) else None


def _run_workload(
    env: GoldenFixtureEnvironment,
    family: str,
    count: int,
    *,
    repetitions: int,
    measure_overhead: bool,
    time_specialist: bool,
) -> dict[str, Any]:
    analysis_id, cell_ids = _family_workload(env, family, count)
    misses: list[dict[str, Any]] = []
    hits: list[dict[str, Any]] = []
    overhead: list[dict[str, Any]] = []
    parity: list[bool] = []
    hit_controls: list[dict[str, Any]] = []

    for repetition in range(repetitions):
        with tempfile.TemporaryDirectory(prefix=f"cellxplorer-05017-{family}-miss-") as root:
            payload, metrics = _profile_route(
                env,
                analysis_id,
                family,
                recompute=True,
                cache_root=Path(root),
                instrumented=True,
            )
            metrics["repetition"] = repetition + 1
            misses.append(metrics)
        if measure_overhead:
            with tempfile.TemporaryDirectory(prefix=f"cellxplorer-05017-{family}-control-") as root:
                _control_payload, control = _profile_route_simple(
                    env,
                    analysis_id,
                    family,
                    recompute=True,
                    cache_root=Path(root),
                )
            overhead.append({
                "repetition": repetition + 1,
                "profiled_ms": metrics["complete_route_ms"],
                "unprofiled_ms": control["complete_route_ms"],
                "delta_ms": metrics["complete_route_ms"] - control["complete_route_ms"],
                "delta_fraction": (
                    metrics["complete_route_ms"] / control["complete_route_ms"] - 1.0
                    if control["complete_route_ms"]
                    else None
                ),
                "scientific_parity": metrics["scientific_digest"] == _digest(_control_payload),
                "order_parity": metrics["series_order"] == control["series_order"],
            })

        with tempfile.TemporaryDirectory(prefix=f"cellxplorer-05017-{family}-hit-") as root:
            cache_root = Path(root)
            warm_payload, warm = _profile_route_simple(
                env,
                analysis_id,
                family,
                recompute=True,
                cache_root=cache_root,
            )
            hit_payload, hit = _profile_route(
                env,
                analysis_id,
                family,
                recompute=False,
                cache_root=cache_root,
                instrumented=True,
            )
            hit["repetition"] = repetition + 1
            hits.append(hit)
            hit_controls.append({
                "repetition": repetition + 1,
                "cache_status": hit.get("cache_status"),
                "scientific_compute_calls": hit.get("calls", {}).get("scientific_compute", 0),
                "raw_load_calls": hit.get("counts", {}).get("raw_load_calls", 0),
                "exact_hit_contract": _exact_hit_is_clean(hit),
            })
            parity.append(
                warm["scientific_digest"] == hit["scientific_digest"]
                and warm["series_order"] == hit["series_order"]
                and _digest(warm_payload) == _digest(hit_payload)
            )

    specialist = None
    if family == "time_capacity" and time_specialist:
        with tempfile.TemporaryDirectory(prefix="cellxplorer-05017-time-specialist-") as root:
            specialist = _time_specialist_profile(env, analysis_id, Path(root))

    miss_summary = _summarize_samples(misses, family)
    hit_summary = _summarize_samples(hits, family)
    return {
        "family": family,
        "cell_count": len(cell_ids),
        "cell_ids": cell_ids,
        "workload_source": (
            "committed_golden_fixture"
            if len(cell_ids) == 1
            else "source_distinct_content_identical_fixture_clones"
        ),
        "route_options": (
            {"viewport_width": 1200, "precision": "full", "compact": False}
            if family == "time_capacity"
            else {"recompute": True}
        ),
        "forced_miss": miss_summary,
        "exact_persisted_hit": hit_summary,
        "exact_hit_controls": hit_controls,
        "miss_hit_scientific_order_parity": all(parity),
        "profiler_overhead": {
            "samples": overhead,
            "p50_delta_ms": _median([item["delta_ms"] for item in overhead]) if overhead else None,
            "p50_delta_fraction": _median([
                item["delta_fraction"]
                for item in overhead
                if item.get("delta_fraction") is not None
            ]) if overhead else None,
            "all_scientific_parity": all(item["scientific_parity"] for item in overhead) if overhead else None,
            "all_order_parity": all(item["order_parity"] for item in overhead) if overhead else None,
        },
        "specialist_time_capacity_profile": specialist,
        "rate_deep": _rate_deep_summary(misses) if family == "rate_capability" else None,
    }


def _stage_inclusive_ms(record: Mapping[str, Any]) -> float | None:
    for key in ("inclusive_ms", "ms", "p50"):
        value = record.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return float(value)
    return None


def _scientific_attribution(
    summary: Mapping[str, Any],
) -> dict[str, Any]:
    hierarchy = summary.get("stage_hierarchy") or summary.get("nested_stages_ms") or {}
    if not isinstance(hierarchy, Mapping):
        return {
            "scientific_ms": None,
            "children": {},
            "child_sum_ms": None,
            "residual_ms": None,
            "overlap_ms": None,
            "status": "unresolved",
        }
    scientific_record = hierarchy.get("scientific_compute")
    scientific_ms = (
        _stage_inclusive_ms(scientific_record)
        if isinstance(scientific_record, Mapping)
        else None
    )
    children = {
        str(name): _stage_inclusive_ms(record)
        for name, record in hierarchy.items()
        if isinstance(record, Mapping)
        and record.get("parent") == "scientific_compute"
        and name != "scientific_compute"
        and _stage_inclusive_ms(record) is not None
    }
    child_sum = sum(children.values()) if children else 0.0
    residual = (
        max(0.0, scientific_ms - child_sum)
        if scientific_ms is not None
        else None
    )
    overlap = (
        max(0.0, child_sum - scientific_ms)
        if scientific_ms is not None
        else None
    )
    status = "unresolved"
    if scientific_ms is not None and children:
        status = (
            "unresolved"
            if residual is not None and residual > max(children.values())
            else "resolved"
        )
    return {
        "scientific_ms": scientific_ms,
        "children": children,
        "child_sum_ms": child_sum,
        "residual_ms": residual,
        "overlap_ms": overlap,
        "status": status,
    }


def _dominant_stage(workload: Mapping[str, Any]) -> tuple[str, float | None]:
    summary = workload.get("forced_miss") or {}
    family = workload.get("family")
    attribution = _scientific_attribution(summary)

    if family == "time_capacity":
        specialist = workload.get("specialist_time_capacity_profile") or {}
        candidates = [
            (f"time_capacity.{name}", float(value))
            for name, value in (specialist.get("backend_stages_ms") or {}).items()
            if isinstance(value, (int, float))
        ]
        return max(candidates, key=lambda item: item[1]) if candidates else (
            "unresolved scientific compute residual",
            None,
        )

    if family == "rate_capability":
        deep = workload.get("rate_deep") or {}
        candidates = [
            (name, float(value["p50"]))
            for name, value in (deep.get("stages_ms") or {}).items()
            if isinstance(value, Mapping)
            and value.get("parent") == "scientific_compute"
            and isinstance(value.get("p50"), (int, float))
        ]
        if candidates:
            return max(candidates, key=lambda item: item[1])
        return "unresolved scientific compute residual", attribution.get("residual_ms")

    children = [
        (name, value)
        for name, value in attribution["children"].items()
        if value is not None
    ]
    if not children or attribution["scientific_ms"] is None:
        return "unresolved scientific compute residual", attribution.get("residual_ms")
    dominant = max(children, key=lambda item: float(item[1]))
    residual = float(attribution["residual_ms"] or 0.0)
    if residual > float(dominant[1]):
        return "unresolved scientific compute residual", residual
    return dominant


def _priority_table(families: Mapping[str, Mapping[str, Any]]) -> list[dict[str, Any]]:
    rows = []
    for family in FAMILIES:
        family_record = families.get(family) or {}
        workloads = {
            int(item["cell_count"]): item
            for item in family_record.get("workloads", [])
        }
        one = workloads.get(1, {}).get("forced_miss", {}).get("complete_route_ms", {}).get("p50")
        six = workloads.get(6, {}).get("forced_miss", {}).get("complete_route_ms", {}).get("p50")
        hit = workloads.get(6, {}).get("exact_persisted_hit", {}).get("complete_route_ms", {}).get("p50")
        representative = float(six or 0.0)
        band = "Critical" if representative >= 1000 else "High" if representative >= 300 else "Medium" if representative >= 150 else "Low"
        stage, stage_ms = _dominant_stage(workloads.get(6, {}))
        share = stage_ms / representative if stage_ms is not None and representative > 0 else None
        attribution = _scientific_attribution(workloads.get(6, {}).get("forced_miss") or {})
        unresolved = stage.startswith("unresolved")
        if stage_ms is None or unresolved:
            next_action = "More focused profiling before choosing an optimization"
        else:
            next_action = f"Rank a narrow follow-up at {stage}"
        rows.append({
            "family": family,
            "one_cell_miss_p50_ms": one,
            "six_cell_miss_p50_ms": six,
            "exact_hit_p50_ms": hit,
            "dominant_stage": stage,
            "dominant_ms": stage_ms,
            "dominant_share": share,
            "scientific_attribution": attribution,
            "attribution_status": "unresolved" if unresolved else attribution.get("status"),
            "priority_band": band,
            "scaling_observation": (
                "unavailable" if not one or not six else
                "approximately linear operational growth" if 4.0 <= six / one <= 8.0 else
                "sublinear operational growth" if six / one < 4.0 else
                "superlinear operational growth"
            ),
            "frontend_status": "NOT RUN",
            "next_action": next_action,
            "recommendation_boundary": stage,
            "optimization_ceiling_if_stage_removed_ms": (
                max(0.0, representative - stage_ms)
                if stage_ms is not None and not unresolved
                else None
            ),
            "optimization_scope_note": "Hypothesis only; no optimization is implemented in 050.17.",
        })
    return sorted(rows, key=lambda item: (FAMILIES.index(item["family"]), item["family"]))


def _environment() -> dict[str, Any]:
    def version(package: str) -> str | None:
        try:
            return importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            return None

    return {
        "platform": platform.platform(),
        "python": platform.python_version(),
        "pandas": version("pandas"),
        "numpy": version("numpy"),
        "pyarrow": version("pyarrow"),
        "logical_cpus": os.cpu_count(),
        "worker_mode": "current production route; Time/Capacity specialist profile also records its mode",
        "mains_battery": "not exposed by profiler environment",
        "browser_plotly": "NOT RUN by explicit user instruction",
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--families",
        nargs="+",
        choices=AVAILABLE_FAMILIES,
        default=list(FAMILIES),
        help="Five-family authoritative matrix by default; time_capacity is reference-only.",
    )
    parser.add_argument("--repetitions", type=int, default=REPETITIONS, choices=range(1, 6))
    parser.add_argument("--output", type=Path)
    parser.add_argument("--skip-overhead", action="store_true")
    parser.add_argument("--skip-time-specialist", action="store_true")
    args = parser.parse_args()

    started = perf_counter()
    result: dict[str, Any] = {
        "spec": "050.17",
        "commit": os.popen("git rev-parse HEAD").read().strip(),
        "environment": _environment(),
        "repetitions": args.repetitions,
        "browser_status": "NOT RUN",
        "scope": {
            "authoritative_families": list(FAMILIES),
            "reference_only_families": list(REFERENCE_FAMILIES),
            "time_capacity_default": "excluded from the 050.17 matrix and priority ranking",
        },
        "families": {},
    }
    try:
        with GoldenFixtureEnvironment.create() as env:
            result["fixture_root"] = str(env.root)
            for family in args.families:
                result["families"][family] = {
                    "workloads": [
                        _run_workload(
                            env,
                            family,
                            count,
                            repetitions=args.repetitions,
                            measure_overhead=not args.skip_overhead,
                            time_specialist=not args.skip_time_specialist,
                        )
                        for count in (1, 6)
                    ]
                }
            result["priority_table"] = _priority_table(result["families"])
    finally:
        try:
            from app.services import time_capacity_workers

            time_capacity_workers.shutdown_time_capacity_worker_pool()
        except Exception:
            pass
    result["elapsed_ms"] = (perf_counter() - started) * 1000.0
    encoded = json.dumps(result, indent=2, sort_keys=True, default=str) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded, encoding="utf-8")
    print(encoded, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
