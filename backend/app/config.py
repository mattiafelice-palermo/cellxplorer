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
LOG_DIR = APP_DATA_DIR / "logs"
BACKUP_DIR = APP_DATA_DIR / "backups"
DB_PATH = APP_DATA_DIR / "cellxplorer.db"

APP_DATA_DIR.mkdir(parents=True, exist_ok=True)
CACHE_DIR.mkdir(parents=True, exist_ok=True)
IMPORT_DIR.mkdir(parents=True, exist_ok=True)
LOG_DIR.mkdir(parents=True, exist_ok=True)

DB_URL = f"sqlite:///{DB_PATH.as_posix()}"
APP_VERSION = "0.15.0"

# Version of our derived per-cycle calculation code. Bump when the
# calculation in services/calc.py changes meaning.
# 1.1.0: vectorized per_cycle; mean charge/discharge voltages can differ
#        from 1.0.0 in the 7th decimal (float32 summation order).
# 1.2.0: added cycle_duration_h, charge_time_h, discharge_time_h.
# 1.3.0: added charge/discharge first/last voltage endpoints and
#        render-time polarization.
# 1.4.0: added CV-charge time, capacity, fraction, and event counts.
# 1.5.0: capacity and energy are summed per step instead of taking a per-cycle
#        maximum. Neware's counters reset at every step boundary, so the old
#        maximum kept only the largest step of a phase — a CC+CV charge lost its
#        CV portion, which understated charge capacity and pushed coulombic
#        efficiency above 100%.
CALC_VERSION = "1.5.0"

FRONTEND_DIST = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"
