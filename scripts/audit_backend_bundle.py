"""Inventory a clean frozen bundle and reject development-only Arrow payloads."""
from __future__ import annotations

import argparse
from collections import defaultdict
import hashlib
import json
from pathlib import Path

SDK_SUFFIXES = {".h", ".hpp", ".cc", ".lib", ".pxd", ".pxi", ".pyx", ".pyi", ".cmake"}
UNUSED_OPTIONALS = {"scipy", "scipy.libs", "matplotlib", "IPython", "PIL", "psycopg", "psycopg2", "pymysql", "MySQLdb", "pytest"}
BUILD_ONLY_ROOTS = {"setuptools", "distutils", "_distutils_hack"}


def inventory(root: Path) -> dict:
    components: dict[str, dict] = defaultdict(lambda: {"files": 0, "bytes": 0, "small_files": 0})
    files = []
    for file in sorted(root.rglob("*")):
        if not file.is_file():
            continue
        relative = file.relative_to(root).as_posix()
        component = relative.split("/")[1] if relative.startswith("_internal/") else file.name
        data = file.read_bytes()
        files.append({"path": relative, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
        components[component]["files"] += 1
        components[component]["bytes"] += len(data)
        components[component]["small_files"] += len(data) <= 16384
    report = {"files": len(files), "bytes": sum(f["bytes"] for f in files),
              "components": dict(sorted(components.items())), "inventory": files}
    manifest = root / '_internal/tcl-resources.json'
    if manifest.is_file():
        report['tcl_resources'] = json.loads(manifest.read_text(encoding='utf-8'))
    return report


def validate(report: dict) -> None:
    if report["files"] == 0:
        raise ValueError("Empty backend payload")
    paths = {row["path"] for row in report["inventory"]}
    for required in ["cellxplorer-backend.exe", "_internal/app/assets/plotly.min.js", "_internal/_tkinter.pyd", "_internal/tzdata.zip"]:
        if required not in paths:
            raise ValueError(f"Required runtime payload missing: {required}")
    if '_internal/_tcl_data/tzdata.tcl' not in paths:
        resources = report.get('tcl_resources', {})
        libraries = resources.get('libraries', {})
        if resources.get('mode') != 'embedded-zipfs' or len(libraries) != 2 or '_internal/tcl-resources.json' not in paths:
            raise ValueError('Required archived Tcl timezone resources missing')
        inventory_hashes = {row['path']: row.get('sha256') for row in report['inventory']}
        for name, sha in libraries.items():
            if Path(name).name != name or not name.lower().endswith('.dll') or inventory_hashes.get('_internal/' + name) != sha:
                raise ValueError('Embedded Tcl/Tk library manifest does not match payload')
        if any(p.startswith(('_internal/_tcl_data/', '_internal/_tk_data/')) for p in paths):
            raise ValueError('Loose Tcl/Tk resources mixed with embedded archives')
    for package in ["pyarrow", "numpy", "pandas", "tzdata.zip"]:
        if package not in report["components"]:
            raise ValueError(f"Required runtime component missing: {package}")
    for row in report["inventory"]:
        if row["path"].startswith("_internal/tzdata/"):
            raise ValueError("Loose timezone package duplicates archive-backed data")
        if row['path'].startswith('_internal/_tcl_data/tzdata/'):
            raise ValueError('Loose Tcl timezone scripts duplicate archived resources')
        parts = Path(row["path"]).parts
        if len(parts) > 1 and parts[0] == "_internal" and parts[1] in UNUSED_OPTIONALS | BUILD_ONLY_ROOTS:
            raise ValueError(f"Unused optional dependency leaked into runtime: {row['path']}")
        if row["path"].startswith("_internal/pyarrow/"):
            arrow_path = Path(row["path"]).relative_to("_internal/pyarrow")
            if arrow_path.name in {'arrow_flight.dll', 'arrow_python_flight.dll', 'arrow_substrait.dll'} or arrow_path.name.startswith(('_flight.', '_substrait.', '_pyarrow_cpp_tests.')):
                raise ValueError(f'Unused Arrow component leaked into runtime: {arrow_path}')
            if arrow_path.suffix in SDK_SUFFIXES or any(part in {"include", "includes", "src", "tests"} for part in arrow_path.parts):
                raise ValueError(f"Development-only Arrow data leaked into runtime: {row['path']}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--validate", action="store_true")
    args = parser.parse_args()
    if not args.root.is_dir():
        raise SystemExit(f"Backend directory missing: {args.root}")
    report = inventory(args.root)
    if args.validate:
        validate(report)
    if args.output:
        args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key != "inventory"}, indent=2))


if __name__ == "__main__":
    main()
