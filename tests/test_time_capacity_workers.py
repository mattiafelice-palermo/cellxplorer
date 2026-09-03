import csv
import sys
import tempfile
import time
import unittest
from dataclasses import FrozenInstanceError
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.services import time_capacity_workers as workers
from app.services import analysis_engine


class TimeCapacityWorkerTests(unittest.TestCase):
    def _wait_for_pool_state(self, state: str, timeout: float = 35.0) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if workers._POOL_STATE == state:
                return
            time.sleep(0.05)
        self.fail(f"worker pool did not reach {state!r}; state={workers._POOL_STATE!r}")

    def test_adaptive_budget_uses_width_and_visible_cell_count(self):
        self.assertEqual(analysis_engine.time_capacity_display_budget(4000, 600, 6), 1200)
        self.assertEqual(analysis_engine.time_capacity_display_budget(4000, 1200, 6), 2400)
        self.assertEqual(analysis_engine.time_capacity_display_budget(4000, 2400, 6), 4000)
        self.assertEqual(analysis_engine.time_capacity_display_budget(4000, 320, 20), 800)
        self.assertEqual(analysis_engine.time_capacity_display_budget(100_000, 10_000, 5), 24_000)
        self.assertEqual(analysis_engine.time_capacity_display_budget(100_000, 50_000, 5), 24_000)

    @staticmethod
    def _export_fixture():
        trace = {
            "cell_id": 1,
            "group_id": None,
            "label": "Cell A",
            "cycle": [1, 1, 2],
            "source_cycle": [4, 4, 5],
            "display_x": [0.0, 1.0, 2.0],
            "voltage_v": [3.1234567, 3.2345678, 3.3456789],
            "current_ma": [10.0, 20.0, 30.0],
            "electrode_area_cm2": 2.0,
            "nominal_capacity_mah": 100.0,
            "sources": [{"position": 1, "filename": "cell-a.ndax", "hash": "hash-a"}],
            "source_index": [0, 0, 0],
        }
        plan = {
            "x_title": "Time (min)",
            "traces": [{
                "cell_id": 1,
                "group_id": None,
                "current_name": "Cell A",
                "voltage_series": [{
                    "channel": "voltage",
                    "name": "Cell A",
                    "y_title": "Cell voltage (V)",
                }],
            }],
        }
        settings = {
            "voltage_channel": "voltage",
            "stacked": True,
            "current_left": "current_density",
            "current_right": "c_rate",
            "electrode_area_cm2": None,
        }
        return {"cell_traces": [trace]}, plan, settings

    def test_native_csv_export_crops_the_full_resolution_rows(self):
        result, plan, settings = self._export_fixture()
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "range.csv"
            summary = workers.write_time_capacity_data_export(
                result,
                plan,
                settings,
                destination,
                export_format="csv",
                data_precision="standard",
                x_range=(0.5, 1.5),
            )
            with destination.open("r", encoding="utf-8-sig", newline="") as source:
                rows = list(csv.reader(source))

        self.assertEqual(summary["rows"], 1)
        self.assertEqual(rows[0][:8], [
            "Cell",
            "Global cycle",
            "Local cycle",
            "Source position",
            "Source file",
            "Source hash",
            "Cell A | Time (min)",
            "Cell A | Cell voltage (V)",
        ])
        self.assertEqual(rows[1][:8], [
            "Cell A", "1", "4", "1", "cell-a.ndax", "hash-a", "1", "3.23457"
        ])
        self.assertEqual(rows[1][-4:], ["1", "10", "1", "0.2"])

    def test_native_parquet_export_keeps_full_rows_and_unique_field_names(self):
        import pyarrow.parquet as pq

        result, plan, settings = self._export_fixture()
        duplicate_plan = {
            **plan,
            "traces": [*plan["traces"], {**plan["traces"][0]}],
        }
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "full.parquet"
            summary = workers.write_time_capacity_data_export(
                result,
                duplicate_plan,
                settings,
                destination,
                export_format="parquet",
            )
            table = pq.read_table(destination)

        self.assertEqual(summary["rows"], 3)
        self.assertEqual(table.num_rows, 3)
        self.assertEqual(len(table.column_names), len(set(table.column_names)))
        self.assertIn("Cell (2)", table.column_names)
        self.assertEqual(table.column(table.column_names.index("Cell A | Cell voltage (V)" )).to_pylist(), [
            3.1234567, 3.2345678, 3.3456789
        ])

    def test_workload_gate_is_deterministic_and_bounded(self):
        rich = workers.HostResources(
            logical_cpus=16,
            total_memory_bytes=32 * 1024 * 1024 * 1024,
            available_memory_bytes=16 * 1024 * 1024 * 1024,
        )
        # One Cell is one job: nothing to split, so serial.
        self.assertEqual(
            workers.choose_execution(1, 3_000, resources=rich).reason,
            "single_cell",
        )
        # A 16-CPU host reaches the widest tier, so a selection is not split
        # into rounds against a narrower pool.
        self.assertEqual(
            workers.choose_execution(6, 120_000, resources=rich).workers,
            6,
        )
        self.assertEqual(
            workers.choose_execution(6, 120_000, resources=rich).reason,
            "broad_host_gate_6",
        )
        # An 8-CPU host keeps the previous 4-worker tier.
        eight = workers.HostResources(
            logical_cpus=8,
            total_memory_bytes=32 * 1024 * 1024 * 1024,
            available_memory_bytes=16 * 1024 * 1024 * 1024,
        )
        self.assertEqual(
            workers.choose_execution(6, 120_000, resources=eight).workers,
            4,
        )
        # Spec 052.4: there is no workload floor any more. Small interactive
        # requests are exactly the ones that need the warm pool, and they were
        # the ones the old row threshold excluded.
        for cell_count, rows in ((2, 5_510), (3, 8_231), (4, 10_988), (6, 16_492)):
            decision = workers.choose_execution(cell_count, rows, resources=rich)
            with self.subTest(cells=cell_count, rows=rows):
                self.assertEqual(decision.mode, "process")
                self.assertEqual(decision.workers, 6)
        # A tiny multi-Cell request still parallelizes; only the host gates
        # may reduce it.
        self.assertEqual(
            workers.choose_execution(2, 10, resources=rich).mode,
            "process",
        )
        constrained = workers.HostResources(
            logical_cpus=8,
            total_memory_bytes=2 * 1024 * 1024 * 1024,
            available_memory_bytes=300 * 1024 * 1024,
        )
        self.assertEqual(
            workers.choose_execution(6, 120_000, resources=constrained).workers,
            2,
        )
        unavailable = workers.HostResources(None, None, None)
        self.assertEqual(
            workers.choose_execution(6, 120_000, resources=unavailable).mode,
            "serial",
        )

    def test_owner_descriptor_is_frozen_and_has_no_orm_slot(self):
        descriptor = workers.ResolvedCellDescriptor(
            cell_id=1,
            cell_name="Cell 1",
            label="Cell 1",
            group_id=None,
            group_name=None,
            active_mass_mg=None,
            nominal_capacity_mah=None,
            electrode_area_cm2=None,
            source_names=(("hash", "file.ndax"),),
            source_descriptors=(),
            segments=(),
            missing=(),
            missing_positions=(),
            source_versions=(("hash", "parser"),),
            current_parser_versions=("parser",),
            voltage_facts=(("voltage", True, "cell", None),),
            excluded=False,
        )
        self.assertEqual(descriptor.cell_id, 1)
        self.assertNotIn("db", descriptor.__dataclass_fields__)
        with self.assertRaises(FrozenInstanceError):
            descriptor.cell_id = 2  # type: ignore[misc]

    def test_force_serial_never_starts_a_pool(self):
        workers.shutdown_time_capacity_worker_pool()
        decision = workers.choose_execution(
            6,
            120_000,
            resources=workers.HostResources(
                logical_cpus=16,
                total_memory_bytes=32 * 1024 * 1024 * 1024,
                available_memory_bytes=16 * 1024 * 1024 * 1024,
            ),
            force_serial=True,
        )
        self.assertEqual((decision.mode, decision.workers), ("serial", 1))
        self.assertIsNone(workers._POOL)
        self.assertEqual(workers._POOL_STATE, "stopped")

    def test_warm_pool_requires_distinct_worker_pids(self):
        for worker_count in (2, 4):
            workers.shutdown_time_capacity_worker_pool()
            pool = workers._new_pool(worker_count)
            try:
                pids = workers._warm_pool(pool, worker_count)
                self.assertGreaterEqual(len(pids), worker_count)
            finally:
                pool.shutdown(wait=True, cancel_futures=True)

    def test_startup_publishes_only_a_ready_reusable_pool(self):
        workers.shutdown_time_capacity_worker_pool()
        decision = workers.ExecutionDecision(
            "process",
            2,
            "focused_warmup",
            logical_cpus=16,
            total_memory_bytes=32 * 1024 * 1024 * 1024,
            available_memory_bytes=16 * 1024 * 1024 * 1024,
        )
        try:
            with patch.object(workers, "choose_execution", return_value=decision):
                workers.start_time_capacity_worker_pool()
                self._wait_for_pool_state("ready")
            pool = workers._POOL
            self.assertIsNotNone(pool)
            self.assertEqual(workers._POOL_WORKERS, 2)
            with patch.object(
                workers,
                "_new_pool",
                side_effect=AssertionError("ready dispatch must not create a pool"),
            ):
                self.assertIs(workers._ready_pool(2), pool)
        finally:
            workers.shutdown_time_capacity_worker_pool()
        self.assertEqual(workers._POOL_STATE, "stopped")
        self.assertIsNone(workers._POOL)
        self.assertIsNone(workers._WARMUP_THREAD)

    def test_warmup_failure_selects_serial_until_shutdown(self):
        workers.shutdown_time_capacity_worker_pool()
        decision = workers.ExecutionDecision(
            "process",
            2,
            "focused_warmup",
            logical_cpus=16,
            total_memory_bytes=32 * 1024 * 1024 * 1024,
            available_memory_bytes=16 * 1024 * 1024 * 1024,
        )
        try:
            with patch.object(workers, "choose_execution", return_value=decision), patch.object(
                workers,
                "_warm_pool",
                side_effect=RuntimeError("focused warmup failure"),
            ):
                workers.start_time_capacity_worker_pool()
                self._wait_for_pool_state("failed")
            self.assertIsNone(workers._POOL)
            with self.assertRaises(workers.PoolNotReadyError) as raised:
                workers._ready_pool(2)
            self.assertEqual(raised.exception.reason, "pool_failed_serial")
        finally:
            workers.shutdown_time_capacity_worker_pool()


if __name__ == "__main__":
    unittest.main()
