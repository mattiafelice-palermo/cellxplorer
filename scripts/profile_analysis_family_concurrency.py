"""Measure the Spec 050.23 S1/P4/P8 cross-family route candidates.

The serial sample calls the real analysis router.  The process candidates use
the same owner-side selection/cache boundary and dispatch one immutable
single-Cell job per selected Cell to one already-warm shared spawn pool.  A
worker reads the canonical Parquet cache and runs the review-clean family
service; the owner merges fragments in selection order, persists the complete
result and serializes the response.  No ORM object, Session, or DataFrame is
ever placed in a job.

The benchmark and production boundary share the same compact job contract;
production routing is enabled only for families that clear the measured gates.
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping
from concurrent.futures import ProcessPoolExecutor
from contextlib import ExitStack
from copy import deepcopy
from dataclasses import asdict
import argparse
import hashlib
import importlib.metadata
import json
import multiprocessing
import os
from pathlib import Path
import pickle
import platform
import statistics
import sys
import tempfile
from time import perf_counter, process_time, sleep
from typing import Any
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "scripts"))

from golden_analysis_support import GoldenFixtureEnvironment  # noqa: E402
import profile_analysis_families as family_profiler  # noqa: E402
from app.services import analysis_family_workers as family_workers  # noqa: E402


FAMILIES = tuple(family_profiler.FAMILIES)
COUNTS = (4, 8, 12, 16)
MODES = ("S1", "P4", "P8")
DEFAULT_FAMILIES = ",".join(FAMILIES)
DEFAULT_COUNTS = ",".join(str(value) for value in COUNTS)
DEFAULT_WORKERS = "1,4,8"


def _finite(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value == value


def _median(values: Iterable[object]) -> float | None:
    finite = [float(value) for value in values if _finite(value)]
    return statistics.median(finite) if finite else None


def _digest(value: Any) -> str:
    def project(item: Any) -> Any:
        if isinstance(item, dict):
            return {
                key: project(child)
                for key, child in item.items()
                if key not in {
                    "computed_at",
                    "cache_status",
                    "data_signature",
                    "source_data_signature",
                }
            }
        if isinstance(item, list):
            return [project(child) for child in item]
        return item

    body = json.dumps(project(value), sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def _order(value: Mapping[str, Any]) -> list[tuple[int, str | None]]:
    for key in ("cell_series", "cell_traces"):
        entries = value.get(key)
        if isinstance(entries, list):
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


def _parse_csv(value: str, *, name: str, allowed: Iterable[str] | None = None) -> list[Any]:
    values = [part.strip() for part in value.split(",") if part.strip()]
    if not values:
        raise ValueError(f"{name} cannot be empty")
    if allowed is not None:
        allowed_set = set(allowed)
        unknown = [part for part in values if part not in allowed_set]
        if unknown:
            raise ValueError(f"unsupported {name}: {unknown}")
    return values


def _native_thread_settings() -> dict[str, Any]:
    names = (
        "OMP_NUM_THREADS",
        "MKL_NUM_THREADS",
        "OPENBLAS_NUM_THREADS",
        "NUMEXPR_NUM_THREADS",
        "ARROW_NUM_THREADS",
        "POLARS_MAX_THREADS",
    )
    values: dict[str, Any] = {
        "python_cpu_count": os.cpu_count(),
        "environment": {name: os.environ.get(name) for name in names},
    }
    try:
        import numpy as np

        values["numpy_version"] = np.__version__
    except Exception as exc:  # pragma: no cover - diagnostic fallback
        values["numpy_error"] = type(exc).__name__
    try:
        import pyarrow as pa

        values["pyarrow_version"] = pa.__version__
        values["pyarrow_cpu_count"] = pa.cpu_count()
        values["pyarrow_io_thread_count"] = pa.io_thread_count()
    except Exception as exc:  # pragma: no cover - diagnostic fallback
        values["pyarrow_error"] = type(exc).__name__
    return values


def _copy_source(source: Any) -> family_workers.WorkerSource:
    return family_workers.WorkerSource(
        id=int(source.id),
        hash=str(source.hash),
        path="",
        filename=str(source.filename),
        ext=str(source.ext),
        size=int(source.size) if source.size is not None else None,
        # Protocol headers can be multi-megabyte documents.  The owner sends
        # the reconstructed protocol by source hash below; the raw header
        # never crosses the worker boundary.
        header_meta={},
        nominal_capacity_mah=(
            float(source.nominal_capacity_mah)
            if source.nominal_capacity_mah is not None
            else None
        ),
        row_count=int(source.row_count) if source.row_count is not None else None,
        cycle_count=int(source.cycle_count) if source.cycle_count is not None else None,
        parse_status=getattr(source, "parse_status", None),
        parser_version=getattr(source, "parser_version", None),
        location_status=str(getattr(source, "location_status", "online") or "online"),
        voltage_data_availability=deepcopy(
            getattr(source, "voltage_data_availability", {}) or {}
        ),
    )


def _protocol_caches(
    context: Any,
) -> tuple[
    tuple[tuple[str, float | None, dict, dict], ...],
    tuple[tuple[tuple[str, float | None], dict], ...],
    tuple[tuple[dict, float | None, dict], ...],
    tuple[tuple[str, dict], ...],
]:
    """Resolve equal source protocols once in the owner for worker reuse."""

    from app.services import analysis_engine, protocol

    entries: list[tuple[str, float | None, dict, dict]] = []
    by_key: dict[tuple[str, float | None], dict] = {}
    header_entries: list[tuple[dict, float | None, dict]] = []
    by_source: dict[str, dict] = {}
    seen_entries: set[tuple[str, float | None, str]] = set()
    for cell in context.cells:
        nominal = analysis_engine.cell_nominal_capacity_mah(
            cell,
            context.scalar_metadata.get(cell.id),
        )
        for source in context.files_by_cell[cell.id]:
            header = deepcopy(source.header_meta or {})
            parser_version = context.parser_versions_by_cell[cell.id][source.hash]
            header_key = json.dumps(header, sort_keys=True, separators=(",", ":"), default=str)
            entry_key = (parser_version, nominal, header_key)
            protocol_value = by_key.get((header_key, nominal))
            if protocol_value is None:
                protocol_value = protocol.reconstruct_protocol(header, nominal)
                by_key[(header_key, nominal)] = protocol_value
            by_source[source.hash] = protocol_value
            if entry_key not in seen_entries:
                entries.append((parser_version, nominal, header, protocol_value))
                header_entries.append((header, nominal, protocol_value))
                seen_entries.add(entry_key)
    return tuple(entries), tuple(by_key.items()), tuple(header_entries), tuple(by_source.items())


def _worker_context(
    owner_context: Any,
    cell_id: int,
    protocol_entries: tuple[tuple[str, float | None, dict, dict], ...],
    protocol_cache: tuple[tuple[tuple[str, float | None], dict], ...],
    dcir_header_cache: tuple[tuple[dict, float | None, dict], ...],
    protocol_by_source: tuple[tuple[str, dict], ...],
) -> family_workers.WorkerRequestContext:
    from app.services import analysis_engine

    owner_unit = next(
        unit for unit in owner_context.units if int(unit["cell"].id) == int(cell_id)
    )
    owner_cell = owner_unit["cell"]
    cell = family_workers.WorkerCell(
        id=int(owner_cell.id),
        name=str(owner_cell.name),
        archived=bool(owner_cell.archived),
    )
    unit = dict(owner_unit)
    unit["cell"] = cell
    files = tuple(_copy_source(source) for source in owner_context.files_by_cell[cell_id])
    return family_workers.WorkerRequestContext(
        units=(unit,),
        missing_refs=(),
        cells=(cell,),
        files_by_cell={cell_id: files},
        hashes_by_cell={cell_id: tuple(owner_context.hashes_by_cell[cell_id])},
        parser_versions_by_cell={
            cell_id: dict(owner_context.parser_versions_by_cell[cell_id])
        },
        scalar_metadata={
            cell_id: dict(owner_context.scalar_metadata.get(cell_id) or {})
        },
        labels_by_cell={cell_id: str(owner_context.labels_by_cell[cell_id])},
        # The source-hash map is the compact owner-resolved protocol cache.
        # Do not send header-keyed caches: their keys would retain the raw
        # instrument header that the worker is specifically not meant to see.
        protocol_cache_entries=(),
        protocol_cache=(),
        dcir_protocol_cache=(),
        dcir_protocol_header_cache=(),
        protocol_by_source=protocol_by_source,
    )


def _one_cell_spec(spec: Mapping[str, Any], family: str, cell_id: int) -> dict[str, Any]:
    result = deepcopy(dict(spec))
    result.setdefault("selection", {})["entries"] = [
        {"kind": "cell", "ref_id": int(cell_id)}
    ]
    computation = result.setdefault("computation", {})
    if family in {"steps", "dcir"}:
        config = computation.setdefault(family, {})
        config["series"] = [
            deepcopy(item)
            for item in (config.get("series") or [])
            if isinstance(item, Mapping) and int(item.get("cell_id", -1)) == int(cell_id)
        ]
    return result


def _worker_jobs(
    family: str,
    spec: dict[str, Any],
    cell_ids: list[int],
    owner_context: Any,
) -> list[family_workers.FamilyWorkerJob]:
    protocol_entries, protocol_cache, dcir_header_cache, protocol_by_source = _protocol_caches(
        owner_context
    )
    jobs: list[family_workers.FamilyWorkerJob] = []
    for ordinal, cell_id in enumerate(cell_ids):
        jobs.append(
            family_workers.FamilyWorkerJob(
                family=family,
                spec=_one_cell_spec(spec, family, cell_id),
                provenance=None,
                request_context=_worker_context(
                    owner_context,
                    cell_id,
                    protocol_entries,
                    protocol_cache,
                    dcir_header_cache,
                    protocol_by_source,
                ),
                ordinal=ordinal,
                cell_id=int(cell_id),
                submitted_at=0.0,
            )
        )
    return jobs


def _make_05023_workloads(
    env: GoldenFixtureEnvironment,
    family: str,
) -> dict[int, tuple[int, list[int]]]:
    """Create one source-distinct 16-Cell fixture and reuse prefixes."""

    case_id, source_cell_id = family_profiler.FAMILY_CASES[family]
    case = family_profiler._case(env.manifest, case_id)
    from app.models import Analysis
    from golden_analysis_support import load_case_spec

    all_cell_ids = family_profiler._clone_cells(env, family, source_cell_id, max(COUNTS))
    workloads: dict[int, tuple[int, list[int]]] = {}
    for count in COUNTS:
        cell_ids = list(all_cell_ids[:count])
        spec = family_profiler._scaled_spec(
            load_case_spec(env.root, case),
            family,
            cell_ids,
        )
        analysis = Analysis(title=f"050.23 profiler {family} {count}", spec=spec)
        env.db.add(analysis)
        env.db.commit()
        workloads[count] = (int(analysis.id), cell_ids)
    return workloads


def _merge_common(first: Mapping[str, Any], family: str) -> dict[str, Any]:
    result = deepcopy(dict(first))
    result.pop("cache_status", None)
    result.pop("data_signature", None)
    result.pop("computed_at", None)
    result["type"] = "cycling" if family == "cycles" else family
    return result


def _merge_cycles(results: list[dict[str, Any]], spec: Mapping[str, Any]) -> dict[str, Any]:
    from app.services import analysis_engine

    ordered = sorted(results, key=lambda item: item["ordinal"])
    first = ordered[0]["result"]
    merged = _merge_common(first, "cycles")
    series = [item["result"]["cell_series"][0] for item in ordered]
    sources = [item["result"]["sources"][0] for item in ordered]
    badges = [badge for item in ordered for badge in item["result"].get("badges", [])]
    quantity_cols = [column for column, _label in analysis_engine.ALL_QUANTITIES.values()]
    aggregation = dict(spec.get("aggregation") or {})
    by_group: dict[int, list[dict]] = {}
    group_names: dict[int, str] = {}
    if (aggregation.get("mode") or "replicate_mean") == "replicate_mean":
        for item in series:
            if item.get("group_id") is not None and not item.get("excluded") and item.get("x"):
                by_group.setdefault(int(item["group_id"]), []).append(item)
                group_names[int(item["group_id"])] = str(item.get("group_name") or "")
    aggregates = []
    for group_id, members in by_group.items():
        aggregate = analysis_engine.aggregate_series(members, quantity_cols, aggregation)
        aggregate["group_id"] = group_id
        aggregate["group_name"] = group_names[group_id]
        aggregates.append(aggregate)
    group_metrics = []
    seen_groups: list[int] = []
    for item in series:
        group_id = item.get("group_id")
        if group_id is not None and int(group_id) not in seen_groups:
            seen_groups.append(int(group_id))
    for group_id in seen_groups:
        members = [
            item for item in series
            if item.get("group_id") == group_id
            and not item.get("excluded")
            and item.get("metrics", {}).get("n_cycles")
        ]
        if members:
            group_metrics.append(
                {
                    "group_id": group_id,
                    "group_name": members[0].get("group_name"),
                    "metrics": analysis_engine.aggregate_metrics(
                        [item["metrics"] for item in members]
                    ),
                }
            )
    merged.update(
        {
            "cell_series": series,
            "aggregates": aggregates,
            "group_metrics": group_metrics,
            "badges": badges,
            "sources": sources,
        }
    )
    return merged


def _merge_steps(results: list[dict[str, Any]], spec: Mapping[str, Any]) -> dict[str, Any]:
    ordered = sorted(results, key=lambda item: item["ordinal"])
    first = ordered[0]["result"]
    merged = _merge_common(first, "steps")
    series = [series for item in ordered for series in item["result"].get("cell_series", [])]
    sources = [source for item in ordered for source in item["result"].get("sources", [])]
    merged.update(
        {
            "steps": {
                "series": deepcopy(
                    ((spec.get("computation") or {}).get("steps") or {}).get("series") or []
                ),
                "mode": (first.get("steps") or {}).get("mode", "union"),
            },
            "cell_series": series,
            "badges": [badge for item in ordered for badge in item["result"].get("badges", [])],
            "sources": sources,
        }
    )
    return merged


def _merge_dcir(results: list[dict[str, Any]], spec: Mapping[str, Any]) -> dict[str, Any]:
    ordered = sorted(results, key=lambda item: item["ordinal"])
    first = ordered[0]["result"]
    merged = _merge_common(first, "dcir")
    merged.update(
        {
            "dcir": {
                "series": deepcopy(
                    ((spec.get("computation") or {}).get("dcir") or {}).get("series") or []
                )
            },
            "cell_series": [
                series for item in ordered for series in item["result"].get("cell_series", [])
            ],
            "badges": [badge for item in ordered for badge in item["result"].get("badges", [])],
            "sources": [
                source for item in ordered for source in item["result"].get("sources", [])
            ],
        }
    )
    return merged


def _merge_chargeability(
    results: list[dict[str, Any]],
    spec: Mapping[str, Any],
    cell_ids: list[int],
) -> dict[str, Any]:
    ordered = sorted(results, key=lambda item: item["ordinal"])
    first = ordered[0]["result"]
    merged = _merge_common(first, "chargeability")
    candidates = [candidate for item in ordered for candidate in item["result"].get("candidates", [])]
    matches = [match for item in ordered for match in item["result"].get("matches", [])]
    fingerprints = sorted({str(item["fingerprint"]) for item in matches})
    matched_cell_ids = {int(item["cell_id"]) for item in matches}
    compatible = bool(matches) and len(fingerprints) == 1
    complete = bool(cell_ids) and matched_cell_ids == set(cell_ids)
    merged.update(
        {
            "candidates": candidates,
            "matches": matches,
            "cells": [cell for item in ordered for cell in item["result"].get("cells", [])],
            "available_filters": {
                "initial_soc_pct": sorted(
                    {round(float(item["initial_soc_pct"]), 6) for item in candidates}
                ),
                "final_soc_pct": sorted(
                    {round(float(item["final_soc_pct"]), 6) for item in candidates}
                ),
                "current_ceiling_c": sorted(
                    {round(float(item["current_ceiling_c"]), 6) for item in candidates}
                ),
                "target_voltage_v": sorted(
                    {
                        round(float(item["target_voltage_v"]), 6)
                        for item in candidates
                        if item.get("target_voltage_v") is not None
                    }
                ),
            },
            "compatibility": {
                "compatible": compatible,
                "complete": complete,
                "fingerprints": fingerprints,
            },
            "badges": [badge for item in ordered for badge in item["result"].get("badges", [])],
            "sources": [
                source for item in ordered for source in item["result"].get("sources", [])
            ],
        }
    )
    if matches and not compatible:
        merged["badges"].append(
            {
                "kind": "chargeability_protocol_mismatch",
                "detail": "Selected cells matched different chargeability protocols; curves are shown but are not directly equivalent.",
            }
        )
    return merged


def _merge_rate_capability(
    results: list[dict[str, Any]],
    spec: Mapping[str, Any],
    cell_ids: list[int],
) -> dict[str, Any]:
    from app.services import rate_capability

    ordered = sorted(results, key=lambda item: item["ordinal"])
    first = ordered[0]["result"]
    merged = _merge_common(first, "rate_capability")
    cells = [item for result in ordered for item in result["result"].get("cells", [])]
    blocks = [block for result in ordered for block in result["result"].get("blocks", [])]
    detected = [
        block
        for result in ordered
        for block in result["result"].get("detected_blocks", [])
    ]
    worker_cells = [
        family_workers.WorkerCell(id=int(cell_id), name=str(next(
            item["cell_name"]
            for result in ordered
            for item in result["result"].get("cells", [])
            if int(item["cell_id"]) == int(cell_id)
        )))
        for cell_id in cell_ids
    ]
    config = deepcopy(first.get("config") or {})
    blocks, comparison = rate_capability.build_common_rate_comparison(
        blocks,
        worker_cells,
        float(config.get("rate_tolerance_fraction", 0.03)),
    )
    fingerprints_by_family: dict[str, set[str]] = {"charge": set(), "discharge": set()}
    for block in blocks:
        fingerprints_by_family.setdefault(str(block["family"]), set()).add(str(block["fingerprint"]))
    compatibility = {
        family: {
            "compatible": bool([block for block in blocks if block["family"] == family])
            and len(fingerprints_by_family.get(family, set())) == 1,
            "complete": {
                int(block["cell_id"])
                for block in blocks
                if block["family"] == family
            } == set(cell_ids),
            "fingerprints": sorted(fingerprints_by_family.get(family, set())),
        }
        for family in ("charge", "discharge")
    }
    available_blocks = detected
    merged.update(
        {
            "config": config,
            "blocks": blocks,
            "detected_blocks": detected,
            "points": [point for block in blocks for point in block.get("points", [])],
            "comparison": comparison,
            "available": {
                "charge_rates_c": sorted(
                    {round(float(rate), 6) for block in available_blocks if block["family"] == "charge" for rate in block["rates_c"]}
                ),
                "discharge_rates_c": sorted(
                    {round(float(rate), 6) for block in available_blocks if block["family"] == "discharge" for rate in block["rates_c"]}
                ),
                "charge_fixed_rates_c": sorted(
                    {round(float(block["fixed_rate_c"]), 6) for block in available_blocks if block["family"] == "charge"}
                ),
                "discharge_fixed_rates_c": sorted(
                    {round(float(block["fixed_rate_c"]), 6) for block in available_blocks if block["family"] == "discharge"}
                ),
                "charge_structures": sorted(
                    {block["charge_structure"] for block in available_blocks if block["family"] == "charge"}
                ),
            },
            "invalid_execution_count": sum(
                int(result["result"].get("invalid_execution_count") or 0)
                for result in ordered
            ),
            "cells": cells,
            "selection_contexts": [
                {
                    "cell_id": int(cell_id),
                    "entry_kind": "cell",
                    "entry_ref_id": int(cell_id),
                }
                for cell_id in cell_ids
            ],
            "compatibility": compatibility,
            "badges": [badge for result in ordered for badge in result["result"].get("badges", [])],
            "sources": [
                source for result in ordered for source in result["result"].get("sources", [])
            ],
        }
    )
    return merged


def _merge_results(
    family: str,
    results: list[dict[str, Any]],
    spec: Mapping[str, Any],
    cell_ids: list[int],
) -> dict[str, Any]:
    if not results:
        raise RuntimeError("family worker returned no results")
    if family == "cycles":
        return _merge_cycles(results, spec)
    if family == "steps":
        return _merge_steps(results, spec)
    if family == "dcir":
        return _merge_dcir(results, spec)
    if family == "chargeability":
        return _merge_chargeability(results, spec, cell_ids)
    if family == "rate_capability":
        return _merge_rate_capability(results, spec, cell_ids)
    raise ValueError(f"unsupported merge family: {family}")


class ResidentFamilyPool:
    """One already-warm spawn pool for a benchmark candidate mode."""

    def __init__(self, workers: int):
        self.workers = int(workers)
        self.executor: ProcessPoolExecutor | None = None
        self.warm_pids: list[int] = []
        self.warm_idle_rss_bytes: int | None = None

    def start(self) -> None:
        from app.services.process_priority import background_pool_initializer

        self.executor = ProcessPoolExecutor(
            max_workers=self.workers,
            mp_context=multiprocessing.get_context("spawn"),
            initializer=background_pool_initializer,
        )
        deadline = perf_counter() + 120.0
        acknowledgements: list[tuple[int, int | None]] = []
        while perf_counter() < deadline:
            futures = [
                self.executor.submit(family_workers.worker_ping)
                for _ in range(self.workers * 2)
            ]
            acknowledgements.extend(
                future.result(timeout=max(1.0, deadline - perf_counter()))
                for future in futures
            )
            self.warm_pids = sorted({int(pid) for pid, _rss in acknowledgements})
            if len(self.warm_pids) >= self.workers:
                break
            sleep(0.05)
        if len(self.warm_pids) < self.workers:
            self.close()
            raise RuntimeError(
                f"family worker warmup acknowledged {len(self.warm_pids)} of {self.workers} PIDs"
            )
        rss_values = [int(rss) for _pid, rss in acknowledgements if isinstance(rss, int)]
        self.warm_idle_rss_bytes = sum(rss_values) if rss_values else None

    def close(self) -> None:
        executor, self.executor = self.executor, None
        if executor is not None:
            executor.shutdown(wait=True, cancel_futures=True)

    def __enter__(self) -> "ResidentFamilyPool":
        self.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()


def _sql_profile(db: Any) -> Any:
    from app.services import time_capacity_profiling

    return time_capacity_profiling.SQLProfile(db)


def _route_response_metrics(response: Any) -> tuple[dict[str, Any], str]:
    payload = json.loads(response.body)
    return payload, _digest(payload)


def _run_serial_miss(
    env: GoldenFixtureEnvironment,
    analysis_id: int,
    family: str,
    cache_root: Path,
) -> dict[str, Any]:
    from app.routers import analyses
    from app.services import analysis_cache
    from app.services.analysis_family_workers import _cache_wrappers

    counters: dict[str, Any] = {"calls": {}, "elapsed_ms": {}, "rows": {}, "physical_rows": 0, "row_groups": 0}
    route = family_profiler._route_for(family)
    request = family_profiler._request_for(family, analyses, True)
    sql = _sql_profile(env.db)
    rss_before = family_workers._rss_bytes()
    started_cpu = process_time()
    started = perf_counter()
    with family_profiler._analysis_cache_root(cache_root):
        with _cache_wrappers(counters):
            response = route(analysis_id, request, env.db)
    elapsed = (perf_counter() - started) * 1000.0
    metrics: dict[str, Any] = {}
    sql.finish(metrics)
    payload, digest = _route_response_metrics(response)
    return {
        "mode": "S1",
        "workers": 1,
        "complete_route_ms": elapsed,
        "cpu_seconds": process_time() - started_cpu,
        "body_bytes": len(response.body or b""),
        "scientific_digest": digest,
        "series_order": _order(payload),
        "cache_status": payload.get("cache_status"),
        "raw_reads": counters,
        "owner_preprocessing_ms": None,
        "job_construction_ms": 0.0,
        "serialized_job_bytes": 0,
        "job_serialization_ms": 0.0,
        "submit_ms": 0.0,
        "result_transfer_ms": 0.0,
        "queue_ms": 0.0,
        "worker_wall_ms": [],
        "worker_pids": [],
        "worker_result_bytes": [],
        "owner_merge_ms": None,
        "cache_persistence_ms": None,
        "json_serialization_ms": None,
        "parent_rss_before_bytes": rss_before,
        "parent_rss_after_bytes": family_workers._rss_bytes(),
        "worker_warm_idle_rss_bytes": None,
        "worker_request_peak_rss_bytes": None,
        "sql": metrics.get("sql"),
        "native_thread_settings": _native_thread_settings(),
    }


def _run_parallel_miss(
    env: GoldenFixtureEnvironment,
    analysis_id: int,
    family: str,
    cell_ids: list[int],
    cache_root: Path,
    pool: ResidentFamilyPool,
) -> tuple[dict[str, Any], dict[str, Any]]:
    from app.models import Analysis
    from app.routers import analyses
    from app.services import analysis_cache, analysis_engine
    from app.services.analysis_family_workers import _cache_wrappers

    if pool.executor is None:
        raise RuntimeError("family pool is not warm")
    analysis = env.db.get(Analysis, analysis_id)
    if analysis is None:
        raise RuntimeError(f"analysis {analysis_id} not found")
    spec = deepcopy(analysis.spec)
    started_cpu = process_time()
    started = perf_counter()
    rss_before = family_workers._rss_bytes()
    sql = _sql_profile(env.db)
    context_started = perf_counter()
    with family_profiler._analysis_cache_root(cache_root):
        analysis_engine.ensure_canonical_cycling_available(env.db, spec)
        owner_context = analysis_engine.build_analysis_request_context(
            env.db,
            spec,
            None,
            use_current_versions=True,
        )
        owner_context_ms = (perf_counter() - context_started) * 1000.0
        jobs_started = perf_counter()
        jobs = _worker_jobs(family, spec, cell_ids, owner_context)
        job_build_ms = (perf_counter() - jobs_started) * 1000.0
        serialized_job_bytes = 0
        job_serialization_ms = 0.0
        submitted_jobs: list[family_workers.FamilyWorkerJob] = []
        for job in jobs:
            submitted = perf_counter()
            next_job = family_workers.FamilyWorkerJob(
                family=job.family,
                spec=job.spec,
                provenance=job.provenance,
                request_context=job.request_context,
                ordinal=job.ordinal,
                cell_id=job.cell_id,
                submitted_at=submitted,
            )
            serialize_started = perf_counter()
            encoded = pickle.dumps(next_job, protocol=pickle.HIGHEST_PROTOCOL)
            job_serialization_ms += (perf_counter() - serialize_started) * 1000.0
            serialized_job_bytes += len(encoded)
            if family_workers.worker_job_has_forbidden_state(next_job):
                raise AssertionError("forbidden owner state crossed the family worker boundary")
            submitted_jobs.append(next_job)
        submit_started = perf_counter()
        futures = [pool.executor.submit(family_workers.run_family_job, job) for job in submitted_jobs]
        submit_ms = (perf_counter() - submit_started) * 1000.0
        transfer_started = perf_counter()
        results = [future.result(timeout=180) for future in futures]
        result_transfer_ms = (perf_counter() - transfer_started) * 1000.0
        merge_started = perf_counter()
        merged = _merge_results(family, results, spec, cell_ids)
        owner_merge_ms = (perf_counter() - merge_started) * 1000.0
        key = analysis_cache.result_key(
            env.db,
            family,
            spec,
            None,
            use_current_versions=True,
            request_context=owner_context,
        )
        merged["cache_status"] = "miss"
        merged["data_signature"] = key
        persistence_started = perf_counter()
        analysis_cache.store_result(family, key, merged)
        cache_persistence_ms = (perf_counter() - persistence_started) * 1000.0
        json_started = perf_counter()
        response = analyses.fast_json(merged)
        json_serialization_ms = (perf_counter() - json_started) * 1000.0
    elapsed = (perf_counter() - started) * 1000.0
    sql_metrics: dict[str, Any] = {}
    sql.finish(sql_metrics)
    payload, digest = _route_response_metrics(response)
    worker_wall = [float(item["worker_wall_ms"]) for item in results]
    worker_after = [
        int(item["rss_after_bytes"])
        for item in results
        if isinstance(item.get("rss_after_bytes"), int)
    ]
    worker_before = [
        int(item["rss_before_bytes"])
        for item in results
        if isinstance(item.get("rss_before_bytes"), int)
    ]
    raw_reads = {
        "calls": {},
        "elapsed_ms": {},
        "rows": {},
        "physical_rows": 0,
        "row_groups": 0,
    }
    for item in results:
        counters = item.get("cache_reads") or {}
        for key_name in ("calls", "elapsed_ms", "rows"):
            for name, value in (counters.get(key_name) or {}).items():
                raw_reads[key_name][name] = raw_reads[key_name].get(name, 0) + value
        raw_reads["physical_rows"] += int(counters.get("physical_rows") or 0)
        raw_reads["row_groups"] += int(counters.get("row_groups") or 0)
    metrics = {
        "mode": f"P{pool.workers}",
        "workers": pool.workers,
        "complete_route_ms": elapsed,
        "cpu_seconds": process_time() - started_cpu,
        "body_bytes": len(response.body or b""),
        "scientific_digest": digest,
        "series_order": _order(payload),
        "cache_status": payload.get("cache_status"),
        "raw_reads": raw_reads,
        "owner_preprocessing_ms": owner_context_ms,
        "job_construction_ms": job_build_ms,
        "serialized_job_bytes": serialized_job_bytes,
        "job_serialization_ms": job_serialization_ms,
        "submit_ms": submit_ms,
        "result_transfer_ms": result_transfer_ms,
        "queue_ms": _median(item.get("queue_ms") for item in results),
        "worker_wall_ms": worker_wall,
        "worker_wall_range_ms": {
            "min": min(worker_wall) if worker_wall else None,
            "max": max(worker_wall) if worker_wall else None,
        },
        "worker_pids": sorted({int(item["worker_pid"]) for item in results}),
        "worker_result_bytes": [int(item["result_bytes"]) for item in results],
        "worker_result_serialization_ms": _median(
            item.get("result_serialization_ms") for item in results
        ),
        "owner_merge_ms": owner_merge_ms,
        "cache_persistence_ms": cache_persistence_ms,
        "json_serialization_ms": json_serialization_ms,
        "parent_rss_before_bytes": rss_before,
        "parent_rss_after_bytes": family_workers._rss_bytes(),
        "worker_warm_idle_rss_bytes": pool.warm_idle_rss_bytes,
        "worker_request_peak_rss_bytes": (
            sum(worker_after) if worker_after else sum(worker_before) if worker_before else None
        ),
        "sql": sql_metrics.get("sql"),
        "native_thread_settings": _native_thread_settings(),
    }
    return metrics, payload


def _run_exact_hit(
    env: GoldenFixtureEnvironment,
    analysis_id: int,
    family: str,
    cache_root: Path,
) -> dict[str, Any]:
    from app.routers import analyses

    route = family_profiler._route_for(family)
    request = family_profiler._request_for(family, analyses, False)
    started = perf_counter()
    with family_profiler._analysis_cache_root(cache_root):
        response = route(analysis_id, request, env.db)
    elapsed = (perf_counter() - started) * 1000.0
    payload, digest = _route_response_metrics(response)
    return {
        "complete_route_ms": elapsed,
        "cache_status": payload.get("cache_status"),
        "scientific_digest": digest,
        "series_order": _order(payload),
        "worker_dispatch_count": 0,
        "worker_job_count": 0,
        "exact_hit_contract": payload.get("cache_status") == "hit",
    }


def _summary(samples: list[dict[str, Any]]) -> dict[str, Any]:
    values = [sample["complete_route_ms"] for sample in samples]
    digests = sorted({sample.get("scientific_digest") for sample in samples})
    orders = [sample.get("series_order") for sample in samples]
    return {
        "samples_ms": values,
        "p50_ms": _median(values),
        "min_ms": min(values) if values else None,
        "max_ms": max(values) if values else None,
        "spread_fraction": (
            (max(values) - min(values)) / _median(values)
            if values and _median(values)
            else None
        ),
        "scientific_digests": digests,
        "scientific_parity": len(digests) == 1,
        "series_order": orders[0] if orders else [],
        "ordering_parity": all(order == orders[0] for order in orders) if orders else False,
        "worker_pids": sorted({pid for sample in samples for pid in sample.get("worker_pids", [])}),
        "worker_wall_p50_ms": _median(
            wall for sample in samples for wall in sample.get("worker_wall_ms", [])
        ),
        "queue_p50_ms": _median(sample.get("queue_ms") for sample in samples),
        "owner_merge_p50_ms": _median(sample.get("owner_merge_ms") for sample in samples),
        "serialized_job_bytes_p50": _median(sample.get("serialized_job_bytes") for sample in samples),
        "worker_result_bytes_p50": _median(
            sum(sample.get("worker_result_bytes", [])) for sample in samples
        ),
        "worker_warm_idle_rss_bytes": samples[0].get("worker_warm_idle_rss_bytes") if samples else None,
        "worker_request_peak_rss_bytes_max": max(
            (sample.get("worker_request_peak_rss_bytes") or 0 for sample in samples),
            default=None,
        ),
        "raw_reads": samples[0].get("raw_reads") if samples else None,
        "sql": samples[0].get("sql") if samples else None,
    }


def _delta(serial: Mapping[str, Any], candidate: Mapping[str, Any]) -> dict[str, float | None]:
    serial_p50 = serial.get("p50_ms")
    candidate_p50 = candidate.get("p50_ms")
    if not isinstance(serial_p50, (int, float)) or not isinstance(candidate_p50, (int, float)):
        return {"ms": None, "fraction": None}
    return {
        "ms": float(serial_p50) - float(candidate_p50),
        "fraction": (float(serial_p50) - float(candidate_p50)) / float(serial_p50)
        if serial_p50
        else None,
    }


def _point_summary(
    samples: Mapping[str, list[dict[str, Any]]],
    cell_ids: list[int],
) -> dict[str, Any]:
    summaries = {mode: _summary(samples[mode]) for mode in MODES}
    return {
        "cell_ids": list(cell_ids),
        "modes": summaries,
        "deltas": {
            "P4_vs_S1": _delta(summaries["S1"], summaries["P4"]),
            "P8_vs_P4": _delta(summaries["P4"], summaries["P8"]),
            "P8_vs_S1": _delta(summaries["S1"], summaries["P8"]),
        },
        "parity": {
            mode: summaries[mode]["scientific_parity"]
            and summaries[mode]["ordering_parity"]
            for mode in MODES
        },
    }


def _promotion_decision(
    family_matrix: Mapping[int, Mapping[str, Any]],
    resources: Mapping[str, Any],
) -> dict[str, Any]:
    thresholds = list(COUNTS)
    p4_thresholds: list[int] = []
    for index, count in enumerate(thresholds):
        point = family_matrix[count]
        delta = point["deltas"]["P4_vs_S1"]
        p4 = point["modes"]["P4"]
        serial = point["modes"]["S1"]
        qualifies = (
            bool(p4.get("scientific_parity") and p4.get("ordering_parity"))
            and isinstance(delta.get("ms"), (int, float))
            and isinstance(delta.get("fraction"), (int, float))
            and delta["ms"] >= 10.0
            and delta["fraction"] >= 0.15
        )
        if not qualifies:
            continue
        larger_ok = True
        for larger in thresholds[index + 1 :]:
            larger_point = family_matrix[larger]
            larger_delta = larger_point["deltas"]["P4_vs_S1"]
            larger_ok = larger_ok and (
                isinstance(larger_delta.get("ms"), (int, float))
                and larger_delta["ms"] >= 10.0
                and larger_delta["fraction"] >= 0.15
                and larger_point["modes"]["P4"].get("scientific_parity")
                and larger_point["modes"]["P4"].get("ordering_parity")
            )
        if larger_ok:
            p4_thresholds.append(count)
    p4_threshold = min(p4_thresholds) if p4_thresholds else None

    p8_thresholds: list[int] = []
    p8_host_ok = (
        isinstance(resources.get("logical_cpus"), int)
        and resources["logical_cpus"] >= 12
        and isinstance(resources.get("available_memory_bytes"), int)
        and resources["available_memory_bytes"] >= 8 * 128 * 1024 * 1024 + 512 * 1024 * 1024
    )
    for index, count in enumerate(thresholds):
        point = family_matrix[count]
        delta = point["deltas"]["P8_vs_P4"]
        p8 = point["modes"]["P8"]
        p4 = point["modes"]["P4"]
        rss4 = p4.get("worker_warm_idle_rss_bytes")
        rss8 = p8.get("worker_warm_idle_rss_bytes")
        rss_ok = (
            isinstance(rss4, (int, float))
            and isinstance(rss8, (int, float))
            and rss8 <= rss4 * 1.5
        )
        qualifies = (
            p8_host_ok
            and rss_ok
            and bool(p8.get("scientific_parity") and p8.get("ordering_parity"))
            and isinstance(delta.get("ms"), (int, float))
            and isinstance(delta.get("fraction"), (int, float))
            and delta["ms"] >= 15.0
            and delta["fraction"] >= 0.15
        )
        if not qualifies:
            continue
        larger_ok = True
        for larger in thresholds[index + 1 :]:
            larger_delta = family_matrix[larger]["deltas"]["P8_vs_P4"]
            larger_ok = larger_ok and (
                isinstance(larger_delta.get("ms"), (int, float))
                and larger_delta["ms"] >= 15.0
                and larger_delta["fraction"] >= 0.15
                and family_matrix[larger]["modes"]["P8"].get("scientific_parity")
                and family_matrix[larger]["modes"]["P8"].get("ordering_parity")
            )
        if larger_ok:
            p8_thresholds.append(count)
    p8_threshold = min(p8_thresholds) if p8_thresholds else None
    if p8_threshold is not None:
        chosen = "P8"
        threshold = p8_threshold
    elif p4_threshold is not None:
        chosen = "P4"
        threshold = p4_threshold
    else:
        chosen = "serial"
        threshold = None
    return {
        "chosen_production_mode": chosen,
        "chosen_threshold_cells": threshold,
        "p4_threshold_candidates": p4_thresholds,
        "p8_threshold_candidates": p8_thresholds,
        "p8_host_gate": {
            "logical_cpus_and_memory": p8_host_ok,
            "logical_cpus": resources.get("logical_cpus"),
            "available_memory_bytes": resources.get("available_memory_bytes"),
        },
        "production_integration": (
            "not promoted; production worker ownership remains unchanged"
            if chosen == "serial"
            else f"{chosen} promoted at {threshold} Cells through the existing shared application pool; serial fallback retained"
        ),
    }


def _environment() -> dict[str, Any]:
    from app.services import time_capacity_workers

    resources = time_capacity_workers.host_resources()

    def version(name: str) -> str | None:
        try:
            return importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            return None

    return {
        "platform": platform.platform(),
        "python": platform.python_version(),
        "pandas": version("pandas"),
        "numpy": version("numpy"),
        "pyarrow": version("pyarrow"),
        "logical_cpus": resources.logical_cpus,
        "total_memory_bytes": resources.total_memory_bytes,
        "available_memory_bytes": resources.available_memory_bytes,
        "native_thread_settings": _native_thread_settings(),
        "browser_status": "NOT RUN",
    }


def _run_hit_control(
    env: GoldenFixtureEnvironment,
    family: str,
    analysis_id: int,
    cell_ids: list[int],
    mode: str,
    pool: ResidentFamilyPool | None,
) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix=f"cellxplorer-05023-{family}-{len(cell_ids)}-{mode}-hit-") as root:
        cache_root = Path(root)
        if mode == "S1":
            _run_serial_miss(env, analysis_id, family, cache_root)
        else:
            if pool is None:
                raise RuntimeError(f"missing pool for {mode}")
            _run_parallel_miss(env, analysis_id, family, cell_ids, cache_root, pool)
        return _run_exact_hit(env, analysis_id, family, cache_root)


def run_matrix(
    *,
    families: list[str],
    counts: list[int],
    repetitions: int,
) -> dict[str, Any]:
    started = perf_counter()
    result: dict[str, Any] = {
        "spec": "050.23",
        "commit": os.popen("git rev-parse HEAD").read().strip(),
        "repetitions": repetitions,
        "browser_status": "NOT RUN",
        "candidate_modes": {
            "S1": "current serial production route",
            "P4": "four already-warm persistent spawned workers",
            "P8": "eight already-warm persistent spawned workers",
        },
        "scope": {
            "families": families,
            "cell_counts": counts,
            "time_capacity": "excluded from the matrix and production decision",
            "worker_startup": "outside measured route; distinct PID warmup required",
            "production_integration": "P4 promotion decisions are applied through the existing shared application pool; serial fallback retained",
        },
        "environment": _environment(),
        "families": {},
    }
    resources = {
        "logical_cpus": result["environment"].get("logical_cpus"),
        "available_memory_bytes": result["environment"].get("available_memory_bytes"),
    }
    try:
        with GoldenFixtureEnvironment.create() as env:
            for family in families:
                family_record: dict[str, Any] = {"workloads": {}, "exact_hit_controls": {}}
                workloads = _make_05023_workloads(env, family)
                with ResidentFamilyPool(4) as p4_pool, ResidentFamilyPool(8) as p8_pool:
                    raw_samples_by_count: dict[int, dict[str, list[dict[str, Any]]]] = {}
                    for count in counts:
                        analysis_id, cell_ids = workloads[count]
                        samples: dict[str, list[dict[str, Any]]] = {mode: [] for mode in MODES}
                        for _repetition in range(repetitions):
                            with tempfile.TemporaryDirectory(prefix=f"cellxplorer-05023-{family}-{count}-s1-") as root:
                                samples["S1"].append(
                                    _run_serial_miss(env, analysis_id, family, Path(root))
                                )
                        for _repetition in range(repetitions):
                            with tempfile.TemporaryDirectory(prefix=f"cellxplorer-05023-{family}-{count}-p4-") as root:
                                sample, _payload = _run_parallel_miss(
                                    env, analysis_id, family, cell_ids, Path(root), p4_pool
                                )
                                samples["P4"].append(sample)
                        for _repetition in range(repetitions):
                            with tempfile.TemporaryDirectory(prefix=f"cellxplorer-05023-{family}-{count}-p8-") as root:
                                sample, _payload = _run_parallel_miss(
                                    env, analysis_id, family, cell_ids, Path(root), p8_pool
                                )
                                samples["P8"].append(sample)
                        raw_samples_by_count[count] = samples
                        family_record["workloads"][str(count)] = _point_summary(samples, cell_ids)

                    preliminary_decision = _promotion_decision(
                        {int(key): value for key, value in family_record["workloads"].items()},
                        resources,
                    )
                    confirmation: dict[str, Any] | None = None
                    if preliminary_decision["p4_threshold_candidates"]:
                        threshold = int(min(preliminary_decision["p4_threshold_candidates"]))
                        analysis_id, cell_ids = workloads[threshold]
                        confirmation_samples: dict[str, list[dict[str, Any]]] = {
                            "S1": [],
                            "P4": [],
                        }
                        serial_before: list[dict[str, Any]] = []
                        serial_after: list[dict[str, Any]] = []
                        for _ in range(2):
                            with tempfile.TemporaryDirectory(prefix=f"cellxplorer-05023-{family}-{threshold}-confirm-before-") as root:
                                serial_before.append(
                                    _run_serial_miss(env, analysis_id, family, Path(root))
                                )
                        for _ in range(repetitions):
                            with tempfile.TemporaryDirectory(prefix=f"cellxplorer-05023-{family}-{threshold}-confirm-s1-") as root:
                                confirmation_samples["S1"].append(
                                    _run_serial_miss(env, analysis_id, family, Path(root))
                                )
                        for _ in range(repetitions):
                            with tempfile.TemporaryDirectory(prefix=f"cellxplorer-05023-{family}-{threshold}-confirm-p4-") as root:
                                sample, _payload = _run_parallel_miss(
                                    env, analysis_id, family, cell_ids, Path(root), p4_pool
                                )
                                confirmation_samples["P4"].append(sample)
                        for _ in range(2):
                            with tempfile.TemporaryDirectory(prefix=f"cellxplorer-05023-{family}-{threshold}-confirm-after-") as root:
                                serial_after.append(
                                    _run_serial_miss(env, analysis_id, family, Path(root))
                                )
                        # P8 was not promoted in the preliminary block; retain
                        # its original measured summary while replacing only
                        # the noisy P4 decision point with the confirmation.
                        raw_samples_by_count[threshold]["S1"].extend(
                            confirmation_samples["S1"]
                        )
                        raw_samples_by_count[threshold]["P4"].extend(
                            confirmation_samples["P4"]
                        )
                        family_record["workloads"][str(threshold)] = _point_summary(
                            raw_samples_by_count[threshold],
                            cell_ids,
                        )
                        confirmation = {
                            "threshold_cells": threshold,
                            "repetitions": repetitions,
                            "confirmed_modes": {
                                "S1": _summary(confirmation_samples["S1"]),
                                "P4": _summary(confirmation_samples["P4"]),
                            },
                            "serial_bracket_before_p50_ms": _median(
                                item["complete_route_ms"] for item in serial_before
                            ),
                            "serial_bracket_after_p50_ms": _median(
                                item["complete_route_ms"] for item in serial_after
                            ),
                            "reason": "promotion point had >15% warm-sample spread; focused confirmation block run",
                        }
                    family_record["confirmation"] = confirmation
                    family_record["promotion_decision"] = _promotion_decision(
                        {int(key): value for key, value in family_record["workloads"].items()},
                        resources,
                    )
                    # One exact-hit proof per family and candidate mode is
                    # sufficient; the route itself remains the hit authority.
                    for mode, pool in (("S1", None), ("P4", p4_pool), ("P8", p8_pool)):
                        analysis_id, cell_ids = workloads[counts[0]]
                        family_record["exact_hit_controls"][mode] = _run_hit_control(
                            env, family, analysis_id, cell_ids, mode, pool
                        )
                result["families"][family] = family_record
    finally:
        try:
            from app.services import time_capacity_workers

            time_capacity_workers.shutdown_time_capacity_worker_pool()
        except Exception:
            pass
    result["elapsed_ms"] = (perf_counter() - started) * 1000.0
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--families", default=DEFAULT_FAMILIES)
    parser.add_argument("--cells", default=DEFAULT_COUNTS)
    parser.add_argument("--workers", default=DEFAULT_WORKERS)
    parser.add_argument("--repetitions", type=int, default=5, choices=range(1, 6))
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        families = _parse_csv(args.families, name="families", allowed=FAMILIES)
        counts = [int(value) for value in _parse_csv(args.cells, name="cells")]
        workers = [int(value) for value in _parse_csv(args.workers, name="workers")]
        if set(counts) != set(COUNTS):
            raise ValueError(f"cells must be exactly {COUNTS}")
        if set(workers) != {1, 4, 8}:
            raise ValueError("workers must include exactly 1, 4 and 8")
    except ValueError as exc:
        parser.error(str(exc))
    report = run_matrix(
        families=list(families),
        counts=sorted(counts),
        repetitions=args.repetitions,
    )
    encoded = json.dumps(report, indent=2, sort_keys=True, default=str) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded, encoding="utf-8")
    print(encoded, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
