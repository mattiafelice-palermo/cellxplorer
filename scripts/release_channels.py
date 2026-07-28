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


class ReleaseChannelBranchError(Exception):
    """Raised when the release-channels branch has an unsafe tree."""


def validate_branch_tree(payload: object) -> dict[str, str]:
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
            directories.add(path)
            continue
        if kind != "blob" or not isinstance(sha, str) or not sha:
            raise ReleaseChannelBranchError(
                f"Unexpected Git tree entry for {path!r}: expected a blob."
            )
        blobs[path] = sha

    actual = set(blobs)
    missing = sorted(REQUIRED_CHANNEL_PATHS - actual)
    unexpected = sorted(actual - REQUIRED_CHANNEL_PATHS)
    if missing:
        raise ReleaseChannelBranchError(
            "release-channels is not provisioned; missing: " + ", ".join(missing)
        )
    if unexpected:
        raise ReleaseChannelBranchError(
            "release-channels contains unexpected files: " + ", ".join(unexpected)
        )
    if directories != {"stable", "beta"}:
        raise ReleaseChannelBranchError(
            "release-channels must contain only the stable and beta directories."
        )
    return blobs


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tree-json", type=Path, required=True)
    args = parser.parse_args(argv)

    try:
        payload = json.loads(args.tree_json.read_text(encoding="utf-8"))
        blobs = validate_branch_tree(payload)
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
