#!/usr/bin/env python3
"""Build the frontend for one application channel and write the dist stamp."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("channel", choices=("stable", "beta", "alpha"))
    args = parser.parse_args(argv)

    env = os.environ.copy()
    env["VITE_CELLXPLORER_CHANNEL"] = args.channel
    npm = "npm.cmd" if os.name == "nt" else "npm"
    build = subprocess.run([npm, "run", "build"], cwd=FRONTEND, env=env, check=False)
    if build.returncode != 0:
        return build.returncode

    stamp = subprocess.run(
        [sys.executable, "scripts/frontend_channel.py", "write", "--channel", args.channel],
        cwd=ROOT,
        check=False,
    )
    return stamp.returncode


if __name__ == "__main__":
    raise SystemExit(main())
