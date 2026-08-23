"""Focused ownership and serialization checks for Spec 050.23 jobs."""
from __future__ import annotations

import sys
import pickle
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "scripts"))

from app.services.analysis_family_workers import (
    FamilyWorkerJob,
    WorkerCell,
    WorkerRequestContext,
    WorkerSource,
    _merge_rate_capability,
    _owner_cache_ready,
    try_compute_family,
    worker_job_has_forbidden_state,
)
from profile_analysis_family_concurrency import _dedupe_worker_rss_samples, _rss_memory_gate
from app.routers import analyses as analyses_router


class AnalysisFamilyWorkerJobTests(unittest.TestCase):
    def _job(self, spec: dict | None = None) -> FamilyWorkerJob:
        cell = WorkerCell(id=7, name="Cell 7")
        source = WorkerSource(
            id=8,
            hash="a" * 64,
            path="",
            filename="cell.ndax",
            ext=".ndax",
            size=12,
            header_meta={},
            nominal_capacity_mah=1.0,
            row_count=2,
            cycle_count=1,
            parse_status="parsed",
            parser_version="neware-nda:1",
            location_status="offline",
            voltage_data_availability={},
        )
        context = WorkerRequestContext(
            units=({
                "cell": cell,
                "group_id": None,
                "group_name": None,
                "label": cell.name,
                "entry_kind": "cell",
                "entry_ref_id": cell.id,
            },),
            missing_refs=(),
            cells=(cell,),
            files_by_cell={cell.id: (source,)},
            hashes_by_cell={cell.id: (source.hash,)},
            parser_versions_by_cell={cell.id: {source.hash: "neware-nda:1"}},
            scalar_metadata={cell.id: {}},
            labels_by_cell={cell.id: cell.name},
            protocol_by_source=((source.hash, {"steps": []}),),
        )
        return FamilyWorkerJob(
            family="cycles",
            spec=spec or {"selection": {"entries": [{"kind": "cell", "ref_id": 7}]}},
            provenance=None,
            request_context=context,
            ordinal=0,
            cell_id=cell.id,
            submitted_at=0.0,
        )

    def test_compact_job_is_pickle_safe_and_has_no_forbidden_state(self):
        job = self._job()
        self.assertFalse(worker_job_has_forbidden_state(job))
        self.assertIsInstance(pickle.dumps(job, protocol=pickle.HIGHEST_PROTOCOL), bytes)
        self.assertEqual(job.request_context.files_by_cell[7][0].path, "")

    def test_complete_dataframe_payload_is_rejected(self):
        job = self._job({"frame": pd.DataFrame({"x": [1, 2]})})
        self.assertTrue(worker_job_has_forbidden_state(job))

    def test_production_helper_submits_to_the_existing_p4_pool(self):
        cells = tuple(WorkerCell(id=index, name=f"Cell {index}") for index in range(4))
        context = SimpleNamespace(
            units=tuple({"cell": cell, "label": cell.name} for cell in cells),
            cells=cells,
        )
        job = replace(self._job(), use_current_versions=False)

        class FakeFuture:
            def result(self, timeout=None):
                return {"ordinal": 0, "cell_id": 7, "result": {}}

        class FakePool:
            def __init__(self):
                self.calls = []

            def submit(self, function, submitted_job):
                self.calls.append((function, submitted_job))
                return FakeFuture()

        pool = FakePool()
        with (
            patch(
                "app.services.analysis_engine.ensure_canonical_cycling_available"
            ),
            patch(
                "app.services.analysis_family_workers._worker_jobs",
                return_value=[job],
            ),
            patch(
                "app.services.analysis_family_workers._merge_results",
                return_value={},
            ),
            patch(
                "app.services.analysis_family_workers._owner_cache_ready",
                return_value=True,
            ),
            patch(
                "app.services.analysis_family_workers._finalize_merged_result",
                return_value={"ok": True},
            ),
            patch(
                "app.services.time_capacity_workers._ready_pool",
                return_value=pool,
            ) as ready_pool,
        ):
            result = try_compute_family(
                None,
                {"selection": {"entries": []}},
                {"calc_version": "calc-old"},
                family="cycles",
                use_current_versions=False,
                request_context=context,
            )

        self.assertEqual(result, {"ok": True})
        ready_pool.assert_called_once_with(4)
        self.assertEqual(len(pool.calls), 1)
        self.assertFalse(pool.calls[0][1].use_current_versions)

    def test_scientific_worker_exception_is_not_hidden_by_serial_fallback(self):
        cells = tuple(WorkerCell(id=index, name=f"Cell {index}") for index in range(4))
        context = SimpleNamespace(
            units=tuple({"cell": cell, "label": cell.name} for cell in cells),
            cells=cells,
        )

        class BadFuture:
            def result(self, timeout=None):
                raise ValueError("scientific failure")

        class FakePool:
            def submit(self, function, submitted_job):
                return BadFuture()

        with (
            patch(
                "app.services.analysis_engine.ensure_canonical_cycling_available"
            ),
            patch(
                "app.services.analysis_family_workers._worker_jobs",
                return_value=[self._job()],
            ),
            patch(
                "app.services.analysis_family_workers._owner_cache_ready",
                return_value=True,
            ),
            patch(
                "app.services.time_capacity_workers._ready_pool",
                return_value=FakePool(),
            ),
        ):
            with self.assertRaisesRegex(ValueError, "scientific failure"):
                try_compute_family(
                    None,
                    {"selection": {"entries": []}},
                    None,
                    family="cycles",
                    request_context=context,
                )

    def test_cycles_require_exact_cycle_cache_and_do_not_dispatch_when_missing(self):
        cell = WorkerCell(id=7, name="Cell 7")
        source = self._job().request_context.files_by_cell[7][0]
        context = SimpleNamespace(
            cells=(cell,),
            files_by_cell={7: (source,)},
            parser_versions_by_cell={7: {source.hash: "neware-nda:1"}},
        )
        with (
            patch("app.services.cache.pending_hashes", return_value=set()),
            patch("app.services.cache.raw_path", return_value=Path(__file__)),
            patch("app.services.cache.has_cycles", return_value=False),
        ):
            self.assertFalse(
                _owner_cache_ready(
                    context,
                    family="cycles",
                    calc_version="calc-current",
                )
            )

        cells = tuple(WorkerCell(id=index, name=f"Cell {index}") for index in range(4))
        request_context = SimpleNamespace(
            units=tuple({"cell": cell, "label": cell.name} for cell in cells),
            cells=cells,
        )
        with (
            patch("app.services.analysis_engine.ensure_canonical_cycling_available"),
            patch(
                "app.services.analysis_family_workers._owner_cache_ready",
                return_value=False,
            ),
            patch(
                "app.services.analysis_family_workers._worker_jobs"
            ) as worker_jobs,
            patch("app.services.time_capacity_workers._ready_pool") as ready_pool,
        ):
            result = try_compute_family(
                None,
                {"selection": {"entries": []}},
                None,
                family="cycles",
                request_context=request_context,
            )
        self.assertIsNone(result)
        worker_jobs.assert_not_called()
        ready_pool.assert_not_called()

    def test_rate_p4_merge_matches_serial_replicate_group_selection_contexts(self):
        cell_ids = [1, 2, 3, 4]
        results = []
        for ordinal, cell_id in enumerate(cell_ids):
            results.append(
                {
                    "ordinal": ordinal,
                    "result": {
                        "cells": [{"cell_id": cell_id, "cell_name": f"Cell {cell_id}"}],
                        "blocks": [],
                        "detected_blocks": [],
                        "config": {"rate_tolerance_fraction": 0.03},
                        "selection_contexts": [
                            {
                                "cell_id": cell_id,
                                "entry_kind": "replicate_group",
                                "entry_ref_id": 77,
                            }
                        ],
                        "badges": [],
                        "sources": [],
                        "invalid_execution_count": 0,
                    },
                }
            )
        spec = {
            "selection": {
                "entries": [{"kind": "replicate_group", "ref_id": 77}],
                "hidden_replicate_group_ids": [88],
                "exclusions": [
                    {
                        "cell_id": 3,
                        "entry_kind": "replicate_group",
                        "entry_ref_id": 77,
                    }
                ],
            }
        }
        serial_selection_contexts = [
            {
                "cell_id": cell_id,
                "entry_kind": "replicate_group",
                "entry_ref_id": 77,
            }
            for cell_id in cell_ids
        ]
        with patch(
            "app.services.rate_capability.build_common_rate_comparison",
            return_value=([], {}),
        ):
            merged = _merge_rate_capability(results, spec, cell_ids)
        self.assertEqual(
            merged["selection_contexts"],
            serial_selection_contexts,
        )
        self.assertGreaterEqual(len(merged["selection_contexts"]), 4)
        self.assertEqual(spec["selection"]["hidden_replicate_group_ids"], [88])
        self.assertEqual(
            spec["selection"]["exclusions"][0]["entry_kind"],
            "replicate_group",
        )
        self.assertEqual(merged["selection_contexts"][0]["entry_kind"], "replicate_group")

    def test_rss_math_deduplicates_worker_pings_and_includes_parent(self):
        samples = [(101, 100), (101, 125), (202, 200), (202, 225)]
        self.assertEqual(
            _dedupe_worker_rss_samples(samples),
            {101: 125, 202: 225},
        )
        gate = _rss_memory_gate(350, 50, 700, 100)
        self.assertEqual(gate["p4_resident_rss_bytes"], 400)
        self.assertEqual(gate["p8_resident_rss_bytes"], 800)
        self.assertEqual(gate["ratio"], 2.0)
        self.assertFalse(gate["ok"])


