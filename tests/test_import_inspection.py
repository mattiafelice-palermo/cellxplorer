import tempfile
import time
import unittest
import sys
import stat
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.services import import_inspection


class ImportInspectionTests(unittest.TestCase):
    def test_worker_bound_is_one_to_four(self):
        self.assertEqual(import_inspection.inspection_worker_count(0), 1)
        self.assertEqual(import_inspection.inspection_worker_count(1), 1)
        self.assertEqual(import_inspection.inspection_worker_count(3), 3)
        self.assertEqual(import_inspection.inspection_worker_count(1000), 4)

    def test_strategy_keeps_small_batches_serial(self):
        self.assertEqual(import_inspection.inspection_strategy(25), "serial")
        self.assertEqual(import_inspection.inspection_strategy(26), "multiprocessing")

    def test_sampled_estimate_uses_selected_worker_count(self):
        self.assertAlmostEqual(
            import_inspection.inspection_estimate_seconds(1.0, 10, "serial", 1),
            10.0,
        )
        self.assertAlmostEqual(
            import_inspection.inspection_estimate_seconds(1.0, 100, "multiprocessing", 4),
            25.75,
        )

    def test_small_batch_reuses_first_sample_and_reports_reading_phases(self):
        paths = [f"file-{index}.ndax" for index in range(3)]
        calls = []
        phases = []

        def fake_inspect(path: str):
            calls.append(path)
            index = int(Path(path).stem.split("-")[1])
            return import_inspection.FileInspection(path, Path(path).name, index, index, "ndax", str(index), {})

        with patch.object(import_inspection, "inspect_file", side_effect=fake_inspect):
            result = import_inspection.inspect_files(paths, on_phase=phases.append)

        self.assertEqual([item.path for item in result], paths)
        self.assertEqual(calls, paths)
        self.assertEqual([event["phase"] for event in phases], ["sampling", "sampling", "reading", "reading", "reading"])
        self.assertFalse(any(event["phase"] == "starting_workers" for event in phases))
        self.assertEqual(
            [event["progress_percent"] for event in phases],
            sorted(event["progress_percent"] for event in phases),
        )

    def test_large_batch_reports_worker_startup_before_reads(self):
        paths = [f"file-{index}.ndax" for index in range(26)]
        phases = []

        def fake_inspect(path: str):
            index = int(Path(path).stem.split("-")[1])
            return import_inspection.FileInspection(path, Path(path).name, index, index, "ndax", str(index), {})

        with patch.object(import_inspection, "inspect_file", side_effect=fake_inspect), \
            patch.object(import_inspection.time, "sleep") as sleep:
            result = import_inspection.inspect_files(
                paths,
                on_phase=phases.append,
                executor_cls=ThreadPoolExecutor,
            )

        self.assertEqual(len(result), len(paths))
        startup = [event for event in phases if event["phase"] == "starting_workers"]
        self.assertEqual([event["phase_current"] for event in startup], [1, 2, 3, 4])
        self.assertEqual(startup[-1]["strategy"], "multiprocessing")
        self.assertEqual(startup[-1]["worker_count"], 4)
        self.assertTrue(any(event["phase"] == "reading" for event in phases))
        self.assertEqual(sleep.call_count, 4)
        self.assertEqual(
            [event["progress_percent"] for event in phases],
            sorted(event["progress_percent"] for event in phases),
        )
        self.assertTrue(
            all(
                import_inspection.cached_header_metadata(str(index), index, index) == {}
                for index in range(1, 26)
            )
        )

    def test_parallel_results_restore_input_order(self):
        paths = [f"file-{index}.ndax" for index in range(8)]

        def fake_inspect(path: str):
            index = int(Path(path).stem.split("-")[1])
            time.sleep((7 - index) * 0.001)
            return import_inspection.FileInspection(path, Path(path).name, index, index, "ndax", str(index), {})

        completed = []
        with patch.object(import_inspection, "inspect_file", side_effect=fake_inspect):
            result = import_inspection.inspect_files(
                paths,
                on_completed=completed.append,
                executor_cls=ThreadPoolExecutor,
            )

        self.assertEqual([item.path for item in result], paths)
        self.assertCountEqual(completed, paths)

    def test_moving_file_is_rejected_between_stat_snapshots(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "cell.ndax"
            path.write_bytes(b"data")
            first = SimpleNamespace(st_mode=stat.S_IFREG, st_size=4, st_mtime_ns=1)
            second = SimpleNamespace(st_mode=stat.S_IFREG, st_size=5, st_mtime_ns=1)
            with patch.object(Path, "stat", side_effect=[first, second]):
                with patch.object(import_inspection.parsing, "compute_hash", return_value="hash"), \
                    patch.object(import_inspection.parsing, "read_header_metadata", return_value={}):
                    with self.assertRaisesRegex(ValueError, "changed during inspection"):
                        import_inspection.inspect_file(str(path))

    def test_xlsx_inspection_rejects_a_source_that_changes_during_metadata_read(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "cell.xlsx"
            path.write_bytes(b"data")
            first = SimpleNamespace(st_mode=stat.S_IFREG, st_size=4, st_mtime_ns=1)
            second = SimpleNamespace(st_mode=stat.S_IFREG, st_size=5, st_mtime_ns=1)
            with patch.object(Path, "stat", side_effect=[first, second]):
                with patch.object(import_inspection.parsing, "compute_hash", return_value="hash"), \
                    patch.object(
                        import_inspection.parsing,
                        "read_header_metadata",
                        return_value={"source_format": "Neware Excel"},
                    ):
                    with self.assertRaisesRegex(ValueError, "changed during inspection"):
                        import_inspection.inspect_file(str(path))

    def test_exact_and_soft_match_rules_are_pure(self):
        candidate = import_inspection.ImportMatchCandidate(
            source_file_id=7,
            hash="exact",
            filename="old.ndax",
            barcode="barcode",
            channel="3",
            start_time="2025-01-01",
            remarks="remark",
            registered=True,
            archived=False,
            cell_id=9,
            cell_name="Cell 9",
            test_id=10,
            test_name="Imported file",
            path="C:/old.ndax",
            location_status="online",
            parse_status="unparsed",
        )
        snapshot = import_inspection.ImportIdentitySnapshot(
            exact_by_hash={candidate.hash: candidate},
            soft_candidates=(candidate,),
        )
        exact = import_inspection.match_import(snapshot, "exact", "new.ndax", {})
        self.assertEqual(exact["kind"], "exact_duplicate")
        soft = import_inspection.match_import(
            snapshot,
            "new-hash",
            "old.ndax",
            {"barcode": "barcode", "channel": "3"},
        )
        self.assertEqual(soft["kind"], "possible_update")

    def test_archived_exact_match_is_not_a_duplicate(self):
        candidate = import_inspection.ImportMatchCandidate(
            source_file_id=1, hash="archived", filename="old.ndax", barcode=None,
            channel=None, start_time=None, remarks=None, registered=False, archived=True,
            cell_id=2, cell_name="Archived", test_id=3, test_name="Imported file",
            path="C:/old.ndax", location_status="online", parse_status="unparsed",
        )
        snapshot = import_inspection.ImportIdentitySnapshot({"archived": candidate}, (candidate,))
        self.assertIsNone(import_inspection.match_import(snapshot, "archived", "old.ndax", {}))


if __name__ == "__main__":
    unittest.main()
