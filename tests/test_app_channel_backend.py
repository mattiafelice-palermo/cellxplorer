import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.services import app_channel


class BackendAppChannelTests(unittest.TestCase):
    def test_packaged_stable_and_beta(self):
        with patch.dict(os.environ, {"CELLXPLORER_STARTUP_MODE": "manual", "CELLXPLORER_CHANNEL": "stable"}, clear=True):
            self.assertEqual(app_channel.deep_link_import_base(), "cellxplorer://import-analysis")
        with patch.dict(os.environ, {"CELLXPLORER_STARTUP_MODE": "startup", "CELLXPLORER_CHANNEL": "beta"}, clear=True):
            self.assertEqual(app_channel.deep_link_import_base(), "cellxplorer-beta://import-analysis")

    def test_non_packaged_missing_defaults_stable(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(app_channel.resolve_app_channel(), "stable")

    def test_packaged_missing_or_invalid_fails(self):
        with patch.dict(os.environ, {"CELLXPLORER_STARTUP_MODE": "manual"}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "required in packaged mode"):
                app_channel.resolve_app_channel()
        with patch.dict(os.environ, {"CELLXPLORER_STARTUP_MODE": "manual", "CELLXPLORER_CHANNEL": "preview"}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "Unsupported CELLXPLORER_CHANNEL"):
                app_channel.resolve_app_channel()

    def test_validate_startup_fails_for_packaged_invalid(self):
        with patch.dict(os.environ, {"CELLXPLORER_STARTUP_MODE": "manual", "CELLXPLORER_CHANNEL": ""}, clear=True):
            with self.assertRaises(RuntimeError):
                app_channel.validate_packaged_channel_at_startup()


if __name__ == "__main__":
    unittest.main()
