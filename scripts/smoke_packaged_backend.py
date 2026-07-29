"""Start the packaged backend sidecar and prove it answers the API.

`release.yml` used to check only that the sidecar *file* existed. That cannot catch
the failure this script exists for: release 0.17.0 shipped a sidecar that was built
fine and then died during import, because CI resolved a Starlette without
`add_event_handler`. Every user saw "Could not contact the CellXplorer backend".

So this runs the real frozen binary — not `app.main` under the CI interpreter,
which would have passed that release — with the same environment Tauri gives it,
and fails loudly with the child's own traceback if it cannot serve.

HTTP polling is deliberately `urllib` and not `httpx`: adding httpx to
`requirements.txt` would bundle it into the sidecar, and a dev-only requirements
file is one more thing that can drift. That trap has already broken this repo's
CI once (`tests/test_app_startup.py`).

    python scripts/smoke_packaged_backend.py [--sidecar PATH] [--timeout SECONDS]
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SIDECAR = (
    ROOT / "src-tauri" / "binaries" / "cellxplorer-backend-x86_64-pc-windows-msvc.exe"
)
DEFAULT_TIMEOUT = 90.0


def find_free_port() -> int:
    """Bind port 0, note what we got, release it.

    Same approach as `available_backend_port()` in src-tauri/src/main.rs, so the
    smoke test races for a port exactly the way the shipped app does.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def child_environment(port: int, data_dir: Path, app_version: str) -> dict[str, str]:
    """The environment Tauri hands the sidecar.

    Mirrors the `.env(...)` chain in src-tauri/src/main.rs. A smoke test that
    launched the binary differently from the shell would prove less than it looks.
    """
    env = dict(os.environ)
    env.update(
        {
            "CELLXPLORER_PORT": str(port),
            "CELLXPLORER_DATA": str(data_dir),
            "CELLXPLORER_APP_VERSION": app_version,
            "CELLXPLORER_CHANNEL": "stable",
            "CELLXPLORER_STARTUP_MODE": "smoke-test",
        }
    )
    # The sidecar must not inherit a developer's real data root.
    env.pop("CELLXPLORER_INSTALL_INSTANCE_ID", None)
    return env


def health_is_ready(payload: object) -> bool:
    """True when /api/health reports a usable backend."""
    return isinstance(payload, dict) and payload.get("status") in {"ok", "degraded"}


def database_is_compatible(payload: object) -> bool:
    """True when the sidecar created/opened a usable database on first run."""
    if not isinstance(payload, dict):
        return False
    return bool(payload.get("compatible")) and bool(payload.get("schema_revision"))


def _get_json(url: str, timeout: float = 5.0) -> object:
    with urllib.request.urlopen(url, timeout=timeout) as response:  # noqa: S310 — loopback only
        return json.loads(response.read().decode("utf-8"))


def _expected_app_version() -> str:
    sys.path.insert(0, str(ROOT / "backend"))
    from app.config import APP_VERSION  # noqa: PLC0415 — needs the path set first

    return APP_VERSION


def _terminate(process: subprocess.Popen) -> None:
    """Kill the whole tree: a frozen uvicorn leaves children holding the port."""
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(process.pid)],
            capture_output=True,
            check=False,
        )
    else:
        process.terminate()
    try:
        process.wait(timeout=20)
    except subprocess.TimeoutExpired:
        process.kill()


def run_smoke_test(sidecar: Path, timeout: float) -> int:
    if not sidecar.is_file():
        print(f"FAIL: no sidecar at {sidecar}", file=sys.stderr)
        return 1

    app_version = _expected_app_version()
    port = find_free_port()
    data_dir = Path(tempfile.mkdtemp(prefix="cellxplorer-smoke-"))
    base = f"http://127.0.0.1:{port}"
    print(f"Starting {sidecar.name} on port {port} with CELLXPLORER_DATA={data_dir}")

    process = subprocess.Popen(
        [str(sidecar)],
        env=child_environment(port, data_dir, app_version),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        cwd=str(ROOT),
    )

    def fail(message: str) -> int:
        sys.stdout.flush()  # keep the progress lines above the failure in CI logs
        print(f"FAIL: {message}", file=sys.stderr)
        _terminate(process)
        # The child's own output is the whole point of this test.
        try:
            output = process.stdout.read() if process.stdout else ""
        except Exception:  # noqa: BLE001 — best effort while already failing
            output = ""
        if output.strip():
            print("\n--- sidecar output ---", file=sys.stderr)
            print(output.strip(), file=sys.stderr)
            print("--- end sidecar output ---", file=sys.stderr)
        else:
            print("(the sidecar produced no output)", file=sys.stderr)
        return 1

    try:
        deadline = time.monotonic() + timeout
        health: object = None
        while time.monotonic() < deadline:
            if process.poll() is not None:
                return fail(f"the sidecar exited with code {process.returncode} before serving")
            try:
                health = _get_json(f"{base}/api/health", timeout=3.0)
                break
            except (urllib.error.URLError, OSError, json.JSONDecodeError, TimeoutError):
                time.sleep(0.5)
        else:
            return fail(f"no response from {base}/api/health within {timeout:.0f}s")

        if not health_is_ready(health):
            return fail(f"/api/health reported {health!r}")
        print(f"  /api/health           {health}")

        status = _get_json(f"{base}/api/database/status")
        if not database_is_compatible(status):
            return fail(f"/api/database/status reported an unusable database: {status!r}")
        print(f"  /api/database/status  compatible, revision {status.get('schema_revision')}")

        meta = _get_json(f"{base}/api/meta")
        if not isinstance(meta, dict):
            return fail(f"/api/meta returned {meta!r}")
        if meta.get("app_version") != app_version:
            # APP_VERSION is baked in at PyInstaller time, so a mismatch means the
            # binary predates the working tree. `build-app.ps1` can skip PyInstaller
            # when its fingerprint stamp looks current, so this is the check that
            # stops a stale sidecar being shipped. Rebuild with -ForceBackend.
            return fail(
                f"the sidecar reports app_version {meta.get('app_version')!r} but this tree is "
                f"{app_version!r} — the binary is stale; rebuild it with "
                f"`.\\scripts\\build-app.ps1 -SkipInstall -SkipFrontend -SkipInstaller "
                f"-ForceBackend`"
            )
        if not meta.get("calc_version"):
            return fail("/api/meta did not report a calc_version")
        print(f"  /api/meta             {app_version}, calc {meta.get('calc_version')}")
    finally:
        _terminate(process)
        shutil.rmtree(data_dir, ignore_errors=True)

    print("PASS: the packaged backend started and served the API")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--sidecar", type=Path, default=DEFAULT_SIDECAR)
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    args = parser.parse_args(argv)
    return run_smoke_test(args.sidecar.resolve(), args.timeout)


if __name__ == "__main__":
    raise SystemExit(main())
