"""Render-time signed V dQ energy for verified GCPL measurements (Spec 103.4).

Primitive caches remain untouched. Missing measured counter samples are never
replaced; only a wholly absent directional column permits this derivation.
"""
from __future__ import annotations

import hashlib
import json
from collections import OrderedDict
from threading import RLock

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

from . import cache

POLICY = "gcpl-signed-vdq-1"
DIRECTIONS = ("charge", "discharge")
_MEMO = OrderedDict()
_LOCK = RLock()
_MAX_BYTES = 8 * 1024 * 1024
_MAX_ENTRIES = 32


def _storage_identity(path):
    stat = path.stat()
    return (stat.st_dev, stat.st_ino, stat.st_size) if stat.st_ino else None


def _verified(attrs):
    if not isinstance(attrs, dict):
        return False
    gcpl = attrs.get("biologic_gcpl", {})
    return isinstance(gcpl, dict) and str(gcpl.get("adapter_revision", "")).startswith("gcpl") and gcpl.get("scientific_interpretation") == "verified"


def _descriptor(ref):
    # Native Neware analyses must retain their summary-only fast path.
    if not ref.parser_version.startswith("bm:"):
        return None
    try:
        with pq.ParquetFile(cache.raw_path(ref.file_hash, ref.parser_version)) as file:
            metadata = file.schema_arrow.metadata or {}
            attrs = json.loads(metadata.get(b"pandas", b"{}")).get("attributes", {})
            attrs = attrs or json.loads(metadata.get(b"PANDAS_ATTRS", b"{}"))
            if not _verified(attrs):
                return None
            return set(file.schema_arrow.names)
    except (OSError, ValueError, TypeError, AttributeError):
        return None


def integrate_phase(raw: pd.DataFrame, direction: str, capacity: float):
    """Return net mWh and a failure reason; never bridge an unobserved transfer."""
    required = {"record_index", "step", "status", "current_ma", "voltage_v",
                "total_time_s", f"{direction}_capacity_mah"}
    if not required.issubset(raw):
        return np.nan, "missing recorded endpoints"
    raw = raw.sort_values("record_index", kind="stable")
    status = raw.status.astype("string").fillna("")
    discharge = status.str.contains("DChg", case=False)
    active = discharge if direction == "discharge" else status.str.contains("Chg", case=False) & ~discharge
    if not active.any():
        return np.nan, "no recorded directional participation"
    energy = transfer = 0.0
    for _step, rows in raw.loc[active].groupby("step", sort=False):
        if len(rows) < 2:
            return np.nan, "insufficient recorded endpoints"
        q = pd.to_numeric(rows[f"{direction}_capacity_mah"], errors="coerce").to_numpy(float)
        if not np.isfinite(q).all():
            return np.nan, "missing measured capacity"
        delta = np.diff(q)
        if (delta < 0).any():
            return np.nan, "directional counter reversal"
        positive = delta > 0
        record = pd.to_numeric(rows.record_index, errors="coerce").to_numpy(float)
        time = pd.to_numeric(rows.total_time_s, errors="coerce").to_numpy(float)
        voltage = pd.to_numeric(rows.voltage_v, errors="coerce").to_numpy(float)
        current = pd.to_numeric(rows.current_ma, errors="coerce").to_numpy(float)
        valid = ((np.diff(record) == 1) & np.isfinite(time[:-1]) & np.isfinite(time[1:]) & (np.diff(time) > 0))
        valid &= (current[:-1] < 0) & (current[1:] < 0) if direction == "discharge" else (current[:-1] > 0) & (current[1:] > 0)
        for column in ("mpr_acquisition_segment", "acquisition_segment", "acquisition_segment_id"):
            if column in rows:
                segment = rows[column].to_numpy()
                valid &= pd.notna(segment[:-1]) & pd.notna(segment[1:]) & (segment[:-1] == segment[1:])
        if not valid.all():
            return np.nan, "insufficient contiguous recorded participation"
        valid &= np.isfinite(voltage[:-1]) & np.isfinite(voltage[1:])
        if (positive & ~valid).any():
            return np.nan, "unresolved positive transfer across recorded endpoints"
        transfer += float(delta.sum())
        energy += float(np.sum((voltage[:-1][positive] + voltage[1:][positive]) * .5 * delta[positive]))
    if not np.isfinite(capacity) or not np.isclose(transfer, capacity, rtol=1e-7, atol=1e-9):
        return np.nan, "measured capacity reconciliation failed"
    if not np.isfinite(energy):
        return np.nan, "non-finite calculated directional energy"
    return energy, None


