from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
os.environ["CELLXPLORER_DATA"] = str(ROOT / ".test-cellxplorer")
sys.path.insert(0, str(ROOT / "backend"))

from app.services import download_registry


class DownloadRegistryTests(unittest.TestCase):
    def _isolate(self, folder: Path):
        return patch.object(download_registry, "_PATH", folder / "downloads-history.json")

    def test_record_and_list_reports_existence(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            with self._isolate(folder):
                present = folder / "plot.png"
                present.write_bytes(b"x" * 10)
                download_registry.record(filename="plot.png", path=str(present))
                download_registry.record(filename="gone.csv", path=str(folder / "gone.csv"))

                entries = download_registry.list_entries()
                self.assertEqual([e["filename"] for e in entries], ["gone.csv", "plot.png"])
                by_name = {e["filename"]: e for e in entries}
                self.assertFalse(by_name["gone.csv"]["exists"])
                self.assertTrue(by_name["plot.png"]["exists"])
                self.assertEqual(by_name["plot.png"]["kind"], "image")
                self.assertEqual(by_name["gone.csv"]["kind"], "data")

    def test_repeated_path_collapses_to_top(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            with self._isolate(folder):
                path = str(folder / "report.html")
                download_registry.record(filename="report.html", path=path)
                download_registry.record(filename="other.png", path=str(folder / "other.png"))
                download_registry.record(filename="report.html", path=path)
                entries = download_registry.list_entries()
                self.assertEqual(len(entries), 2)
                self.assertEqual(entries[0]["filename"], "report.html")

    def test_path_less_browser_downloads_each_keep_a_row(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            with self._isolate(folder):
                download_registry.record(filename="first.png", path="")
                download_registry.record(filename="second.png", path="")
                entries = download_registry.list_entries()
                self.assertEqual([e["filename"] for e in entries], ["second.png", "first.png"])

    def test_delete_entry_removes_file_when_requested(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            with self._isolate(folder):
                target = folder / "delete-me.pdf"
                target.write_bytes(b"data")
                entry = download_registry.record(filename="delete-me.pdf", path=str(target))

                result = download_registry.delete_entry(entry["id"], delete_file=True)
                self.assertTrue(result["removed"])
                self.assertTrue(result["deleted_file"])
                self.assertFalse(target.exists())
                self.assertEqual(download_registry.list_entries(), [])

    def test_delete_entry_keeps_file_when_not_requested(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            with self._isolate(folder):
                target = folder / "keep.pdf"
                target.write_bytes(b"data")
                entry = download_registry.record(filename="keep.pdf", path=str(target))

                result = download_registry.delete_entry(entry["id"], delete_file=False)
                self.assertTrue(result["removed"])
                self.assertFalse(result["deleted_file"])
                self.assertTrue(target.exists())

    def test_file_endpoint_serves_recorded_downloads_only(self):
        from fastapi import HTTPException

        from app.routers import settings as settings_router

        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            with self._isolate(folder):
                target = folder / "plot.png"
                target.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 32)
                entry = download_registry.record(filename="plot.png", path=str(target))

                response = settings_router.read_download(entry["id"])
                self.assertEqual(Path(response.path), target)

                # Unknown ids are rejected: the path always comes from the
                # registry, never from the request.
                with self.assertRaises(HTTPException) as unknown:
                    settings_router.read_download("not-a-real-id")
                self.assertEqual(unknown.exception.status_code, 404)

                # An entry whose file disappeared reports 404 rather than
                # raising an OS error.
                target.unlink()
                with self.assertRaises(HTTPException) as gone:
                    settings_router.read_download(entry["id"])
                self.assertEqual(gone.exception.status_code, 404)

    def test_mark_seen_clears_the_badge_flag(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            with self._isolate(folder):
                entry = download_registry.record(filename="fresh.png", path=str(folder / "fresh.png"))
                self.assertFalse(entry["seen"])

                self.assertTrue(download_registry.mark_seen(entry["id"]))
                self.assertTrue(download_registry.list_entries()[0]["seen"])
                # Acknowledging twice is harmless, and unknown ids report False.
                self.assertTrue(download_registry.mark_seen(entry["id"]))
                self.assertFalse(download_registry.mark_seen("not-a-real-id"))

    def test_entries_written_before_seen_existed_do_not_count(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            with self._isolate(folder):
                download_registry._write(
                    [{"id": "old", "filename": "legacy.csv", "path": "", "kind": "data",
                      "bytes": None, "created_at": "2026-01-01T00:00:00+00:00"}]
                )
                self.assertTrue(download_registry.list_entries()[0]["seen"])

    def test_missing_entry_reports_not_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            with self._isolate(folder):
                result = download_registry.delete_entry("nope", delete_file=True)
                self.assertFalse(result["removed"])


if __name__ == "__main__":
    unittest.main()
