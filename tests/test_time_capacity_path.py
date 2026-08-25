"""Indexed Time/Capacity source planning and selective-read tests (Spec 050.3)."""
from __future__ import annotations

import os
import sys
import tempfile
import threading
import unittest
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.services import cache, canonical_cycling, stitch, time_capacity_path


def raw_frame(labels: list[int], *, rows_per_cycle: int = 3) -> pd.DataFrame:
    cycles = [label for label in labels for _ in range(rows_per_cycle)]
    rows = len(cycles)
    frame = pd.DataFrame(
        {
            "record_index": range(rows),
            "cycle": cycles,
            "step_index": [1 + index % 2 for index in range(rows)],
            "step": [index % 2 for index in range(rows)],
            "status": ["CC_Chg"] * rows,
            "time_s": [float(index % rows_per_cycle) for index in range(rows)],
            "voltage_v": [3.0 + index / 1000 for index in range(rows)],
            "current_ma": [1.0] * rows,
            "charge_capacity_mah": [float(index) for index in range(rows)],
            "discharge_capacity_mah": [0.0] * rows,
            "timestamp": pd.date_range("2026-01-01", periods=rows, freq="s"),
        }
    )
    return frame


class TimeCapacityPathTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.cache_root = Path(self.temp.name)
        self.cache_patch = patch.object(cache, "CACHE_DIR", self.cache_root)
        self.cache_patch.start()
        self.row_group_patch = patch.object(cache, "RAW_CACHE_ROW_GROUP_SIZE", 4)
        self.row_group_patch.start()

    def tearDown(self) -> None:
        self.row_group_patch.stop()
        self.cache_patch.stop()
        self.temp.cleanup()

    def _publish(
        self,
        file_hash: str,
        parser_version: str,
        labels: list[int],
    ) -> stitch.CachedSourceRef:
        frame = raw_frame(labels)
        target = cache.raw_path(file_hash, parser_version)
        cache._publish_optimized_raw(frame, target, parser_version)
        return stitch.CachedSourceRef(file_hash, parser_version)

    def test_projection_is_explicit_and_excludes_unused_timestamp(self) -> None:
        available = list(canonical_cycling.REQUIRED_CYCLING_COLUMNS) + [
            "working_potential_v",
            "counter_potential_v",
            "timestamp",
            "charge_energy_mwh",
        ]
        self.assertEqual(
            time_capacity_path.time_capacity_raw_columns(available),
            [
                *canonical_cycling.REQUIRED_CYCLING_COLUMNS,
                "working_potential_v",
                "counter_potential_v",
            ],
        )

    def test_compact_request_projection_only_reads_consumed_columns(self) -> None:
        available = [
            *canonical_cycling.REQUIRED_CYCLING_COLUMNS,
            "working_potential_v",
            "counter_potential_v",
            "timestamp",
        ]
        expected_time = [
            "record_index",
            "cycle",
            "status",
            "time_s",
            "voltage_v",
            "current_ma",
        ]
        self.assertEqual(
            time_capacity_path.time_capacity_request_columns(
                available,
                {"view": "voltage_current", "x_axis": "time"},
                precision="standard",
                compact=True,
            ),
            expected_time,
        )
        self.assertEqual(
            time_capacity_path.time_capacity_request_columns(
                available,
                {"view": "voltage_current", "x_axis": "capacity_mah"},
                precision="standard",
                compact=True,
            ),
            [
                *expected_time,
                "charge_capacity_mah",
                "discharge_capacity_mah",
            ],
        )
        self.assertEqual(
            time_capacity_path.time_capacity_request_columns(
                available,
                {
                    "view": "voltage_current",
                    "x_axis": "time",
                    "voltage_channels": [
                        "voltage",
                        "working_potential",
                        "counter_potential",
                    ],
                },
                precision="standard",
                compact=True,
            ),
            [
                "record_index",
                "cycle",
                "status",
                "time_s",
                "voltage_v",
                "current_ma",
                "working_potential_v",
                "counter_potential_v",
            ],
        )
        self.assertEqual(
            time_capacity_path.time_capacity_request_columns(
                available,
                {"view": "dqdv", "x_axis": "capacity_mah"},
                precision="standard",
                compact=True,
            ),
            [
                *expected_time,
                "charge_capacity_mah",
                "discharge_capacity_mah",
            ],
        )
        self.assertEqual(
            time_capacity_path.time_capacity_request_columns(
                available,
                {"view": "voltage_current", "x_axis": "time"},
                precision="standard",
                compact=True,
                protocol_active=True,
            ),
            [
                "record_index",
                "cycle",
                "step_index",
                "status",
                "time_s",
                "voltage_v",
                "current_ma",
            ],
        )
        self.assertEqual(
            time_capacity_path.time_capacity_request_columns(
                available,
                {"view": "voltage_current", "x_axis": "time"},
                precision="full",
                compact=False,
            ),
            time_capacity_path.time_capacity_raw_columns(available),
        )

    def test_indexed_reader_honors_request_projection(self) -> None:
        ref = self._publish("a" * 64, "parser-a", [1, 2])
        plan = time_capacity_path.build_time_capacity_stitch_plan([ref])
        requested = time_capacity_path.time_capacity_request_columns(
            plan.sources[0].index["raw_column_names"],
            {"view": "voltage_current", "x_axis": "time"},
            precision="standard",
            compact=True,
        )

        with patch.object(cache, "load_raw_cycles", wraps=cache.load_raw_cycles) as reader:
            selected = time_capacity_path.load_indexed_time_capacity_raw(
                plan,
                [1],
                requested_columns=requested,
            )

        self.assertIsNotNone(selected)
        self.assertEqual(reader.call_args.args[3], requested)
        self.assertEqual(list(selected.columns), [
            *requested,
            "source_cycle",
            "segment",
            "source_hash",
        ])

    def test_sparse_local_labels_remain_dense_global_labels(self) -> None:
        ref = self._publish("a" * 64, "parser-a", [1, 2, 4])
        diagnostics: dict = {}
        plan = time_capacity_path.build_time_capacity_stitch_plan(
            [ref], diagnostics=diagnostics
        )
        self.assertEqual([1, 2, 3], list(plan.sources[0].cycle_map.values()))

        requested = time_capacity_path.requested_global_cycles(
            plan,
            explicit_cycles=[3],
            cycle_start=1,
            cycle_end=None,
        )
        selected = time_capacity_path.load_indexed_time_capacity_raw(
            plan, requested, diagnostics=diagnostics
        )
        self.assertIsNotNone(selected)
        self.assertEqual(set(selected["cycle"]), {3})
        self.assertEqual(set(selected["source_cycle"]), {4})
        self.assertEqual(diagnostics["source_reads"][0]["requested_source_cycles"], [4])
        self.assertEqual(diagnostics["selected_rows"], 3)

    def test_later_source_request_does_not_read_earlier_source(self) -> None:
        first = self._publish("b" * 64, "parser-a", [1, 2])
        second = self._publish("c" * 64, "parser-b", [7, 9])
        plan = time_capacity_path.build_time_capacity_stitch_plan([first, second])
        self.assertEqual(plan.path, "indexed")

        with patch.object(cache, "load_raw_cycles", wraps=cache.load_raw_cycles) as reader:
            selected = time_capacity_path.load_indexed_time_capacity_raw(plan, [3])

        self.assertIsNotNone(selected)
        self.assertEqual(list(selected["cycle"].unique()), [3])
        self.assertEqual(list(selected["source_cycle"].unique()), [7])
        self.assertEqual(reader.call_count, 1)
        self.assertEqual(reader.call_args.args[0], second.file_hash)
        self.assertEqual(reader.call_args.args[2], (7,))

    def test_indexed_consecutive_time_facts_preserve_later_cycle_origin(self) -> None:
        ref = self._publish("8" * 64, "parser-a", [1, 2, 3, 4])
        plan = time_capacity_path.build_time_capacity_stitch_plan([ref])

        facts = time_capacity_path.consecutive_time_cycle_facts(plan)
        self.assertEqual(facts[1], (0.0, 0.0))
        self.assertEqual(facts[2], (2.0, 0.0))
        self.assertEqual(
            time_capacity_path.consecutive_time_request_facts(plan, [3, 4], 1),
            (4.0, 0.0),
        )

    def test_benchmark_can_wait_for_the_layout_boundary_without_changing_default(self) -> None:
        ref = self._publish("7" * 64, "parser-a", [1, 2])
        plan = time_capacity_path.build_time_capacity_stitch_plan([ref])

        with patch.object(cache, "load_raw_cycles", wraps=cache.load_raw_cycles) as reader:
            selected = time_capacity_path.load_indexed_time_capacity_raw(
                plan,
                [1],
                wait_for_layout=True,
            )

        self.assertIsNotNone(selected)
        self.assertEqual(reader.call_args.kwargs["wait_for_layout"], True)

    def test_range_crossing_boundary_reads_only_contributing_sources(self) -> None:
        first = self._publish("d" * 64, "parser-a", [1, 2])
        second = self._publish("e" * 64, "parser-b", [7, 9])
        plan = time_capacity_path.build_time_capacity_stitch_plan([first, second])
        diagnostics: dict = {}
        selected = time_capacity_path.load_indexed_time_capacity_raw(
            plan, [2, 3], diagnostics=diagnostics
        )

        self.assertIsNotNone(selected)
        self.assertEqual(list(selected["cycle"].unique()), [2, 3])
        self.assertEqual(list(selected["segment"].unique()), [0, 1])
        self.assertEqual(
            [item["requested_source_cycles"] for item in diagnostics["source_reads"]],
            [[2], [7]],
        )

    def test_layout_preparation_does_not_block_legacy_request(self) -> None:
        file_hash = "5" * 64
        parser_version = "legacy-parser"
        frame = raw_frame([1, 2])
        target = cache.raw_path(file_hash, parser_version)
        target.parent.mkdir(parents=True, exist_ok=True)
        frame.to_parquet(target, index=False)
        ref = stitch.CachedSourceRef(file_hash, parser_version)
        expected, _, _ = stitch.stitch_raw([ref])

        preparation_started = threading.Event()
        release_preparation = threading.Event()
        request_finished = threading.Event()
        result: dict[str, object] = {}
        original_publish = cache._publish_optimized_raw

        def blocking_publish(*args, **kwargs):
            preparation_started.set()
            if not release_preparation.wait(10):
                raise TimeoutError("test did not release raw-layout preparation")
            return original_publish(*args, **kwargs)

        def prepare() -> None:
            try:
                result["preparation"] = cache.prepare_raw_layout(file_hash, parser_version)
            except BaseException as exc:  # surface worker failures in the test thread
                result["preparation_error"] = exc

        def request() -> None:
            try:
                read_diagnostics = cache.RawCycleReadDiagnostics()
                result["indexed_read"] = cache.load_raw_cycles(
                    file_hash,
                    parser_version,
                    [1],
                    list(canonical_cycling.REQUIRED_CYCLING_COLUMNS),
                    diagnostics=read_diagnostics,
                    wait_for_layout=False,
                )
                result["indexed_read_status"] = read_diagnostics.status
                result["plan"] = time_capacity_path.build_time_capacity_stitch_plan([ref])
                result["raw"], _, _ = stitch.stitch_raw([ref])
            except BaseException as exc:  # surface worker failures in the test thread
                result["request_error"] = exc
            finally:
                request_finished.set()

        with patch.object(cache, "_publish_optimized_raw", side_effect=blocking_publish):
            preparation_thread = threading.Thread(target=prepare)
            request_thread: threading.Thread | None = None
            preparation_thread.start()
            try:
                self.assertTrue(preparation_started.wait(5))
                request_thread = threading.Thread(target=request)
                request_thread.start()
                self.assertTrue(
                    request_finished.wait(2),
                    "Time/Capacity request waited for layout conversion",
                )
            finally:
                release_preparation.set()
                preparation_thread.join(10)
                if request_thread is not None:
                    request_thread.join(10)

        self.assertFalse(preparation_thread.is_alive())
        self.assertIn("preparation", result)
        self.assertNotIn("preparation_error", result)
        self.assertNotIn("request_error", result)
        self.assertIsNone(result["indexed_read"])
        self.assertEqual(result["indexed_read_status"], "layout_preparing")
        plan = result["plan"]
        self.assertIsInstance(plan, time_capacity_path.TimeCapacityStitchPlan)
        self.assertEqual(plan.path, "legacy")
        pd.testing.assert_frame_equal(result["raw"], expected, check_dtype=False)

        prepared_plan = time_capacity_path.build_time_capacity_stitch_plan([ref])
        self.assertEqual(prepared_plan.path, "indexed")


    def test_missing_middle_source_fails_closed_and_skips_suffix(self) -> None:
        first = self._publish("f" * 64, "parser-a", [1, 2])
        missing = stitch.CachedSourceRef("1" * 64, "parser-missing")
        third = self._publish("2" * 64, "parser-c", [1, 2])
        plan = time_capacity_path.build_time_capacity_stitch_plan([first, missing, third])

        self.assertEqual(plan.path, "missing")
        self.assertEqual(plan.missing, [missing.file_hash])
        self.assertEqual(plan.missing_positions, [1])
        self.assertEqual(plan.skipped_segments, [2])
        self.assertEqual([segment["segment"] for segment in plan.segments], [0])

        with patch.object(cache, "load_raw_cycles") as reader:
            selected = time_capacity_path.load_indexed_time_capacity_raw(plan, [1, 2, 3])
        self.assertIsNotNone(selected)
        self.assertTrue(selected.empty)
        self.assertFalse(stitch.stitch_metadata(selected)["complete"])
        reader.assert_not_called()

    def test_valid_legacy_raw_without_index_uses_legacy_fallback(self) -> None:
        file_hash = "3" * 64
        parser_version = "legacy-parser"
        target = cache.raw_path(file_hash, parser_version)
        target.parent.mkdir(parents=True, exist_ok=True)
        raw_frame([1, 2]).to_parquet(target, index=False)

        plan = time_capacity_path.build_time_capacity_stitch_plan(
            [stitch.CachedSourceRef(file_hash, parser_version)]
        )

        self.assertEqual(plan.path, "legacy")
        self.assertEqual(plan.fallback_reason, "raw_layout_unavailable")
        self.assertEqual(plan.missing, [])

    def test_unknown_requested_cycles_do_not_fabricate_rows(self) -> None:
        ref = self._publish("4" * 64, "parser-a", [1, 2])
        plan = time_capacity_path.build_time_capacity_stitch_plan([ref])
        diagnostics: dict = {}
        selected = time_capacity_path.load_indexed_time_capacity_raw(
            plan, [99], diagnostics=diagnostics
        )

        self.assertIsNotNone(selected)
        self.assertTrue(selected.empty)
        self.assertTrue(stitch.stitch_metadata(selected)["complete"])
        self.assertEqual(diagnostics["selected_rows"], 0)

    def test_extreme_range_endpoints_are_clamped_to_known_cycles(self) -> None:
        ref = self._publish("6" * 64, "parser-a", [1, 2])
        plan = time_capacity_path.build_time_capacity_stitch_plan([ref])
        huge = 10**100

        with self.subTest("upper endpoint"):
            self.assertEqual(
                time_capacity_path.requested_global_cycles(
                    plan,
                    explicit_cycles=[],
                    cycle_start=1,
                    cycle_end=huge,
                ),
                (1, 2),
            )
        with self.subTest("lower endpoint"):
            self.assertEqual(
                time_capacity_path.requested_global_cycles(
                    plan,
                    explicit_cycles=[],
                    cycle_start=-huge,
                    cycle_end=2,
                ),
                (1, 2),
            )
        with self.subTest("wholly above"):
            self.assertEqual(
                time_capacity_path.requested_global_cycles(
                    plan,
                    explicit_cycles=[],
                    cycle_start=huge,
                    cycle_end=huge,
                ),
                (),
            )
        with self.subTest("wholly below"):
            self.assertEqual(
                time_capacity_path.requested_global_cycles(
                    plan,
                    explicit_cycles=[],
                    cycle_start=-huge,
                    cycle_end=-1,
                ),
                (),
            )


