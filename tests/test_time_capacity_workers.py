import sys
import unittest
from dataclasses import FrozenInstanceError
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.services import time_capacity_workers as workers
from app.services import analysis_engine


class TimeCapacityWorkerTests(unittest.TestCase):
    def test_adaptive_budget_uses_width_and_visible_cell_count(self):
        self.assertEqual(analysis_engine.time_capacity_display_budget(4000, 600, 6), 1200)
        self.assertEqual(analysis_engine.time_capacity_display_budget(4000, 1200, 6), 2400)
        self.assertEqual(analysis_engine.time_capacity_display_budget(4000, 2400, 6), 4000)
        self.assertEqual(analysis_engine.time_capacity_display_budget(4000, 320, 20), 800)

    def test_workload_gate_is_deterministic_and_bounded(self):
        rich = workers.HostResources(
            logical_cpus=16,
            total_memory_bytes=32 * 1024 * 1024 * 1024,
            available_memory_bytes=16 * 1024 * 1024 * 1024,
        )
        self.assertEqual(
            workers.choose_execution(1, 3_000, resources=rich).reason,
            "small_cell_count",
        )
        self.assertEqual(
            workers.choose_execution(6, 120_000, resources=rich).workers,
            4,
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


if __name__ == "__main__":
    unittest.main()
