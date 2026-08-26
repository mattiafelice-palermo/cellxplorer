#!/usr/bin/env python3
"""Derive unmistakable, size-specific Alpha icons from the Stable source art."""

from __future__ import annotations

import io
import math
import struct
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
STABLE_ICON = ROOT / "frontend" / "public" / "app-icon.png"
ALPHA_PUBLIC = ROOT / "frontend" / "public" / "app-icon-alpha.png"
ALPHA_DIR = ROOT / "src-tauri" / "icons-alpha"

ALPHA_RGB = (0xB1, 0x97, 0xFC)
BADGE_RGB = (0x70, 0x48, 0xE8)
ICO_SIZES = (16, 24, 32, 48, 256)
LARGE_BADGE_MIN_SIZE = 48
STABLE_BRAND_ANCHORS = (
    (0x12, 0xB8, 0x86),
    (0x20, 0xC9, 0x97),
    (0x0C, 0xA6, 0x78),
    (0x63, 0xE6, 0xB7),
    (0x96, 0xF2, 0xD7),
)

PIXEL_FONT = {
    "A": ("01110", "10001", "10001", "11111", "10001", "10001", "10001"),
    "H": ("10001", "10001", "10001", "11111", "10001", "10001", "10001"),
    "L": ("10000", "10000", "10000", "10000", "10000", "10000", "11111"),
    "P": ("11110", "10001", "10001", "11110", "10000", "10000", "10000"),
}


def _distance(a: tuple[int, int, int], b: tuple[int, int, int]) -> float:
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)))


def _is_brand_teal(r: int, g: int, b: int, a: int) -> bool:
    if a < 16 or g <= r or g <= b:
        return False
    return min(_distance((r, g, b), anchor) for anchor in STABLE_BRAND_ANCHORS) <= 72


def recolor_icon(source: Path) -> Image.Image:
    image = Image.open(source).convert("RGBA")
    pixels = image.load()
    for y in range(image.height):
        for x in range(image.width):
            r, g, b, a = pixels[x, y]
            if not _is_brand_teal(r, g, b, a):
                continue
            anchor = min(STABLE_BRAND_ANCHORS, key=lambda color: _distance((r, g, b), color))
            anchor_luma = sum(anchor) / 3
            scale = max(0.55, min(1.35, ((r + g + b) / 3) / anchor_luma))
            pixels[x, y] = tuple(
                max(0, min(255, int(value * scale))) for value in ALPHA_RGB
            ) + (a,)
    return image


def _draw_pixel_text(
    draw: ImageDraw.ImageDraw,
    text: str,
    x: int,
    y: int,
    scale: int,
) -> None:
    cursor = x
    for letter in text:
        rows = PIXEL_FONT[letter]
        for row_index, row in enumerate(rows):
            for column_index, value in enumerate(row):
                if value != "1":
                    continue
                x0 = cursor + column_index * scale
                y0 = y + row_index * scale
                draw.rectangle(
                    (x0, y0, x0 + scale - 1, y0 + scale - 1),
                    fill="white",
                )
        cursor += 6 * scale


def render_size(base: Image.Image, size: int) -> Image.Image:
    image = base.resize((size, size), Image.Resampling.LANCZOS)
    draw = ImageDraw.Draw(image)

    if size >= LARGE_BADGE_MIN_SIZE:
        text = "ALPHA"
        scale = max(1, size // 64)
        width = (len(text) * 6 - 1) * scale
        height = 7 * scale
        padding_x = max(2, 2 * scale)
        padding_y = max(1, scale)
        margin = max(2, size // 32)
        right = size - margin - 1
        bottom = size - margin - 1
        left = right - width - 2 * padding_x
        top = bottom - height - 2 * padding_y
        draw.rounded_rectangle(
            (left, top, right, bottom),
            radius=max(1, size // 32),
            fill=BADGE_RGB + (255,),
        )
        _draw_pixel_text(draw, text, left + padding_x, top + padding_y, scale)
    else:
        text = "A"
        scale = 1 if size <= 24 else 2
        width = 5 * scale
        height = 7 * scale
        padding = 1
        right = size - 1
        bottom = size - 1
        left = right - width - 2 * padding
        top = bottom - height - 2 * padding
        draw.rectangle((left, top, right, bottom), fill=BADGE_RGB + (255,))
        _draw_pixel_text(draw, text, left + padding, top + padding, scale)

    return image


def write_rgba(image: Image.Image, destination: Path) -> None:
    destination.write_bytes(image.convert("RGBA").tobytes())


def _png_bytes(image: Image.Image) -> bytes:
    payload = io.BytesIO()
    image.save(payload, format="PNG", optimize=False, compress_level=9)
    return payload.getvalue()


def write_ico(base: Image.Image, destination: Path) -> None:
    """Write PNG-backed ICO frames without allowing automatic downscaling."""

    frames = [(size, _png_bytes(render_size(base, size))) for size in ICO_SIZES]
    header_size = 6 + 16 * len(frames)
    offset = header_size
    entries: list[bytes] = []
    payloads: list[bytes] = []

    for size, payload in frames:
        dimension = 0 if size == 256 else size
        entries.append(
            struct.pack(
                "<BBBBHHII",
                dimension,
                dimension,
                0,
                0,
                1,
                32,
                len(payload),
                offset,
            )
        )
        payloads.append(payload)
        offset += len(payload)

    destination.write_bytes(
        struct.pack("<HHH", 0, 1, len(frames)) + b"".join(entries) + b"".join(payloads)
    )


def main() -> int:
    if not STABLE_ICON.is_file():
        print(f"Missing stable icon source: {STABLE_ICON}", file=sys.stderr)
        return 1

    base = recolor_icon(STABLE_ICON)
    alpha_256 = render_size(base, 256)
    ALPHA_DIR.mkdir(parents=True, exist_ok=True)
    alpha_256.save(ALPHA_PUBLIC, format="PNG", optimize=False, compress_level=9)
    alpha_256.save(ALPHA_DIR / "icon.png", format="PNG", optimize=False, compress_level=9)
    write_rgba(alpha_256, ALPHA_DIR / "icon-256.rgba")
    write_ico(base, ALPHA_DIR / "icon.ico")

    print("Wrote Alpha icons with ALPHA/A size-specific badges")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
