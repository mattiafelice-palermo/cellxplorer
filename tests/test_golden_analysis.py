"""Golden analysis regression corpus tests (Spec 015)."""
from __future__ import annotations

import copy
import json
import math
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "tests"))

from golden_analysis_support import (  # noqa: E402
    ComparisonError,
    compare_values,
    fixture_root,
    load_manifest,
    project_result,
    verify_source_binaries,
)
import golden_analysis_support  # noqa: E402


class GoldenAnalysisCorpusTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = load_manifest()
        cls.root = fixture_root()
        verify_source_binaries(cls.manifest, cls.root)

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

        with golden_analysis_support.GoldenFixtureEnvironment.create() as env:
            seen: set[str] = set()
            for source in self.manifest["sources"]:
                digest = source["sha256"]
                if digest in seen:
                    continue
                seen.add(digest)
                sf = env.db.query(SourceFile).filter_by(hash=digest).one()
                self.assertEqual(sf.row_count, source["row_count"])
                self.assertEqual(sf.cycle_count, source["cycle_count"])

    def test_each_source_parsed_once_per_module(self):
        with mock.patch.object(
            golden_analysis_support.scanner,
            "parse_file",
            wraps=golden_analysis_support.scanner.parse_file,
        ) as parse_mock:
            with golden_analysis_support.GoldenFixtureEnvironment.create() as env:
                for case in self.manifest["cases"]:
                    env.run_case(case)
        unique_hashes = len({source["sha256"] for source in self.manifest["sources"]})
        self.assertEqual(parse_mock.call_count, unique_hashes)

    def test_cases_match_expected_projections(self):
        with golden_analysis_support.GoldenFixtureEnvironment.create() as env:
            for case in self.manifest["cases"]:
                with self.subTest(case=case["id"]):
                    expected = json.loads((self.root / case["expected_path"]).read_text(encoding="utf-8"))
                    actual = env.run_case(case)
                    profile = golden_analysis_support.comparison_profile(self.manifest, case)
                    compare_values(expected, actual, profile=profile)

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

    def test_missing_source_binary_fails_usefully(self):
        manifest = copy.deepcopy(self.manifest)
        manifest["sources"][0]["binary_path"] = "sources/missing.ndax"
        with self.assertRaises(golden_analysis_support.ManifestError):
            verify_source_binaries(manifest, self.root)

    def test_live_database_is_not_used(self):
        live_root = (Path.home() / ".cellxplorer").resolve()
        self.assertNotEqual(Path(os.environ["CELLXPLORER_DATA"]).resolve(), live_root)


if __name__ == "__main__":
    unittest.main()
