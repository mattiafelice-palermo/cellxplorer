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

from .services.app_channel import resolve_data_root

APP_DATA_DIR = resolve_data_root(os.environ, Path.home())
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
APP_VERSION = "0.22.0-beta.3"
INSTALL_INSTANCE_ID = os.environ.get("CELLXPLORER_INSTALL_INSTANCE_ID", "").strip() or None

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
# 1.6.0: performance only — the CV-per-cycle walk indexes numpy arrays instead of
#        building a pandas sub-frame per (cycle, step) group, and status
#        predicates are evaluated over the distinct status values rather than
#        every row. Outputs were verified bit-identical (atol=0) against 1.5.0 on
#        the golden corpus and on a full real library. The bump is precautionary:
#        it costs one recompute and removes any chance of a cached value produced
#        by an edge-case path we could not exercise.
# 1.6.1: multi-source dense cycle stitching (Spec 034.1) — global cycle mapping uses
#        observed local labels only; stitched frames add provenance columns. Per-file
#        per-cycle parquet outputs are unchanged, but analysis provenance must not reuse
#        pre-034.1 global cycle numbers for gapped or multi-source selections.
CALC_VERSION = "1.6.1"

FRONTEND_DIST = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"
