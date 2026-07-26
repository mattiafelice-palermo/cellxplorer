import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = ROOT / "scripts" / "run_backend_tests.py"


def load_runner():
    spec = importlib.util.spec_from_file_location("run_backend_tests", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


runner = load_runner()


class RunBackendTestsTests(unittest.TestCase):
    def test_run_module_preserves_unique_cellxplorer_data(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "tests").mkdir()
            (root / "tests" / "test_alpha.py").write_text("", encoding="utf-8")
            (root / "tests" / "test_beta.py").write_text("", encoding="utf-8")

            observed: dict[str, str] = {}

            def fake_run(command, cwd, env, capture_output, text, shell):
                module = command[-1]
                observed[module] = env["CELLXPLORER_DATA"]
                return mock.Mock(returncode=0, stdout="", stderr="")

            with mock.patch.object(runner.subprocess, "run", side_effect=fake_run):
                jobs = runner.effective_backend_jobs(2, 2)
                first = runner.run_module(
                    python_executable=sys.executable,
                    root=root,
                    module="tests.test_alpha",
                    data_dir=root / "data" / "tests-test_alpha",
                    backend_jobs=jobs,
                )
                second = runner.run_module(
                    python_executable=sys.executable,
                    root=root,
                    module="tests.test_beta",
                    data_dir=root / "data" / "tests-test_beta",
                    backend_jobs=jobs,
                )

            self.assertNotEqual(first[3], second[3])
            self.assertEqual(first[3], str(root / "data" / "tests-test_alpha"))
            self.assertEqual(second[3], str(root / "data" / "tests-test_beta"))
            self.assertEqual(observed["tests.test_alpha"], first[3])
            self.assertEqual(observed["tests.test_beta"], second[3])

    def test_ndax_budget_reduces_when_backend_parallelism_is_high(self):
        with mock.patch.dict(os.environ, {"CELLXPLORER_PREFLIGHT_CPU_BUDGET": "8"}, clear=False):
            self.assertLess(runner.ndax_worker_budget(8), runner.ndax_worker_budget(1))

    def test_effective_backend_jobs_respects_cpu_budget(self):
        with mock.patch.dict(os.environ, {"CELLXPLORER_PREFLIGHT_CPU_BUDGET": "4"}, clear=False):
            self.assertEqual(runner.effective_backend_jobs(16, 20), 4)


if __name__ == "__main__":
    unittest.main()