def _outcomes(ref, names):
    """Compact immutable source-local results; never retain measurement arrays."""
    path = cache.raw_path(ref.file_hash, ref.parser_version)
    identity = _storage_identity(path)
    key = (str(path), *identity, POLICY) if identity is not None else None
    with _LOCK:
        if key in _MEMO:
            _MEMO.move_to_end(key)
            return json.loads(_MEMO[key])
    raw = pd.read_parquet(path)
    if not _verified(raw.attrs) or _storage_identity(path) != identity:
        raise ValueError("GCPL energy evidence changed while being read")
    names = set(raw.columns)
    outcomes = {}
    for cycle, rows in raw.groupby("cycle", sort=False):
        phases = {}
        status = rows.status.astype("string").fillna("")
        discharge = status.str.contains("DChg", case=False)
        for direction in DIRECTIONS:
            mask = discharge if direction == "discharge" else status.str.contains("Chg", case=False) & ~discharge
            phase = rows.loc[mask]
            if phase.empty:
                continue
            capacity_column = f"{direction}_capacity_mah"
            capacity = sum(float(g[capacity_column].max() - g[capacity_column].min()) for _, g in phase.groupby("step", sort=False)) if capacity_column in phase else np.nan
            energy_column = f"{direction}_energy_mwh"
            if energy_column not in names:
                value, reason = integrate_phase(rows, direction, capacity)
                basis = "calculated"
            else:
                # Existing native holes are unavailable and never synthesized.
                finite = np.isfinite(pd.to_numeric(phase[energy_column], errors="coerce")).all()
                value = sum(float(g[energy_column].max() - g[energy_column].min()) for _, g in phase.groupby("step", sort=False)) if finite else np.nan
                reason = None if finite else "missing measured energy"
                basis = "measured"
            phases[direction] = {"capacity": capacity if np.isfinite(capacity) else None,
                "value": value if np.isfinite(value) else None, "reason": reason, "basis": basis}
        outcomes[str(int(cycle))] = phases
    encoded = json.dumps(outcomes, allow_nan=False).encode()
    if key is not None and len(encoded) <= _MAX_BYTES:
        with _LOCK:
            _MEMO[key] = encoded
            while len(_MEMO) > _MAX_ENTRIES or sum(map(len, _MEMO.values())) > _MAX_BYTES:
                _MEMO.popitem(last=False)
    return outcomes


def resolve(frame: pd.DataFrame, refs: list, qualified: pd.DataFrame, segments=None):
    """Resolve source-local evidence before masks and prefixes, preserving natives."""
    result, cumulative = frame.copy(), qualified.copy()
    provenance = {direction: [] for direction in DIRECTIONS}
    candidates = {}
    for segment, ref in enumerate(refs):
        names = _descriptor(ref)
        if names is None:
            continue
        try:
            outcomes = _outcomes(ref, names)
        except (OSError, ValueError, KeyError, TypeError):
            outcomes = {}
        metadata = next((s for s in (segments or []) if s.get("segment") == segment), {})
        mapping = metadata.get("cycle_mapping", {})
        if not mapping:
            local = frame.loc[frame.segment.eq(segment)] if "segment" in frame else frame
            mapping = {int(r.get("source_cycle", r.cycle)): int(r.cycle) for _, r in local.iterrows()}
        for source_cycle, global_cycle in mapping.items():
            for direction in DIRECTIONS:
                phase = outcomes.get(str(int(source_cycle)), {}).get(direction)
                if phase:
                    candidates.setdefault((int(global_cycle), direction), []).append(phase)
                elif f"{direction}_energy_mwh" not in names and not outcomes:
                    candidates.setdefault((int(global_cycle), direction), []).append({"value": None, "capacity": None, "basis": "calculated", "reason": "recorded energy evidence unavailable"})
    changed = set()
    for index, row in frame.iterrows():
        for direction in DIRECTIONS:
            column = f"{direction}_energy_mwh"
            value = row.get(column, np.nan)
            basis, reason = ("measured", None) if pd.notna(value) and np.isfinite(value) else ("unavailable", "measured energy unavailable")
            phases = candidates.get((int(row.cycle), direction), [])
            if phases and (any(p["basis"] == "calculated" for p in phases) or any(p["reason"] for p in phases)):
                reason = next((p["reason"] for p in phases if p["reason"]), None)
                capacity = sum(p["capacity"] or 0 for p in phases)
                expected = row.get(f"{direction}_capacity_mah", np.nan)
                if reason is None and (not np.isfinite(expected) or not np.isclose(capacity, expected, rtol=1e-7, atol=1e-9)):
                    reason = "measured capacity reconciliation failed"
                value = sum(p["value"] or 0 for p in phases) if reason is None else np.nan
                if reason is None and value < 0:
                    reason, value = "negative net directional energy", np.nan
                bases = {p["basis"] for p in phases}
                basis = "unavailable" if reason else "mixed" if len(bases) > 1 else next(iter(bases))
                result.at[index, column] = cumulative.at[index, column] = value
                changed.add(index)
            previous = provenance[direction][-1] if provenance[direction] else None
            prefix_known = pd.notna(cumulative.at[index, column]) if column in cumulative else False
            bases = {basis, previous["cumulative_basis"]} if previous else {basis}
            prefix_basis = "unavailable" if not prefix_known or "unavailable" in bases else "mixed" if len(bases) > 1 else basis
            provenance[direction].append({"basis": basis, "reason": reason,
                "cumulative_basis": prefix_basis,
                "cumulative_reason": previous["cumulative_reason"] if previous and previous["cumulative_basis"] == "unavailable" else reason or ("measured energy unavailable" if not prefix_known else None)})
    for index in changed:
        charge, discharge = result.at[index, "charge_energy_mwh"], result.at[index, "discharge_energy_mwh"]
        result.at[index, "energy_efficiency_pct"] = discharge / charge * 100 if pd.notna(charge) and charge > 0 and pd.notna(discharge) and discharge >= 0 else np.nan
    return result, cumulative, provenance


