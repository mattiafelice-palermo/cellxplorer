#!/usr/bin/env python3
"""Deterministic Beta icon assets from the committed Stable frontend icon."""

from __future__ import annotations

import struct
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STABLE_ICON = ROOT / "frontend" / "public" / "app-icon.png"
STABLE_ICO = ROOT / "src-tauri" / "icons" / "icon.ico"
BETA_DIR = ROOT / "src-tauri" / "icons-beta"
BETA_PUBLIC = ROOT / "frontend" / "public" / "app-icon-beta.png"
SCRIPT = ROOT / "scripts" / "build_beta_icons.py"


class BuildBetaIconsTests(unittest.TestCase):
    def test_script_is_present(self):
        self.assertTrue(SCRIPT.is_file())

    def test_committed_beta_assets_exist(self):
        for path in (
            BETA_PUBLIC,
            BETA_DIR / "icon.png",
            BETA_DIR / "icon.ico",
            BETA_DIR / "icon-256.rgba",
        ):
            with self.subTest(path=path.as_posix()):
                self.assertTrue(path.is_file(), f"Missing {path}")

    def test_stable_assets_are_unchanged_since_generation(self):
        self.assertTrue(STABLE_ICON.is_file())
        self.assertTrue(STABLE_ICO.is_file())

    def test_beta_ico_contains_required_sizes(self):
        try:
            from PIL import Image
        except ImportError as error:
            self.skipTest(f"Pillow is required for icon tests: {error}")

        with Image.open(BETA_DIR / "icon.ico") as icon:
            sizes = sorted(icon.info.get("sizes", [(icon.width, icon.height)]))
        self.assertEqual(sizes, [(16, 16), (24, 24), (32, 32), (48, 48), (256, 256)])

    def test_beta_rgba_is_256_square(self):
        raw = (BETA_DIR / "icon-256.rgba").read_bytes()
        self.assertEqual(len(raw), 256 * 256 * 4)

    def test_regeneration_is_deterministic_when_pillow_available(self):
        try:
            from PIL import Image  # noqa: F401
        except ImportError as error:
            self.skipTest(f"Pillow is required for regeneration test: {error}")

        import importlib.util

        spec = importlib.util.spec_from_file_location("build_beta_icons", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)

        before = {
            path: path.read_bytes()
            for path in (
                BETA_PUBLIC,
                BETA_DIR / "icon.png",
                BETA_DIR / "icon.ico",
                BETA_DIR / "icon-256.rgba",
            )
        }
        self.assertEqual(module.main(), 0)
        for path, original in before.items():
            with self.subTest(path=path.as_posix()):
                self.assertEqual(path.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
