#!/usr/bin/env python3
"""Validate a generated Tauri updater latest.json against GitHub release assets."""

from __future__ import annotations

import argparse
import base64
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

# Tauri action v1 writes api.github.com asset URLs, not browser download URLs.
GITHUB_API_ASSET_RE = re.compile(
    r"^https://api\.github\.com/repos/"
    r"(?P<owner>[^/]+)/(?P<repo>[^/]+)/releases/assets/(?P<asset_id>\d+)/?$"
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


def normalize_signature_text(value: str) -> str:
    return value.replace("\r\n", "\n").strip()


def load_json(path: Path) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ManifestVerificationError(f"{path.as_posix()}: invalid JSON ({exc})") from exc


def load_json_object(path: Path) -> dict:
    payload = load_json(path)
    if not isinstance(payload, dict):
        raise ManifestVerificationError(f"{path.as_posix()}: JSON root must be an object.")
    return payload


def load_release_assets(path: Path) -> list[dict]:
    payload = load_json(path)
    if not isinstance(payload, list):
        raise ManifestVerificationError(
            f"{path.as_posix()}: release assets JSON must be an array."
        )
    assets: list[dict] = []
    for index, entry in enumerate(payload):
        if not isinstance(entry, dict):
            raise ManifestVerificationError(
                f"{path.as_posix()}: release asset at index {index} must be an object."
            )
        assets.append(entry)
    return assets


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


def parse_github_api_asset_url(url: str) -> tuple[str, str, int]:
    match = GITHUB_API_ASSET_RE.fullmatch(url.strip())
    if not match:
        raise ManifestVerificationError(
            "Windows platform URL must be a GitHub API release-asset URL "
            "(https://api.github.com/repos/<owner>/<repo>/releases/assets/<id>)."
        )
    return match.group("owner"), match.group("repo"), int(match.group("asset_id"))


def find_asset_by_id(assets: list[dict], asset_id: int) -> dict:
    for asset in assets:
        raw_id = asset.get("id")
        try:
            current_id = int(raw_id)
        except (TypeError, ValueError):
            continue
        if current_id == asset_id:
            return asset
    raise ManifestVerificationError(
        f"Release assets metadata does not include asset id {asset_id}."
    )


def asset_display_name(asset: dict) -> str:
    for key in ("name", "label"):
        value = asset.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    raise ManifestVerificationError("Release asset is missing a name/label.")


def require_named_asset(assets: list[dict], name: str) -> dict:
    for asset in assets:
        try:
            if asset_display_name(asset) == name:
                return asset
        except ManifestVerificationError:
            continue
    raise ManifestVerificationError(f"Release assets metadata is missing {name!r}.")


def _minisign_data_line(decoded_text: str, *, kind: str) -> str:
    lines = [line.strip() for line in decoded_text.splitlines() if line.strip()]
    if kind == "pubkey":
        data_lines = [line for line in lines if not line.lower().startswith("untrusted comment:")]
        if not data_lines:
            raise ManifestVerificationError("Updater public key has no minisign data line.")
        return data_lines[-1]
    if len(lines) < 2:
        raise ManifestVerificationError("Updater signature is missing the minisign data line.")
    return lines[1]


def minisign_key_id_from_tauri_pubkey(pubkey_b64: str) -> bytes:
    try:
        decoded = base64.b64decode(pubkey_b64.strip(), validate=True)
        text = decoded.decode("utf-8")
        data_line = _minisign_data_line(text, kind="pubkey")
        blob = base64.b64decode(data_line, validate=True)
    except (ValueError, UnicodeDecodeError) as exc:
        raise ManifestVerificationError(f"Invalid Tauri updater public key encoding ({exc}).") from exc
    if len(blob) < 10:
        raise ManifestVerificationError("Tauri updater public key is too short.")
    return blob[2:10]


def minisign_key_id_from_tauri_sig(signature_b64: str) -> bytes:
    try:
        decoded = base64.b64decode(signature_b64.strip(), validate=True)
        text = decoded.decode("utf-8")
        data_line = _minisign_data_line(text, kind="signature")
        blob = base64.b64decode(data_line, validate=True)
    except (ValueError, UnicodeDecodeError) as exc:
        raise ManifestVerificationError(f"Invalid updater signature encoding ({exc}).") from exc
    if len(blob) < 10:
        raise ManifestVerificationError("Updater signature is too short.")
    return blob[2:10]


def assert_signature_matches_pubkey(signature_b64: str, pubkey_b64: str) -> None:
    pub_id = minisign_key_id_from_tauri_pubkey(pubkey_b64)
    sig_id = minisign_key_id_from_tauri_sig(signature_b64)
    if pub_id != sig_id:
        raise ManifestVerificationError(
            "Updater signature key id does not match the embedded Tauri public key."
        )


def verify_manifest(
    manifest: dict,
    *,
    expected_version: str,
    expected_notes: str,
    expected_owner: str,
    expected_repo: str,
    release_assets: list[dict],
    setup_exe_name: str | None = None,
    pubkey_b64: str | None = None,
    uploaded_signature_text: str | None = None,
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

    setup_name = setup_exe_name or infer_setup_exe_name(target_version)
    require_named_asset(release_assets, "latest.json")
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

    owner, repo, asset_id = parse_github_api_asset_url(url)
    if owner != expected_owner or repo != expected_repo:
        raise ManifestVerificationError(
            f"Windows platform URL repository {owner}/{repo} does not match "
            f"expected {expected_owner}/{expected_repo}."
        )

    asset = find_asset_by_id(release_assets, asset_id)
    asset_name = asset_display_name(asset)
    if asset_name != setup_name:
        raise ManifestVerificationError(
            f"Release asset id {asset_id} is named {asset_name!r}, expected {setup_name!r}."
        )

    sig_name = f"{setup_name}.sig"
    require_named_asset(release_assets, sig_name)

    if uploaded_signature_text is not None:
        if normalize_signature_text(uploaded_signature_text) != normalize_signature_text(signature):
            raise ManifestVerificationError(
                "Uploaded .sig contents do not match latest.json platform signature text."
            )

    if pubkey_b64:
        assert_signature_matches_pubkey(signature, pubkey_b64)

    serialized = json.dumps(manifest, ensure_ascii=False)
    assert_no_secrets(serialized, "Manifest JSON")
    assert_no_secrets(signature, "Signature")


def infer_setup_exe_name(version: str) -> str:
    return f"CellXplorer_{normalize_version(version)}_x64-setup.exe"


def load_pubkey_from_tauri_conf(path: Path) -> str:
    conf = load_json_object(path)
    try:
        pubkey = conf["plugins"]["updater"]["pubkey"]
    except (KeyError, TypeError) as exc:
        raise ManifestVerificationError(
            f"{path.as_posix()}: missing plugins.updater.pubkey."
        ) from exc
    if not isinstance(pubkey, str) or not pubkey.strip():
        raise ManifestVerificationError(
            f"{path.as_posix()}: plugins.updater.pubkey must be a non-empty string."
        )
    return pubkey.strip()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Verify a Tauri updater latest.json against GitHub release assets."
    )
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--expected-version", required=True)
    parser.add_argument("--notes-file", type=Path, required=True)
    parser.add_argument("--owner", required=True)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--release-assets", type=Path, required=True)
    parser.add_argument(
        "--setup-exe-name",
        default=None,
        help="Expected NSIS setup executable file name in release-asset metadata.",
    )
    parser.add_argument(
        "--tauri-conf",
        type=Path,
        default=None,
        help="Optional tauri.conf.json used to verify signature key identity.",
    )
    parser.add_argument(
        "--uploaded-signature",
        type=Path,
        default=None,
        help="Optional downloaded draft .sig contents to compare with latest.json.",
    )
    args = parser.parse_args(argv)

    if not args.manifest.is_file():
        print(f"ERROR: manifest not found: {args.manifest}", file=sys.stderr)
        return 1
    if not args.notes_file.is_file():
        print(f"ERROR: notes file not found: {args.notes_file}", file=sys.stderr)
        return 1
    if not args.release_assets.is_file():
        print(f"ERROR: release assets not found: {args.release_assets}", file=sys.stderr)
        return 1

    setup_name = args.setup_exe_name or infer_setup_exe_name(args.expected_version)
    notes = args.notes_file.read_text(encoding="utf-8")
    pubkey = None
    uploaded_sig = None
    try:
        if args.tauri_conf is not None:
            if not args.tauri_conf.is_file():
                raise ManifestVerificationError(f"tauri.conf not found: {args.tauri_conf}")
            pubkey = load_pubkey_from_tauri_conf(args.tauri_conf)
        if args.uploaded_signature is not None:
            if not args.uploaded_signature.is_file():
                raise ManifestVerificationError(
                    f"uploaded signature not found: {args.uploaded_signature}"
                )
            uploaded_sig = args.uploaded_signature.read_text(encoding="utf-8")
        verify_manifest(
            load_json_object(args.manifest),
            expected_version=args.expected_version,
            expected_notes=notes,
            expected_owner=args.owner,
            expected_repo=args.repo,
            release_assets=load_release_assets(args.release_assets),
            setup_exe_name=setup_name,
            pubkey_b64=pubkey,
            uploaded_signature_text=uploaded_sig,
        )
    except ManifestVerificationError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    print(f"PASS: updater manifest matches {normalize_version(args.expected_version)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
