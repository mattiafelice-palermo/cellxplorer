#!/usr/bin/env python3
"""Bump every maintained CellXplorer version declaration and prepend CHANGELOG."""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from check_versions import (
    VersionCheckError,
    _repo_root,
    check_versions,
    collect_version_sources,
    normalize_expected_version,
)


SEMVER_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")
PUBLISHABLE_VERSION_RE = re.compile(
    r"^(\d+)\.(\d+)\.(\d+)(?:-(?:beta|alpha)(?:\.(\d+)|(\d+)))?$"
)
CHANGELOG_HEADING_RE = re.compile(
    r"^##\s+(?:\[)?(?P<version>v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\])?"
)
CHANGELOG_SECTION_KEYS = {
    "new features": "New features",
    "bug fixes": "Bug fixes",
}


@dataclass
class ChangelogNotes:
    flat: list[str] = field(default_factory=list)
    new_features: list[str] = field(default_factory=list)
    bug_fixes: list[str] = field(default_factory=list)

    @property
    def is_sectioned(self) -> bool:
        return bool(self.new_features or self.bug_fixes)

    def all_items(self) -> list[str]:
        if self.is_sectioned:
            return [*self.new_features, *self.bug_fixes]
        return self.flat


class BumpVersionError(Exception):
    """Raised when a version bump cannot be applied safely."""


def parse_semver(value: str) -> tuple[int, int, int]:
    normalized = normalize_expected_version(value.strip())
    match = SEMVER_RE.match(normalized)
    if not match:
        raise BumpVersionError(f"Version must be exact SemVer MAJOR.MINOR.PATCH, got {value!r}.")
    return int(match.group(1)), int(match.group(2)), int(match.group(3))


def parse_publishable_version(value: str) -> str:
    """Accept stable, Beta, or Alpha publishable versions."""
    normalized = normalize_expected_version(value.strip())
    if not PUBLISHABLE_VERSION_RE.fullmatch(normalized):
        raise BumpVersionError(
            f"Version must be MAJOR.MINOR.PATCH, MAJOR.MINOR.PATCH-beta.N / "
            f"MAJOR.MINOR.PATCH-betaNNN, or MAJOR.MINOR.PATCH-alpha.N, got {value!r}."
        )
    return normalized


def bump_semver(current: str, *, patch: bool, minor: bool, major: bool) -> str:
    # Incremental bumps always produce a stable version from the core SemVer triple.
    core = current.split("-", 1)[0]
    major_n, minor_n, patch_n = parse_semver(core)
    if major:
        return f"{major_n + 1}.0.0"
    if minor:
        return f"{major_n}.{minor_n + 1}.0"
    if patch:
        return f"{major_n}.{minor_n}.{patch_n + 1}"
    raise BumpVersionError("One of --patch, --minor, or --major is required when NEW_VERSION is omitted.")


def resolve_target_version(
    repo_root: Path,
    explicit: str | None,
    *,
    patch: bool,
    minor: bool,
    major: bool,
) -> str:
    sources = collect_version_sources(repo_root)
    current = sources[0].version
    if explicit is not None:
        target = parse_publishable_version(explicit)
        if target == current:
            raise BumpVersionError(f"Target version {target} matches the current version.")
        return target
    return bump_semver(current, patch=patch, minor=minor, major=major)


