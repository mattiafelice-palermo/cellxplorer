"""One-off fresh pip/uv dependency equivalence check; never use real app data."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
UV_VERSION = "0.13.6"
INDEX = "https://pypi.org/simple"


def normalize(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def validate_inventories(pip: dict[str, str], uv: dict[str, str], pins: dict[str, str]) -> None:
    if uv.get("uv") != UV_VERSION or "uv" in pip:
        raise ValueError("Only the exact pinned uv tool may differ")
    runtime = {name: version for name, version in uv.items() if name != "uv"}
    if pip != runtime:
        names = sorted(set(pip) | set(runtime))
        differences = {name: [pip.get(name), runtime.get(name)] for name in names if pip.get(name) != runtime.get(name)}
        raise ValueError(f"pip/uv distribution inventories differ: {differences}")
    for name, version in pins.items():
        if pip.get(name) != version:
            raise ValueError(f"Required pin not installed: {name}=={version}")


def pinned_requirements(paths: list[Path]) -> dict[str, str]:
    pins = {}
    for path in paths:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.split("#", 1)[0].strip()
            if not line:
                continue
            match = re.fullmatch(r"([\w.-]+)==([\w.+-]+)", line)
            if not match:
                raise ValueError(f"Unrecognized or unpinned requirement: {line}")
            name, version = normalize(match[1]), match[2]
            if name in pins and pins[name] != version:
                raise ValueError(f"Conflicting pin: {name}")
            pins[name] = version
    return pins


def run(args: list[str]) -> None:
    subprocess.run(args, cwd=ROOT, check=True, timeout=600)


def inventory(python: Path) -> dict[str, str]:
    code = "import importlib.metadata as m,json,re; print(json.dumps({re.sub(r'[-_.]+','-',d.metadata['Name']).lower():d.version for d in m.distributions()},sort_keys=True))"
    result = subprocess.run([str(python), "-c", code], check=True, capture_output=True, text=True, timeout=30)
    return json.loads(result.stdout)


def compare_environments(output: Path) -> None:
    report = {"verified": False, "python": sys.version, "phase": "requirements", "inventories": {}}
    try:
        requirements = [ROOT / "backend/requirements.txt", ROOT / "packaging/requirements-build.txt"]
        pins = pinned_requirements(requirements)
        report["pins"] = pins
        # Fresh unique roots only. No deletion, mutation or seeding of app state.
        scratch = Path(tempfile.mkdtemp(prefix="cx-ci-installer-compare-", dir=os.environ.get("RUNNER_TEMP")))
        environments = report["inventories"]
        for installer in ("pip", "uv"):
            environment = scratch / installer
            report["phase"] = f"{installer}: create environment"
            run([sys.executable, "-m", "venv", str(environment)])
            python = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
            report["phase"] = f"{installer}: upgrade pip"
            run([str(python), "-m", "pip", "install", "--index-url", INDEX, "--upgrade", "pip"])
            if installer == "pip":
                # Preserve the former workflow's two sequential resolver invocations.
                for requirement in requirements:
                    report["phase"] = f"pip: install {requirement.name} from {requirement.parent.name}"
                    run([str(python), "-m", "pip", "install", "--index-url", INDEX, "-r", str(requirement)])
            else:
                report["phase"] = "uv: install pinned tool"
                run([str(python), "-m", "pip", "install", "--index-url", INDEX, f"uv=={UV_VERSION}"])
                report["phase"] = "uv: resolve and install runtime/build dependencies"
                run([str(python), "-m", "uv", "pip", "install", "--system", "--python", str(python), "--default-index", INDEX,
                     "-r", str(requirements[0]), "-r", str(requirements[1])])
            report["phase"] = f"{installer}: pip check and inventory"
            run([str(python), "-m", "pip", "check"])
            environments[installer] = inventory(python)
        report["phase"] = "compare inventories and independent pins"
        validate_inventories(environments["pip"], environments["uv"], pins)
        report.update(verified=True, phase="complete")
        print(f"PASS: fresh pip/uv inventories match ({len(environments['pip'])} distributions plus pinned uv)")
    except Exception as exc:
        report["error"] = f"{type(exc).__name__}: {exc}"
        raise
    finally:
        output.write_text(json.dumps(report, indent=2), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    compare_environments(parser.parse_args().output)


if __name__ == "__main__":
    main()
