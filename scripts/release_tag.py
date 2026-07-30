#!/usr/bin/env python3
"""Release-tag validation helpers for the GitHub release workflow."""

from __future__ import annotations

import argparse
import re
import sys

STABLE_TAG_RE = re.compile(r"^v\d+\.\d+\.\d+$")
# Accept legacy vX.Y.Z-beta.N and compact vX.Y.Z-betaNNN (sorts above beta.9 on GitHub).
BETA_TAG_RE = re.compile(r"^v\d+\.\d+\.\d+-beta(?:\.\d+|\d+)$")


class ReleaseTagError(Exception):
    """Raised when a release tag is not an accepted publishable SemVer tag."""


def normalize_version(value: str) -> str:
    value = value.strip()
    if value.startswith("v"):
        value = value[1:]
    return value


def is_stable_release_tag(tag: str) -> bool:
    return bool(STABLE_TAG_RE.fullmatch(tag.strip()))


def is_beta_release_tag(tag: str) -> bool:
    return bool(BETA_TAG_RE.fullmatch(tag.strip()))


def is_publishable_release_tag(tag: str) -> bool:
    return is_stable_release_tag(tag) or is_beta_release_tag(tag)


def require_stable_release_tag(tag: str) -> str:
    tag = tag.strip()
    if not is_stable_release_tag(tag):
        raise ReleaseTagError(
            f"Tag {tag!r} is not a stable release tag. Expected exactly vMAJOR.MINOR.PATCH "
            f"(for example v0.15.0)."
        )
    return tag


def require_publishable_release_tag(tag: str) -> str:
    tag = tag.strip()
    if not is_publishable_release_tag(tag):
        raise ReleaseTagError(
            f"Tag {tag!r} is not a publishable release tag. Expected vMAJOR.MINOR.PATCH or "
            f"vMAJOR.MINOR.PATCH-beta.N (for example v0.15.0 or v0.16.2-beta.1)."
        )
    return tag


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Validate that a Git tag is a publishable SemVer release tag "
            "(stable or beta)."
        )
    )
    parser.add_argument("--tag", required=True, help="Git tag name (for example v0.15.0).")
    parser.add_argument(
        "--stable-only",
        action="store_true",
        help="Reject beta tags and require exactly vMAJOR.MINOR.PATCH.",
    )
    args = parser.parse_args(argv)
    try:
        if args.stable_only:
            require_stable_release_tag(args.tag)
            label = "stable"
        else:
            require_publishable_release_tag(args.tag)
            label = "beta" if is_beta_release_tag(args.tag.strip()) else "stable"
    except ReleaseTagError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    print(f"PASS: {label} release tag {args.tag.strip()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