def _write_json_version(path: Path, version: str, *, lock_root_name: str | None = None) -> None:
    data = json.loads(path.read_text(encoding="utf-8"))
    data["version"] = version
    if lock_root_name is not None:
        packages = data.get("packages")
        if not isinstance(packages, dict) or "" not in packages:
            raise BumpVersionError(f"{path.as_posix()}: packages[''] is missing.")
        packages[""]["version"] = version
        if packages[""].get("name") != lock_root_name:
            packages[""]["name"] = lock_root_name
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def apply_version_bump(repo_root: Path, new_version: str) -> list[Path]:
    changed: list[Path] = []

    config_path = repo_root / "backend/app/config.py"
    config_text = config_path.read_text(encoding="utf-8")
    updated, count = re.subn(
        r'^APP_VERSION = "[^"]+"',
        f'APP_VERSION = "{new_version}"',
        config_text,
        count=1,
        flags=re.MULTILINE,
    )
    if count != 1:
        raise BumpVersionError(f"{config_path.as_posix()}: APP_VERSION assignment not found.")
    config_path.write_text(updated, encoding="utf-8")
    changed.append(config_path)

    _write_json_version(repo_root / "package.json", new_version)
    changed.append(repo_root / "package.json")
    _write_json_version(
        repo_root / "package-lock.json",
        new_version,
        lock_root_name="cellxplorer-desktop",
    )
    changed.append(repo_root / "package-lock.json")

    _write_json_version(repo_root / "frontend/package.json", new_version)
    changed.append(repo_root / "frontend/package.json")
    _write_json_version(
        repo_root / "frontend/package-lock.json",
        new_version,
        lock_root_name="cellxplorer-frontend",
    )
    changed.append(repo_root / "frontend/package-lock.json")

    _write_json_version(repo_root / "src-tauri/tauri.conf.json", new_version)
    changed.append(repo_root / "src-tauri/tauri.conf.json")

    cargo_toml = repo_root / "src-tauri/Cargo.toml"
    cargo_text = cargo_toml.read_text(encoding="utf-8")
    updated, count = re.subn(
        r'(?m)^(name = "cellxplorer"\nversion = )"[^"]+"',
        rf'\1"{new_version}"',
        cargo_text,
        count=1,
    )
    if count != 1:
        updated, count = re.subn(
            r'(?m)^version = "[^"]+"',
            f'version = "{new_version}"',
            cargo_text,
            count=1,
        )
    if count != 1:
        raise BumpVersionError(f"{cargo_toml.as_posix()}: package.version not found.")
    cargo_toml.write_text(updated, encoding="utf-8")
    changed.append(cargo_toml)

    cargo_lock = repo_root / "src-tauri/Cargo.lock"
    lock_text = cargo_lock.read_text(encoding="utf-8")
    updated, count = re.subn(
        r'(\[\[package\]\]\nname = "cellxplorer"\nversion = ")[^"]+(")',
        rf"\g<1>{new_version}\2",
        lock_text,
        count=1,
    )
    if count != 1:
        raise BumpVersionError(f"{cargo_lock.as_posix()}: cellxplorer package version not found.")
    cargo_lock.write_text(updated, encoding="utf-8")
    changed.append(cargo_lock)

    return changed


def _changelog_has_version(content: str, version: str) -> bool:
    for line in content.splitlines():
        match = CHANGELOG_HEADING_RE.match(line.strip())
        if match and normalize_expected_version(match.group("version")) == version:
            return True
    return False


def _normalize_note_line(line: str) -> str:
    stripped = line.strip()
    if stripped.startswith("- "):
        return stripped[2:].strip()
    return stripped


def parse_changelog_notes(lines: list[str]) -> ChangelogNotes:
    notes = ChangelogNotes()
    current_section: str | None = None
    saw_section_header = False

    for raw in lines:
        stripped = raw.strip()
        if not stripped:
            continue
        section_key = stripped.lower().rstrip(":")
        if section_key in CHANGELOG_SECTION_KEYS:
            current_section = section_key
            saw_section_header = True
            continue

        item = _normalize_note_line(stripped)
        if not item:
            continue

        if current_section == "new features":
            notes.new_features.append(item)
        elif current_section == "bug fixes":
            notes.bug_fixes.append(item)
        elif saw_section_header:
            raise BumpVersionError(
                f"Release note {item!r} is outside a recognized section. "
                "Use 'New features' or 'Bug fixes' headings."
            )
        else:
            notes.flat.append(item)

    if not notes.all_items():
        raise BumpVersionError("At least one non-empty release note is required.")
    if notes.flat and notes.is_sectioned:
        raise BumpVersionError(
            "Mix flat release notes with section headings is not supported."
        )
    return notes


def format_changelog_section(
    version: str,
    notes: ChangelogNotes,
    *,
    release_date: date,
) -> str:
    lines = [f"## {version} - {release_date.isoformat()}", ""]
    if notes.is_sectioned:
        if notes.new_features:
            lines.extend(["### New features", ""])
            lines.extend(f"- {item}" for item in notes.new_features)
            lines.append("")
        if notes.bug_fixes:
            lines.extend(["### Bug fixes", ""])
            lines.extend(f"- {item}" for item in notes.bug_fixes)
            lines.append("")
    else:
        lines.extend(f"- {item}" for item in notes.flat)
        lines.append("")
    return "\n".join(lines).rstrip() + "\n\n"


