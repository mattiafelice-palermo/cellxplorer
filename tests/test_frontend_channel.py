import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "frontend_channel.py"
BUILD_SCRIPT = ROOT / "scripts" / "build_frontend_channel.py"
NSIS_HOOKS = ROOT / "src-tauri" / "nsis-hooks.nsh"
KILL_SCRIPT = ROOT / "src-tauri" / "kill_installation_processes.ps1"


def load_frontend_channel():
    spec = importlib.util.spec_from_file_location("frontend_channel", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


frontend_channel = load_frontend_channel()


def load_build_frontend_channel():
    spec = importlib.util.spec_from_file_location("build_frontend_channel", BUILD_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


build_frontend_channel = load_build_frontend_channel()


class FrontendChannelStampTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.dist = self.root / "frontend" / "dist"
        self.dist.mkdir(parents=True)
        (self.dist / "index.html").write_text("<html></html>", encoding="utf-8")
        for relative in frontend_channel.BRANDING_INPUTS:
            target = self.root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b"fixture")

    def tearDown(self):
        self.temp.cleanup()

    def test_write_and_verify_matching_channel(self):
        frontend_channel.write_stamp(self.root, "beta")
        frontend_channel.verify_stamp(self.root, "beta")

    def test_verify_rejects_channel_mismatch(self):
        frontend_channel.write_stamp(self.root, "stable")
        with self.assertRaisesRegex(RuntimeError, "built for channel 'stable'"):
            frontend_channel.verify_stamp(self.root, "beta")

    def test_verify_rejects_missing_stamp(self):
        with self.assertRaisesRegex(RuntimeError, "Missing frontend channel stamp"):
            frontend_channel.verify_stamp(self.root, "stable")

    def test_channel_builder_consumes_requested_channel_and_writes_stamp(self):
        completed = type("Completed", (), {"returncode": 0})()
        calls: list[tuple[list[str], Path, dict[str, str] | None]] = []

        def fake_run(command, *, cwd, env=None, check=False):
            del check
            calls.append((command, cwd, env))
            return completed

        with patch.object(build_frontend_channel.subprocess, "run", side_effect=fake_run):
            self.assertEqual(build_frontend_channel.main(["beta"]), 0)

        self.assertEqual(calls[0][1], build_frontend_channel.FRONTEND)
        self.assertEqual(calls[0][2]["VITE_CELLXPLORER_CHANNEL"], "beta")
        self.assertEqual(calls[1][0][-3:], ["write", "--channel", "beta"])

    def test_channel_builder_rejects_invalid_channel_before_build(self):
        with self.assertRaises(SystemExit):
            build_frontend_channel.main(["preview"])


class NsisProcessCleanupTests(unittest.TestCase):
    def test_hooks_kill_by_install_dir_not_image_name(self):
        hooks = NSIS_HOOKS.read_text(encoding="utf-8")
        self.assertIn("$INSTDIR", hooks)
        self.assertIn("kill_installation_processes.ps1", hooks)
        self.assertIn("-File", hooks)
        self.assertIn("Abort", hooks)
        self.assertNotIn("taskkill /F /T /IM cellxplorer.exe", hooks)
        self.assertNotIn("taskkill /F /T /IM cellxplorer-backend.exe", hooks)

    def test_kill_script_scopes_to_install_prefix(self):
        script = KILL_SCRIPT.read_text(encoding="utf-8")
        self.assertIn("StartsWith($prefix", script)
        self.assertIn("AddSeconds(10)", script)
        self.assertIn("$remaining.Count", script)
        self.assertNotIn("/IM cellxplorer", script)


if __name__ == "__main__":
    unittest.main()
