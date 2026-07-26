#!/usr/bin/env python3
"""Verify that all maintained CellXplorer version declarations match."""

from __future__ import annotations

import argparse
import ast
import json
import re
import sys
import tomllib
from dataclasses import dataclass
from pathlib import Path


PLOTLY_ASSET_MIN_BYTES = 1_000_000
PLOTLY_COPY_COMMAND = (
    "Copy-Item frontend\\node_modules\\plotly.js-dist-min\\plotly.min.js "
    "backend\\app\\assets\\plotly.min.js"
)


@dataclass(frozen=True)
class VersionSource:
    label: str
    path: str
    version: str


class VersionCheckError(Exception):
    """Raised when a version declaration is missing or malformed."""


class PlotlyVersionSkip(Exception):
    """Plotly runtime check skipped because frontend dependencies are absent."""


def _read_plotly_npm_version(root: Path) -> str:
    package_json = root / "frontend" / "node_modules" / "plotly.js-dist-min" / "package.json"
    if not package_json.is_file():
        raise PlotlyVersionSkip(
            "Plotly runtime check skipped: frontend/node_modules/plotly.js-dist-min is not installed."
        )
    return _read_json_version(package_json)


def _read_plotly_asset_version(path: Path) -> str:
    if not path.is_file():
        raise VersionCheckError(
            f"{path.as_posix()}: portable-report Plotly runtime is missing."
        )
    if path.stat().st_size < PLOTLY_ASSET_MIN_BYTES:
        raise VersionCheckError(
            f"{path.as_posix()}: portable-report Plotly runtime is unexpectedly small."
        )
    header = path.read_text(encoding="utf-8", errors="replace")[:2048]
    match = re.search(r"v(\d+\.\d+\.\d+)", header)
    if not match:
        raise VersionCheckError(
            f"{path.as_posix()}: could not parse Plotly version from runtime header."
        )
    return match.group(1)


def check_plotly_runtime_versions(root: Path | None = None) -> tuple[list[str], list[str]]:
    root = root or _repo_root()
    asset_path = root / "backend" / "app" / "assets" / "plotly.min.js"
    try:
        npm_version = _read_plotly_npm_version(root)
    except PlotlyVersionSkip as exc:
        return [], [str(exc)]
    try:
        asset_version = _read_plotly_asset_version(asset_path)
    except VersionCheckError as exc:
        return [str(exc)], []
    if npm_version != asset_version:
        return [
            "Plotly runtime versions do not match: "
            f"frontend/node_modules/plotly.js-dist-min is {npm_version}, "
            f"backend/app/assets/plotly.min.js is {asset_version}. "
            f"Refresh the asset with:\n  {PLOTLY_COPY_COMMAND}"
        ], []
    return [], []


def _repo_root(start: Path | None = None) -> Path:
    return (start or Path(__file__).resolve()).parents[1]


def _read_app_version(path: Path) -> str:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        for target in node.targets:
            if isinstance(target, ast.Name) and target.id == "APP_VERSION":
                value = node.value
                if isinstance(value, ast.Constant) and isinstance(value.value, str):
                    return value.value
                raise VersionCheckError(f"{path.as_posix()}: APP_VERSION is not a string literal")
    raise VersionCheckError(f"{path.as_posix()}: APP_VERSION is missing")


def _read_json_version(path: Path, key: str = "version") -> str:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise VersionCheckError(f"{path.as_posix()}: malformed JSON ({exc.msg})") from exc
    value = data.get(key)
    if not isinstance(value, str) or not value:
        raise VersionCheckError(f"{path.as_posix()}: top-level {key!r} is missing")
    return value


def _read_json_lock_root_version(path: Path) -> str:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise VersionCheckError(f"{path.as_posix()}: malformed JSON ({exc.msg})") from exc
    packages = data.get("packages")
    if not isinstance(packages, dict):
        raise VersionCheckError(f"{path.as_posix()}: packages[""] is missing")
    root = packages.get("")
    if not isinstance(root, dict):
        raise VersionCheckError(f"{path.as_posix()}: packages[""] is missing")
    value = root.get("version")
    if not isinstance(value, str) or not value:
        raise VersionCheckError(f"{path.as_posix()}: packages[""].version is missing")
    return value


