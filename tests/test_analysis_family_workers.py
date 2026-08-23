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

from app.services.analysis_family_workers import (
    FamilyWorkerJob,
    WorkerCell,
    WorkerRequestContext,
    WorkerSource,
    try_compute_family,
    worker_job_has_forbidden_state,
)


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


if __name__ == "__main__":
    unittest.main()
