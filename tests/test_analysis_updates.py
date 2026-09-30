from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.db import Base
from app.models import ActivityEvent, Analysis, Cell, SourceFile, Test, TestFile
from app.services import analysis_updates, background_jobs, cache_maintenance


class AnalysisUpdatesTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://")
        Base.metadata.create_all(self.engine)
        self.factory = sessionmaker(bind=self.engine, expire_on_commit=False)
        self.db = self.factory()
        self.db.add_all([Cell(id=1, name="Cell A"), Cell(id=2, name="Cell B"),
                         Analysis(id=1, title="Cycling", spec={}), Analysis(id=2, title="Bump", spec={})])
        for i in (1, 2):
            self.db.add_all([Test(id=i, cell_id=i, name=f"internal {i}"),
                             SourceFile(id=i, hash=str(i) * 64, path=f"missing-{i}.ndax",
                                        filename=f"{i}.ndax", size=10, ext="ndax", parse_status="parsed")])
        self.db.flush()
        self.db.add_all([TestFile(test_id=i, file_id=i, position=0) for i in (1, 2)])
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    def record(self, cell_id=1, source_id=1, titles=None, batch="first", cycles=5):
        analysis_updates.record_analysis_update(self.db, cell_id=cell_id, source_id=source_id,
            analysis_titles=titles if titles is not None else {1: "Cycling"}, batch_key=batch, added_cycles=cycles)
        self.db.commit()

    def read(self):
        with patch.object(cache_maintenance.warmup, "analysis_activity_states", return_value={}):
            return analysis_updates.list_analysis_updates(self.db)

    def test_batch_deduplicates_cells_sources_and_analysis_membership(self):
        self.record(titles={1: "Cycling", 2: "Bump"})
        self.record(cell_id=2, source_id=2, cycles=8)
        self.record(titles={1: "Cycling", 2: "Bump"})
        notice, = self.read()
        self.assertEqual(notice["cell_count"], 2)
        self.assertEqual(notice["analyses"][0]["cell_ids"], [1, 2])
        self.assertEqual(notice["analyses"][0]["added_cycles"], 13)
        self.assertEqual(notice["analyses"][1]["added_cycles"], 5)

    def test_separate_runs_never_merge_and_survive_session_restart(self):
        self.record()
        self.record(batch="second")
        self.db.close()
        self.db = self.factory()
        notices = self.read()
        self.assertEqual(len(notices), 2)
        self.assertGreater(notices[0]["id"], notices[1]["id"])

    def test_unknown_delta_omits_partial_total(self):
        self.record()
        self.record(cell_id=2, source_id=2, cycles=None)
        self.assertIsNone(self.read()[0]["analyses"][0]["added_cycles"])

    def test_unreferenced_update_creates_no_notice(self):
        self.record(titles={})
        self.assertEqual(self.read(), [])

    def test_status_tracks_data_preparation_error_rename_and_removal(self):
        self.record()
        source = self.db.get(SourceFile, 1)
        source.parse_status = "pending"
        self.db.commit()
        self.assertEqual(self.read()[0]["analyses"][0]["status"], "preparing_data")
        source.parse_status = "error"
        self.db.commit()
        self.assertEqual(self.read()[0]["analyses"][0]["status"], "needs_attention")
        source.parse_status = "parsed"
        self.db.get(Analysis, 1).title = "Renamed"
        self.db.commit()
        self.assertEqual(self.read()[0]["analyses"][0]["title"], "Renamed")
        self.db.delete(self.db.get(Analysis, 1))
        self.db.commit()
        row = self.read()[0]["analyses"][0]
        self.assertEqual(row["status"], "removed")
        self.assertEqual(row["title"], "Cycling")

    def test_invalidation_emits_only_for_new_source_data(self):
        self.db.get(Analysis, 1).spec = {"selection": {"entries": [{"kind": "cell", "ref_id": 1}]}}
        self.db.commit()
        with patch.object(cache_maintenance.analysis_cache, "delete_analysis_artifacts"):
            for reason in ("cell_edit", "source_order_changed", "continuation_detached"):
                cache_maintenance.invalidate_cell_dependents(self.db, 1, queue_warmup=False, reason=reason)
            self.assertEqual(self.db.query(ActivityEvent).filter(ActivityEvent.action == analysis_updates.ACTION).count(), 0)
            cache_maintenance.invalidate_cell_dependents(self.db, 1, queue_warmup=False, reason="continuation_attached")
            self.db.commit()
            self.assertEqual(len(self.read()), 1)

    def test_cheap_read_never_probes_caches(self):
        self.record()
        with patch.object(cache_maintenance.analysis_cache, "saved_plot_data_signature", side_effect=AssertionError("Cache probe")):
            self.assertEqual(self.read()[0]["analyses"][0]["status"], "ready")
        self.assertEqual(len(analysis_updates.list_analysis_updates(self.db, limit=0)), 1)

    def test_detached_source_detected_even_when_original_remains(self):
        self.db.add(SourceFile(id=3, hash="3" * 64, path="tail.ndax", filename="tail.ndax", size=1, ext="ndax", parse_status="parsed"))
        self.db.flush()
        link = TestFile(test_id=1, file_id=3, position=1)
        self.db.add(link)
        analysis_updates.record_analysis_update(self.db, cell_id=1, source_id=3, source_ids=[1, 3], analysis_titles={1: "Cycling"})
        self.db.commit()
        self.assertEqual(self.read()[0]["analyses"][0]["status"], "ready")
        self.db.delete(link)
        self.db.commit()
        self.assertEqual(self.read()[0]["analyses"][0]["status"], "changed_since_update")

    def test_all_task_outcomes_survive_processing_detail_cap(self):
        coordinator = cache_maintenance.WarmupCoordinator()
        tasks = [{"id": f"1:p{i}:1", "analysis_id": 1, "analysis_title": "Cycling", "plot_id": f"p{i}", "plot_title": "Plot", "expected_data_signature": "signature"} for i in range(205)]
        coordinator._tasks = tasks
        coordinator._job_id = background_jobs.create_job(kind="cache_warmup", title="Cache", description="Preparing", total=len(tasks), items=coordinator._job_items(tasks))
        try:
            with patch.object(coordinator, "_is_current", return_value=True), patch.object(cache_maintenance.analysis_cache, "load_latest_thumbnail", return_value=b"image"), patch.object(cache_maintenance.analysis_cache, "store_prepared_marker"):
                for task in tasks:
                    coordinator.next_task(self.db)
                    coordinator.complete(task["id"], status="ready", detail=None, error=None, db=self.db)
            self.assertEqual(coordinator.analysis_activity_states({1})[1], "ready")
            self.assertLessEqual(len(background_jobs.get_job(coordinator._job_id)["items"]), 200)
        finally:
            background_jobs.clear_jobs()

    def test_latest_generation_and_foreground_ready_override_old_failure(self):
        coordinator = cache_maintenance.WarmupCoordinator()
        coordinator._tasks = [{"id": "old", "analysis_id": 1, "plot_id": "p", "activity_state": "failed"}, {"id": "new", "analysis_id": 1, "plot_id": "p"}]
        coordinator._next_index = 1
        coordinator._job_id = background_jobs.create_job(kind="cache_warmup", title="Cache", description="Preparing", total=2, items=[])
        try:
            self.assertEqual(coordinator.analysis_activity_states({1})[1], "refreshing")
            coordinator.foreground_ready(1, "p")
            self.assertEqual(coordinator.analysis_activity_states({1})[1], "ready")
            self.assertIsNone(coordinator.next_task(self.db))
            self.assertEqual(coordinator.analysis_activity_states({1})[1], "ready")
            coordinator._tasks[-1]["activity_state"] = "skipped"
            self.assertEqual(coordinator.analysis_activity_states({1})[1], "needs_attention")
            coordinator._tasks[-1]["activity_state"] = "superseded"
            self.assertEqual(coordinator.analysis_activity_states({1})[1], "changed_since_update")
        finally:
            background_jobs.clear_jobs()

    def test_current_queue_paused_failed_and_ready_states(self):
        coordinator = cache_maintenance.WarmupCoordinator()
        background_jobs.clear_jobs()
        try:
            coordinator._tasks = [{"id": "1:p:1", "analysis_id": 1}]
            coordinator._job_id = background_jobs.create_job(kind="cache_warmup", title="Cache", description="Preparing", total=1,
                                                            items=[{"id": "1:p:1", "label": "Plot", "status": "queued"}])
            self.assertEqual(coordinator.analysis_activity_states({1})[1], "refreshing")
            background_jobs.update_job(coordinator._job_id, status="paused")
            self.assertEqual(coordinator.analysis_activity_states({1})[1], "paused")
            background_jobs.update_item(coordinator._job_id, "1:p:1", status="failed")
            self.assertEqual(coordinator.analysis_activity_states({1})[1], "needs_attention")
            background_jobs.update_item(coordinator._job_id, "1:p:1", status="ready")
            self.assertEqual(coordinator.analysis_activity_states({1})[1], "ready")
        finally:
            background_jobs.clear_jobs()


if __name__ == "__main__":
    unittest.main()
