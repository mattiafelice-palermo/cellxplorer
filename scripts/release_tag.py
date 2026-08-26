#!/usr/bin/env python3
"""Release-tag validation helpers for the GitHub release workflow."""

from __future__ import annotations

import argparse
import re
import sys

STABLE_TAG_RE = re.compile(r"^v\d+\.\d+\.\d+$")
# Accept legacy vX.Y.Z-beta.N and compact vX.Y.Z-betaNNN (sorts above beta.9 on GitHub).
BETA_TAG_RE = re.compile(r"^v\d+\.\d+\.\d+-beta(?:\.\d+|\d+)$")
# Alpha uses one exact dotted prerelease grammar and deliberately rejects leading-zero
# sequence numbers so the tag, manifest, and installed updater all share one identity.
ALPHA_TAG_RE = re.compile(r"^v\d+\.\d+\.\d+-alpha\.(?:0|[1-9]\d*)$")


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


def is_alpha_release_tag(tag: str) -> bool:
    return bool(ALPHA_TAG_RE.fullmatch(tag.strip()))


def release_channel_for_tag(tag: str) -> str | None:
    """Return the exact release channel for a publishable tag, or ``None``."""
    normalized = tag.strip()
    if is_stable_release_tag(normalized):
        return "stable"
    if is_beta_release_tag(normalized):
        return "beta"
    if is_alpha_release_tag(normalized):
        return "alpha"
    return None


# Descriptive alias for callers that prefer classification terminology.
classify_release_tag = release_channel_for_tag


def is_publishable_release_tag(tag: str) -> bool:
    return release_channel_for_tag(tag) is not None


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
            f"vMAJOR.MINOR.PATCH-beta.N or vMAJOR.MINOR.PATCH-alpha.N "
            f"(for example v0.15.0, v0.16.2-beta.1, or v0.28.0-alpha.1)."
        )
    return tag


def require_release_tag_for_channel(tag: str, channel: str) -> str:
    """Require a publishable tag whose grammar belongs to ``channel``."""
    normalized = tag.strip()
    if channel not in {"stable", "beta", "alpha"}:
        raise ReleaseTagError(f"Unsupported release channel: {channel!r}.")
    if release_channel_for_tag(normalized) != channel:
        expected = {
            "stable": "vMAJOR.MINOR.PATCH",
            "beta": "vMAJOR.MINOR.PATCH-beta.N or vMAJOR.MINOR.PATCH-betaNNN",
            "alpha": "vMAJOR.MINOR.PATCH-alpha.N",
        }[channel]
        raise ReleaseTagError(
            f"Tag {normalized!r} is not a {channel} release tag. Expected exactly {expected}."
        )
    return normalized


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Validate that a Git tag is a publishable SemVer release tag "
            "(stable, beta, or alpha)."
        )
    )
    parser.add_argument("--tag", required=True, help="Git tag name (for example v0.15.0).")
    parser.add_argument(
        "--stable-only",
        action="store_true",
        help="Reject prerelease tags and require exactly vMAJOR.MINOR.PATCH.",
    )
    parser.add_argument(
        "--channel",
        choices=("stable", "beta", "alpha"),
        default=None,
        help="Require the tag to belong to this exact release channel.",
    )
    args = parser.parse_args(argv)
    try:
        if args.stable_only and args.channel not in (None, "stable"):
            raise ReleaseTagError("--stable-only cannot be combined with a non-Stable channel.")
        if args.channel is not None:
            require_release_tag_for_channel(args.tag, args.channel)
            label = args.channel
        elif args.stable_only:
            require_stable_release_tag(args.tag)
            label = "stable"
        else:
            require_publishable_release_tag(args.tag)
            label = release_channel_for_tag(args.tag.strip())
            assert label is not None
    except ReleaseTagError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    print(f"PASS: {label} release tag {args.tag.strip()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
