"""Golden analysis regression corpus tests (Spec 015)."""
from __future__ import annotations

import copy
import json
import math
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
_MODULE_DATA_ROOT = Path(tempfile.mkdtemp(prefix="cellxplorer-golden-test-"))
os.environ["CELLXPLORER_DATA"] = str(_MODULE_DATA_ROOT)
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "tests"))

import golden_analysis_support  # noqa: E402
from golden_analysis_support import (  # noqa: E402
    ComparisonError,
    compare_values,
    fixture_root,
    load_manifest,
    project_result,
    required_raw_columns,
    verify_source_binaries,
)
from app.services import parsing  # noqa: E402


class GoldenAnalysisCorpusTests(unittest.TestCase):
    env: golden_analysis_support.GoldenFixtureEnvironment

    @classmethod
    def setUpClass(cls):
        cls.manifest = load_manifest()
        cls.root = fixture_root()
        verify_source_binaries(cls.manifest, cls.root)
        cls.env = golden_analysis_support.GoldenFixtureEnvironment.create(
            data_root=_MODULE_DATA_ROOT,
        )

    @classmethod
    def tearDownClass(cls):
        cls.env.close()

    def test_manifest_has_four_source_binaries(self):
        sources = self.manifest["sources"]
        self.assertEqual(len(sources), 4)
        keys = {source["key"] for source in sources}
        self.assertEqual(
            keys,
            {"cycles_time_steps", "dcir", "chargeability", "rate_capability"},
        )
        families = {
            source["key"]: set(source["families"])
            for source in sources
        }
        self.assertEqual(families["cycles_time_steps"], {"cycles", "time_capacity", "steps"})
        self.assertEqual(families["dcir"], {"dcir"})
        self.assertEqual(families["chargeability"], {"chargeability"})
        self.assertEqual(families["rate_capability"], {"rate_capability"})

    def test_manifest_metadata_is_trimmed(self):
        for source in self.manifest["sources"]:
            self.assertNotIn("metadata", source)
        for cell in self.manifest["entities"]["cells"]:
            metadata = cell.get("metadata") or {}
            for key in metadata:
                self.assertIn(
                    key,
                    golden_analysis_support.ALLOWED_CELL_METADATA_KEYS,
                    msg=f"unexpected metadata key {key!r}",
                )
                self.assertFalse(key.startswith("raw."))

    def test_shared_cycles_source_used_by_three_families(self):
        case_keys = {
            case["id"]: set(case["source_keys"])
            for case in self.manifest["cases"]
        }
        shared = case_keys["cycles_baseline"]
        self.assertIn("cycles_time_steps", shared)
        self.assertIn("cycles_time_steps", case_keys["time_capacity_baseline"])
        self.assertIn("cycles_time_steps", case_keys["steps_baseline"])

    def test_parsed_dimensions_match_manifest(self):
        from app.models import SourceFile

        seen: set[str] = set()
        for source in self.manifest["sources"]:
            digest = source["sha256"]
            if digest in seen:
                continue
            seen.add(digest)
            sf = self.env.db.query(SourceFile).filter_by(hash=digest).one()
            self.assertEqual(sf.row_count, source["row_count"])
            self.assertEqual(sf.cycle_count, source["cycle_count"])
            self.assertTrue(sf.header_meta)

    def test_each_unique_binary_parsed_once_per_module(self):
        unique_hashes = len({source["sha256"] for source in self.manifest["sources"]})
        self.assertEqual(
            sum(self.env.timeseries_parse_counts.values()),
            unique_hashes,
            msg=self.env.timeseries_parse_counts,
        )

    def test_cases_match_expected_projections(self):
        for case in self.manifest["cases"]:
            with self.subTest(case=case["id"]):
                expected = json.loads((self.root / case["expected_path"]).read_text(encoding="utf-8"))
                actual = self.env.run_case(case)
                profile = golden_analysis_support.comparison_profile(self.manifest, case)
                compare_values(expected, actual, profile=profile)

    def test_protocol_dependent_cases_are_non_empty(self):
        checks = {
            "steps_baseline": lambda result: result["cell_series"][0]["n_blocks"] > 0,
            "dcir_baseline": lambda result: result["cell_series"][0]["n_measurements"] > 0,
            "chargeability_baseline": lambda result: bool(result.get("matches")),
            "rate_capability_baseline": lambda result: bool(result.get("points")),
        }
        for case_id, predicate in checks.items():
            case = next(item for item in self.manifest["cases"] if item["id"] == case_id)
            with self.subTest(case=case_id):
                self.assertTrue(predicate(self.env.run_case(case)))

    def test_normalization_and_derivative_differ_from_baselines(self):
        baseline_ids = {
            "cycles_baseline",
            "time_capacity_baseline",
        }
        distinct_ids = {
            "cycles_normalization",
            "time_capacity_derivative",
        }
        loaded = {
            case["id"]: self.env.run_case(case)
            for case in self.manifest["cases"]
            if case["id"] in baseline_ids | distinct_ids
        }
        self.assertNotEqual(
            loaded["cycles_normalization"],
            loaded["cycles_baseline"],
        )
        deriv = loaded["time_capacity_derivative"]["cell_traces"][0]
        base = loaded["time_capacity_baseline"]["cell_traces"][0]
        self.assertTrue(deriv.get("derivative_y"))
        self.assertNotEqual(deriv.get("derivative_y"), base.get("derivative_y"))

    def test_comparator_reports_precise_path(self):
        expected = {"metrics": {"ce_pct": 99.1}}
        actual = {"metrics": {"ce_pct": 99.2}}
        with self.assertRaises(ComparisonError) as ctx:
            compare_values(expected, actual)
        self.assertIn("metrics.ce_pct", str(ctx.exception))

    def test_nan_values_fail(self):
        with self.assertRaises(ComparisonError):
            compare_values({"value": 1.0}, {"value": math.nan})

    def test_missing_expected_file_fails_usefully(self):
        case = dict(self.manifest["cases"][0])
        case["expected_path"] = "expected/does-not-exist.json"
        with self.assertRaises(golden_analysis_support.ManifestError):
            golden_analysis_support.load_case_expected(self.root, case)

    def test_missing_spec_file_fails_usefully(self):
        case = dict(self.manifest["cases"][0])
        case["spec_path"] = "specs/does-not-exist.json"
        with self.assertRaises(golden_analysis_support.ManifestError):
            golden_analysis_support.load_case_spec(self.root, case)

    def test_missing_source_binary_fails_usefully(self):
        manifest = copy.deepcopy(self.manifest)
        manifest["sources"][0]["binary_path"] = "sources/missing.ndax"
        with self.assertRaises(golden_analysis_support.ManifestError):
            verify_source_binaries(manifest, self.root)

    def test_live_database_is_not_used(self):
        live_root = (Path.home() / ".cellxplorer").resolve()
        self.assertNotEqual(_MODULE_DATA_ROOT.resolve(), live_root)
        self.assertTrue(str(self.env.data_root).startswith(str(_MODULE_DATA_ROOT)))

    def test_caches_stay_under_module_data_root(self):
        cache_root = _MODULE_DATA_ROOT / "cache"
        self.assertTrue(cache_root.is_dir())
        cache_files = list(cache_root.rglob("*.parquet"))
        self.assertGreater(len(cache_files), 0)
        for path in cache_files:
            self.assertTrue(path.resolve().is_relative_to(_MODULE_DATA_ROOT.resolve()))

    def test_required_raw_columns_present(self):
        self.assertGreaterEqual(len(required_raw_columns()), 6)


if __name__ == "__main__":
    unittest.main()
