import importlib.util
import io
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = ROOT / "scripts" / "profile_test_suite.py"


def load_profiler():
    spec = importlib.util.spec_from_file_location("profile_test_suite", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


profiler = load_profiler()


class ProfileTestSuiteTests(unittest.TestCase):
    def test_percentiles_and_counts_are_deterministic(self):
        statistics = profiler.duration_statistics([1.0, 2.0, 3.0, 4.0])

        self.assertEqual(statistics["count"], 4)
        self.assertEqual(statistics["sum_seconds"], 10.0)
        self.assertEqual(statistics["p50_seconds"], 2.5)
        self.assertAlmostEqual(statistics["p99_seconds"], 3.97)
        self.assertEqual(statistics["max_seconds"], 4.0)

    def test_tap_parser_records_each_node_subtest_and_failure(self):
        tap = """\
TAP version 13
# Subtest: alpha
    1..0
    # duration_ms: 4.5
ok 1 - alpha
# Subtest: beta
    1..0
    # duration_ms: 8.0
not ok 2 - beta
1..2
"""

        cases, failed = profiler._parse_tap(tap)

        self.assertTrue(failed)
        self.assertEqual([case["id"] for case in cases], ["alpha", "beta"])
        self.assertEqual([case["duration_seconds"] for case in cases], [0.0045, 0.008])
        self.assertEqual(cases[1]["status"], "failed")

    def test_timing_result_records_setup_body_and_teardown(self):
        class TimedCase(unittest.TestCase):
            def setUp(self):
                self.marker = "ready"

            def test_body(self):
                self.assertEqual(self.marker, "ready")

            def tearDown(self):
                self.marker = "done"

        profiler.install_case_phase_instrumentation()
        result = profiler.TimingResult()
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(TimedCase)
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            suite.run(result)

        self.assertTrue(result.wasSuccessful())
        self.assertEqual(len(result.case_timings), 1)
        timing = result.case_timings[0]
        self.assertEqual(timing["status"], "passed")
        self.assertGreaterEqual(timing["duration_seconds"], 0.0)
        self.assertGreaterEqual(timing["setup_seconds"], 0.0)
        self.assertGreaterEqual(timing["body_seconds"], 0.0)
        self.assertGreaterEqual(timing["teardown_seconds"], 0.0)

    def test_backend_summary_preserves_complete_case_and_module_population(self):
        payloads = [
            {
                "module": "tests.test_alpha",
                "case_count": 2,
                "tests_run": 2,
                "module_wall_seconds": 0.8,
                "process_wall_seconds": 1.0,
                "module_cpu_seconds": 0.7,
                "case_timings": [
                    {
                        "id": "tests.test_alpha.A.test_fast",
                        "duration_seconds": 0.1,
                        "body_seconds": 0.08,
                        "setup_seconds": 0.01,
                        "teardown_seconds": 0.01,
                    },
                    {
                        "id": "tests.test_alpha.A.test_slow",
                        "duration_seconds": 0.4,
                        "body_seconds": 0.35,
                        "setup_seconds": 0.02,
                        "teardown_seconds": 0.03,
                    },
                ],
                "successful": True,
                "failures": [],
                "errors": [],
                "skips": [],
                "process_exit_code": 0,
            }
        ]

        summary = profiler._summarize_backend(
            root=ROOT,
            module_payloads=payloads,
            started=0.0,
            discovered_cases=2,
        )

        self.assertEqual(summary["module_count"], 1)
        self.assertEqual(summary["discovered_case_count"], 2)
        self.assertEqual(summary["recorded_case_count"], 2)
        self.assertEqual(summary["case_duration_seconds"], 0.5)
        self.assertEqual(summary["case_body_seconds"], 0.43)
        self.assertEqual(summary["modules"][0]["case_body_seconds"], 0.43)
        self.assertEqual(summary["sum_module_cpu_seconds"], 0.7)
        self.assertIn("top_50_cases", summary)
        self.assertIn("10", summary["top_case_concentration"])

    def test_body_concentration_uses_body_ranked_cases_not_elapsed_ranked_cases(self):
        elapsed_heavy = {
            "id": "tests.test_alpha.A.test_elapsed_heavy",
            "duration_seconds": 100.0,
            "body_seconds": 0.1,
            "setup_seconds": 0.0,
            "teardown_seconds": 0.0,
        }
        body_heavy = [
            {
                "id": f"tests.test_alpha.A.test_body_{index}",
                "duration_seconds": 1.0,
                "body_seconds": 1.0,
                "setup_seconds": 0.0,
                "teardown_seconds": 0.0,
            }
            for index in range(10)
        ]
        payload = {
            "module": "tests.test_alpha",
            "case_count": 11,
            "tests_run": 11,
            "module_wall_seconds": 110.0,
            "process_wall_seconds": 110.0,
            "module_cpu_seconds": 110.0,
            "case_timings": [elapsed_heavy, *body_heavy],
            "successful": True,
            "failures": [],
            "errors": [],
            "skips": [],
            "process_exit_code": 0,
        }

        summary = profiler._summarize_backend(
            root=ROOT,
            module_payloads=[payload],
            started=0.0,
            discovered_cases=11,
        )

        self.assertEqual(summary["top_50_cases"][0]["id"], elapsed_heavy["id"])
        self.assertAlmostEqual(
            summary["top_case_concentration"]["10"],
            10.0 / 10.1,
        )

    def test_discovery_helpers_use_sorted_complete_inputs(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "tests").mkdir()
            (root / "tests" / "__init__.py").write_text("", encoding="utf-8")
            (root / "tests" / "test_beta.py").write_text(
                "import unittest\nclass Beta(unittest.TestCase):\n def test_one(self): pass\n",
                encoding="utf-8",
            )
            (root / "tests" / "test_alpha.py").write_text(
                "import unittest\nclass Alpha(unittest.TestCase):\n def test_one(self): pass\n",
                encoding="utf-8",
            )

            self.assertEqual(
                profiler.discover_backend_modules(root),
                ["tests.test_alpha", "tests.test_beta"],
            )
            self.assertEqual(profiler.discover_backend_cases(root), 2)


if __name__ == "__main__":
    unittest.main()