class IndexedLegacyTimeCapacityParityTests(unittest.TestCase):
    def test_golden_time_capacity_result_is_equal_on_both_access_paths(self) -> None:
        sys.path.insert(0, str(ROOT / "tests"))
        from golden_analysis_support import GoldenFixtureEnvironment, load_case_spec

        root = ROOT / "tests" / "fixtures" / "golden_analysis"

        def strip_volatile(value):
            if isinstance(value, dict):
                return {
                    key: strip_volatile(item)
                    for key, item in value.items()
                    if key not in {"computed_at", "current_parser_version", "current_calc_version"}
                }
            if isinstance(value, list):
                return [strip_volatile(item) for item in value]
            return value

        with GoldenFixtureEnvironment.create() as environment:
            from app.services import analysis_engine, cache as active_cache

            for case_id, cycle_end in (
                ("time_capacity_baseline", 3),
                ("time_capacity_derivative", 3),
                ("time_capacity_baseline", None),
            ):
                case = {
                    "id": case_id,
                    "kind": "time_capacity",
                    "spec_path": f"specs/{case_id}.json",
                }
                spec = load_case_spec(root, case)
                spec["computation"]["time_capacity"]["cycle_end"] = cycle_end
                indexed = analysis_engine.compute_time_capacity(
                    environment.db,
                    spec,
                    None,
                    precision="full",
                    compact=False,
                )
                with patch.object(active_cache, "try_load_raw_layout_index", return_value=None):
                    legacy = analysis_engine.compute_time_capacity(
                        environment.db,
                        deepcopy(spec),
                        None,
                        precision="full",
                        compact=False,
                    )
                with self.subTest(case=case_id, cycle_end=cycle_end):
                    self.assertEqual(strip_volatile(indexed), strip_volatile(legacy))


