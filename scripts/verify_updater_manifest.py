#!/usr/bin/env python3
"""Validate a generated Tauri updater latest.json manifest."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlparse


SECRET_MARKERS = (
    "TAURI_SIGNING_PRIVATE_KEY",
    "BEGIN PRIVATE KEY",
    "github_pat_",
    "ghp_",
    "gho_",
)


class ManifestVerificationError(Exception):
    """Raised when latest.json fails validation."""


def normalize_version(value: str) -> str:
    value = value.strip()
    if value.startswith("v"):
        value = value[1:]
    return value


def normalize_notes(value: str) -> str:
    return value.replace("\r\n", "\n").strip()


def load_json(path: Path) -> dict:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ManifestVerificationError(f"{path.as_posix()}: invalid JSON ({exc})") from exc
    if not isinstance(payload, dict):
        raise ManifestVerificationError(f"{path.as_posix()}: manifest root must be an object.")
    return payload


def choose_windows_platform(payload: dict) -> tuple[str, dict]:
    platforms = payload.get("platforms")
    if isinstance(platforms, dict):
        for key in ("windows-x86_64", "windows-x86_64-nsis"):
            entry = platforms.get(key)
            if isinstance(entry, dict):
                return key, entry
        for key, entry in platforms.items():
            if key.startswith("windows-") and isinstance(entry, dict):
                return key, entry

    for key in ("windows-x86_64", "windows-x86_64-nsis"):
        entry = payload.get(key)
        if isinstance(entry, dict):
            return key, entry

    raise ManifestVerificationError(
        "Manifest is missing a Windows x86_64 / NSIS platform entry."
    )


def assert_no_secrets(text: str, label: str) -> None:
    lowered = text.lower()
    for marker in SECRET_MARKERS:
        if marker.lower() in lowered:
            raise ManifestVerificationError(
                f"{label} appears to contain secret material ({marker})."
            )


def verify_manifest(
    manifest: dict,
    *,
    expected_version: str,
    expected_notes: str,
    setup_exe_name: str | None = None,
) -> None:
    version = normalize_version(str(manifest.get("version", "")))
    target_version = normalize_version(expected_version)
    if version != target_version:
        raise ManifestVerificationError(
            f"Manifest version {version!r} does not match expected {target_version!r}."
        )

    notes = manifest.get("notes")
    if notes is None:
        raise ManifestVerificationError("Manifest notes are missing.")
    if normalize_notes(str(notes)) != normalize_notes(expected_notes):
        raise ManifestVerificationError(
            "Manifest notes do not match the extracted changelog section."
        )

    _platform_key, platform_entry = choose_windows_platform(manifest)
    url = platform_entry.get("url")
    signature = platform_entry.get("signature")
    if not isinstance(url, str) or not url.strip():
        raise ManifestVerificationError("Windows platform URL is missing.")
    if not isinstance(signature, str) or not signature.strip():
        raise ManifestVerificationError("Windows platform signature is missing.")

    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise ManifestVerificationError("Windows platform URL must use HTTPS.")
    if "github.com" not in parsed.netloc:
        raise ManifestVerificationError("Windows platform URL must point to GitHub releases.")

    if setup_exe_name and setup_exe_name not in url:
        raise ManifestVerificationError(
            f"Windows platform URL does not reference setup executable {setup_exe_name!r}."
        )

    serialized = json.dumps(manifest, ensure_ascii=False)
    assert_no_secrets(serialized, "Manifest JSON")
    assert_no_secrets(signature, "Signature")


def infer_setup_exe_name(version: str) -> str:
    return f"CellXplorer_{normalize_version(version)}_x64-setup.exe"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Verify a Tauri updater latest.json file.")
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--expected-version", required=True)
    parser.add_argument("--notes-file", type=Path, required=True)
    parser.add_argument(
        "--setup-exe-name",
        default=None,
        help="Expected NSIS setup executable file name inside the platform URL.",
    )
    args = parser.parse_args(argv)

    if not args.manifest.is_file():
        print(f"ERROR: manifest not found: {args.manifest}", file=sys.stderr)
        return 1
    if not args.notes_file.is_file():
        print(f"ERROR: notes file not found: {args.notes_file}", file=sys.stderr)
        return 1

    setup_name = args.setup_exe_name or infer_setup_exe_name(args.expected_version)
    notes = args.notes_file.read_text(encoding="utf-8")

    try:
        verify_manifest(
            load_json(args.manifest),
            expected_version=args.expected_version,
            expected_notes=notes,
            setup_exe_name=setup_name,
        )
    except ManifestVerificationError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    print(f"PASS: updater manifest matches {normalize_version(args.expected_version)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
