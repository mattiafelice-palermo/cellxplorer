"""Parquet cache, keyed by (file hash, parser version, calc version).

Caches are regenerable artifacts, never user-facing entities. Old versions
are kept on disk so previously computed analyses stay reproducible.

Layout:  CACHE_DIR/<hash[:2]>/<hash>/raw__p<parser>.parquet
         CACHE_DIR/<hash[:2]>/<hash>/cycles__p<parser>__c<calc>.parquet
"""
from __future__ import annotations

import logging
import os
import re
import threading
import uuid
from pathlib import Path

import pandas as pd

from ..config import CACHE_DIR, CALC_VERSION
from . import calc, parsing

logger = logging.getLogger(__name__)

# background (write-behind) cache writes, keyed by file hash — see
# build_write_behind(). Everything that reads or rebuilds a cache waits on
# any in-flight write for that hash first.
_pending_lock = threading.Lock()
_pending: dict[str, threading.Thread] = {}


def _wait_for_pending(file_hash: str) -> None:
    with _pending_lock:
        thread = _pending.get(file_hash)
    if thread is not None:
        thread.join()


def wait_for_pending(file_hash: str) -> None:
    """Block until any in-flight background cache write for this hash is
    done. Needed before handing work to OTHER processes (which cannot see
    this process's write threads); in-process readers wait automatically."""
    _wait_for_pending(file_hash)


def _write_atomic(df: pd.DataFrame, path: Path) -> None:
    """Write parquet via temp file + os.replace so concurrent readers never
    see a partially written cache."""
    tmp = path.with_name(f"{path.name}.tmp-{uuid.uuid4().hex}")
    try:
        df.to_parquet(tmp, index=False)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


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


def capacity_totals(cycles: pd.DataFrame | None) -> dict[str, float | None]:
    """Return the same aggregate capacities shown in the cell library."""

    def _sum(column: str) -> float | None:
        if cycles is None or column not in cycles.columns:
            return None
        values = pd.to_numeric(cycles[column], errors="coerce")
        total = values.sum(min_count=1)
        return None if pd.isna(total) else round(float(total), 6)

    return {
        "total_charge_capacity_mah": _sum("charge_capacity_mah"),
        "total_discharge_capacity_mah": _sum("discharge_capacity_mah"),
    }


def build(file_hash: str, source_path: str | Path, force: bool = False) -> dict:
    """Parse source file and (re)build raw + cycles caches at the CURRENT
    parser/calc versions. Returns {rows, cycles, parser_version, calc_version}.

    Idempotent: identical content (hash) at identical versions yields
    identical caches, so if both files already exist the parse is skipped
    (row/cycle counts come from Parquet metadata). Pass force=True to
    rebuild regardless, e.g. if a cache file is suspected corrupt."""
    _wait_for_pending(file_hash)
    rp, cp = raw_path(file_hash), cycles_path(file_hash)
    if not force and rp.exists() and cp.exists():
        import pyarrow.parquet as pq

        cycle_columns = [
            column
            for column in ("charge_capacity_mah", "discharge_capacity_mah")
            if column in pq.read_schema(cp).names
        ]
        totals = capacity_totals(pd.read_parquet(cp, columns=cycle_columns))
        return {
            "rows": pq.read_metadata(rp).num_rows,
            "cycles": pq.read_metadata(cp).num_rows,
            "parser_version": parsing.PARSER_VERSION,
            "calc_version": CALC_VERSION,
            "cached": True,
            **totals,
        }

    # A calculation-version bump does not require rereading the binary file:
    # reuse the parser-versioned raw cache and derive only the new cycle cache.
    raw = pd.read_parquet(rp) if rp.exists() and not force else parsing.parse_timeseries(source_path)
    d = _dir(file_hash)
    d.mkdir(parents=True, exist_ok=True)
    _write_atomic(raw, rp)
    cycles = calc.per_cycle(raw)
    _write_atomic(cycles, cp)
    return {
        "rows": len(raw),
        "cycles": len(cycles),
        "parser_version": parsing.PARSER_VERSION,
        "calc_version": CALC_VERSION,
        "cached": False,
        **capacity_totals(cycles),
    }


def build_write_behind(file_hash: str, source_path: str | Path) -> pd.DataFrame:
    """Parse now, return the per-cycle frame immediately, and write the
    raw + cycles Parquet caches on a background thread.

    This is the preview path: the caller gets plottable data as soon as the
    parse finishes instead of also waiting ~0.5–1s for cache writes. Any
    later build()/load for the same hash joins the in-flight write first,
    so the caches are always complete before they are read."""
    _wait_for_pending(file_hash)
    if raw_path(file_hash).exists() and cycles_path(file_hash).exists():
        return load_cycles(file_hash, parsing.PARSER_VERSION, CALC_VERSION)

    raw = parsing.parse_timeseries(source_path)
    cycles = calc.per_cycle(raw)

    def _write() -> None:
        try:
            _dir(file_hash).mkdir(parents=True, exist_ok=True)
            _write_atomic(raw, raw_path(file_hash))
            _write_atomic(cycles, cycles_path(file_hash))
        except Exception:
            logger.exception("background cache write failed for %s", file_hash)
        finally:
            with _pending_lock:
                _pending.pop(file_hash, None)

    thread = threading.Thread(target=_write, daemon=True, name=f"cache-write-{file_hash[:8]}")
    with _pending_lock:
        _pending[file_hash] = thread
    thread.start()
    return cycles


def load_cycles(
    file_hash: str, parser_version: str, calc_version: str
) -> pd.DataFrame | None:
    """Load per-cycle cache at EXACT versions (reproducibility). If the
    cycles file is missing but a raw cache at that parser version exists and
    calc_version is current, derive and store it."""
    _wait_for_pending(file_hash)
    p = cycles_path(file_hash, parser_version, calc_version)
    if p.exists():
        return pd.read_parquet(p)
    rp = raw_path(file_hash, parser_version)
    if rp.exists() and calc_version == CALC_VERSION:
        cycles = calc.per_cycle(pd.read_parquet(rp))
        _write_atomic(cycles, p)
        return cycles
    return None


def load_raw(file_hash: str, parser_version: str) -> pd.DataFrame | None:
    _wait_for_pending(file_hash)
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
