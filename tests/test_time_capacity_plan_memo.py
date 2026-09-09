"""Source-only planning reuse retains live index guards and request ownership."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from dataclasses import replace
import json
import os
from pathlib import Path
import pickle
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.services import cache, stitch, time_capacity_path as planning
from tests.test_time_capacity_path import raw_frame


class SourcePlanMemoTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.enterContext(patch.object(cache, "CACHE_DIR", self.root))
        self.enterContext(patch.object(cache, "RAW_CACHE_ROW_GROUP_SIZE", 4))
        cache.clear_raw_layout_index_cache()
        planning.clear_source_plan_memo()
        self.addCleanup(cache.clear_raw_layout_index_cache)
        self.addCleanup(planning.clear_source_plan_memo)
        self.ref = self.publish("a" * 64)

    def publish(self, file_hash, parser="memo:test:r1", labels=None):
        ref = stitch.CachedSourceRef(file_hash, parser)
        cache._publish_optimized_raw(
            raw_frame(labels or [2, 7, 19]), cache.raw_path(file_hash, parser), parser,
        )
        return ref

    def plan(self, ref=None, diagnostics=None):
        return planning.build_time_capacity_stitch_plan(
            (ref or self.ref,), diagnostics=diagnostics,
        )

    def test_live_probe_returns_identical_object_and_every_hit_probes(self):
        first_index = cache.try_load_raw_layout_index(self.ref.file_hash, self.ref.parser_version)
        self.assertIs(first_index, cache.try_load_raw_layout_index(
            self.ref.file_hash, self.ref.parser_version))
        first = self.plan()
        with patch.object(cache, "try_load_raw_layout_index", wraps=cache.try_load_raw_layout_index) as probe, \
                patch.object(stitch, "build_dense_cycle_map", side_effect=AssertionError("rebuilt map")):
            diagnostics = {}
            second = self.plan(diagnostics=diagnostics)
            self.assertEqual(probe.call_count, 1)
        self.assertIsNot(first, second)
        self.assertIs(first.sources[0], second.sources[0])
        self.assertEqual(diagnostics["indexed_source_count"], 1)
        self.assertEqual(diagnostics["row_groups_total"], first_index["raw_row_group_count"])
        self.assertEqual(diagnostics["source_reads"], [])
        self.assertEqual(planning.source_plan_memo_stats()["entries"], 1)

    def test_same_shape_atomic_index_replacement_refreshes_time_and_capabilities(self):
        first = self.plan()
        before = planning.consecutive_time_cycle_facts(first)
        target = cache.raw_index_path(self.ref.file_hash, self.ref.parser_version)
        replacement = json.loads(target.read_text(encoding="utf-8"))
        shape = replacement["raw_shape_fingerprint"]
        replacement["consecutive_time"]["cycle_starts"]["7"]["reset_offset_s"] += 10.0
        replacement["voltage_data_availability"]["voltage_v"] = False
        staged = target.with_suffix(".replacement")
        staged.write_text(json.dumps(replacement), encoding="utf-8")
        os.replace(staged, target)
        second = self.plan()
        self.assertEqual(second.sources[0].index["raw_shape_fingerprint"], shape)
        self.assertIsNot(first.sources[0], second.sources[0])
        self.assertEqual(planning.consecutive_time_cycle_facts(second)[2][0], before[2][0] + 10.0)
        self.assertFalse(second.source_facts[self.ref.file_hash]["voltage_data_availability"]["voltage_v"])
        self.assertEqual(planning.consecutive_time_cycle_facts(first), before)

    def test_missing_and_corrupt_index_and_missing_raw_never_hit(self):
        self.plan()
        target = cache.raw_index_path(self.ref.file_hash, self.ref.parser_version)
        original = target.read_bytes()
        target.unlink()
        self.assertEqual(self.plan().path, "legacy")
        self.assertEqual(planning.source_plan_memo_stats()["entries"], 0)
        target.write_bytes(original)
        self.plan()
        target.write_bytes(b"invalid json")
        self.assertEqual(self.plan().path, "legacy")
        self.assertEqual(planning.source_plan_memo_stats()["entries"], 0)
        target.write_bytes(original)
        self.plan()
        cache.raw_path(self.ref.file_hash, self.ref.parser_version).unlink()
        missing = self.plan()
        self.assertEqual(missing.path, "missing")
        self.assertEqual(missing.missing_positions, [0])
        self.assertEqual(planning.source_plan_memo_stats()["entries"], 0)

    def test_busy_boundary_invalidates_memo_without_waiting(self):
        first = self.plan()
        locked, release = threading.Event(), threading.Event()

        def hold_boundary():
            with cache._raw_layout_io_lock:
                locked.set()
                release.wait(5)

        thread = threading.Thread(target=hold_boundary)
        thread.start()
        try:
            self.assertTrue(locked.wait(2))
            self.assertEqual(self.plan().path, "legacy")
            self.assertEqual(planning.source_plan_memo_stats()["entries"], 0)
        finally:
            release.set()
            thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertIsNot(self.plan().sources[0], first.sources[0])

    def test_source_parser_namespace_and_validated_generation_are_distinct(self):
        first = self.plan()
        alternate = self.publish(self.ref.file_hash, parser="memo:test:r2")
        self.assertIsNot(self.plan(alternate).sources[0], first.sources[0])
        another = self.publish("b" * 64)
        self.assertIsNot(self.plan(another).sources[0], first.sources[0])
        # Even the exact same validated object cannot cross a cache namespace.
        index = cache.try_load_raw_layout_index(self.ref.file_hash, self.ref.parser_version)
        with patch.object(cache, "CACHE_DIR", self.root / "other"), \
                patch.object(cache, "try_load_raw_layout_index", return_value=index):
            self.assertIsNot(self.plan().sources[0], first.sources[0])
        cache.clear_raw_layout_index_cache()
        self.assertIsNot(self.plan().sources[0], first.sources[0])

    def test_nested_mutations_cannot_escape_request_boundaries(self):
        first = self.plan()
        expected = planning.consecutive_time_cycle_facts(first)
        with self.assertRaises(TypeError):
            first.sources[0].index["consecutive_time"]["cycle_starts"]["7"]["raw_time_s"] = 900.0
        with self.assertRaises(TypeError):
            first.sources[0].cycle_map[7] = 900
        with self.assertRaises(TypeError):
            first.sources[0].segment_metadata.update(cycle_start=900)
        with self.assertRaises(TypeError):
            first.sources[0].index["row_groups"][0]["row_count"] = 900
        first.segments[0]["cycle_start"] = 900
        first.source_facts[self.ref.file_hash]["voltage_data_availability"]["voltage_v"] = False
        first.missing_positions.append(0)
        first.sources = ()
        second = self.plan()
        returned = planning.consecutive_time_cycle_facts(second)
        returned[2] = (900.0, 900.0)
        self.assertEqual(planning.consecutive_time_cycle_facts(second), expected)
        self.assertEqual(second.segments[0]["cycle_start"], 1)
        self.assertTrue(second.source_facts[self.ref.file_hash]["voltage_data_availability"]["voltage_v"])
        self.assertTrue(second.complete)

    def test_pickle_and_editable_deepcopy_preserve_facts_without_stale_memo(self):
        original = self.plan()
        restored = pickle.loads(pickle.dumps(original))
        self.assertEqual(planning.consecutive_time_cycle_facts(restored),
                         planning.consecutive_time_cycle_facts(original))
        self.assertIsNotNone(planning._memo_facts(restored))
        with self.assertRaises(TypeError):
            restored.sources[0].cycle_map[2] = 99
        edited = deepcopy(original)
        edited.sources[0].index["consecutive_time"]["cycle_starts"]["7"]["reset_offset_s"] += 3.0
        self.assertIsNone(planning._memo_facts(edited))
        self.assertEqual(planning.consecutive_time_cycle_facts(edited)[2][0],
                         planning.consecutive_time_cycle_facts(original)[2][0] + 3.0)
        replaced = replace(original, sources=(replace(original.sources[0], cycle_map={2: 99}),))
        self.assertIsNone(planning._memo_facts(replaced))
        self.assertEqual(planning.requested_global_cycles(
            replaced, explicit_cycles=[], cycle_start=None, cycle_end=None), (99,))

    def test_dense_bounds_explicit_cycles_and_exact_time_facts_match_uncached(self):
        with patch.object(planning, "_SOURCE_PLAN_MEMO_MAX_ENTRIES", 0):
            ordinary = self.plan()
        memoized = self.plan()
        self.assertEqual(planning.consecutive_time_cycle_facts(ordinary),
                         planning.consecutive_time_cycle_facts(memoized))
        for start, end, explicit in ((None, None, []), (2, 3, []), (-10**20, 10**20, []),
                                     (50, 60, []), (3, 2, []), (None, None, [7, "2", "bad", 2])):
            kwargs = dict(explicit_cycles=explicit, cycle_start=start, cycle_end=end)
            self.assertEqual(planning.requested_global_cycles(ordinary, **kwargs),
                             planning.requested_global_cycles(memoized, **kwargs))
        for cycles, origin in (([2, 3], 1), ([1, 3], 2), ([99], 1), ([], 1)):
            self.assertEqual(planning.consecutive_time_request_facts(ordinary, cycles, origin),
                             planning.consecutive_time_request_facts(memoized, cycles, origin))

    def test_lru_entry_byte_bounds_and_oversized_admission(self):
        refs = [self.ref, self.publish("b" * 64), self.publish("c" * 64)]
        with patch.object(planning, "_SOURCE_PLAN_MEMO_MAX_ENTRIES", 2):
            first, second = self.plan(refs[0]), self.plan(refs[1])
            self.assertIs(self.plan(refs[0]).sources[0], first.sources[0])
            self.plan(refs[2])
            self.assertEqual(planning.source_plan_memo_stats()["entries"], 2)
            self.assertIsNot(self.plan(refs[1]).sources[0], second.sources[0])
        planning.clear_source_plan_memo()
        self.plan()
        one_size = planning.source_plan_memo_stats()["bytes"]
        planning.clear_source_plan_memo()
        with patch.object(planning, "_SOURCE_PLAN_MEMO_MAX_BYTES", one_size + 1024):
            for ref in refs:
                self.plan(ref)
                self.assertLessEqual(planning.source_plan_memo_stats()["bytes"], one_size + 1024)
            self.assertEqual(planning.source_plan_memo_stats()["entries"], 1)
        planning.clear_source_plan_memo()
        with patch.object(planning, "_SOURCE_PLAN_MEMO_MAX_BYTES", 1):
            self.assertEqual(self.plan().path, "indexed")
            self.assertEqual(planning.source_plan_memo_stats(), {"entries": 0, "bytes": 0})

    def test_multisource_and_invalid_columns_are_not_memoized(self):
        another = self.publish("b" * 64)
        multi = planning.build_time_capacity_stitch_plan((self.ref, another))
        self.assertEqual(multi.path, "indexed")
        self.assertIsNone(multi._planning_facts)
        self.assertEqual(planning.source_plan_memo_stats()["entries"], 0)
        self.plan()
        index = deepcopy(cache.try_load_raw_layout_index(self.ref.file_hash, self.ref.parser_version))
        index["raw_column_names"] = []
        with patch.object(cache, "try_load_raw_layout_index", return_value=index):
            self.assertEqual(self.plan().fallback_reason, "required_columns_unavailable")
        self.assertEqual(planning.source_plan_memo_stats()["entries"], 0)

    def test_concurrent_hits_share_frozen_source_not_request_containers(self):
        first = self.plan()
        index = cache.try_load_raw_layout_index(self.ref.file_hash, self.ref.parser_version)
        # Lock contention/fallback is tested separately; isolate simultaneous hits.
        with patch.object(cache, "try_load_raw_layout_index", return_value=index), \
                ThreadPoolExecutor(max_workers=4) as pool:
            plans = list(pool.map(lambda _: self.plan(), range(20)))
        self.assertTrue(all(plan.sources[0] is first.sources[0] for plan in plans))
        self.assertEqual(len({id(plan.segments) for plan in plans}), len(plans))
        self.assertEqual(len({id(plan.source_facts) for plan in plans}), len(plans))


if __name__ == "__main__":
    unittest.main()
