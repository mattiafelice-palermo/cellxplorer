"""Full-history cycle prefix sums, independent of presentation filtering."""
from __future__ import annotations

import numpy as np
import pandas as pd
from functools import lru_cache

from . import cache


QUANTITIES: dict[str, tuple[str, str]] = {}
SPECIFIC: dict[str, tuple[str, str]] = {}
for dimension, unit in (("capacity", "mah"), ("energy", "mwh")):
    display_unit = "mAh" if dimension == "capacity" else "mWh"
    for key, label in (
        (f"cumulative_charge_{dimension}", f"Cumulative charge {dimension}"),
        (f"cumulative_discharge_{dimension}", f"Cumulative discharge {dimension}"),
        (f"{dimension}_throughput", f"{dimension.capitalize()} throughput"),
        ("net_coulomb_imbalance" if dimension == "capacity" else "net_energy_imbalance",
         "Net coulomb imbalance" if dimension == "capacity" else "Net energy imbalance"),
    ):
        QUANTITIES[key] = (f"{key}_{unit}", f"{label} ({display_unit})")
        SPECIFIC[f"{key}_specific"] = (f"{key}_{unit}_g", f"{label} ({display_unit}/g)")
QUANTITIES["fec"] = ("fec", "Equivalent full cycles (FEC)")
STRICT_COLUMNS = {column for column, _ in (*QUANTITIES.values(), *SPECIFIC.values())}
INCREMENTS = ("charge_capacity_mah", "discharge_capacity_mah", "charge_energy_mwh", "discharge_energy_mwh")


@lru_cache(maxsize=64)
def _unknown_cycles(path: str, identity: tuple) -> tuple[tuple[str, int | None], ...]:
    return _read_unknown_cycles(path)


def _read_unknown_cycles(path: str) -> tuple[tuple[str, int | None], ...]:
    """Immutable evidence; footer-only fast path for ordinary all-finite counters.

    Primitive summaries historically sum missing steps as zero. Inspect the raw
    cache's null evidence without changing those summaries or their identities.
    Only suspect columns need row materialization; never reopen original files.
    None means the entire increment is unavailable. Bound the cache by sources.
    """
    import pyarrow.parquet as pq

    with pq.ParquetFile(path) as parquet:
        names = parquet.schema_arrow.names
        suspect: list[str] = []
        unknown: dict[str, int | None] = {}
        for column in INCREMENTS:
            if column not in names:
                unknown[column] = None
                continue
            index = names.index(column)
            statistics = [parquet.metadata.row_group(group).column(index).statistics for group in range(parquet.num_row_groups)]
            if statistics and all(stats is not None and stats.has_null_count and stats.null_count == parquet.metadata.row_group(group).num_rows for group, stats in enumerate(statistics)):
                unknown[column] = None
            elif any(
                stats is None
                or not stats.has_null_count or stats.null_count
                for stats in statistics
            ):
                suspect.append(column)
            else:
                unknown[column] = -1
        if suspect:
            if "cycle" not in names:
                unknown.update({column: None for column in suspect})
            else:
                columns = ["cycle", *suspect, *(["status"] if "status" in names else [])]
                raw = parquet.read(columns=columns).to_pandas()
                for column in suspect:
                    if "status" in raw:
                        status = raw.status.astype("string").fillna("")
                        discharge = status.str.contains("DChg", case=False)
                        charge = status.str.contains("Chg", case=False) & ~discharge
                        mask = discharge if column.startswith("discharge") else charge
                    else:
                        mask = pd.Series(True, index=raw.index)
                    bad = mask & ~np.isfinite(pd.to_numeric(raw[column], errors="coerce"))
                    cycles = raw.loc[bad, "cycle"].dropna()
                    unknown[column] = int(cycles.min()) if len(cycles) else -1
    return tuple(unknown.items())


def _cache_identity(stat) -> tuple | None:
    return (stat.st_dev, stat.st_ino, stat.st_size) if stat.st_ino else None


def _source_evidence(ref) -> tuple[tuple[str, int | None], ...]:
    path = cache.raw_path(ref.file_hash, ref.parser_version)
    # A usable file without a stable inode is uncacheable, not unavailable.
    identity = _cache_identity(path.stat())
    return _unknown_cycles(str(path), identity) if identity is not None else _read_unknown_cycles(str(path))