def prepend_changelog(
    repo_root: Path,
    version: str,
    notes: ChangelogNotes,
    *,
    release_date: date,
) -> Path:
    changelog_path = repo_root / "CHANGELOG.md"
    if not changelog_path.is_file():
        raise BumpVersionError("CHANGELOG.md is missing.")
    content = changelog_path.read_text(encoding="utf-8")
    if _changelog_has_version(content, version):
        raise BumpVersionError(f"CHANGELOG.md already contains a section for {version}.")

    section = format_changelog_section(version, notes, release_date=release_date)
    marker = "\n## "
    insert_at = content.find(marker)
    if insert_at == -1:
        updated = content.rstrip() + "\n\n" + section
    else:
        updated = content[:insert_at] + "\n" + section + content[insert_at + 1 :]
    changelog_path.write_text(updated, encoding="utf-8")
    return changelog_path


def load_notes(args: argparse.Namespace) -> ChangelogNotes:
    lines: list[str] = []
    if args.notes_file is not None:
        lines.extend(args.notes_file.read_text(encoding="utf-8").splitlines())
    lines.extend(args.notes)
    for feature in args.feature:
        lines.extend(["New features", feature])
    for bugfix in args.bugfix:
        lines.extend(["Bug fixes", bugfix])
    if not lines:
        raise BumpVersionError(
            "Provide --notes, --notes-file, --feature, and/or --bugfix."
        )
    return parse_changelog_notes(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Bump every maintained CellXplorer version declaration and prepend CHANGELOG."
    )
    parser.add_argument(
        "new_version",
        nargs="?",
        help=(
            "Target version (MAJOR.MINOR.PATCH, -beta.N, or -alpha.N). "
            "Omit with --patch, --minor, or --major."
        ),
    )
    bump = parser.add_mutually_exclusive_group()
    bump.add_argument("--patch", action="store_true", help="Increment patch from the current version.")
    bump.add_argument("--minor", action="store_true", help="Increment minor from the current version.")
    bump.add_argument("--major", action="store_true", help="Increment major from the current version.")
    parser.add_argument(
        "--notes",
        action="append",
        default=[],
        help="Release-note bullet without a section (repeatable, legacy flat format).",
    )
    parser.add_argument(
        "--feature",
        action="append",
        default=[],
        help="New-feature bullet for a sectioned changelog (repeatable).",
    )
    parser.add_argument(
        "--bugfix",
        action="append",
        default=[],
        help="Bug-fix bullet for a sectioned changelog (repeatable).",
    )
    parser.add_argument(
        "--notes-file",
        type=Path,
        help=(
            "Read release notes from a text file. Use 'New features' and 'Bug fixes' "
            "headings for sectioned changelogs; otherwise one bullet per line."
        ),
    )
    parser.add_argument(
        "--date",
        type=date.fromisoformat,
        default=date.today(),
        help="Release date for the changelog heading (YYYY-MM-DD).",
    )
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=_repo_root(),
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show the target version without modifying files.",
    )
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return 2 if exc.code == 2 else int(exc.code or 2)

    try:
        if args.new_version is None and not (args.patch or args.minor or args.major):
            parser.error("Provide NEW_VERSION or one of --patch, --minor, --major.")
        target = resolve_target_version(
            args.repo_root,
            args.new_version,
            patch=args.patch,
            minor=args.minor,
            major=args.major,
        )
        notes = load_notes(args)
        if args.dry_run:
            print(f"Would bump to {target}")
            print(format_changelog_section(target, notes, release_date=args.date).rstrip())
            return 0

        changed = apply_version_bump(args.repo_root, target)
        changed.append(prepend_changelog(args.repo_root, target, notes, release_date=args.date))

        _, errors, _ = check_versions(args.repo_root, target)
        if errors:
            raise BumpVersionError(errors[0])

        print(f"Bumped CellXplorer to {target}")
        for path in changed:
            print(f"  updated {path.relative_to(args.repo_root).as_posix()}")
        print("\nNext: python scripts\\check_versions.py --expected-version", target)
        print("      python scripts\\preflight.py --no-cache")
        return 0
    except (BumpVersionError, VersionCheckError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
