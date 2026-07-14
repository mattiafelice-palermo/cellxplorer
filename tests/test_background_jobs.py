import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ["CELLXPLORER_DATA"] = str(ROOT / ".test-cellxplorer")
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


if __name__ == "__main__":
    unittest.main()
