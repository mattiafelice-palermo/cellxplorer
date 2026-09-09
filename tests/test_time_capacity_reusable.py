from __future__ import annotations

from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from io import BytesIO
import json
import os
from pathlib import Path
import sys
import tempfile
import zlib
import unittest
from unittest.mock import patch

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.services import analysis_cache, analysis_engine as engine, cache
from app.services import time_capacity_reusable as reusable, time_capacity_workers as workers
from app.routers import analyses as router
from app.models import Analysis
from tests import test_analysis_engine as fixture_support


class ReusableTimeCapacityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.raw_root = tempfile.TemporaryDirectory()
        cls.raw_patch = patch.object(cache, "CACHE_DIR", Path(cls.raw_root.name))
        cls.raw_patch.start()
        fixture_support.AnalysisEngineTests.setUpClass()

    @classmethod
    def tearDownClass(cls):
        fixture_support.AnalysisEngineTests.tearDownClass()
        cls.raw_patch.stop()
        cls.raw_root.cleanup()

    def setUp(self):
        self.fixture = fixture_support.AnalysisEngineTests()
        self.fixture.setUp()
        self.db = self.fixture.db
        self.addCleanup(self.db.get_bind().dispose)
        self.addCleanup(self.db.close)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        for name, path in (("_ROOT", root), ("_RESULTS", root / "results"),
                           ("_ARTIFACTS", root / "artifacts")):
            self.enterContext(patch.object(analysis_cache, name, path))
        self.enterContext(patch.object(analysis_cache, "_budget_total", None))
        self.enterContext(patch.object(analysis_cache, "ANALYSIS_CACHE_LIMIT_BYTES", 16 * 1024 * 1024))
        self.enterContext(patch.object(workers, "_ready_pool", side_effect=workers.PoolNotReadyError("test")))
        reusable.clear_memory()
        self.addCleanup(reusable.clear_memory)
        self.spec = self.fixture.spec_with([{"kind": "cell", "ref_id": cell.id}
                                          for cell in self.fixture.cells.values()])
        self.spec["computation"]["time_capacity"] = {
            "cycle_start": 1, "cycle_end": 20, "time_reference": "selected_range",
            "display_mode": "consecutive", "x_axis": "time", "view": "voltage_current",
        }

    def jobs(self, spec=None):
        built = workers._build_jobs(self.db, spec or self.spec, None, use_current_versions=False,
                                   viewport_width=1200, precision="standard", compact=True)
        self.assertIsNotNone(built)
        return built[:2]

    def compute(self, spec):
        return engine.compute_time_capacity(self.db, spec, None, viewport_width=1200,
                                            precision="standard", compact=True)

    def test_preparation_once_and_range_unit_resolution_tail_parity(self):
        candidates = []
        for start, end, points, unit in ((1, 20, 3000, "min"), (2, 21, 4000, "s"),
                                         (29, 48, 4000, "h"), (31, 50, 3000, "min"),
                                         (1, 50, 100, "min"), (55, 60, 4000, "min")):
            spec = deepcopy(self.spec)
            spec["computation"]["time_capacity"].update(cycle_start=start, cycle_end=end,
                                                        max_points_per_cell=points, time_unit=unit)
            candidates.append((spec, self.compute(spec)))
        original = deepcopy(self.spec)
        first = reusable.prepare(self.db, self.spec, None)
        self.assertEqual(first, {"status": "ready", "total": 2, "prepared": 2, "reused": 0, "skipped": 0})
        self.assertEqual(self.spec, original)
        with patch.object(workers, "_materialize_read", side_effect=AssertionError("Unexpected source read")):
            second = reusable.prepare(self.db, self.spec, None)
            self.assertEqual(second["reused"], 2)
            for spec, expected in candidates:
                actual = self.compute(spec)
                self.assertEqual(actual["cell_traces"], expected["cell_traces"])
                self.assertEqual(actual["settings"], expected["settings"])

    def test_identity_is_range_and_presentation_independent_but_source_sensitive(self):
        jobs, request = self.jobs()
        key = reusable.artifact_key(jobs[0], request)
        self.assertIsNotNone(key)
        moved = deepcopy(self.spec)
        moved["computation"]["time_capacity"].update(cycle_start=20, cycle_end=50,
                                                    max_points_per_cell=1000, time_unit="s")
        moved_jobs, moved_request = self.jobs(moved)
        self.assertEqual(reusable.artifact_key(moved_jobs[0], moved_request), key)
        self.assertNotEqual(reusable.artifact_key(jobs[0], replace(request, calc_version="other")), key)
        changed = deepcopy(jobs[0])
        changed.plan.sources[0].index["raw_shape_fingerprint"] = "new-bytes"
        self.assertNotEqual(reusable.artifact_key(changed, request), key)
        source = jobs[0].plan.sources[0]
        changed = replace(jobs[0], refs=(replace(source.ref, parser_version="other"),))
        # Identity comes from the resolved plan, never mutable labels or UI settings.
        self.assertEqual(reusable.artifact_key(changed, request), key)
        for field in ("parser_version", "file_hash"):
            changed_source = replace(source, ref=replace(source.ref, **{field: "changed"}))
            changed = replace(jobs[0], plan=replace(jobs[0].plan, sources=(changed_source,)))
            self.assertNotEqual(reusable.artifact_key(changed, request), key)

    def test_concurrent_readers_identity_validation_and_failed_publication(self):
        reusable.prepare(self.db, self.spec, None)
        jobs, request = self.jobs()
        key = reusable.artifact_key(jobs[0], request)
        reusable.clear_memory()
        with ThreadPoolExecutor(max_workers=8) as pool:
            values = list(pool.map(reusable.load_arrays, [key] * 24))
        self.assertTrue(all(value is values[0] for value in values))
        self.assertFalse(values[0]["cycle"].flags.writeable)
        reusable.clear_memory()
        with patch.object(reusable.gzip, "open", side_effect=zlib.error("bad compression")):
            self.assertIsNone(reusable.load_arrays(key))
        stream = BytesIO()
        np.savez(stream, identity=np.array("wrong identity"), **values[0])
        self.assertFalse(reusable.store_arrays(key, stream.getvalue()))
        self.assertIsNone(reusable.load_arrays(key))
        self.assertEqual(reusable.prepare(self.db, self.spec, None)["prepared"], 1)
        before = reusable.artifact_path(key).read_bytes()
        with patch.object(analysis_cache.os, "replace", side_effect=OSError("failed publication")):
            with self.assertRaises(OSError):
                reusable.store_arrays(key, stream.getvalue())
        self.assertEqual(reusable.artifact_path(key).read_bytes(), before)
        self.assertIsNotNone(reusable.load_arrays(key))

    def test_missing_corrupt_deleted_and_rebuilt_artifacts_fall_back(self):
        expected = self.compute(self.spec)
        reusable.prepare(self.db, self.spec, None)
        jobs, request = self.jobs()
        key = reusable.artifact_key(jobs[0], request)
        arrays = reusable.load_arrays(key)
        self.assertFalse(arrays["cycle"].flags.writeable)
        path = reusable.artifact_path(key)
        path.write_bytes(b"corrupt cache")
        self.assertIsNone(reusable.load_arrays(key))
        self.assertEqual(self.compute(self.spec)["cell_traces"], expected["cell_traces"])
        self.assertEqual(reusable.prepare(self.db, self.spec, None)["prepared"], 1)
        self.assertIsNotNone(reusable.load_arrays(key))
        path.unlink()
        self.assertIsNone(reusable.load_arrays(key), "RAM must not outlive explicit disk cleanup")
        self.assertEqual(self.compute(self.spec)["cell_traces"], expected["cell_traces"])

    def test_memory_and_disk_limits_and_oversized_sources(self):
        reusable.prepare(self.db, self.spec, None)
        jobs, request = self.jobs()
        keys = [reusable.artifact_key(job, request) for job in jobs]
        reusable.clear_memory()
        with patch.object(reusable, "MEMORY_LIMIT_ENTRIES", 1):
            for key in keys:
                self.assertIsNotNone(reusable.load_arrays(key))
            self.assertEqual(reusable.memory_stats()["entries"], 1)
        reusable.clear_memory()
        with patch.object(reusable, "MEMORY_LIMIT_BYTES", 1):
            self.assertIsNone(reusable.load_arrays(keys[0]))
        with patch.object(reusable, "MAX_ARRAY_BYTES", 1), \
             patch.object(workers, "_materialize_read", side_effect=AssertionError("oversized read")):
            self.assertEqual(reusable.prepare(self.db, self.spec, None)["skipped"], 2)
        with analysis_cache._lock:
            analysis_cache._prune_locked(0)
        self.assertTrue(all(not reusable.artifact_path(key).exists() for key in keys))
        self.assertIsNone(reusable.load_arrays(keys[0]))

    def test_unsupported_views_and_full_or_refinement_requests_do_not_use_arrays(self):
        jobs, request = self.jobs()
        for changes in ({"x_axis": "capacity_mah"}, {"view": "dq_dv"},
                        {"time_reference": "test_start"}, {"voltage_channels": ["working_potential"]},
                        {"cycles": [1, 3]}):
            candidate = replace(request, settings={**request.settings, **changes})
            self.assertIsNone(reusable.artifact_key(jobs[0], candidate))
        self.assertIsNone(reusable.artifact_key(jobs[0], replace(request, precision="full")))
        self.assertIsNone(reusable.artifact_key(jobs[0], replace(request, refinement=True)))
        multiple = replace(jobs[0], plan=replace(jobs[0].plan, sources=jobs[0].plan.sources * 2))
        self.assertIsNone(reusable.artifact_key(multiple, request))

    def test_prepare_route_does_not_persist_recipe_provenance_or_window_results(self):
        analysis = Analysis(title="prepare", spec=deepcopy(self.spec))
        self.db.add(analysis)
        self.db.commit()
        with patch.object(analysis_cache, "store_result", side_effect=AssertionError("window persistence")):
            result = router.prepare_time_capacity_analysis(analysis.id, router.ComputeRequest(spec=self.spec), self.db)
        self.assertEqual(result["prepared"], 2)
        self.db.expire_all()
        self.assertEqual(self.db.get(Analysis, analysis.id).spec, self.spec)
        self.assertIsNone(self.db.get(Analysis, analysis.id).provenance)


class VectorConversionTests(unittest.TestCase):
    def test_float_conversion_exactly_preserves_existing_semantics(self):
        values = np.array([0., -0., np.nan, np.inf, -np.inf, 1.234565, -8.654321, 1e100])
        for digits in (None, 0, 5, 6):
            rounded = np.round(values, digits) if digits is not None else values
            expected = [None if np.isnan(value) else float(value) for value in rounded]
            self.assertEqual(json.dumps(engine._jsonsafe_plot(values, digits)), json.dumps(expected))
        self.assertEqual(engine._jsonsafe_plot([], 6), [])

    def test_integer_conversion_handles_fractional_missing_and_out_of_int64_range(self):
        for values in ([], [0, -0., 1.9, -1.9], [1, np.nan, -2.9],
                       [-(2.0 ** 63), 2.0 ** 63, 1e100]):
            expected = [None if np.isnan(value) else int(value) for value in np.asarray(values, dtype="float64")]
            self.assertEqual(engine._jsonsafe_int(values), expected)
        for infinity in (np.inf, -np.inf):
            with self.assertRaises(OverflowError):
                engine._jsonsafe_int([infinity])
