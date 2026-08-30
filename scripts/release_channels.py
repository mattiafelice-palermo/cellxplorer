#!/usr/bin/env python3
"""Validate the manifest-only release-channels branch contract."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


REQUIRED_CHANNEL_PATHS = frozenset(
    {
        "README.md",
        "stable/latest.json",
        "beta/latest.json",
    }
)
ALPHA_CHANNEL_PATH = "alpha/latest.json"
ALL_CHANNEL_PATHS = REQUIRED_CHANNEL_PATHS | {ALPHA_CHANNEL_PATH}


class ReleaseChannelBranchError(Exception):
    """Raised when the release-channels branch has an unsafe tree."""


def validate_branch_tree(
    payload: object,
    *,
    target_channel: str | None = None,
    published_alpha: bool | None = None,
) -> dict[str, str]:
    if target_channel not in (None, "stable", "beta", "alpha"):
        raise ReleaseChannelBranchError(
            f"Unsupported release channel: {target_channel!r}."
        )
    if target_channel is not None and published_alpha is None:
        raise ReleaseChannelBranchError(
            "Authoritative published-Alpha evidence is required when validating a target channel."
        )
    if published_alpha is not None and not isinstance(published_alpha, bool):
        raise ReleaseChannelBranchError("published_alpha evidence must be a boolean.")
    alpha_is_published = bool(published_alpha)
    if not isinstance(payload, dict):
        raise ReleaseChannelBranchError("Git tree response must be a JSON object.")
    if payload.get("truncated") is True:
        raise ReleaseChannelBranchError(
            "Git tree response is truncated; branch contents cannot be proven."
        )
    tree = payload.get("tree")
    if not isinstance(tree, list):
        raise ReleaseChannelBranchError("Git tree response is missing its tree array.")

    blobs: dict[str, str] = {}
    directories: set[str] = set()
    for entry in tree:
        if not isinstance(entry, dict):
            raise ReleaseChannelBranchError("Git tree contains a non-object entry.")
        path = entry.get("path")
        kind = entry.get("type")
        sha = entry.get("sha")
        if not isinstance(path, str) or not path:
            raise ReleaseChannelBranchError("Git tree entry is missing a path.")
        if kind == "tree":
            if path in directories:
                raise ReleaseChannelBranchError(
                    f"Git tree contains a duplicate entry for {path!r}."
                )
            directories.add(path)
            continue
        if kind != "blob" or not isinstance(sha, str) or not sha:
            raise ReleaseChannelBranchError(
                f"Unexpected Git tree entry for {path!r}: expected a blob."
            )
        if path in blobs or path in directories:
            raise ReleaseChannelBranchError(
                f"Git tree contains a duplicate entry for {path!r}."
            )
        blobs[path] = sha

    required = set(REQUIRED_CHANNEL_PATHS)
    allowed = set(REQUIRED_CHANNEL_PATHS)
    if alpha_is_published:
        required.add(ALPHA_CHANNEL_PATH)
        allowed.add(ALPHA_CHANNEL_PATH)
    if target_channel == "beta":
        # The first real Beta release is what creates the first trustworthy Beta pointer.
        # Stable must already be valid so no transition binary can embed a 404 feed.
        required.remove("beta/latest.json")
    actual = set(blobs)
    missing = sorted(required - actual)
    unexpected = sorted(actual - allowed)
    if missing:
        raise ReleaseChannelBranchError(
            "release-channels is not provisioned; missing: " + ", ".join(missing)
        )
    if unexpected:
        raise ReleaseChannelBranchError(
            "release-channels contains unexpected files: " + ", ".join(unexpected)
        )
    expected_directories = {
        path.split("/", 1)[0] for path in actual if "/" in path
    }
    if directories != expected_directories:
        raise ReleaseChannelBranchError(
            "release-channels directory entries do not match its manifest paths."
        )
    return blobs


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tree-json", type=Path, required=True)
    parser.add_argument(
        "--target-channel", choices=("stable", "beta", "alpha"), required=True
    )
    parser.add_argument(
        "--published-alpha",
        choices=("true", "false"),
        required=True,
        help="Authoritative GitHub release-history evidence for whether Alpha was published.",
    )
    args = parser.parse_args(argv)

    try:
        payload = json.loads(args.tree_json.read_text(encoding="utf-8"))
        blobs = validate_branch_tree(
            payload,
            target_channel=args.target_channel,
            published_alpha=args.published_alpha == "true",
        )
    except (OSError, json.JSONDecodeError, ReleaseChannelBranchError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1

    print(
        "PASS: release-channels contains exactly "
        + ", ".join(sorted(blobs))
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
