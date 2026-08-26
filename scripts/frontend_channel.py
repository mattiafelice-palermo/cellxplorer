#!/usr/bin/env python3
"""Write and verify the frontend build-channel stamp beside frontend/dist."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STAMP_NAME = ".cellxplorer-channel.json"
STAMP_VERSION = 1

BRANDING_INPUTS = (
    "frontend/src/appChannel.ts",
    "frontend/src/main.tsx",
    "frontend/public/app-icon.png",
    "frontend/public/app-icon-beta.png",
    "frontend/public/app-icon-alpha.png",
    "src-tauri/tauri.conf.json",
    "src-tauri/tauri.beta.conf.json",
    "src-tauri/tauri.alpha.conf.json",
)


def stamp_path(repo_root: Path) -> Path:
    return repo_root / "frontend" / "dist" / STAMP_NAME


def branding_inputs_hash(repo_root: Path) -> str:
    digest = hashlib.sha256()
    for relative in BRANDING_INPUTS:
        path = repo_root / relative
        if not path.is_file():
            raise FileNotFoundError(f"Missing frontend branding input: {relative}")
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\n")
    return digest.hexdigest()


def write_stamp(repo_root: Path, channel: str) -> Path:
    if channel not in {"stable", "beta", "alpha"}:
        raise ValueError(f"Unsupported channel: {channel}")
    dist = repo_root / "frontend" / "dist"
    index = dist / "index.html"
    if not index.is_file():
        raise FileNotFoundError(
            "frontend/dist/index.html is missing. Build the frontend before writing the channel stamp."
        )
    payload = {
        "version": STAMP_VERSION,
        "channel": channel,
        "brandingHash": branding_inputs_hash(repo_root),
    }
    destination = stamp_path(repo_root)
    destination.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return destination


def verify_stamp(repo_root: Path, channel: str) -> None:
    if channel not in {"stable", "beta", "alpha"}:
        raise ValueError(f"Unsupported channel: {channel}")
    destination = stamp_path(repo_root)
    if not destination.is_file():
        raise RuntimeError(
            f"Missing frontend channel stamp at {destination.as_posix()}. "
            f"Build the frontend for channel '{channel}' before packaging."
        )
    payload = json.loads(destination.read_text(encoding="utf-8"))
    if payload.get("version") != STAMP_VERSION:
        raise RuntimeError("Frontend channel stamp version is unsupported.")
    if payload.get("channel") != channel:
        raise RuntimeError(
            f"frontend/dist was built for channel '{payload.get('channel')}', "
            f"but packaging requested '{channel}'."
        )
    expected_hash = branding_inputs_hash(repo_root)
    if payload.get("brandingHash") != expected_hash:
        raise RuntimeError(
            "Frontend channel stamp is stale relative to current branding inputs. "
            f"Rebuild the frontend for channel '{channel}'."
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=ROOT)
    sub = parser.add_subparsers(dest="command", required=True)

    write_cmd = sub.add_parser("write", help="Write stamp after a frontend build")
    write_cmd.add_argument("--channel", choices=("stable", "beta", "alpha"), required=True)

    verify_cmd = sub.add_parser("verify", help="Verify stamp before packaging")
    verify_cmd.add_argument("--channel", choices=("stable", "beta", "alpha"), required=True)

    args = parser.parse_args(argv)
    repo_root = args.repo_root.resolve()
    try:
        if args.command == "write":
            path = write_stamp(repo_root, args.channel)
            print(f"Wrote {path.relative_to(repo_root).as_posix()}")
        else:
            verify_stamp(repo_root, args.channel)
            print(f"PASS: frontend/dist matches channel {args.channel}")
    except (FileNotFoundError, RuntimeError, ValueError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