class OwnerJobStateIsReadOnlyTests(unittest.TestCase):
    """Spec 052.3 Stage 2: owner-resolved job state is never mutated by a run.

    `_build_jobs` used to `deepcopy` the plan and its diagnostics for every
    Cell. That copy was removed because the read path only ever reads them --
    the process path is isolated by pickle, and `_materialize_read` already
    copies `plan_diagnostics` before handing it to the readers that do mutate
    it.

    This test is what makes that deletion safe, and it matters more than it
    looks: Stage 1 memoizes the validated raw-layout index, so one plan's
    `index` object is now shared across requests. If a future change starts
    mutating owner job state, this test must fail rather than letting one
    request corrupt another's cached index.
    """

    def test_owner_job_state_is_not_mutated_by_a_serial_run(self) -> None:
        import pickle
        from hashlib import sha256

        sys.path.insert(0, str(ROOT / "tests"))
        from golden_analysis_support import GoldenFixtureEnvironment, load_case_spec

        root = ROOT / "tests" / "fixtures" / "golden_analysis"

        def digest(value: object) -> str:
            return sha256(pickle.dumps(value, protocol=pickle.HIGHEST_PROTOCOL)).hexdigest()

        with GoldenFixtureEnvironment.create() as environment:
            from app.services import time_capacity_workers as workers

            for case_id, cycle_end, x_axis in (
                ("time_capacity_baseline", 3, "time"),
                ("time_capacity_baseline", None, "time"),
                ("time_capacity_baseline", None, "capacity_mah"),
            ):
                spec = load_case_spec(root, {
                    "id": case_id,
                    "kind": "time_capacity",
                    "spec_path": f"specs/{case_id}.json",
                })
                spec["computation"]["time_capacity"]["cycle_end"] = cycle_end
                spec["computation"]["time_capacity"]["x_axis"] = x_axis

                built = workers._build_jobs(
                    environment.db,
                    spec,
                    None,
                    use_current_versions=False,
                    viewport_width=1200,
                    precision="standard",
                    compact=True,
                    display_origin_cycle_start=None,
                    display_origin_capacity_by_cell=None,
                    refinement=False,
                    refinement_viewport_x_min=None,
                    refinement_viewport_x_max=None,
                )
                if built is None:
                    continue
                jobs, request, _missing = built

                before = (
                    [digest(job.plan) for job in jobs],
                    [digest(job.plan_diagnostics) for job in jobs],
                    [digest(job.descriptor) for job in jobs],
                    digest(request),
                )

                workers._run_serial(jobs, request)

                after = (
                    [digest(job.plan) for job in jobs],
                    [digest(job.plan_diagnostics) for job in jobs],
                    [digest(job.descriptor) for job in jobs],
                    digest(request),
                )

                with self.subTest(case=case_id, cycle_end=cycle_end, x_axis=x_axis):
                    self.assertEqual(
                        before,
                        after,
                        "a serial run mutated owner-resolved job state; the Spec 052.3 "
                        "Stage 2 deletion of the per-Cell deepcopy is no longer safe",
                    )


if __name__ == "__main__":
    unittest.main()
