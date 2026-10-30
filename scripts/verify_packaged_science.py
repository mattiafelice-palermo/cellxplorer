"""Compare actual frozen scientific/runtime behavior with the same source tree."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def create_fixtures(root: Path) -> None:
    sys.path.insert(0, str(ROOT))
    from tests.test_neware_excel import _write_synthetic_workbook
    from tests.biologic_mpr_fixture import encode_gcpl_settings, write_gcpl_mpr
    from tests.test_biologic_gcpl import _row

    fixtures = root / "fixtures"
    fixtures.mkdir()
    shutil.copyfile(ROOT / "tests/fixtures/golden_analysis/sources/cycles_time_steps.ndax", fixtures / "neware.ndax")
    _write_synthetic_workbook(fixtures / "neware.xlsx")
    rows = [_row(0.0, ns=1, control=1.0, ns_changed=True), _row(1.0, ns=1, control=1.0, q_mAh=1.0, dq_mAh=1.0),
            _row(2.0, ns=2, control=-1.0), _row(3.0, ns=2, control=-1.0, q_mAh=-1.0, dq_mAh=-1.0, ns_changed=True)]
    settings = encode_gcpl_settings([{"set_i_c": 0, "current": 0.0, "rest_duration_s": 1.0},
                                    {"set_i_c": 1, "current": 1.0, "c_rate": 1.0},
                                    {"set_i_c": 1, "current": 1.0, "c_rate": 1.0, "sign_code": 1, "goto_step": 1, "repeat_count": 1}], technique_id=0x04)
    write_gcpl_mpr(fixtures / "biologic.mpr", rows, settings_payload=settings)
    (fixtures / "manifest.json").write_text(json.dumps(["neware.ndax", "neware.xlsx", "biologic.mpr"]), encoding="utf-8")


def run(command: list[str], root: Path, environment: dict[str, str]) -> dict:
    result_file = root / "runtime-verification.json"
    result_file.unlink(missing_ok=True)
    result = subprocess.run(command, cwd=ROOT, env=environment, capture_output=True, timeout=120)
    if result.returncode or not result_file.is_file():
        crash = root / "logs/backend-crash.log"
        raise RuntimeError(f"Runtime verification failed ({result.returncode}): {result.stderr!r}\n" + (crash.read_text(encoding="utf-8") if crash.exists() else "No result/crash log"))
    return json.loads(result_file.read_text(encoding="utf-8"))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sidecar", type=Path, default=ROOT / "src-tauri/binaries/backend/cellxplorer-backend.exe")
    parser.add_argument("--python", default=sys.executable)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="cellxplorer-runtime-") as directory:
        root = Path(directory).resolve()
        # Set BEFORE importing fixture helpers and their app modules. No real
        # database, cache or profile is opened by either source or frozen process.
        os.environ["CELLXPLORER_DATA"] = str(root)
        create_fixtures(root)
        version = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
        environment = {**os.environ, "CELLXPLORER_DATA": str(root), "CELLXPLORER_BACKEND_SMOKE": "scientific",
                       "CELLXPLORER_CHANNEL": "stable", "CELLXPLORER_APP_VERSION": version, "CELLXPLORER_STARTUP_MODE": "smoke-test"}
        environment.pop("CELLXPLORER_INSTALL_INSTANCE_ID", None)
        expected = run([args.python, str(ROOT / "packaging/backend_entry.py")], root, environment)
        actual = run([str(args.sidecar.resolve())], root, environment)
        if actual != expected:
            raise AssertionError("Frozen scientific/Parquet/asset/timezone/file-picker result differs from source")
        print("PASS: actual frozen Neware NDAX/Excel and BioLogic raw/cycle parity, Parquet/zstd, NumPy/Arrow compute, CSV, Tcl/file-picker import, timezone and portable-report asset parity")


if __name__ == "__main__":
    main()
