"""Inventory a clean frozen bundle and reject development-only Arrow payloads."""
from __future__ import annotations

import argparse
from collections import defaultdict
import hashlib
import json
from pathlib import Path

SDK_SUFFIXES = {".h", ".hpp", ".cc", ".lib", ".pxd", ".pxi", ".pyx", ".pyi", ".cmake"}
UNUSED_OPTIONALS = {"scipy", "scipy.libs", "matplotlib", "IPython", "PIL", "psycopg", "psycopg2", "pymysql", "MySQLdb", "pytest"}


def inventory(root: Path) -> dict:
    components: dict[str, dict] = defaultdict(lambda: {"files": 0, "bytes": 0})
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
    return {"files": len(files), "bytes": sum(f["bytes"] for f in files),
            "components": dict(sorted(components.items())), "inventory": files}


def validate(report: dict) -> None:
    if report["files"] == 0:
        raise ValueError("Empty backend payload")
    paths = {row["path"] for row in report["inventory"]}
    for required in ["cellxplorer-backend.exe", "_internal/app/assets/plotly.min.js", "_internal/_tkinter.pyd"]:
        if required not in paths:
            raise ValueError(f"Required runtime payload missing: {required}")
    for package in ["pyarrow", "numpy", "pandas", "tzdata"]:
        if package not in report["components"]:
            raise ValueError(f"Required runtime component missing: {package}")
    for row in report["inventory"]:
        parts = Path(row["path"]).parts
        if len(parts) > 1 and parts[0] == "_internal" and parts[1] in UNUSED_OPTIONALS:
            raise ValueError(f"Unused optional dependency leaked into runtime: {row['path']}")
        if row["path"].startswith("_internal/pyarrow/"):
            arrow_path = Path(row["path"]).relative_to("_internal/pyarrow")
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
