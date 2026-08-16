import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = ROOT / "scripts" / "benchmark_test_runners.py"


def load_benchmark():
    spec = importlib.util.spec_from_file_location("benchmark_test_runners", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


benchmark = load_benchmark()


class BenchmarkTestRunnerTests(unittest.TestCase):
    def test_counterbalanced_order_requires_all_three_architectures(self):
        self.assertEqual(benchmark.parse_order("A,B,C,C,B,A"), ["A", "B", "C", "C", "B", "A"])
        with self.assertRaises(ValueError):
            benchmark.parse_order("A,B,A")
        with self.assertRaises(ValueError):
            benchmark.parse_order("A,B,D")

    def test_architecture_a_uses_the_complete_existing_runner(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "scripts").mkdir()
            (root / "scripts" / "run_backend_tests.py").write_text("", encoding="utf-8")
            with mock.patch.object(
                benchmark.subprocess,
                "run",
                return_value=subprocess.CompletedProcess(
                    [], 0, "All 2 backend test modules passed.\n", ""
                ),
            ) as run_mock:
                result = benchmark.run_architecture_a(
                    root=root,
                    python_executable=sys.executable,
                    data_root=root / "data",
                    jobs=2,
                )

            command = run_mock.call_args.args[0]
            self.assertIn("--skip-frontend-tests", command)
            self.assertIn("--data-root", command)
            self.assertEqual(result["architecture"], "A")
            self.assertTrue(result["successful"])

    def test_architecture_b_can_request_a_reversed_module_order(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            result_path = root / "b.json"
            result_path.write_text(
                json.dumps(
                    {
                        "architecture": "B",
                        "case_count": 1,
                        "tests_run": 1,
                        "successful": True,
                        "failures": [],
                        "errors": [],
                        "skips": [],
                        "runner_output": "",
                    }
                ),
                encoding="utf-8",
            )
            with mock.patch.object(
                benchmark.subprocess,
                "run",
                return_value=subprocess.CompletedProcess([], 0, "", ""),
            ) as run_mock:
                result = benchmark.run_architecture_b(
                    root=root,
                    python_executable=sys.executable,
                    data_root=root / "data",
                    jobs=1,
                    reverse_modules=True,
                    result_path=result_path,
                )

            self.assertIn("--reverse-modules", run_mock.call_args.args[0])
            self.assertTrue(result["successful"])

    def test_persistent_worker_resets_environment_disposes_state_and_keeps_failure_attribution(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "app").mkdir()
            (root / "tests").mkdir()
            (root / "app" / "__init__.py").write_text("", encoding="utf-8")
            (root / "tests" / "__init__.py").write_text("", encoding="utf-8")
            (root / "app" / "config.py").write_text(
                "import os\nDATA_ROOT = os.environ['CELLXPLORER_DATA']\n",
                encoding="utf-8",
            )
            (root / "app" / "db.py").write_text(
                "import os\n"
                "class Engine:\n"
                "    def dispose(self):\n"
                "        with open(os.environ['DISPOSE_LOG'], 'a', encoding='utf-8') as fh:\n"
                "            fh.write('disposed\\n')\n"
                "engine = Engine()\n",
                encoding="utf-8",
            )
            (root / "tests" / "test_first.py").write_text(
                "import os\n"
                "import unittest\n"
                "from app import db\n"
                "from app.config import DATA_ROOT\n"
                "class First(unittest.TestCase):\n"
                "    def test_root(self):\n"
                "        self.assertEqual(DATA_ROOT, os.environ['CELLXPLORER_DATA'])\n"
                "        os.environ['LEAK_FROM_FIRST'] = 'bad'\n",
                encoding="utf-8",
            )
            (root / "tests" / "test_failure.py").write_text(
                "import unittest\n"
                "class Failure(unittest.TestCase):\n"
                "    def test_intentional_failure(self):\n"
                "        self.fail('intentional diagnostic failure')\n",
                encoding="utf-8",
            )
            (root / "tests" / "test_second.py").write_text(
                "import os\n"
                "import unittest\n"
                "from app import db\n"
                "from app.config import DATA_ROOT\n"
                "class Second(unittest.TestCase):\n"
                "    def test_reset(self):\n"
                "        self.assertEqual(DATA_ROOT, os.environ['CELLXPLORER_DATA'])\n"
                "        self.assertNotIn('LEAK_FROM_FIRST', os.environ)\n"
                "        with open(os.environ['DISPOSE_LOG'], encoding='utf-8') as fh:\n"
                "            self.assertTrue(fh.read())\n",
                encoding="utf-8",
            )
            dispose_log = root / "dispose.log"
            with mock.patch.dict(os.environ, {"DISPOSE_LOG": str(dispose_log)}, clear=False):
                shard = benchmark.run_worker_shard(
                    root=root,
                    python_executable=sys.executable,
                    modules=[
                        "tests.test_first",
                        "tests.test_failure",
                        "tests.test_second",
                    ],
                    data_root=root / "worker-data",
                    backend_jobs=1,
                )

            results = shard["modules"]
            self.assertEqual(shard["exit_code"], 0)
            self.assertEqual([item["module"] for item in results], [
                "tests.test_first",
                "tests.test_failure",
                "tests.test_second",
            ])
            self.assertTrue(results[0]["successful"])
            self.assertFalse(results[1]["successful"])
            self.assertIn(
                "tests.test_failure.Failure.test_intentional_failure",
                results[1]["failures"],
            )
            self.assertTrue(results[2]["successful"])

    def test_worker_protocol_returns_json_for_each_module(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "tests").mkdir()
            (root / "tests" / "__init__.py").write_text("", encoding="utf-8")
            (root / "tests" / "test_probe.py").write_text(
                "import unittest\n"
                "class Probe(unittest.TestCase):\n"
                "    def test_ok(self): pass\n",
                encoding="utf-8",
            )
            worker_env = os.environ.copy()
            worker_env.pop("CELLXPLORER_DATA", None)
            process = subprocess.Popen(
                [sys.executable, str(SCRIPT_PATH), "--worker", "--root", str(root), "--jobs", "1"],
                cwd=root,
                env=worker_env,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            assert process.stdin is not None
            assert process.stdout is not None
            process.stdin.write(json.dumps({"module": "tests.test_probe", "data_root": str(root / "data")}) + "\n")
            process.stdin.write(json.dumps({"command": "stop"}) + "\n")
            process.stdin.close()
            line = process.stdout.readline()
            process.wait(timeout=20)
            payload = json.loads(line)

            self.assertEqual(payload["case_count"], 1)
            self.assertTrue(payload["successful"])
            self.assertEqual(process.returncode, 0)
            process.stdout.close()
            assert process.stderr is not None
            process.stderr.close()


if __name__ == "__main__":
    unittest.main()
