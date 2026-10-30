"""Build the windowless candidate-owned installer helper and embed its digest."""
from __future__ import annotations

import hashlib
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "scripts/installer_helper/Cargo.toml"
TARGET = ROOT / "src-tauri/target/installer-helper"


def main() -> None:
    subprocess.run([
        "cargo", "build", "--release", "--locked", "--manifest-path", str(MANIFEST),
        "--bin", "cellxplorer-installer-helper", "--target-dir", str(TARGET),
    ], check=True)
    source = TARGET / "release/cellxplorer-installer-helper.exe"
    destination = ROOT / "src-tauri/binaries/cellxplorer-installer-helper.exe"
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    digest = hashlib.sha256(destination.read_bytes()).hexdigest()
    (destination.parent / "installer-helper.sha256.nsh").write_text(
        f'!define CX_INSTALLER_HELPER_SHA256 "{digest}"\n', encoding="ascii"
    )
    print(f"Staged GUI/asInvoker installer helper ({source.stat().st_size} bytes; SHA256 {digest})")


if __name__ == "__main__":
    main()
