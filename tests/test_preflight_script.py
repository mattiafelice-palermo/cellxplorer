import importlib.util
import io
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = ROOT / "scripts" / "preflight.py"


def load_preflight():
    spec = importlib.util.spec_from_file_location("preflight", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


preflight = load_preflight()


def make_repo() -> Path:
    root = Path(tempfile.mkdtemp(prefix="cellxplorer-preflight-"))
    (root / "frontend" / "tests").mkdir(parents=True)
    (root / "frontend" / "node_modules").mkdir(parents=True)
    (root / "scripts").mkdir(parents=True)
    (root / "scripts" / "check_versions.py").write_text("# stub\n", encoding="utf-8")
    (root / "frontend" / "tests" / "b.test.ts").write_text("", encoding="utf-8")
    (root / "frontend" / "tests" / "a.test.ts").write_text("", encoding="utf-8")
    return root


class PreflightScriptTests(unittest.TestCase):
    def setUp(self):
        self.repo = make_repo()
        self.calls: list[tuple[list[str], Path, dict[str, str]]] = []

    def mock_run(self, command, cwd, env):
        self.calls.append((command, cwd, env))
        return 0

    def failing_run(self, command, cwd, env):
        self.calls.append((command, cwd, env))
        return 1

    def run_preflight(self, **kwargs):
        stdout = io.StringIO()
        stderr = io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = preflight.run_preflight(
                self.repo,
                python_executable=r"C:\Python\python.exe",
                node_executable=r"C:\Node\node.exe",
                npm_executable=r"C:\Node\npm.cmd",
                run_command=kwargs.get("run_command", self.mock_run),
            )
        return code, stdout.getvalue(), stderr.getvalue()

    def test_stages_use_required_order(self):
        code, stdout, _stderr = self.run_preflight()
        self.assertEqual(code, 0)
        self.assertEqual(len(self.calls), 4)
        names = [
            "Version consistency",
            "Backend tests",
            "Frontend policy tests",
            "Frontend production build",
        ]
        for index, name in enumerate(names, start=1):
            self.assertIn(f"[{index}/4] {name}", stdout)
            self.assertIn(f"PASS: {name}", stdout)

        version_cmd, backend_cmd, frontend_cmd, build_cmd = [call[0] for call in self.calls]
        self.assertTrue(version_cmd[1].endswith("scripts\\check_versions.py") or version_cmd[1].endswith("scripts/check_versions.py"))
        self.assertEqual(backend_cmd[:5], [r"C:\Python\python.exe", "-m", "unittest", "discover", "tests"])
        self.assertEqual(frontend_cmd[:2], [r"C:\Node\node.exe", "--test"])
        self.assertEqual(build_cmd, [r"C:\Node\npm.cmd", "--prefix", "frontend", "run", "build"])

    def test_current_python_executable_is_used(self):
        self.run_preflight()
        version_cmd = self.calls[0][0]
        backend_cmd = self.calls[1][0]
        self.assertEqual(version_cmd[0], r"C:\Python\python.exe")
        self.assertEqual(backend_cmd[0], r"C:\Python\python.exe")

    def test_frontend_test_paths_are_sorted_and_explicit(self):
        self.run_preflight()
        frontend_cmd = self.calls[2][0]
        test_paths = frontend_cmd[2:]
        self.assertEqual(
            test_paths,
            [
                f"frontend{os.sep}tests{os.sep}a.test.ts",
                f"frontend{os.sep}tests{os.sep}b.test.ts",
            ],
        )

    def test_no_frontend_tests_causes_failure(self):
        for path in (self.repo / "frontend" / "tests").glob("*.test.ts"):
            path.unlink()
        _code, _stdout, stderr = self.run_preflight()
        self.assertEqual(_code, 1)
        self.assertIn("No frontend policy tests were found", stderr)
        self.assertEqual(self.calls, [])

    def test_missing_node_causes_failure(self):
        with mock.patch.object(preflight, "find_node_executable", return_value=None):
            with redirect_stderr(io.StringIO()) as stderr:
                code = preflight.run_preflight(
                    self.repo,
                    npm_executable=r"C:\Node\npm.cmd",
                    run_command=self.mock_run,
                )
        self.assertEqual(code, 1)
        self.assertIn("Node.js is not available", stderr.getvalue())
        self.assertEqual(self.calls, [])

    def test_missing_npm_causes_failure(self):
        with mock.patch.object(preflight, "find_npm_executable", return_value=None):
            with redirect_stderr(io.StringIO()) as stderr:
                code = preflight.run_preflight(
                    self.repo,
                    node_executable=r"C:\Node\node.exe",
                    run_command=self.mock_run,
                )
        self.assertEqual(code, 1)
        self.assertIn("npm is not available", stderr.getvalue())
        self.assertEqual(self.calls, [])

    def test_missing_node_modules_gives_installation_instruction(self):
        import shutil

        shutil.rmtree(self.repo / "frontend" / "node_modules")
        _code, _stdout, stderr = self.run_preflight()
        self.assertEqual(_code, 1)
        self.assertIn("Frontend dependencies are not installed.", stderr)
        self.assertIn("Run: npm --prefix frontend ci", stderr)

    def test_cellxplorer_data_is_replaced(self):
        original = "C:\\Users\\real\\.cellxplorer"
        observed: list[str] = []

        def capture_env(command, cwd, env):
            observed.append(env["CELLXPLORER_DATA"])
            self.assertNotEqual(env["CELLXPLORER_DATA"], original)
            self.assertTrue(Path(env["CELLXPLORER_DATA"]).is_dir())
            return 0

        with mock.patch.dict("os.environ", {"CELLXPLORER_DATA": original}, clear=False):
            self.run_preflight(run_command=capture_env)
        self.assertEqual(len(observed), 4)
        self.assertEqual(len(set(observed)), 1)

    def test_first_failed_stage_stops_later_stages(self):
        def fail_on_backend(command, cwd, env):
            self.calls.append((command, cwd, env))
            if command[1:3] == ["-m", "unittest"]:
                return 1
            return 0

        code, stdout, stderr = self.run_preflight(run_command=fail_on_backend)
        self.assertEqual(code, 1)
        self.assertEqual(len(self.calls), 2)
        self.assertIn("FAIL: command exited with code 1", stderr)
        self.assertIn("Preflight stopped. Later stages were not run.", stderr)
        self.assertNotIn("[3/4] Frontend policy tests", stdout)
        self.assertNotIn("PREFLIGHT PASSED", stdout)

    def test_successful_stages_return_zero(self):
        code, stdout, _stderr = self.run_preflight()
        self.assertEqual(code, 0)
        self.assertIn("PREFLIGHT PASSED", stdout)
        self.assertIn("4/4 stages completed successfully", stdout)

    def test_interruption_returns_130(self):
        def interrupt(_command, _cwd, _env):
            raise KeyboardInterrupt

        code, _stdout, _stderr = self.run_preflight(run_command=interrupt)
        self.assertEqual(code, 130)

    def test_shell_true_is_never_used(self):
        with mock.patch("preflight.subprocess.run", autospec=True) as run_mock:
            run_mock.return_value = subprocess.CompletedProcess([], 0)
            preflight.default_run_command(["python", "-V"], ROOT, {})
        run_mock.assert_called_once()
        self.assertIs(run_mock.call_args.kwargs.get("shell"), False)

    def test_repository_root_is_used_as_cwd(self):
        self.run_preflight()
        for _command, cwd, _env in self.calls:
            self.assertEqual(cwd, self.repo)


class PreflightRepoRootTests(unittest.TestCase):
    def test_repo_root_from_script_location(self):
        self.assertEqual(preflight.repo_root(SCRIPT_PATH), ROOT)


if __name__ == "__main__":
    unittest.main()
