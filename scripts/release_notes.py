#!/usr/bin/env python3
"""Extract release notes for a specific version from CHANGELOG.md."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


HEADING_RE = re.compile(
    r"^##\s+(?:\[)?(?P<version>v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\])?"
    r"(?:\s+-\s+\d{4}-\d{2}-\d{2})?\s*$"
)


class ReleaseNotesError(Exception):
    """Raised when changelog extraction fails."""


def normalize_version(value: str) -> str:
    value = value.strip()
    if value.startswith("v"):
        value = value[1:]
    return value


def extract_release_notes(content: str, expected_version: str) -> str:
    normalized = normalize_version(expected_version)
    matches: list[tuple[int, str, str]] = []
    lines = content.splitlines()
    for index, line in enumerate(lines):
        match = HEADING_RE.match(line.strip())
        if not match:
            continue
        version = normalize_version(match.group("version"))
        matches.append((index, version, line))

    selected = [item for item in matches if item[1] == normalized]
    if not selected:
        raise ReleaseNotesError(
            f"No changelog section found for version {normalized}."
        )
    if len(selected) > 1:
        raise ReleaseNotesError(
            f"Duplicate changelog sections found for version {normalized}."
        )

    start_index = selected[0][0] + 1
    end_index = len(lines)
    for index, version, _line in matches:
        if index <= selected[0][0]:
            continue
        end_index = index
        break

    body_lines = lines[start_index:end_index]
    while body_lines and not body_lines[0].strip():
        body_lines.pop(0)
    while body_lines and not body_lines[-1].strip():
        body_lines.pop()

    body = "\n".join(body_lines).strip()
    if not body:
        raise ReleaseNotesError(
            f"Changelog section for version {normalized} is empty."
        )
    return body + "\n"


def repo_root(start: Path | None = None) -> Path:
    return (start or Path(__file__).resolve()).parents[1]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Extract release notes for one version from CHANGELOG.md."
    )
    parser.add_argument(
        "--expected-version",
        required=True,
        help="Version or tag to extract (accepts a leading v).",
    )
    parser.add_argument(
        "--changelog",
        type=Path,
        default=None,
        help="Path to CHANGELOG.md (defaults to repository root).",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Optional file to write the extracted notes.",
    )
    args = parser.parse_args(argv)

    changelog_path = args.changelog or (repo_root() / "CHANGELOG.md")
    if not changelog_path.is_file():
        print(f"ERROR: changelog not found: {changelog_path}", file=sys.stderr)
        return 1

    try:
        notes = extract_release_notes(
            changelog_path.read_text(encoding="utf-8"),
            args.expected_version,
        )
    except ReleaseNotesError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    if args.output:
        args.output.write_text(notes, encoding="utf-8", newline="\n")
    else:
        sys.stdout.write(notes)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
