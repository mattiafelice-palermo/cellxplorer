#!/usr/bin/env python3
"""Derive Beta icon assets from the committed Stable frontend icon."""

from __future__ import annotations

import math
import struct
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
STABLE_ICON = ROOT / "frontend" / "public" / "app-icon.png"
BETA_PUBLIC = ROOT / "frontend" / "public" / "app-icon-beta.png"
BETA_DIR = ROOT / "src-tauri" / "icons-beta"

BETA_RGB = (0x7D, 0xB7, 0xE8)
STABLE_BRAND_ANCHORS = (
    (0x12, 0xB8, 0x86),
    (0x20, 0xC9, 0x97),
    (0x0C, 0xA6, 0x78),
    (0x63, 0xE6, 0xB7),
    (0x96, 0xF2, 0xD7),
)


def _distance(a: tuple[int, int, int], b: tuple[int, int, int]) -> float:
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)))


def _is_brand_teal(r: int, g: int, b: int, a: int) -> bool:
    if a < 16:
        return False
    if g <= r or g <= b:
        return False
    return min(_distance((r, g, b), anchor) for anchor in STABLE_BRAND_ANCHORS) <= 72


def recolor_icon(source: Path) -> Image.Image:
    image = Image.open(source).convert("RGBA")
    pixels = image.load()
    width, height = image.size
    for y in range(height):
        for x in range(width):
            r, g, b, a = pixels[x, y]
            if not _is_brand_teal(r, g, b, a):
                continue
            anchor = min(STABLE_BRAND_ANCHORS, key=lambda color: _distance((r, g, b), color))
            anchor_luma = sum(anchor) / 3
            pixel_luma = (r + g + b) / 3
            scale = pixel_luma / anchor_luma if anchor_luma else 1.0
            scale = max(0.55, min(1.35, scale))
            pixels[x, y] = (
                max(0, min(255, int(BETA_RGB[0] * scale))),
                max(0, min(255, int(BETA_RGB[1] * scale))),
                max(0, min(255, int(BETA_RGB[2] * scale))),
                a,
            )
    return image


def write_rgba(image: Image.Image, destination: Path) -> None:
    resized = image.convert("RGBA").resize((256, 256), Image.Resampling.LANCZOS)
    destination.write_bytes(resized.tobytes())


def write_ico(image: Image.Image, destination: Path) -> None:
    sizes = [16, 24, 32, 48, 256]
    images = [image.convert("RGBA").resize((size, size), Image.Resampling.LANCZOS) for size in sizes]
    images[0].save(
        destination,
        format="ICO",
        sizes=[(size, size) for size in sizes],
        append_images=images[1:],
    )


def main() -> int:
    if not STABLE_ICON.is_file():
        print(f"Missing stable icon source: {STABLE_ICON}", file=sys.stderr)
        return 1

    beta = recolor_icon(STABLE_ICON)
    BETA_DIR.mkdir(parents=True, exist_ok=True)
    beta.save(BETA_PUBLIC, format="PNG")
    beta.save(BETA_DIR / "icon.png", format="PNG")
    write_rgba(beta, BETA_DIR / "icon-256.rgba")
    write_ico(beta, BETA_DIR / "icon.ico")

    print(f"Wrote {BETA_PUBLIC.relative_to(ROOT)}")
    print(f"Wrote {BETA_DIR.relative_to(ROOT)}/icon.png")
    print(f"Wrote {BETA_DIR.relative_to(ROOT)}/icon-256.rgba")
    print(f"Wrote {BETA_DIR.relative_to(ROOT)}/icon.ico")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
