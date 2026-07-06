"""Application configuration: local data directory layout.

Everything Cellxplorer persists lives under APP_DATA_DIR:
  - cellxplorer.db   SQLite database (the canonical Library)
  - cache/           Parquet caches keyed by (file hash, parser/calc version)

Raw Neware files are NEVER copied here; they stay wherever the user keeps
them (e.g. a network drive) and are referenced by content hash.
"""
from __future__ import annotations

import os
from pathlib import Path

APP_DATA_DIR = Path(os.environ.get("CELLXPLORER_DATA", Path.home() / ".cellxplorer"))
CACHE_DIR = APP_DATA_DIR / "cache"
IMPORT_DIR = APP_DATA_DIR / "imports"
DB_PATH = APP_DATA_DIR / "cellxplorer.db"

APP_DATA_DIR.mkdir(parents=True, exist_ok=True)
CACHE_DIR.mkdir(parents=True, exist_ok=True)
IMPORT_DIR.mkdir(parents=True, exist_ok=True)

DB_URL = f"sqlite:///{DB_PATH.as_posix()}"

# Version of our derived per-cycle calculation code. Bump when the
# calculation in services/calc.py changes meaning.
CALC_VERSION = "1.0.0"

FRONTEND_DIST = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"
