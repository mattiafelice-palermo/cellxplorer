"""Parquet cache, keyed by (file hash, parser version, calc version).

Caches are regenerable artifacts, never user-facing entities. Old versions
are kept on disk so previously computed analyses stay reproducible.

Layout:  CACHE_DIR/<hash[:2]>/<hash>/raw__p<parser>.parquet
         CACHE_DIR/<hash[:2]>/<hash>/cycles__p<parser>__c<calc>.parquet
"""
from __future__ import annotations

import logging
import re
from pathlib import Path

import pandas as pd

from ..config import CACHE_DIR, CALC_VERSION
from . import calc, parsing

logger = logging.getLogger(__name__)


def _safe(v: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "_", v)


def _dir(file_hash: str) -> Path:
    return CACHE_DIR / file_hash[:2] / file_hash


def raw_path(file_hash: str, parser_version: str = parsing.PARSER_VERSION) -> Path:
    return _dir(file_hash) / f"raw__p{_safe(parser_version)}.parquet"


def cycles_path(
    file_hash: str,
    parser_version: str = parsing.PARSER_VERSION,
    calc_version: str = CALC_VERSION,
) -> Path:
    return _dir(file_hash) / f"cycles__p{_safe(parser_version)}__c{_safe(calc_version)}.parquet"


def has_cycles(file_hash: str, parser_version: str, calc_version: str) -> bool:
    return cycles_path(file_hash, parser_version, calc_version).exists()


def build(file_hash: str, source_path: str | Path) -> dict:
    """Parse source file and (re)build raw + cycles caches at the CURRENT
    parser/calc versions. Returns {rows, cycles, parser_version, calc_version}."""
    raw = parsing.parse_timeseries(source_path)
    d = _dir(file_hash)
    d.mkdir(parents=True, exist_ok=True)
    raw.to_parquet(raw_path(file_hash), index=False)
    cycles = calc.per_cycle(raw)
    cycles.to_parquet(cycles_path(file_hash), index=False)
    return {
        "rows": len(raw),
        "cycles": len(cycles),
        "parser_version": parsing.PARSER_VERSION,
        "calc_version": CALC_VERSION,
    }


def load_cycles(
    file_hash: str, parser_version: str, calc_version: str
) -> pd.DataFrame | None:
    """Load per-cycle cache at EXACT versions (reproducibility). If the
    cycles file is missing but a raw cache at that parser version exists and
    calc_version is current, derive and store it."""
    p = cycles_path(file_hash, parser_version, calc_version)
    if p.exists():
        return pd.read_parquet(p)
    rp = raw_path(file_hash, parser_version)
    if rp.exists() and calc_version == CALC_VERSION:
        cycles = calc.per_cycle(pd.read_parquet(rp))
        cycles.to_parquet(p, index=False)
        return cycles
    return None


def load_raw(file_hash: str, parser_version: str) -> pd.DataFrame | None:
    p = raw_path(file_hash, parser_version)
    return pd.read_parquet(p) if p.exists() else None


def available_versions(file_hash: str) -> list[dict]:
    """List cached (parser, calc) version pairs for a file."""
    d = _dir(file_hash)
    out = []
    if d.exists():
        for f in d.glob("cycles__p*__c*.parquet"):
            m = re.match(r"cycles__p(.+)__c(.+)\.parquet", f.name)
            if m:
                out.append({"parser_version": m.group(1), "calc_version": m.group(2)})
    return out
