from __future__ import annotations

import importlib.util
import os
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "cellxplorer_backend_entry", ROOT / "packaging" / "backend_entry.py"
)
assert SPEC and SPEC.loader
backend_entry = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(backend_entry)


class PackagedBackendTests(unittest.TestCase):
    def test_backend_port_defaults_to_development_port(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(backend_entry._backend_port(), 8642)

    def test_backend_port_uses_desktop_selected_port(self):
        with patch.dict(os.environ, {"CELLXPLORER_PORT": "53127"}, clear=True):
            self.assertEqual(backend_entry._backend_port(), 53127)

    def test_backend_port_rejects_invalid_values(self):
        for value in ("invalid", "0", "70000"):
            with self.subTest(value=value):
                with patch.dict(os.environ, {"CELLXPLORER_PORT": value}, clear=True):
                    self.assertEqual(backend_entry._backend_port(), 8642)


if __name__ == "__main__":
    unittest.main()
