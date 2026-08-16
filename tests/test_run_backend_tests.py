import io
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
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
    def make_runner_repo(self, root: Path) -> None:
        (root / "tests").mkdir()
        (root / "frontend" / "tests").mkdir(parents=True)
        for name in ("test_alpha.py", "test_beta.py"):
            (root / "tests" / name).write_text("", encoding="utf-8")
        for name in ("a.test.ts", "b.test.ts"):
            (root / "frontend" / "tests" / name).write_text("", encoding="utf-8")

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

    def test_timing_history_ignores_missing_malformed_and_invalid_values(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            cache_path = root / runner.PREFLIGHT_CACHE_FILE
            self.assertEqual(runner.read_timing_history(root), {})

            cache_path.write_text(
                json.dumps(
                    {
                        runner.TEST_TIMINGS_KEY: {
                            "known": 3.5,
                            "negative": -1,
                            "text": "2.0",
                            "boolean": True,
                            "nan": float("nan"),
                        }
                    }
                ),
                encoding="utf-8",
            )
            self.assertEqual(runner.read_timing_history(root), {"known": 3.5})

            cache_path.write_text("{malformed", encoding="utf-8")
            self.assertEqual(runner.read_timing_history(root), {})

    def test_cost_aware_ordering_puts_unknown_tasks_first_then_known_longest_first(self):
        history = {"tests.test_short": 1.0, "tests.test_long": 8.0}
        self.assertEqual(
            runner.order_task_names(
                ["tests.test_short", "tests.test_new", "tests.test_long"],
                history,
            ),
            ["tests.test_new", "tests.test_long", "tests.test_short"],
        )

    def test_cost_aware_runner_submits_longest_known_tasks_first_and_persists_successes(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.make_runner_repo(root)
            (root / runner.PREFLIGHT_CACHE_FILE).write_text(
                json.dumps(
                    {
                        runner.TEST_TIMINGS_KEY: {
                            "tests.test_alpha": 1.0,
                            "tests.test_beta": 10.0,
                            "frontend/tests/a.test.ts": 5.0,
                            "frontend/tests/b.test.ts": 2.0,
                        }
                    }
                ),
                encoding="utf-8",
            )
            observed: list[str] = []

            def fake_run(command, cwd, env, capture_output, text, shell):
                if "--test" in command:
                    observed.append(Path(command[-1]).relative_to(root).as_posix())
                else:
                    observed.append(command[-1])
                return mock.Mock(returncode=0, stdout="", stderr="")

            with (
                mock.patch.object(runner, "repo_root", return_value=root),
                mock.patch.object(runner.subprocess, "run", side_effect=fake_run),
                redirect_stdout(io.StringIO()),
            ):
                code = runner.main(
                    ["--jobs", "1", "--node", "node.exe", "--data-root", str(root / "data")]
                )

            self.assertEqual(code, 0)
            self.assertEqual(
                observed,
                [
                    "tests.test_beta",
                    "frontend/tests/a.test.ts",
                    "frontend/tests/b.test.ts",
                    "tests.test_alpha",
                ],
            )
            cache = json.loads((root / runner.PREFLIGHT_CACHE_FILE).read_text(encoding="utf-8"))
            self.assertEqual(
                set(cache[runner.TEST_TIMINGS_KEY]),
                {
                    "tests.test_alpha",
                    "tests.test_beta",
                    "frontend/tests/a.test.ts",
                    "frontend/tests/b.test.ts",
                },
            )

    def test_effective_backend_jobs_respects_cpu_budget(self):
        with mock.patch.dict(os.environ, {"CELLXPLORER_PREFLIGHT_CPU_BUDGET": "4"}, clear=False):
            self.assertEqual(runner.effective_backend_jobs(16, 20), 4)

    def test_default_jobs_restores_sixteen_worker_cap(self):
        with mock.patch.dict(os.environ, {"CELLXPLORER_PREFLIGHT_CPU_BUDGET": "16"}, clear=False):
            self.assertEqual(runner.default_jobs(), 16)

    def test_backend_and_frontend_files_share_one_bounded_pool(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.make_runner_repo(root)
            observed: list[tuple[list[str], dict[str, str]]] = []

            def fake_run(command, cwd, env, capture_output, text, shell):
                observed.append((command, env))
                return mock.Mock(returncode=0, stdout="", stderr="")

            real_pool = runner.ThreadPoolExecutor
            pool_sizes: list[int] = []

            class RecordingPool:
                def __init__(self, max_workers):
                    pool_sizes.append(max_workers)
                    self._pool = real_pool(max_workers=max_workers)

                def __enter__(self):
                    return self._pool.__enter__()

                def __exit__(self, exc_type, exc, traceback):
                    return self._pool.__exit__(exc_type, exc, traceback)

            stdout = io.StringIO()
            with (
                mock.patch.object(runner, "repo_root", return_value=root),
                mock.patch.object(runner.subprocess, "run", side_effect=fake_run),
                mock.patch.object(runner, "ThreadPoolExecutor", RecordingPool),
                redirect_stdout(stdout),
            ):
                code = runner.main(
                    ["--jobs", "2", "--node", "node.exe", "--data-root", str(root / "data")]
                )

            self.assertEqual(code, 0)
            self.assertEqual(pool_sizes, [2])
            backend_commands = [command for command, _env in observed if "-m" in command]
            frontend_commands = [command for command, _env in observed if "--test" in command]
            self.assertEqual(len(backend_commands), 2)
            self.assertEqual(len(frontend_commands), 2)
            data_roots = {
                env["CELLXPLORER_DATA"]
                for command, env in observed
                if "-m" in command
            }
            self.assertEqual(len(data_roots), 2)
            output = stdout.getvalue()
            self.assertIn("PASS frontend/tests/", output)
            self.assertIn("Slowest test files/modules:", output)
            self.assertIn("All 4 backend/frontend test files/modules passed.", output)

    def test_frontend_failure_names_exact_file_and_preserves_timing(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.make_runner_repo(root)

            def fake_run(command, cwd, env, capture_output, text, shell):
                if any("b.test.ts" in part for part in command):
                    return mock.Mock(returncode=1, stdout="", stderr="frontend failure detail")
                return mock.Mock(returncode=0, stdout="", stderr="")

            stdout = io.StringIO()
            stderr = io.StringIO()
            with (
                mock.patch.object(runner, "repo_root", return_value=root),
                mock.patch.object(runner.subprocess, "run", side_effect=fake_run),
                redirect_stdout(stdout),
                redirect_stderr(stderr),
            ):
                code = runner.main(
                    ["--jobs", "3", "--node", "node.exe", "--data-root", str(root / "data")]
                )

            self.assertEqual(code, 1)
            self.assertIn("FAIL frontend/tests/b.test.ts", stderr.getvalue())
            self.assertIn("=== frontend/tests/b.test.ts ===", stderr.getvalue())
            self.assertIn("frontend failure detail", stderr.getvalue())
            self.assertIn("frontend/tests/b.test.ts", stdout.getvalue())

            cache = json.loads((root / runner.PREFLIGHT_CACHE_FILE).read_text(encoding="utf-8"))
            self.assertNotIn("frontend/tests/b.test.ts", cache[runner.TEST_TIMINGS_KEY])
            self.assertIn("frontend/tests/a.test.ts", cache[runner.TEST_TIMINGS_KEY])

    def test_skip_frontend_tests_keeps_backend_tasks_in_pool(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.make_runner_repo(root)
            observed: list[list[str]] = []

            def fake_run(command, cwd, env, capture_output, text, shell):
                observed.append(command)
                return mock.Mock(returncode=0, stdout="", stderr="")

            stdout = io.StringIO()
            with (
                mock.patch.object(runner, "repo_root", return_value=root),
                mock.patch.object(runner.subprocess, "run", side_effect=fake_run),
                redirect_stdout(stdout),
            ):
                code = runner.main(["--jobs", "2", "--skip-frontend-tests"])

            self.assertEqual(code, 0)
            self.assertEqual(len(observed), 2)
            self.assertIn(runner.FRONTEND_POLICY_SKIP_MESSAGE, stdout.getvalue())
            self.assertIn("All 2 backend test modules passed.", stdout.getvalue())


if __name__ == "__main__":
    unittest.main()
