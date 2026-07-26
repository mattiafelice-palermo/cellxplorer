"""Golden analysis regression corpus tests (Spec 015)."""
from __future__ import annotations

import copy
import importlib.util
import json
import math
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
_PRIOR_DATA = os.environ.get("CELLXPLORER_DATA")
_MODULE_DATA_ROOT = Path(tempfile.mkdtemp(prefix="cellxplorer-golden-test-"))
os.environ["CELLXPLORER_DATA"] = str(_MODULE_DATA_ROOT)
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "tests"))

import golden_analysis_support  # noqa: E402
from golden_analysis_support import (  # noqa: E402
    ComparisonError,
    NonFiniteProjectionError,
    REQUIRED_CYCLES_BASELINE_METRICS,
    REQUIRED_CYCLES_BASELINE_QUANTITIES,
    REQUIRED_CYCLES_NORMALIZATION_QUANTITIES,
    compare_values,
    fixture_root,
    load_manifest,
    project_result,
    required_raw_columns,
    verify_source_binaries,
)


class GoldenAnalysisCorpusTests(unittest.TestCase):
    env: golden_analysis_support.GoldenFixtureEnvironment

    @classmethod
    def setUpClass(cls):
        cls.manifest = load_manifest()
        cls.root = fixture_root()
        verify_source_binaries(cls.manifest, cls.root)
        try:
            cls.env = golden_analysis_support.GoldenFixtureEnvironment.create(
                data_root=_MODULE_DATA_ROOT,
            )
        except Exception:
            shutil.rmtree(_MODULE_DATA_ROOT, ignore_errors=True)
            raise

    @classmethod
    def tearDownClass(cls):
        try:
            cls.env.close()
        finally:
            shutil.rmtree(_MODULE_DATA_ROOT, ignore_errors=True)
            if _PRIOR_DATA is None:
                os.environ.pop("CELLXPLORER_DATA", None)
            else:
                os.environ["CELLXPLORER_DATA"] = _PRIOR_DATA
            if _MODULE_DATA_ROOT.exists():
                raise AssertionError(f"module data root was not cleaned: {_MODULE_DATA_ROOT}")

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
        unique_hashes = {source["sha256"] for source in self.manifest["sources"]}
        self.assertEqual(set(self.env.timeseries_parse_counts), unique_hashes)
        for digest in unique_hashes:
            self.assertEqual(self.env.timeseries_parse_counts[digest], 1)

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
            "dcir_baseline": lambda result: (
                {series.get("direction") for series in result["cell_series"]}
                >= {"charge", "discharge"}
                and all(series["n_measurements"] > 0 for series in result["cell_series"])
            ),
            "chargeability_baseline": lambda result: bool(result.get("matches")),
            "rate_capability_baseline": lambda result: bool(result.get("points")),
        }
        for case_id, predicate in checks.items():
            case = next(item for item in self.manifest["cases"] if item["id"] == case_id)
            with self.subTest(case=case_id):
                self.assertTrue(predicate(self.env.run_case(case)))

    def test_dcir_has_charge_and_discharge_series(self):
        case = next(item for item in self.manifest["cases"] if item["id"] == "dcir_baseline")
        result = self.env.run_case(case)
        by_direction = {series["direction"]: series for series in result["cell_series"]}
        self.assertIn("charge", by_direction)
        self.assertIn("discharge", by_direction)
        for direction, series in by_direction.items():
            with self.subTest(direction=direction):
                self.assertGreater(series["n_measurements"], 0)
                self.assertTrue(any(value is not None for value in series["quantities"]["dcir_mohm"]))
                self.assertTrue(
                    any(value is not None for value in series["quantities"]["dcir_change_pct"])
                )
                self.assertEqual(len(series["measurement_meta"]), series["n_measurements"])

    def test_cycles_baseline_keeps_required_scientific_keys(self):
        case = next(item for item in self.manifest["cases"] if item["id"] == "cycles_baseline")
        result = self.env.run_case(case)
        series = result["cell_series"][0]
        self.assertTrue(REQUIRED_CYCLES_BASELINE_QUANTITIES <= set(series["quantities"]))
        self.assertTrue(REQUIRED_CYCLES_BASELINE_METRICS <= set(series["metrics"]))

    def test_cycles_normalization_keeps_specific_and_context(self):
        case = next(item for item in self.manifest["cases"] if item["id"] == "cycles_normalization")
        result = self.env.run_case(case)
        series = result["cell_series"][0]
        self.assertTrue(REQUIRED_CYCLES_NORMALIZATION_QUANTITIES <= set(series["quantities"]))
        self.assertIn("n_cycles", series["metrics"])
        self.assertNotIn("charge_capacity_mah", series["quantities"])
        self.assertIn("charge_capacity_mah_g", series["quantities"])

    def test_normalization_and_derivative_differ_from_baselines(self):
        loaded = {
            case["id"]: self.env.run_case(case)
            for case in self.manifest["cases"]
            if case["id"]
            in {
                "cycles_baseline",
                "cycles_normalization",
                "time_capacity_baseline",
                "time_capacity_derivative",
            }
        }
        self.assertNotEqual(loaded["cycles_normalization"], loaded["cycles_baseline"])
        deriv = loaded["time_capacity_derivative"]["cell_traces"][0]
        base = loaded["time_capacity_baseline"]["cell_traces"][0]
        self.assertTrue(deriv.get("derivative_y"))
        self.assertNotEqual(deriv.get("derivative_y"), base.get("derivative_y"))

    def test_project_result_rejects_non_finite_values(self):
        with self.assertRaises(NonFiniteProjectionError):
            project_result({"value": math.nan})
        with self.assertRaises(NonFiniteProjectionError):
            project_result({"value": math.inf})

    def test_non_finite_production_shaped_result_fails_projection_path(self):
        shaped = {
            "type": "cycles",
            "cell_series": [
                {
                    "cell_id": 101,
                    "quantities": {"charge_capacity_mah": [1.0, math.nan]},
                    "metrics": {"n_cycles": 2},
                }
            ],
        }
        with self.assertRaises(NonFiniteProjectionError):
            project_result(shaped, projection="cycles_absolute")

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

    def test_required_raw_columns_and_dtypes(self):
        from app.models import SourceFile

        seen: set[str] = set()
        for source in self.manifest["sources"]:
            digest = source["sha256"]
            if digest in seen:
                continue
            seen.add(digest)
            sf = self.env.db.query(SourceFile).filter_by(hash=digest).one()
            raw = golden_analysis_support.cache.load_raw(
                sf.hash,
                sf.parser_version or "v2026.06.11",
            )
            self.assertIsNotNone(raw)
            golden_analysis_support.assert_raw_frame_schema(raw, source_key=source["key"])
            for column in required_raw_columns():
                self.assertIn(column, raw.columns)

    def test_normal_tests_do_not_invoke_corpus_generation(self):
        builder = _load_builder()
        with mock.patch.object(builder, "export_corpus") as export_mock, mock.patch.object(
            builder, "refresh_expected"
        ) as refresh_mock, mock.patch.object(builder, "write_expected_outputs") as write_mock:
            for case in self.manifest["cases"][:2]:
                self.env.run_case(case)
            export_mock.assert_not_called()
            refresh_mock.assert_not_called()
            write_mock.assert_not_called()


