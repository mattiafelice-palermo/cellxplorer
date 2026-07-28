#!/usr/bin/env python3
"""Generate a channel-specific NSIS template from the shared CellXplorer source."""

from __future__ import annotations

import argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "src-tauri" / "cellxplorer-installer.nsi"
OUTPUT_DIR = ROOT / "src-tauri" / "generated"

# NSIS SetCtlColors uses RGB strings. PBM_SETBARCOLOR uses a Windows COLORREF,
# whose bytes are stored as 0x00BBGGRR.
CHANNEL_COLORS = {
    "stable": {
        "rgb": "12B886",
        "colorref": "0x0086B812",
    },
    "beta": {
        "rgb": "3678B7",
        "colorref": "0x00B77836",
    },
}


def output_path(channel: str) -> Path:
    return OUTPUT_DIR / f"cellxplorer-installer.{channel}.nsi"


def render_template(source: str, channel: str) -> str:
    if channel not in CHANNEL_COLORS:
        raise ValueError(f"Unsupported channel: {channel}")

    stable = CHANNEL_COLORS["stable"]
    selected = CHANNEL_COLORS[channel]

    # Fail closed when the vendored template changes: silently producing a
    # partly teal Beta installer is worse than stopping the package build.
    rgb_count = source.count(stable["rgb"])
    colorref_count = source.count(stable["colorref"])
    if rgb_count < 8:
        raise RuntimeError(
            f"Expected at least 8 Stable brand-colour uses in the NSIS template; found {rgb_count}."
        )
    if colorref_count < 1:
        raise RuntimeError("The NSIS progress-bar brand colour was not found.")

    rendered = source.replace(stable["rgb"], selected["rgb"])
    rendered = rendered.replace(stable["colorref"], selected["colorref"])
    rendered = rendered.replace(
        "Stepper chips: filled teal for done/current steps",
        "Stepper chips: filled channel primary for done/current steps",
    )
    rendered = rendered.replace(
        "white surface,\n; teal flat progress bar",
        "white surface,\n; channel-primary flat progress bar",
    )
    return rendered


def prepare(channel: str) -> Path:
    source = SOURCE.read_text(encoding="utf-8")
    rendered = render_template(source, channel)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    destination = output_path(channel)
    destination.write_text(rendered, encoding="utf-8", newline="\n")
    return destination


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("channel", choices=tuple(CHANNEL_COLORS))
    args = parser.parse_args(argv)

    destination = prepare(args.channel)
    print(f"Wrote {destination.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
