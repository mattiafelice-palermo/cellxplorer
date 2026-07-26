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
    (root / "scripts" / "run_backend_tests.py").write_text("# stub\n", encoding="utf-8")
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

    def command_for(self, needle: str) -> list[str]:
        for command, _cwd, _env in self.calls:
            if any(needle in part for part in command):
                return command
        self.fail(f"No command containing {needle!r}")

    def test_stages_use_required_order(self):
        code, stdout, _stderr = self.run_preflight()
        self.assertEqual(code, 0)
        self.assertEqual(len(self.calls), 4)
        self.assertIn("[1/4] Version consistency", stdout)
        self.assertIn("PASS: Version consistency", stdout)
        self.assertIn("PASS: Backend tests", stdout)
        self.assertIn("PASS: Frontend policy tests", stdout)
        self.assertIn("PASS: Frontend production build", stdout)
        self.assertIn("Running 3 verification stages in parallel", stdout)

        version_cmd = self.command_for("check_versions.py")
        backend_cmd = self.command_for("run_backend_tests.py")
        frontend_cmd = self.command_for("--test")
        build_cmds = [
            command
            for command, _, _ in self.calls
            if command[:3] == [r"C:\Node\npm.cmd", "--prefix", "frontend"]
        ]
        self.assertEqual(len(build_cmds), 1)
        build_cmd = build_cmds[0]
        self.assertEqual(version_cmd[0], r"C:\Python\python.exe")
        self.assertEqual(backend_cmd[0], r"C:\Python\python.exe")
        self.assertEqual(backend_cmd[2], "--jobs")
        self.assertTrue(backend_cmd[3].isdigit())
        self.assertEqual(frontend_cmd[:2], [r"C:\Node\node.exe", "--test"])
        self.assertEqual(build_cmd, [r"C:\Node\npm.cmd", "--prefix", "frontend", "run", "build"])
        self.assertTrue(
            self.calls[0][0][1].endswith("check_versions.py")
            or self.calls[0][0][1].endswith("scripts\\check_versions.py")
        )

    def test_current_python_executable_is_used(self):
        self.run_preflight()
        version_cmd = self.command_for("check_versions.py")
        backend_cmd = self.command_for("run_backend_tests.py")
        self.assertEqual(version_cmd[0], r"C:\Python\python.exe")
        self.assertEqual(backend_cmd[0], r"C:\Python\python.exe")

    def test_frontend_test_paths_are_sorted_and_explicit(self):
        self.run_preflight()
        frontend_cmd = self.command_for("--test")
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

    def test_version_failure_skips_parallel_wave(self):
        def fail_on_version(command, cwd, env):
            self.calls.append((command, cwd, env))
            if "check_versions.py" in command[1]:
                return 1
            return 0

        code, stdout, stderr = self.run_preflight(run_command=fail_on_version)
        self.assertEqual(code, 1)
        self.assertEqual(len(self.calls), 1)
        self.assertIn("Preflight stopped. Later stages were not run.", stderr)
        self.assertNotIn("PREFLIGHT PASSED", stdout)

    def test_parallel_wave_failure_reports_failed_stage(self):
        def fail_on_backend(command, cwd, env):
            self.calls.append((command, cwd, env))
            if "run_backend_tests.py" in command[1]:
                return 1
            return 0

        code, stdout, stderr = self.run_preflight(run_command=fail_on_backend)
        self.assertEqual(code, 1)
        self.assertEqual(len(self.calls), 4)
        self.assertIn("Preflight failed:", stderr)
        self.assertIn("Backend tests", stderr)
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
