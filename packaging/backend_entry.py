from __future__ import annotations

import multiprocessing
import os
import sys
import traceback
import logging
from pathlib import Path

import uvicorn


def _ensure_source_backend_on_path() -> None:
    if getattr(sys, "frozen", False):
        return
    root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(root / "backend"))


def _crash_log_path() -> Path:
    from app.services.app_channel import resolve_data_root

    base = resolve_data_root(os.environ, Path.home())
    return base / "logs" / "backend-crash.log"


def _write_crash_log() -> None:
    try:
        path = _crash_log_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(traceback.format_exc(), encoding="utf-8")
    except Exception:
        pass


def _configure_logging() -> None:
    try:
        log_path = _crash_log_path().parent / "backend.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        logging.basicConfig(
            filename=log_path,
            level=logging.INFO,
            format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        )
    except Exception:
        logging.basicConfig(level=logging.CRITICAL)


def _backend_port() -> int:
    try:
        port = int(os.environ.get("CELLXPLORER_PORT", "8642"))
    except ValueError:
        return 8642
    return port if 1 <= port <= 65535 else 8642


def main() -> int:
    multiprocessing.freeze_support()
    try:
        _configure_logging()
        _ensure_source_backend_on_path()
        from app.services.app_channel import validate_packaged_channel_at_startup

        validate_packaged_channel_at_startup()
        from app.main import app

        if os.environ.get("CELLXPLORER_BACKEND_SMOKE") == "1":
            return 0

        uvicorn.run(
            app,
            host="127.0.0.1",
            port=_backend_port(),
            log_level="info",
            log_config=None,
            access_log=False,
            # Never import the websocket/httptools machinery: unused, and their
            # import cost ~0.5 s of cold start (spec 032). Explicit so the saving
            # holds even in an environment where the extras happen to be installed.
            ws="none",
            http="h11",
        )
        return 0
    except Exception:
        _write_crash_log()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
