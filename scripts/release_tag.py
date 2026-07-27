#!/usr/bin/env python3
"""Stable release-tag validation helpers for the GitHub release workflow."""

from __future__ import annotations

import argparse
import re
import sys

STABLE_TAG_RE = re.compile(r"^v\d+\.\d+\.\d+$")


class ReleaseTagError(Exception):
    """Raised when a release tag is not an accepted stable SemVer tag."""


def normalize_version(value: str) -> str:
    value = value.strip()
    if value.startswith("v"):
        value = value[1:]
    return value


def is_stable_release_tag(tag: str) -> bool:
    return bool(STABLE_TAG_RE.fullmatch(tag.strip()))


def require_stable_release_tag(tag: str) -> str:
    tag = tag.strip()
    if not is_stable_release_tag(tag):
        raise ReleaseTagError(
            f"Tag {tag!r} is not a stable release tag. Expected exactly vMAJOR.MINOR.PATCH "
            f"(for example v0.15.0)."
        )
    return tag


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Validate that a Git tag is an exact stable SemVer release tag."
    )
    parser.add_argument("--tag", required=True, help="Git tag name (for example v0.15.0).")
    args = parser.parse_args(argv)
    try:
        require_stable_release_tag(args.tag)
    except ReleaseTagError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    print(f"PASS: stable release tag {args.tag.strip()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
