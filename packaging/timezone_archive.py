"""Pack an owned PyInstaller bundle's unchanged tzdata package reproducibly."""
from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
import shutil
import tempfile
import zipfile


def pack(bundle: Path) -> dict:
    bundle = bundle.resolve(strict=True)
    internal = bundle / "_internal"
    package = internal / "tzdata"
    if not (bundle / "cellxplorer-backend.exe").is_file():
        raise ValueError("Expected an owned CellXplorer backend bundle")
    if internal.is_symlink() or package.is_symlink() or not package.is_dir():
        raise ValueError("Expected a real loose tzdata package in _internal")
    if not package.resolve().is_relative_to(bundle):
        raise ValueError("Timezone package escapes the backend bundle")
    paths = sorted(package.rglob("*"))
    if any(p.is_symlink() or p.is_junction() for p in [internal, package, *paths]):
        raise ValueError("Timezone package must not contain links or junctions")
    files = [p for p in paths if p.is_file()]
    members = {p.relative_to(internal).as_posix(): p for p in files}
    if not {"tzdata/__init__.py", "tzdata/zoneinfo/__init__.py", "tzdata/zones", "tzdata/zoneinfo/UTC"}.issubset(members):
        raise ValueError("Incomplete timezone package")
    archive = internal / "tzdata.zip"
    with tempfile.NamedTemporaryFile(dir=internal, suffix=".zip", delete=False) as temporary:
        staged = Path(temporary.name)
    try:
        with zipfile.ZipFile(staged, "w", compression=zipfile.ZIP_DEFLATED) as output:
            for name in sorted(members):
                path = members[name]
                entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                entry.create_system = 3
                entry.compress_type = zipfile.ZIP_DEFLATED
                entry.external_attr = 0o100644 << 16
                output.writestr(entry, path.read_bytes())
        with zipfile.ZipFile(staged) as check:
            if set(check.namelist()) != set(members):
                raise ValueError("Timezone archive membership mismatch")
            for name, path in members.items():
                if check.read(name) != path.read_bytes():
                    raise ValueError(f"Timezone archive changed resource bytes: {name}")
        staged.replace(archive)
        # Only the validated package subtree in this explicitly supplied generated
        # bundle is removed, after every archived resource has matched byte-for-byte.
        shutil.rmtree(package)
    finally:
        staged.unlink(missing_ok=True)
    return {"archive": str(archive), "files_replaced": len(files),
            "archive_bytes": archive.stat().st_size,
            "sha256": hashlib.sha256(archive.read_bytes()).hexdigest()}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    import json
    print(json.dumps(pack(parser.parse_args().bundle), indent=2))
