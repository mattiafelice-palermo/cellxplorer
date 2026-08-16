import importlib.util
import io
import json
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
    (root / "frontend" / "src").mkdir(parents=True)
    (root / "frontend" / "node_modules").mkdir(parents=True)
    (root / "scripts").mkdir(parents=True)
    (root / "scripts" / "check_versions.py").write_text("# stub\n", encoding="utf-8")
    (root / "scripts" / "run_backend_tests.py").write_text("# stub\n", encoding="utf-8")
    (root / "scripts" / "preflight.py").write_text("# stub\n", encoding="utf-8")
    (root / "frontend" / "index.html").write_text("<html></html>\n", encoding="utf-8")
    (root / "frontend" / "package.json").write_text('{"name":"cellxplorer-frontend"}\n', encoding="utf-8")
    (root / "frontend" / "package-lock.json").write_text('{"name":"cellxplorer-frontend"}\n', encoding="utf-8")
    (root / "frontend" / "vite.config.ts").write_text("export default {}\n", encoding="utf-8")
    (root / "frontend" / "tsconfig.json").write_text("{}\n", encoding="utf-8")
    (root / "frontend" / "src" / "main.tsx").write_text("export {}\n", encoding="utf-8")
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
                no_cache=kwargs.get("no_cache", False),
            )
        return code, stdout.getvalue(), stderr.getvalue()

    def command_for(self, needle: str) -> list[str]:
        for command, _cwd, _env in self.calls:
            if any(needle in part for part in command):
                return command
        self.fail(f"No command containing {needle!r}")

    def npm_exec_commands(self) -> list[list[str]]:
        return [
            command
            for command, _, _ in self.calls
            if command[:4] == [r"C:\Node\npm.cmd", "--prefix", "frontend", "exec"]
        ]

    def test_stages_use_required_order(self):
        code, stdout, _stderr = self.run_preflight(no_cache=True)
        self.assertEqual(code, 0)
        self.assertEqual(len(self.calls), 4)
        self.assertIn("[1/4] Version consistency", stdout)
        self.assertIn("PASS: Version consistency", stdout)
        self.assertIn("PASS: Backend + frontend tests", stdout)
        self.assertIn("PASS: Frontend type check", stdout)
        self.assertIn("PASS: Frontend production bundle", stdout)
        self.assertIn("Running 3 verification stages in parallel", stdout)
        self.assertIn("Preflight timings:", stdout)
        self.assertIn("Total preflight wall time:", stdout)

        version_cmd = self.command_for("check_versions.py")
        backend_cmd = self.command_for("run_backend_tests.py")
        frontend_cmd = self.command_for("run_backend_tests.py")
        npm_cmds = self.npm_exec_commands()
        self.assertEqual(len(npm_cmds), 2)
        self.assertEqual(npm_cmds[0], [r"C:\Node\npm.cmd", "--prefix", "frontend", "exec", "--", "tsc", "-b"])
        self.assertEqual(
            npm_cmds[1],
            [r"C:\Node\npm.cmd", "--prefix", "frontend", "exec", "--", "vite", "build"],
        )
        self.assertEqual(version_cmd[0], r"C:\Python\python.exe")
        self.assertEqual(backend_cmd[0], r"C:\Python\python.exe")
        self.assertEqual(backend_cmd[2], "--jobs")
        self.assertTrue(backend_cmd[3].isdigit())
        self.assertIn("--node", frontend_cmd)
        self.assertEqual(
            frontend_cmd[frontend_cmd.index("--node") + 1],
            r"C:\Node\node.exe",
        )

    def test_default_backend_jobs_restores_sixteen_worker_cap(self):
        with mock.patch.dict(os.environ, {"CELLXPLORER_PREFLIGHT_CPU_BUDGET": "16"}, clear=False):
            self.assertEqual(preflight.default_backend_jobs(), 16)

    def test_frontend_build_cache_skips_repeat_run(self):
        first_code, first_stdout, _stderr = self.run_preflight(no_cache=True)
        self.assertEqual(first_code, 0)
        self.assertEqual(len(self.calls), 4)
        cache = json.loads((self.repo / preflight.PREFLIGHT_CACHE_FILE).read_text(encoding="utf-8"))
        self.assertEqual(
            cache["frontend_policy_test_hash"],
            preflight.frontend_policy_input_hash(self.repo),
        )

        self.calls.clear()
        second_code, second_stdout, _stderr = self.run_preflight()
        self.assertEqual(second_code, 0)
        self.assertEqual(len(self.calls), 2)
        self.assertIn(preflight.SKIP_FRONTEND_BUILD_MESSAGE, second_stdout)
        self.assertIn("--skip-frontend-tests", self.command_for("run_backend_tests.py"))
        self.assertNotIn("tsc", " ".join(" ".join(cmd) for cmd, _, _ in self.calls))

    def test_frontend_build_cache_invalidated_by_source_change(self):
        self.run_preflight(no_cache=True)
        self.calls.clear()
        (self.repo / "frontend" / "src" / "touch.ts").write_text("export {}\n", encoding="utf-8")
        code, _stdout, _stderr = self.run_preflight()
        self.assertEqual(code, 0)
        self.assertEqual(len(self.calls), 4)

    def test_frontend_policy_cache_invalidated_by_test_change(self):
        self.run_preflight(no_cache=True)
        self.calls.clear()
        (self.repo / "frontend" / "tests" / "a.test.ts").write_text(
            "test change\n", encoding="utf-8"
        )
        code, _stdout, _stderr = self.run_preflight()
        self.assertEqual(code, 0)
        self.assertEqual(len(self.calls), 2)
        self.assertNotIn("--skip-frontend-tests", self.command_for("run_backend_tests.py"))

    def test_old_or_malformed_cache_runs_frontend_policy_tests(self):
        cache_path = self.repo / preflight.PREFLIGHT_CACHE_FILE
        for payload in (
            {
                "frontend_build_hash": preflight.frontend_build_input_hash(self.repo),
                "last_run_passed": True,
            },
            {
                "frontend_build_hash": preflight.frontend_build_input_hash(self.repo),
                "frontend_policy_test_hash": "stale",
                "last_run_passed": True,
            },
        ):
            cache_path.write_text(json.dumps(payload), encoding="utf-8")
            self.calls.clear()
            code, _stdout, _stderr = self.run_preflight()
            self.assertEqual(code, 0)
            self.assertNotIn("--skip-frontend-tests", self.command_for("run_backend_tests.py"))

        cache_path.write_text("{malformed", encoding="utf-8")
        self.calls.clear()
        code, _stdout, _stderr = self.run_preflight()
        self.assertEqual(code, 0)
        self.assertNotIn("--skip-frontend-tests", self.command_for("run_backend_tests.py"))

    def test_no_cache_forces_frontend_build(self):
        cache_path = self.repo / preflight.PREFLIGHT_CACHE_FILE
        cache_path.write_text(
            json.dumps(
                {
                    "frontend_build_hash": preflight.frontend_build_input_hash(self.repo),
                    "last_run_passed": True,
                }
            ),
            encoding="utf-8",
        )
        code, _stdout, _stderr = self.run_preflight(no_cache=True)
        self.assertEqual(code, 0)
        self.assertEqual(len(self.calls), 4)

    def test_failed_run_never_skips_frontend_build(self):
        def fail_on_bundle(command, cwd, env):
            self.calls.append((command, cwd, env))
            if command[-2:] == ["vite", "build"]:
                return 1
            return 0

        code, _stdout, _stderr = self.run_preflight(run_command=fail_on_bundle, no_cache=True)
        self.assertEqual(code, 1)
        cache = json.loads((self.repo / preflight.PREFLIGHT_CACHE_FILE).read_text(encoding="utf-8"))
        self.assertFalse(cache["last_run_passed"])

        self.calls.clear()
        second_code, _stdout, second_stdout = self.run_preflight()
        self.assertEqual(second_code, 0)
        self.assertEqual(len(self.calls), 4)
        self.assertNotIn(preflight.SKIP_FRONTEND_BUILD_MESSAGE, second_stdout)
        self.assertNotIn("--skip-frontend-tests", self.command_for("run_backend_tests.py"))

    def test_current_python_executable_is_used(self):
        self.run_preflight(no_cache=True)
        version_cmd = self.command_for("check_versions.py")
        backend_cmd = self.command_for("run_backend_tests.py")
        self.assertEqual(version_cmd[0], r"C:\Python\python.exe")
        self.assertEqual(backend_cmd[0], r"C:\Python\python.exe")

    def test_frontend_test_paths_are_sorted_and_explicit(self):
        self.run_preflight(no_cache=True)
        runner_cmd = self.command_for("run_backend_tests.py")
        self.assertNotIn(f"frontend{os.sep}tests{os.sep}a.test.ts", runner_cmd)
        self.assertNotIn(f"frontend{os.sep}tests{os.sep}b.test.ts", runner_cmd)

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
            self.run_preflight(run_command=capture_env, no_cache=True)
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

        code, stdout, stderr = self.run_preflight(run_command=fail_on_backend, no_cache=True)
        self.assertEqual(code, 1)
        self.assertEqual(len(self.calls), 4)
        self.assertIn("Preflight failed:", stderr)
        self.assertIn("Backend + frontend tests", stderr)
        self.assertNotIn("PREFLIGHT PASSED", stdout)

    def test_successful_stages_return_zero(self):
        code, stdout, _stderr = self.run_preflight(no_cache=True)
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
        self.run_preflight(no_cache=True)
        frontend_cwd = self.repo / "frontend"
        for command, cwd, _env in self.calls:
            command_text = " ".join(command)
            if "tsc" in command_text or "vite" in command_text:
                self.assertEqual(cwd, frontend_cwd)
            else:
                self.assertEqual(cwd, self.repo)


class PreflightRepoRootTests(unittest.TestCase):
    def test_repo_root_from_script_location(self):
        self.assertEqual(preflight.repo_root(SCRIPT_PATH), ROOT)


if __name__ == "__main__":
    unittest.main()