def _load_builder():
    path = ROOT / "scripts" / "build_golden_analysis_corpus.py"
    spec = importlib.util.spec_from_file_location("build_golden_analysis_corpus", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class GoldenBuilderResolutionTests(unittest.TestCase):
    def test_rate_analysis_uses_its_own_cell_and_plot(self):
        builder = _load_builder()

        with tempfile.TemporaryDirectory(prefix="golden-builder-") as tmp:
            db_path = Path(tmp) / "snapshot.db"
            conn = __import__("sqlite3").connect(db_path)
            conn.executescript(
                """
                CREATE TABLE analyses (id INTEGER PRIMARY KEY, title TEXT, spec TEXT);
                CREATE TABLE cells (id INTEGER PRIMARY KEY, name TEXT);
                CREATE TABLE tests (id INTEGER PRIMARY KEY, cell_id INTEGER);
                CREATE TABLE source_files (
                    id INTEGER PRIMARY KEY, path TEXT, hash TEXT, cycle_count INTEGER
                );
                CREATE TABLE test_files (test_id INTEGER, file_id INTEGER, position INTEGER);
                CREATE TABLE cell_metadata (cell_id INTEGER, key TEXT, value TEXT);
                """
            )
            charge_spec = {
                "selection": {"entries": [{"kind": "cell", "ref_id": 30}]},
                "saved_plots": [
                    {"name": "Chargeability comparison", "computation": {}, "aggregation": {}, "presentation": {}},
                    {"name": "Steps view", "computation": {}, "aggregation": {}, "presentation": {}},
                ],
                "spec_version": 1,
            }
            rate_spec = {
                "selection": {"entries": [{"kind": "cell", "ref_id": 99}]},
                "saved_plots": [
                    {
                        "name": "Rate capability comparison",
                        "computation": {},
                        "aggregation": {},
                        "presentation": {},
                    }
                ],
                "spec_version": 1,
            }
            cycles_spec = {
                "selection": {"entries": [{"kind": "cell", "ref_id": 22}]},
                "saved_plots": [
                    {
                        "name": "Charge capacity (mAh/g) comparison test",
                        "computation": {},
                        "aggregation": {},
                        "presentation": {},
                    },
                    {
                        "name": "Time / capacity comparison",
                        "computation": {},
                        "aggregation": {},
                        "presentation": {},
                    },
                ],
                "spec_version": 1,
            }
            dcir_spec = {
                "selection": {"entries": [{"kind": "cell", "ref_id": 31}]},
                "saved_plots": [
                    {
                        "name": "DCIR comparison 0.7C",
                        "computation": {"dcir": {"series": []}},
                        "aggregation": {},
                        "presentation": {},
                    }
                ],
                "dcir_segments": [],
                "spec_version": 1,
            }
            for analysis_id, title, spec in (
                (9, "Test analysis", cycles_spec),
                (20, "Chargeability test", charge_spec),
                (21, "DCIR test", dcir_spec),
                (22, "Rate capability dedicated", rate_spec),
            ):
                conn.execute(
                    "INSERT INTO analyses(id, title, spec) VALUES (?, ?, ?)",
                    (analysis_id, title, json.dumps(spec)),
                )
            for cell_id, path, digest, cycles in (
                (22, str(Path(tmp) / "cycles.ndax"), "aa", 193),
                (30, str(Path(tmp) / "charge.ndax"), "bb", 37),
                (31, str(Path(tmp) / "dcir.ndax"), "cc", 221),
                (99, str(Path(tmp) / "rate.ndax"), "dd", 40),
            ):
                Path(path).write_bytes(b"x")
                conn.execute("INSERT INTO cells(id, name) VALUES (?, ?)", (cell_id, f"cell-{cell_id}"))
                conn.execute("INSERT INTO tests(id, cell_id) VALUES (?, ?)", (cell_id, cell_id))
                conn.execute(
                    "INSERT INTO source_files(id, path, hash, cycle_count) VALUES (?, ?, ?, ?)",
                    (cell_id, path, digest, cycles),
                )
                conn.execute(
                    "INSERT INTO test_files(test_id, file_id, position) VALUES (?, ?, 0)",
                    (cell_id, cell_id),
                )
            conn.commit()

            cases = builder.build_case_definitions(
                conn,
                cycles_analysis_id=9,
                dcir_analysis_id=21,
                chargeability_analysis_id=20,
                rate_analysis_id=22,
                cycles_cell_id=22,
                dcir_cell_id=31,
                chargeability_cell_id=30,
                rate_cell_id=99,
                rate_fixture_cell_id=104,
                plot_names=builder.DEFAULT_PLOT_NAMES,
            )
            rate_case = next(case for case in cases if case["id"] == "rate_capability_baseline")
            self.assertEqual(rate_case["analysis_id"], 22)
            self.assertEqual(rate_case["cell_id"], 99)
            self.assertEqual(rate_case["fixture_cell_id"], 104)
            self.assertEqual(rate_case["plot_name"], "Rate capability comparison")
            self.assertEqual(builder.primary_cell_id(conn, 22), 99)
            self.assertEqual(builder.cell_source_path(conn, 99), Path(tmp) / "rate.ndax")
            conn.close()

    def test_missing_plot_name_fails_clearly(self):
        builder = _load_builder()
        with self.assertRaises(SystemExit) as ctx:
            builder.saved_plot_by_name({"saved_plots": [{"name": "Other"}]}, "Missing plot")
        self.assertIn("Missing plot", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
