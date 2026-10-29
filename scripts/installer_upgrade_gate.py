"""Artifact preparation and the real Tauri updater verifier for the CI install gate.

No installers are launched here. Byte verification uses the Rust example with
the same minisign verifier and API as Tauri, not Python key-ID comparisons.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import urllib.request
from urllib.error import HTTPError
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
PRODUCTS = {"stable": "CellXplorer", "beta": "CellXplorer Beta", "alpha": "CellXplorer Alpha"}
TAG = re.compile(r"^v(?P<core>(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))"
                 r"(?:-alpha\.(?P<alpha>0|[1-9]\d*)|-beta\.(?P<beta>0|[1-9]\d*)|-beta(?P<compact>\d+))?$")


def channel_version(tag: str):
    match = TAG.fullmatch(tag)
    if not match:
        return None
    channel = "alpha" if match['alpha'] else "beta" if match['beta'] or match['compact'] else "stable"
    sequence = int(match['alpha'] or match['beta'] or 0)
    # Compact beta identifiers sort lexically under SemVer, above dotted beta.N.
    order = (tuple(map(int, match['core'].split('.'))), bool(match['compact']),
             match['compact'] or "", sequence)
    return channel, order


def previous_release(rows: list[dict], channel: str, candidate_tag: str) -> dict:
    candidate = channel_version(candidate_tag)
    eligible = []
    for row in rows:
        parsed = channel_version(row.get("tag_name", ""))
        if (not parsed or parsed[0] != channel or row.get("draft")
                or not row.get("published_at") or row["tag_name"] == candidate_tag):
            continue
        if candidate and candidate[0] == channel and parsed[1] >= candidate[1]:
            continue
        eligible.append((parsed[1], row))
    if not eligible:
        raise ValueError(f"No previous published {channel} installer; gate cannot skip")
    return max(eligible, key=lambda entry: entry[0])[1]


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def require_equal_bytes(local: Path, staged: Path) -> str:
    digest = sha256(local)
    if digest != sha256(staged):
        raise ValueError(f"Staged asset differs from exact local build: {local.name}")
    return digest


def expected_nsis_application_hash(binary: bytes, cli_version: str, windows: dict) -> str:
    # Pinned upstream implementation: tauri-cli-v2.11.4, bundle.rs patch_binary
    # replaces this one marker for NSIS, then restores the unpatched build file.
    # Compute the EXPECTED whole payload, never normalize installed/candidate data.
    # https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle.rs
    if cli_version != "2.11.4":
        raise ValueError("Review NSIS binary patching for the new Tauri CLI before accepting installs")
    if windows.get("certificateThumbprint") or windows.get("signCommand"):
        raise ValueError("Authenticode packaging needs a captured signed payload reference")
    marker = b"__TAURI_BUNDLE_TYPE_VAR_UNK"
    if len(binary) < 64 or not binary.startswith(b"MZ") or binary.count(marker) != 1:
        raise ValueError("Expected one unbundled Tauri application marker in the local PE build")
    packaged = binary.replace(marker, b"__TAURI_BUNDLE_TYPE_VAR_NSS", 1)
    return hashlib.sha256(packaged).hexdigest()


def verify_installer(installer: Path, signature: Path, config: Path | None = None):
    subprocess.run([
        "cargo", "run", "--locked", "--manifest-path", str(ROOT / "scripts/updater_signature_verifier/Cargo.toml"),
        "--target-dir", str(ROOT / "src-tauri/target/signature-verifier"),
        "--bin", "verify_updater_signature", "--", "--installer", str(installer),
        "--signature", str(signature), "--config", str(config or ROOT / "src-tauri/tauri.conf.json"),
    ], check=True, timeout=180)


class GitHub:
    def __init__(self, repository: str, token: str):
        if not re.fullmatch(r"[\w.-]+/[\w.-]+", repository) or not token:
            raise ValueError("GitHub repository and token required")
        self.base = f"https://api.github.com/repos/{repository}"
        self.token = token
        self.headers = {"User-Agent": "CellXplorer-upgrade-gate",
                        "X-GitHub-Api-Version": "2022-11-28"}

    def get(self, path: str, binary: bool = False):
        headers = {**self.headers, "Accept": "application/octet-stream" if binary else "application/vnd.github+json"}
        request = urllib.request.Request(self.base + path, headers=headers)
        # GitHub redirects asset reads to signed CDN URLs. Never forward the API
        # token with that redirect (urllib otherwise copies ordinary headers).
        request.add_unredirected_header("Authorization", f"Bearer {self.token}")
        with urllib.request.urlopen(request, timeout=120) as response:
            data = response.read()
        return data if binary else json.loads(data)

    def releases(self):
        rows = []
        for page in range(1, 1001):
            batch = self.get(f"/releases?per_page=100&page={page}")
            rows.extend(batch)
            if len(batch) < 100:
                return rows
        raise ValueError("Release pagination exceeded bound")

    def asset(self, release: dict, name: str, target: Path):
        asset, = [a for a in release["assets"] if a["name"] == name]
        data = self.get(f'/releases/assets/{int(asset["id"])}', binary=True)
        if len(data) != asset["size"]:
            raise ValueError(f"Incomplete asset: {name}")
        target.write_bytes(data)

    def installer_capabilities(self, tag: str, channel: str) -> dict:
        def source(name):
            payload = self.get(f"/contents/src-tauri/{name}?ref={quote(tag, safe='')}")
            return base64.b64decode(payload["content"].replace("\n", ""), validate=True).decode("utf-8")

        base = json.loads(source("tauri.conf.json"))
        scope = base.get("bundle", {}).get("windows", {}).get("nsis", {}).get("installMode", "currentUser")
        if channel != "stable":
            overlay = json.loads(source(f"tauri.{channel}.conf.json"))
            scope = overlay.get("bundle", {}).get("windows", {}).get("nsis", {}).get("installMode", scope)
        if scope not in {"currentUser", "perMachine", "both"}:
            raise ValueError(f"Unknown prior NSIS scope {scope!r} at {tag}")
        scoped_cli = False
        if scope == "currentUser":
            try:
                policy = source("installation_scope.nsh")
            except HTTPError as error:
                if error.code != 404:
                    raise
                error.close()
            else:
                scoped_cli = all(flag in policy for flag in ('"/CXALLUSERS"', '"/CXCURRENTUSER"'))
        # Stock historical `both` requires its own unproven mode-selection CLI.
        # Never guess that our /CX flags work on that baseline.
        return {"declared_nsis_scope": scope, "supports_user_baseline": scope == "currentUser",
                "supports_machine_baseline": scope == "perMachine" or scoped_cli}


def asset_identity(release: dict, name: str) -> dict:
    asset, = [a for a in release["assets"] if a["name"] == name]
    if int(asset["id"]) <= 0:
        raise ValueError("Invalid release asset ID")
    return {"id": int(asset["id"]), "name": name, "size": int(asset["size"])}


def prepare(root: Path, channel: str, version: str, release_id: str | None,
            evidence_path: Path | None = None):
    github = GitHub(os.environ["GITHUB_REPOSITORY"], os.environ["GH_TOKEN"])
    version = version.removeprefix("v")
    candidate_tag = f"v{version}"
    name = f'{PRODUCTS[channel].replace(" ", ".")}_{version}_x64-setup.exe'
    # Tauri's on-disk bundle retains product spaces; GitHub sanitizes uploaded
    # release-asset names to dots. Bind the two exact names by bytes, never glob.
    local_name = f'{PRODUCTS[channel]}_{version}_x64-setup.exe'
    local = ROOT / "src-tauri/target/release/bundle/nsis" / local_name
    candidate = root / "candidate.exe"
    signature = root / "candidate.sig"
    provenance = None
    if release_id:
        if (evidence_path is None or not evidence_path.parent.is_dir()
                or evidence_path.resolve().is_relative_to(root.resolve())):
            raise ValueError("Draft provenance requires controller evidence outside the native root")
        release = github.get(f"/releases/{int(release_id)}")
        if (release.get("draft") is not True or release["tag_name"] != candidate_tag
                or int(release["id"]) != int(release_id)):
            raise ValueError("Candidate must be the exact draft tag")
        github.asset(release, name, candidate)
        github.asset(release, name + ".sig", signature)
        github.asset(release, "latest.json", root / "staged-latest.json")
        require_equal_bytes(ROOT / "uploaded-latest.json", root / "staged-latest.json")
        provenance = {"schema": 1, "repository": os.environ["GITHUB_REPOSITORY"],
                      "release_id": int(release_id), "tag": candidate_tag, "assets": {},
                      "updater_pubkey": json.loads((ROOT / "src-tauri/tauri.conf.json").read_text())["plugins"]["updater"]["pubkey"]}
        for role, asset_name, path in (("installer", name, candidate), ("signature", name + ".sig", signature),
                                       ("manifest", "latest.json", root / "staged-latest.json")):
            identity = asset_identity(release, asset_name)
            if identity["size"] != path.stat().st_size:
                raise ValueError(f"Draft asset size mismatch: {asset_name}")
            provenance["assets"][role] = {**identity, "sha256": sha256(path)}
    else:
        candidate.write_bytes(local.read_bytes())
        signature.write_bytes(Path(str(local) + ".sig").read_bytes())
    digest = require_equal_bytes(local, candidate)
    require_equal_bytes(Path(str(local) + ".sig"), signature)
    verify_installer(candidate, signature)
    rows = github.releases()
    binary = (ROOT / "src-tauri/target/release/cellxplorer.exe").read_bytes()
    cli_version = json.loads((ROOT / "node_modules/@tauri-apps/cli/package.json").read_text())["version"]
    windows = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text()).get("bundle", {}).get("windows", {})
    if channel != "stable":
        overlay = json.loads((ROOT / f"src-tauri/tauri.{channel}.conf.json").read_text())
        windows = {**windows, **overlay.get("bundle", {}).get("windows", {})}
    plan = {"channel": channel, "version": version, "candidate_sha256": digest,
            "unbundled_binary_sha256": hashlib.sha256(binary).hexdigest(),
            "binary_sha256": expected_nsis_application_hash(binary, cli_version, windows),
            "binary_reference": "tauri-cli-2.11.4 exact NSIS marker patch",
            "previous": {}}
    for other, product in PRODUCTS.items():
        release = previous_release(rows, other, candidate_tag if other == channel else "")
        previous_version = release["tag_name"][1:]
        previous_name = f'{product.replace(" ", ".")}_{previous_version}_x64-setup.exe'
        exe = root / f"previous-{other}.exe"
        sig = root / f"previous-{other}.sig"
        github.asset(release, previous_name, exe)
        github.asset(release, previous_name + ".sig", sig)
        verify_installer(exe, sig)
        capabilities = github.installer_capabilities(release["tag_name"], other)
        if not any(capabilities[k] for k in ("supports_user_baseline", "supports_machine_baseline")):
            raise ValueError(f"Prior {other} installer has no proven unattended scope selection; cannot skip")
        if other != channel and not capabilities["supports_machine_baseline"]:
            raise ValueError(f"Prior {other} installer is user-only; cannot construct the required native machine-scope isolation fixture")
        plan["previous"][other] = {"tag": release["tag_name"], "sha256": sha256(exe),
                                   **capabilities}
    (root / "plan.json").write_text(json.dumps(plan, indent=2), encoding="utf-8")
    if provenance is not None:
        # Parent PowerShell creates/protects this sibling directory BEFORE any
        # worker accounts exist. Never put authoritative provenance in plan.json.
        with evidence_path.open("x", encoding="utf-8") as stream:
            json.dump(provenance, stream, indent=2)


def recheck(evidence_path: Path, release_id: str, expected_tag: str) -> Path:
    evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
    if (evidence["schema"] != 1 or evidence["repository"] != os.environ["GITHUB_REPOSITORY"]
            or evidence["release_id"] != int(release_id) or evidence["tag"] != expected_tag
            or set(evidence["assets"]) != {"installer", "signature", "manifest"}):
        raise ValueError("Controller provenance does not match publication target")
    github = GitHub(evidence["repository"], os.environ["GH_TOKEN"])
    release = github.get(f"/releases/{int(release_id)}")
    if (release.get("draft") is not True or int(release["id"]) != evidence["release_id"]
            or release["tag_name"] != evidence["tag"]):
        raise ValueError("Final release is no longer the same draft/tag")
    with tempfile.TemporaryDirectory(prefix="recheck-", dir=evidence_path.parent) as temporary:
        root = Path(temporary)
        for role, expected in evidence["assets"].items():
            if asset_identity(release, expected["name"]) != {k: expected[k] for k in ("id", "name", "size")}:
                raise ValueError(f"Draft asset identity changed during native matrix: {role}")
            github.asset(release, expected["name"], root / role)
            if sha256(root / role) != expected["sha256"]:
                raise ValueError(f"Draft asset bytes changed during native matrix: {role}")
        config = root / "verifier-config.json"
        config.write_text(json.dumps({"plugins": {"updater": {"pubkey": evidence["updater_pubkey"]}}}), encoding="utf-8")
        verify_installer(root / "installer", root / "signature", config)
        # Public feed consumes this controller-only verified readback, not a
        # potentially worker-modified workspace uploaded-latest.json.
        manifest = evidence_path.parent / "rechecked-latest.json"
        with manifest.open("xb") as stream:
            stream.write((root / "manifest").read_bytes())
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path)
    parser.add_argument("--channel", choices=PRODUCTS)
    parser.add_argument("--version")
    parser.add_argument("--release-id")
    parser.add_argument("--evidence", type=Path)
    parser.add_argument("--recheck", type=Path)
    parser.add_argument("--expected-tag")
    arguments = parser.parse_args()
    if arguments.recheck:
        if not arguments.release_id or not arguments.expected_tag:
            parser.error("--recheck requires --release-id and --expected-tag")
        manifest = recheck(arguments.recheck, arguments.release_id, arguments.expected_tag)
        if os.environ.get("GITHUB_OUTPUT"):
            with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as stream:
                stream.write(f"passed=true\nmanifest_path={manifest}\n")
        print("PASS: final draft IDs, payload digests and cryptographic signature rechecked")
    else:
        if not arguments.root or not arguments.channel or not arguments.version:
            parser.error("preparation requires --root, --channel and --version")
        prepare(arguments.root, arguments.channel, arguments.version, arguments.release_id, arguments.evidence)