def _read_cargo_toml_version(path: Path) -> str:
    try:
        data = tomllib.loads(path.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as exc:
        raise VersionCheckError(f"{path.as_posix()}: malformed TOML ({exc})") from exc
    package = data.get("package")
    if not isinstance(package, dict):
        raise VersionCheckError(f"{path.as_posix()}: [package] is missing")
    value = package.get("version")
    if not isinstance(value, str) or not value:
        raise VersionCheckError(f"{path.as_posix()}: package.version is missing")
    return value


def _read_cargo_lock_version(path: Path, package_name: str = "cellxplorer") -> str:
    try:
        data = tomllib.loads(path.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as exc:
        raise VersionCheckError(f"{path.as_posix()}: malformed TOML ({exc})") from exc
    packages = data.get("package")
    if not isinstance(packages, list):
        raise VersionCheckError(f"{path.as_posix()}: no package named {package_name!r}")
    for package in packages:
        if isinstance(package, dict) and package.get("name") == package_name:
            value = package.get("version")
            if isinstance(value, str) and value:
                return value
            raise VersionCheckError(
                f"{path.as_posix()}: package {package_name!r} has no version"
            )
    raise VersionCheckError(f"{path.as_posix()}: no package named {package_name!r}")


def collect_version_sources(repo_root: Path | None = None) -> list[VersionSource]:
    root = repo_root or _repo_root()
    readers: list[tuple[str, str, object]] = [
        ("Backend", "backend/app/config.py", lambda p: _read_app_version(p)),
        ("Root package", "package.json", lambda p: _read_json_version(p)),
        ("Root package lock", "package-lock.json", lambda p: _read_json_version(p)),
        (
            "Root package lock (packages root)",
            "package-lock.json",
            lambda p: _read_json_lock_root_version(p),
        ),
        ("Frontend package", "frontend/package.json", lambda p: _read_json_version(p)),
        ("Frontend package lock", "frontend/package-lock.json", lambda p: _read_json_version(p)),
        (
            "Frontend package lock (packages root)",
            "frontend/package-lock.json",
            lambda p: _read_json_lock_root_version(p),
        ),
        ("Tauri configuration", "src-tauri/tauri.conf.json", lambda p: _read_json_version(p)),
        ("Rust package", "src-tauri/Cargo.toml", lambda p: _read_cargo_toml_version(p)),
        ("Rust package lock", "src-tauri/Cargo.lock", lambda p: _read_cargo_lock_version(p)),
    ]
    sources: list[VersionSource] = []
    for label, relative, reader in readers:
        path = root / relative
        if not path.is_file():
            raise VersionCheckError(f"{relative}: file is missing")
        sources.append(VersionSource(label, relative, reader(path)))
    return sources


def normalize_expected_version(value: str) -> str:
    return value[1:] if value.startswith("v") else value


def check_versions(
    repo_root: Path | None = None,
    expected_version: str | None = None,
) -> tuple[list[VersionSource], list[str], list[str]]:
    """Return collected sources, failure messages, and informational skips."""
    try:
        sources = collect_version_sources(repo_root)
    except VersionCheckError as exc:
        return [], [str(exc)], []

    versions = {source.version for source in sources}
    errors: list[str] = []
    if len(versions) != 1:
        errors.append("version declarations do not match")
    if expected_version is not None:
        normalized = normalize_expected_version(expected_version)
        if len(versions) == 1 and next(iter(versions)) != normalized:
            errors.append(
                f"expected version {normalized}, found {next(iter(versions))}"
            )
        elif len(versions) != 1:
            errors.append(f"expected version {normalized}")
    plotly_errors, plotly_skips = check_plotly_runtime_versions(repo_root)
    errors.extend(plotly_errors)
    return sources, errors, plotly_skips


def _format_table(sources: list[VersionSource]) -> str:
    width = max(len(source.label) for source in sources)
    lines = [f"{source.label:<{width}}  {source.version}" for source in sources]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Verify CellXplorer version declarations are consistent."
    )
    parser.add_argument(
        "--expected-version",
        help="Optional version that every declaration must match (accepts a leading v).",
    )
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=_repo_root(),
        help=argparse.SUPPRESS,
    )
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return 2 if exc.code == 2 else int(exc.code or 2)

    sources, errors, plotly_skips = check_versions(args.repo_root, args.expected_version)
    if not sources:
        print("FAIL:", errors[0], file=sys.stderr)
        return 1

    print(_format_table(sources))
    for message in plotly_skips:
        print(message)
    if errors:
        print("\nFAIL:", errors[0], file=sys.stderr)
        if "do not match" in errors[0]:
            seen: set[tuple[str, str]] = set()
            for source in sources:
                key = (source.path, source.version)
                if key in seen:
                    continue
                seen.add(key)
                print(f"{source.path:<28} {source.version}", file=sys.stderr)
        elif errors[0].startswith("Plotly runtime versions do not match"):
            print(errors[0], file=sys.stderr)
        return 1

    version = sources[0].version
    print(f"\nPASS: all version declarations match {version}")
    if not plotly_skips:
        print("PASS: portable-report Plotly runtime matches the installed frontend bundle.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except VersionCheckError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
