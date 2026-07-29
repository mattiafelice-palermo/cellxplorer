"""Tests for scripts/smoke_packaged_backend.py (spec 029).

The script's decisions are testable without building a ~100 MB sidecar; only the
"does the frozen binary serve" part needs the real artifact, and that runs in
release CI.
"""
import importlib.util
import os
import socket
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))

MODULE_SPEC = importlib.util.spec_from_file_location(
    "smoke_packaged_backend", ROOT / "scripts" / "smoke_packaged_backend.py"
)
smoke = importlib.util.module_from_spec(MODULE_SPEC)
MODULE_SPEC.loader.exec_module(smoke)


class FreePortTests(unittest.TestCase):
    def test_returns_a_port_that_can_actually_be_bound(self):
        port = smoke.find_free_port()
        self.assertTrue(1 <= port <= 65535)
        # The sidecar has to bind it moments later, so it must really be free.
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", port))

    def test_successive_calls_do_not_hand_out_a_held_port(self):
        first = smoke.find_free_port()
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", first))
            sock.listen(1)
            self.assertNotEqual(smoke.find_free_port(), first)


class ChildEnvironmentTests(unittest.TestCase):
    def test_carries_every_variable_tauri_sets(self):
        # Mirrors the .env(...) chain in src-tauri/src/main.rs. If the shell starts
        # setting another variable, this test should be updated with it.
        env = smoke.child_environment(12345, Path("C:/tmp/data"), "9.9.9")
        self.assertEqual(env["CELLXPLORER_PORT"], "12345")
        self.assertEqual(env["CELLXPLORER_DATA"], str(Path("C:/tmp/data")))
        self.assertEqual(env["CELLXPLORER_APP_VERSION"], "9.9.9")
        self.assertEqual(env["CELLXPLORER_CHANNEL"], "stable")
        self.assertEqual(env["CELLXPLORER_STARTUP_MODE"], "smoke-test")

    def test_does_not_inherit_a_real_install_instance(self):
        os.environ["CELLXPLORER_INSTALL_INSTANCE_ID"] = "leaked"
        try:
            env = smoke.child_environment(1, Path("d"), "1.0.0")
            self.assertNotIn("CELLXPLORER_INSTALL_INSTANCE_ID", env)
        finally:
            os.environ.pop("CELLXPLORER_INSTALL_INSTANCE_ID", None)

    def test_overrides_an_inherited_data_root(self):
        os.environ["CELLXPLORER_DATA"] = "C:/real/library"
        try:
            env = smoke.child_environment(1, Path("C:/tmp/isolated"), "1.0.0")
            self.assertEqual(env["CELLXPLORER_DATA"], str(Path("C:/tmp/isolated")))
        finally:
            os.environ["CELLXPLORER_DATA"] = str(ROOT / ".test-cellxplorer")


class ReadinessTests(unittest.TestCase):
    def test_health_accepts_ok_and_degraded(self):
        # "degraded" still means the process is alive and serving, which is what
        # this smoke test is asserting.
        self.assertTrue(smoke.health_is_ready({"status": "ok"}))
        self.assertTrue(smoke.health_is_ready({"status": "degraded"}))

    def test_health_rejects_anything_else(self):
        for payload in ({"status": "starting"}, {}, None, "ok", [1]):
            with self.subTest(payload=payload):
                self.assertFalse(smoke.health_is_ready(payload))

    def test_database_must_be_compatible_and_have_a_revision(self):
        self.assertTrue(
            smoke.database_is_compatible({"compatible": True, "schema_revision": "abc123"})
        )

    def test_database_rejects_incompatible_or_unmigrated(self):
        for payload in (
            {"compatible": False, "schema_revision": "abc"},
            {"compatible": True, "schema_revision": None},
            {"compatible": True},
            {},
            None,
        ):
            with self.subTest(payload=payload):
                self.assertFalse(smoke.database_is_compatible(payload))


class DependencyTests(unittest.TestCase):
    def test_the_script_does_not_depend_on_httpx(self):
        # httpx is not declared anywhere and is only present on some machines by
        # accident. Depending on it broke this repo's CI once already; adding it to
        # requirements.txt would also bundle it into the sidecar.
        #
        # Inspect the parsed imports, not the raw text: the module docstring names
        # httpx precisely to explain why it is not used.
        import ast

        tree = ast.parse((ROOT / "scripts" / "smoke_packaged_backend.py").read_text("utf-8"))
        imported: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported.add(node.module.split(".")[0])
        self.assertNotIn("httpx", imported)
        self.assertNotIn("starlette", imported)
        self.assertIn("urllib", imported)


class MissingSidecarTests(unittest.TestCase):
    def test_a_missing_sidecar_fails_rather_than_passing_quietly(self):
        code = smoke.run_smoke_test(ROOT / "does-not-exist.exe", timeout=1.0)
        self.assertEqual(code, 1)


if __name__ == "__main__":
    unittest.main()
