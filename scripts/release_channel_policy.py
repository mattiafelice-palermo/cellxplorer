#!/usr/bin/env python3
"""Validate cross-release Stable/Beta/Alpha publication policy."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import release_tag


class ReleaseChannelPolicyError(Exception):
    """Raised when a tag is unsafe for the current published release history."""


def stable_core(tag: str) -> tuple[int, int, int]:
    tag = release_tag.require_stable_release_tag(tag)
    return tuple(int(part) for part in tag[1:].split("."))  # type: ignore[return-value]


def beta_core(tag: str) -> tuple[int, int, int]:
    tag = release_tag.require_publishable_release_tag(tag)
    if not release_tag.is_beta_release_tag(tag):
        raise ReleaseChannelPolicyError(f"Tag {tag!r} is not a Beta release tag.")
    body = tag[1:]
    core = re.sub(r"-beta(?:\.\d+|\d+)$", "", body)
    return tuple(int(part) for part in core.split("."))  # type: ignore[return-value]


def alpha_core(tag: str) -> tuple[int, int, int]:
    tag = release_tag.require_release_tag_for_channel(tag, "alpha")
    body = tag[1:]
    core = re.sub(r"-alpha\.\d+$", "", body)
    return tuple(int(part) for part in core.split("."))  # type: ignore[return-value]


def _release_rows(payload: object) -> list[dict]:
    if not isinstance(payload, list):
        raise ReleaseChannelPolicyError("GitHub releases response must be an array.")
    rows: list[dict] = []
    for entry in payload:
        if isinstance(entry, list):
            rows.extend(row for row in entry if isinstance(row, dict))
        elif isinstance(entry, dict):
            rows.append(entry)
        else:
            raise ReleaseChannelPolicyError(
                "GitHub releases response contains an invalid entry."
            )
    return rows


def latest_real_stable_core(
    payload: object, *, blocked_channel: str = "Beta"
) -> tuple[int, int, int]:
    stable_versions: list[tuple[int, int, int]] = []
    for release in _release_rows(payload):
        if release.get("draft") is True or not release.get("published_at"):
            continue
        tag = release.get("tag_name")
        if isinstance(tag, str) and release_tag.is_stable_release_tag(tag):
            stable_versions.append(stable_core(tag))
    if not stable_versions:
        raise ReleaseChannelPolicyError(
            f"No published exact Stable release was found; {blocked_channel} publication is blocked."
        )
    return max(stable_versions)


def require_beta_targets_future_stable(tag: str, payload: object) -> None:
    candidate = beta_core(tag)
    latest_stable = latest_real_stable_core(payload)
    if candidate <= latest_stable:
        candidate_text = ".".join(str(part) for part in candidate)
        stable_text = ".".join(str(part) for part in latest_stable)
        raise ReleaseChannelPolicyError(
            f"Beta core {candidate_text} must be greater than latest published "
            f"Stable {stable_text}."
        )


def require_alpha_targets_future_stable(tag: str, payload: object) -> None:
    candidate = alpha_core(tag)
    latest_stable = latest_real_stable_core(payload, blocked_channel="Alpha")
    if candidate <= latest_stable:
        candidate_text = ".".join(str(part) for part in candidate)
        stable_text = ".".join(str(part) for part in latest_stable)
        raise ReleaseChannelPolicyError(
            f"Alpha core {candidate_text} must be greater than latest published "
            f"Stable {stable_text}."
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    tags = parser.add_mutually_exclusive_group(required=True)
    tags.add_argument("--beta-tag")
    tags.add_argument("--alpha-tag")
    parser.add_argument("--published-releases-json", type=Path, required=True)
    args = parser.parse_args(argv)

    try:
        payload = json.loads(
            args.published_releases_json.read_text(encoding="utf-8-sig")
        )
        if args.beta_tag is not None:
            require_beta_targets_future_stable(args.beta_tag, payload)
            tag = args.beta_tag
        else:
            assert args.alpha_tag is not None
            require_alpha_targets_future_stable(args.alpha_tag, payload)
            tag = args.alpha_tag
    except (
        OSError,
        json.JSONDecodeError,
        release_tag.ReleaseTagError,
        ReleaseChannelPolicyError,
    ) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1

    print(f"PASS: {tag} targets a future Stable core version")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