class CyclesRouteContextTests(unittest.TestCase):
    def test_small_cycle_misses_build_one_context_for_helper_and_serial_fallback(self):
        for cell_count in (1, 3):
            with self.subTest(cell_count=cell_count):
                context = SimpleNamespace(
                    units=[{"cell": SimpleNamespace(id=index, name=f"Cell {index}")} for index in range(cell_count)],
                    cells=[SimpleNamespace(id=index, name=f"Cell {index}") for index in range(cell_count)],
                )
                build_calls = []
                helper_calls = []
                compute_calls = []

                class FakeEngine:
                    CALC_VERSION = "calc-test"

                    def build_analysis_request_context(self, *args, **kwargs):
                        build_calls.append((args, kwargs))
                        return context

                    def compute(self, *args, **kwargs):
                        compute_calls.append((args, kwargs))
                        return {"cell_series": [], "badges": []}

                    def build_provenance(self, result):
                        return {}

                fake_cache = SimpleNamespace(
                    result_key=lambda *args, **kwargs: "route-test-key",
                    load_result_body=lambda *args, **kwargs: None,
                    load_result=lambda *args, **kwargs: None,
                    store_result=lambda *args, **kwargs: None,
                )
                analysis = SimpleNamespace(
                    spec={"selection": {"entries": []}},
                    provenance=None,
                    title="route test",
                    modified_at=None,
                )
                db = SimpleNamespace(
                    get=lambda *_args, **_kwargs: analysis,
                    commit=lambda: None,
                )

                def helper(*args, **kwargs):
                    helper_calls.append((args, kwargs))
                    return None

                request = analyses_router.ComputeRequest(recompute=True)
                with (
                    patch.object(analyses_router, "engine", FakeEngine()),
                    patch.object(analyses_router, "analysis_cache", fake_cache),
                    patch.object(analyses_router, "_guard_canonical_cycling"),
                    patch.object(analyses_router, "_finish_job"),
                    patch.object(analyses_router, "fast_json", side_effect=lambda value: value),
                    patch(
                        "app.services.analysis_family_workers.try_compute_family",
                        side_effect=helper,
                    ),
                ):
                    analyses_router.compute_analysis(1, request, db)

                self.assertEqual(len(build_calls), 1)
                self.assertEqual(len(helper_calls), 1)
                self.assertEqual(len(compute_calls), 1)
                self.assertIs(helper_calls[0][1]["request_context"], context)
                self.assertIs(compute_calls[0][1]["request_context"], context)


if __name__ == "__main__":
    unittest.main()
