import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.services import background_jobs


class BackgroundJobTests(unittest.TestCase):
    def setUp(self):
        background_jobs.clear_jobs()

    def tearDown(self):
        background_jobs.clear_jobs()

    def test_job_progress_and_item_details_are_reported(self):
        job_id = background_jobs.create_job(
            kind="capacity_summary",
            title="Capacity totals",
            description="Calculating totals",
            total=2,
            items=[
                {"id": 1, "label": "a.ndax"},
                {"id": 2, "label": "b.ndax"},
            ],
        )
        background_jobs.update_item(job_id, 1, status="processing")
        background_jobs.record_result(
            job_id,
            1,
            status="ready",
            detail="Capacity totals ready",
            counter="ready",
        )
        background_jobs.update_job(job_id, status="completed")

        job = background_jobs.list_jobs()[0]
        self.assertEqual(job["completed"], 1)
        self.assertEqual(job["counters"], {"ready": 1})
        self.assertEqual(job["items"][0]["status"], "ready")
        self.assertEqual(job["items"][1]["status"], "queued")
        self.assertIsNotNone(job["completed_at"])

    def test_append_items_extends_total_without_resetting_progress(self):
        job_id = background_jobs.create_job(
            kind="cache_warmup",
            title="Preparing cache",
            description="Working",
            total=1,
            items=[{"id": "first", "label": "First"}],
        )
        background_jobs.record_result(job_id, "first", status="ready", counter="ready")

        background_jobs.append_items(
            job_id,
            [{"id": "second", "label": "Second"}],
            total_increment=1,
        )

        job = background_jobs.get_job(job_id)
        self.assertEqual(job["total"], 2)
        self.assertEqual(job["completed"], 1)
        self.assertEqual([item["id"] for item in job["items"]], ["first", "second"])

    def test_terminal_job_clears_current_item(self):
        job_id = background_jobs.create_job(
            kind="import_inspect",
            title="Inspecting",
            description="Working",
            total=1,
            items=[{"id": "a", "label": "a.ndax"}],
        )
        background_jobs.update_job(
            job_id,
            stage="inspect",
            current_item_id="a",
            current_item_label="a.ndax",
        )
        background_jobs.update_job(job_id, status="completed")
        job = background_jobs.get_job(job_id)
        self.assertIsNone(job["current_item_id"])
        self.assertIsNone(job["current_item_label"])


    def test_jobs_are_findable_by_client_token(self):
        """Compute endpoints open a job only when the cache misses.

        The client cannot be handed an id up front, so it sends a token and
        polls for it. Until real work starts there is deliberately no job, and
        that absence must read as "nothing to show" rather than an error.
        """
        self.assertIsNone(background_jobs.find_by_token("never-used"))

        job_id = background_jobs.create_job(
            kind="analysis_compute",
            title="Preparing Demo (cycle plot)",
            description="Reading cell data",
            total=1,
            token="tok-1",
        )
        found = background_jobs.find_by_token("tok-1")
        self.assertIsNotNone(found)
        self.assertEqual(found["id"], job_id)

        # Tokens do not collide with untokenized jobs.
        background_jobs.create_job(
            kind="analysis_compute", title="Other", description="", total=1
        )
        self.assertEqual(background_jobs.find_by_token("tok-1")["id"], job_id)
        self.assertIsNone(background_jobs.find_by_token(None))

    def test_finish_job_marks_recognition_items_ready_without_cache_counters(self):
        """Uncached recognition must not leave Activity rows badged 'queued'."""
        from app.routers.analyses import _finish_job, _recognition_progress_callback

        job_id = background_jobs.create_job(
            kind="analysis_compute",
            title="Preparing Demo (rate capability plot)",
            description="Reading cell data",
            total=2,
            items=[
                {"id": 1, "label": "Cell A", "status": "queued"},
                {"id": 2, "label": "Cell B", "status": "queued"},
            ],
        )
        progress = _recognition_progress_callback(job_id)
        progress(4, 8, "Cell A", "Building blocks")
        progress(8, 8, "Cell B", "Rate sweeps detected")

        _finish_job(job_id, cached=False)
        job = background_jobs.get_job(job_id)
        self.assertEqual(job["status"], "completed")
        self.assertEqual(job["completed"], job["total"])
        self.assertEqual(job["description"], "Recognition complete")
        self.assertEqual(job["counters"], {})
        for item in job["items"]:
            self.assertEqual(item["status"], "ready")
            self.assertEqual(item["detail"], "Recognition complete")

    def test_finish_job_cached_path_still_counts_cached_reads(self):
        """Cycle-tab cache hits must keep the cached/re-parsed Activity summary."""
        from app.routers.analyses import _finish_job

        job_id = background_jobs.create_job(
            kind="analysis_compute",
            title="Preparing Demo (cycle plot)",
            description="Reading cell data",
            total=2,
            items=[
                {"id": 1, "label": "Cell A", "status": "queued"},
                {"id": 2, "label": "Cell B", "status": "queued"},
            ],
        )
        _finish_job(job_id, cached=True)
        job = background_jobs.get_job(job_id)
        self.assertEqual(job["status"], "completed")
        self.assertEqual(job["description"], "Loaded cached plot data")
        self.assertEqual(job["counters"], {"cached": 2})
        for item in job["items"]:
            self.assertEqual(item["status"], "ready")
            self.assertEqual(item["detail"], "Loaded from persistent cache")


if __name__ == "__main__":
    unittest.main()