def dependency_identity(ref):
    """Stable storage identity, or actual derived outcome on no-inode storage."""
    names = _descriptor(ref)
    if names is None:
        return None
    try:
        path = cache.raw_path(ref.file_hash, ref.parser_version)
        identity = _storage_identity(path)
        if identity is not None:
            return (POLICY, *identity)
        encoded = json.dumps(_outcomes(ref, names), sort_keys=True, allow_nan=False).encode()
        return (POLICY, hashlib.sha256(encoded).hexdigest())
    except (OSError, ValueError, KeyError, TypeError):
        return (POLICY, "unavailable")


def aggregate_provenance(members, full_members, cycles):
    """Describe actual primitive contributors and the fixed cumulative cohort."""
    def lookups(collection):
        return [{direction: dict(zip(m["x"], m.get("energy_provenance", {}).get(direction, []))) for direction in DIRECTIONS} for m in collection]

    visible, full = lookups(members), lookups(full_members)

    def entries(collection, cycle, direction, prefix):
        values = []
        for member in collection:
            entry = member[direction].get(cycle)
            if entry is not None:
                values.append(entry)
            elif prefix:
                values.append({"cumulative_basis": "unavailable", "cumulative_reason": "included member unavailable"})
        return values

    def combine(values, prefix):
        key, reason_key = ("cumulative_basis", "cumulative_reason") if prefix else ("basis", "reason")
        bases = {v[key] for v in values}
        if not bases or (prefix and "unavailable" in bases) or bases == {"unavailable"}:
            return "unavailable", next((v[reason_key] for v in values if v[reason_key]), "included member unavailable")
        bases.discard("unavailable")
        return ("mixed" if len(bases) > 1 else next(iter(bases))), None

    prefixes = {direction: {} for direction in DIRECTIONS}
    full_cycles = sorted({c for m in full_members for c in m["x"]})
    for direction in DIRECTIONS:
        missing_reason = None
        for cycle in full_cycles:
            basis, reason = combine(entries(full, cycle, direction, True), True)
            if basis == "unavailable":
                missing_reason = missing_reason or reason
            prefixes[direction][cycle] = ("unavailable", missing_reason) if missing_reason else (basis, reason)
    result = {direction: [] for direction in DIRECTIONS}
    for cycle in cycles:
        for direction in DIRECTIONS:
            basis, reason = combine(entries(visible, cycle, direction, False), False)
            cumulative_basis, cumulative_reason = prefixes[direction].get(cycle, ("unavailable", "included member unavailable"))
            result[direction].append({"basis": basis, "reason": reason,
                "cumulative_basis": cumulative_basis, "cumulative_reason": cumulative_reason})
    return result


def aggregate_quantity_provenance(members, full_members, aggregate):
    """Qualify each mean using only members that actually supply that quantity."""
    def indexed(collection):
        return [(member, {cycle: i for i, cycle in enumerate(member["x"])}) for member in collection]

    visible, full = indexed(members), indexed(full_members)
    output = {}
    for column, quantity in aggregate["quantities"].items():
        if "energy" not in column:
            continue
        prefix = column.startswith(("cumulative_", "energy_throughput", "net_energy_imbalance"))
        directions = ("discharge",) if "discharge" in column else ("charge",) if "charge" in column else DIRECTIONS
        entries = []
        for cycle, mean in zip(aggregate["x"], quantity["mean"]):
            bases, reasons = set(), []
            for member, lookup in full if prefix else visible:
                index = lookup.get(cycle)
                values = member.get("quantities", {}).get(column, [])
                if index is None or index >= len(values) or (values[index] is None and mean is not None):
                    continue
                for direction in directions:
                    provenance = member.get("energy_provenance", {}).get(direction, [])
                    if index >= len(provenance):
                        continue
                    entry = provenance[index]
                    bases.add(entry["cumulative_basis" if prefix else "basis"])
                    reason = entry["cumulative_reason" if prefix else "reason"]
                    if reason:
                        reasons.append(f"{direction}: {reason}")
            if mean is None or not bases:
                basis = "unavailable"
                reason = "; ".join(dict.fromkeys(reasons)) or "included energy evidence unavailable"
            else:
                basis = "mixed" if len(bases) > 1 else next(iter(bases))
                reason = "; ".join(dict.fromkeys(reasons)) or None
            entries.append({"basis": basis, "reason": reason})
        output[column] = entries
    return output