def evidence_identity(ref) -> tuple | None:
    try:
        path = cache.raw_path(ref.file_hash, ref.parser_version)
        identity = _cache_identity(path.stat())
        # Without an inode, persist the actual evidence outcome in result keys.
        # Regenerated readable evidence must invalidate previously unknown FEC.
        return identity if identity is not None else ("uncached-counter-evidence-v1", _read_unknown_cycles(str(path)))
    except (OSError, ValueError):
        return None


def proven_increments(frame: pd.DataFrame, refs: list) -> pd.DataFrame:
    """Qualify cumulative inputs by source-local raw evidence, preserving primitives."""
    qualified = frame.copy()
    if frame.attrs.get("cross_source_cp_cycle_ids") or frame.attrs.get("cross_source_gcpl_cycle_ids"):
        from . import stitch
        raw, _segments, missing = stitch.stitch_raw(refs)
        if not missing:
            for column in INCREMENTS:
                if column not in raw:
                    qualified[column] = np.nan
                    continue
                status = raw.status.astype("string").fillna("")
                discharge = status.str.contains("DChg", case=False)
                charge = status.str.contains("Chg", case=False) & ~discharge
                mask = discharge if column.startswith("discharge") else charge
                bad = mask & ~np.isfinite(pd.to_numeric(raw[column], errors="coerce"))
                bad_cycles = raw.loc[bad, "cycle"]
                qualified.loc[qualified.cycle.isin(bad_cycles), column] = np.nan
            return qualified
        qualified[list(INCREMENTS)] = np.nan
        return qualified
    for segment, ref in enumerate(refs):
        rows = frame["segment"] == segment
        try:
            evidence = dict(_source_evidence(ref))
        except (OSError, ValueError):
            evidence = {column: None for column in INCREMENTS}
        for column, cycles in evidence.items():
            if column not in qualified:
                continue
            invalid = rows if cycles is None else rows & (frame["source_cycle"] >= cycles) if cycles >= 0 else rows & False
            qualified.loc[invalid, column] = np.nan
    return qualified


def add_columns(
    frame: pd.DataFrame,
    nominal_capacity_mah: float | None,
    active_mass_mg: float | None,
    convention: str = "combined_throughput",
) -> pd.DataFrame:
    """Unknown required increments poison the prefix from their first occurrence.

    Directional increments are magnitudes. Sum and imbalance each require both
    directions; an independently known direction remains usable after a gap.
    The caller supplies the complete ordered source-chain summary before masks.
    """
    frame = frame.sort_values("cycle").copy()
    derived: dict[str, np.ndarray] = {}
    for dimension, unit in (("capacity", "mah"), ("energy", "mwh")):
        def values(direction: str) -> np.ndarray:
            column = frame.get(f"{direction}_{dimension}_{unit}")
            if column is None:
                return np.full(len(frame), np.nan)
            result = np.abs(pd.to_numeric(column, errors="coerce").to_numpy(dtype=float))
            return np.where(np.isfinite(result), result, np.nan)

        charge, discharge = values("charge"), values("discharge")
        derived[f"cumulative_charge_{dimension}_{unit}"] = np.cumsum(charge)
        derived[f"cumulative_discharge_{dimension}_{unit}"] = np.cumsum(discharge)
        derived[f"{dimension}_throughput_{unit}"] = np.cumsum(charge + discharge)
        key = "net_coulomb_imbalance" if dimension == "capacity" else "net_energy_imbalance"
        derived[f"{key}_{unit}"] = np.cumsum(charge - discharge)
    mass_g = active_mass_mg / 1000 if active_mass_mg and np.isfinite(active_mass_mg) and active_mass_mg > 0 else None
    for column, _label in SPECIFIC.values():
        derived[column] = derived[column.removesuffix("_g")] / mass_g if mass_g else np.full(len(frame), np.nan)
    valid_reference = nominal_capacity_mah and np.isfinite(nominal_capacity_mah) and nominal_capacity_mah > 0
    numerator = derived["cumulative_discharge_capacity_mah"] if convention == "discharge" else derived["capacity_throughput_mah"]
    denominator = nominal_capacity_mah if convention == "discharge" else (2 * nominal_capacity_mah if valid_reference else None)
    derived["fec"] = numerator / denominator if valid_reference else np.full(len(frame), np.nan)
    return pd.concat([frame.drop(columns=list(derived), errors="ignore"), pd.DataFrame(derived, index=frame.index)], axis=1)
