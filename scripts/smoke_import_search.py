"""Verify frozen search-worker spawn, persisted settings, rebuild and recovery in disposable data."""
from __future__ import annotations
import argparse
from contextlib import closing
import json
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path
from smoke_packaged_backend import child_environment, _expected_app_version, _terminate

ROOT = Path(__file__).resolve().parents[1]

def run(sidecar: Path):
    with tempfile.TemporaryDirectory(prefix="cellxplorer-search-smoke-") as temporary:
        data = Path(temporary)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        base = f"http://127.0.0.1:{port}/api"
        env = child_environment(port, data, _expected_app_version())
        env["CELLXPLORER_CHANNEL"] = "alpha"
        process = None
        def request(path, value=None, method=None):
            req = urllib.request.Request(base+path, data=json.dumps(value).encode() if value is not None else None,
                headers={"Content-Type": "application/json"}, method=method)
            with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=10) as response:
                return json.load(response)
        def launch():
            nonlocal process
            process = subprocess.Popen([str(sidecar)], env=env, creationflags=subprocess.CREATE_NO_WINDOW)
            deadline = time.monotonic()+60
            while time.monotonic()<deadline:
                try:
                    request("/health")
                    return
                except Exception:
                    if process.poll() is not None: raise RuntimeError("packaged backend exited")
                    time.sleep(.1)
            raise RuntimeError("packaged backend startup timed out")
        def wait_ready():
            deadline = time.monotonic()+60
            while time.monotonic()<deadline:
                states=request("/import-search/settings")["roots"]
                if states and states[0]["status"]=="ready":return states[0]
                time.sleep(.1)
            raise RuntimeError(f"frozen scan did not complete: {states}")
        try:
            launch()
            settings=request("/import-search/settings")["config"]
            settings["roots"]=[dict(id="fixture",path=str(ROOT/"tests/fixtures/golden_analysis/sources"),enabled=True)]
            settings["refresh_hours"]=0
            # Keep the server-validated root defaults as the recovery baseline.
            settings=request("/import-search/settings",settings,"PUT")["config"]
            expected_roots=settings["roots"]
            print(f"Normalized roots after PUT: {json.dumps(expected_roots, sort_keys=True)}")
            assert wait_ready()["count"]==4
            assert request("/import-search/results?q=715")["total"]==2
            settings["paused"]=True
            settings=request("/import-search/settings",settings,"PUT")["config"]
            _terminate(process);process=None
            launch()
            settings=request("/import-search/settings")["config"]
            assert settings["paused"]
            assert settings["roots"]==expected_roots, (expected_roots,settings["roots"])
            assert request("/import-search/results?q=715")["total"]==2
            settings["paused"]=False
            settings=request("/import-search/settings",settings,"PUT")["config"]
            wait_ready()
            request("/import-search/rebuild",{},"POST")
            assert wait_ready()["count"]==4
            _terminate(process);process=None
            catalog=data/"search-index/catalog.sqlite"
            with closing(sqlite3.connect(catalog)) as db:
                db.execute("PRAGMA user_version=999")
                db.commit()
            launch()
            assert wait_ready()["count"]==4
            recovered_roots=request("/import-search/settings")["config"]["roots"]
            assert recovered_roots==expected_roots, (expected_roots,recovered_roots)
            print(f"Normalized roots after incompatible-catalog recovery: {json.dumps(recovered_roots, sort_keys=True)}")
            assert request("/cells")==[]
            _terminate(process);process=None
            catalog.write_bytes(b"damaged derived search catalog")
            launch()
            assert wait_ready()["count"]==4
            recovered_roots=request("/import-search/settings")["config"]["roots"]
            assert recovered_roots==expected_roots, (expected_roots,recovered_roots)
            request("/import-search/rebuild",{},"POST")
            assert wait_ready()["count"]==4
            print("PASS: frozen worker scan, metadata query, pause/restart, rebuild, incompatible/corrupt catalog recovery; scientific library preserved")
        finally:
            if process is not None:_terminate(process)

if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--sidecar",type=Path,default=ROOT/"dist/cellxplorer-backend/cellxplorer-backend.exe")
    args=parser.parse_args()
    run(args.sidecar.resolve())
