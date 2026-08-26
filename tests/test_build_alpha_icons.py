#!/usr/bin/env python3
"""Deterministic Alpha icon assets from the committed Stable frontend icon."""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
STABLE_ICON = ROOT / "frontend" / "public" / "app-icon.png"
STABLE_DIR = ROOT / "src-tauri" / "icons"
BETA_DIR = ROOT / "src-tauri" / "icons-beta"
ALPHA_PUBLIC = ROOT / "frontend" / "public" / "app-icon-alpha.png"
ALPHA_DIR = ROOT / "src-tauri" / "icons-alpha"
SCRIPT = ROOT / "scripts" / "build_alpha_icons.py"


def load_alpha_icons_script():
    spec = importlib.util.spec_from_file_location("build_alpha_icons_test_module", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class BuildAlphaIconsTests(unittest.TestCase):
    def test_script_is_present(self):
        self.assertTrue(SCRIPT.is_file())

    def test_committed_alpha_assets_exist(self):
        for path in (
            ALPHA_PUBLIC,
            ALPHA_DIR / "icon.png",
            ALPHA_DIR / "icon.ico",
            ALPHA_DIR / "icon-256.rgba",
        ):
            with self.subTest(path=path.as_posix()):
                self.assertTrue(path.is_file(), f"Missing {path}")

    def test_alpha_ico_contains_required_sizes(self):
        try:
            from PIL import Image
        except ImportError as error:
            self.skipTest(f"Pillow is required for icon tests: {error}")

        with Image.open(ALPHA_DIR / "icon.ico") as icon:
            sizes = sorted(icon.info.get("sizes", [(icon.width, icon.height)]))
        self.assertEqual(sizes, [(16, 16), (24, 24), (32, 32), (48, 48), (256, 256)])

    def test_alpha_ico_preserves_size_specific_badges(self):
        try:
            from PIL import Image
        except ImportError as error:
            self.skipTest(f"Pillow is required for icon tests: {error}")

        module = load_alpha_icons_script()
        base = module.recolor_icon(STABLE_ICON)

        with Image.open(ALPHA_DIR / "icon.ico") as icon:
            for size in module.ICO_SIZES:
                with self.subTest(size=size):
                    actual = icon.ico.getimage((size, size)).convert("RGBA")
                    expected = module.render_size(base, size)
                    self.assertEqual(actual.tobytes(), expected.tobytes())

        tiny = module.render_size(base, 16)
        large = module.render_size(base, 256)
        badge = module.BADGE_RGB
        count_badge = lambda image: sum(
            image.getpixel((x, y))[:3] == badge
            for y in range(image.height)
            for x in range(image.width)
        )
        self.assertGreater(count_badge(large), count_badge(tiny))

    def test_alpha_rgba_is_256_square(self):
        raw = (ALPHA_DIR / "icon-256.rgba").read_bytes()
        self.assertEqual(len(raw), 256 * 256 * 4)

    def test_regeneration_is_deterministic_and_does_not_touch_other_channels(self):
        try:
            from PIL import Image  # noqa: F401
        except ImportError as error:
            self.skipTest(f"Pillow is required for regeneration test: {error}")

        module = load_alpha_icons_script()
        alpha_paths = (
            ALPHA_PUBLIC,
            ALPHA_DIR / "icon.png",
            ALPHA_DIR / "icon.ico",
            ALPHA_DIR / "icon-256.rgba",
        )
        protected_paths = (STABLE_ICON,) + tuple(
            sorted(path for directory in (STABLE_DIR, BETA_DIR) for path in directory.iterdir())
        )
        before = {
            path: path.read_bytes()
            for path in alpha_paths + protected_paths
            if path.is_file()
        }

        self.assertEqual(module.main(), 0)

        for path, original in before.items():
            with self.subTest(path=path.as_posix()):
                self.assertEqual(path.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
