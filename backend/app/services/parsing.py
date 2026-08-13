"""Parsing service — format-neutral source dispatch facade (Spec 040.2).

This module is the ONLY place NewareNDA is imported and the single dispatch
point every supported source format funnels through. Route handlers never
call NewareNDA or `neware_excel` directly; they go through here (usually
indirectly via `cache.py`).

It owns:

- stable format identifiers (`FORMAT_NEWARE_BINARY`, `FORMAT_NEWARE_EXCEL`)
  and a narrow static descriptor per format (`SourceFormatDescriptor`) —
  a frozen dataclass registry, not a plugin framework: no dynamic loading,
  no importlib discovery, no base-class hierarchy;
- format recognition (`recognize_source`) and the one shared
  extension -> format_id decision table (`_EXTENSION_FORMAT_ID`) that both
  `parse_timeseries` and `read_header_metadata` dispatch through, so a
  suffix cannot be routed to a different format by one than the other;
- the direct NewareNDA integration for `.nda`/`.ndax`: `RAW_COLUMNS`, the
  vectorized fast-path installation (`fast_neware.install()`), and the
  direct NDAX XML metadata optimization (`_read_ndax_metadata_flat`);
- the format-neutral curated metadata contract returned by
  `read_header_metadata` for every supported format, built from whichever
  format's flattened header map it received.

Error taxonomy (Spec 040.2's "small format-neutral error layer", completed by
the 040.2 follow-up): `source_format_errors.py` defines the format-neutral
base `SourceFormatError(ValueError)` and its two neutral subclasses
`UnsupportedSourceFormatError`/`InvalidSourceFormatError`. `parsing` and
`neware_excel` both import from that module rather than from each other
(`parsing` imports `neware_excel`, so the reverse would be circular); this
module re-exports `UnsupportedSourceFormatError` (and the other two neutral
types) rather than redefining them, so there is exactly one class of each
name. `UnsupportedSourceFormatError` is raised directly by this module for
both a wholly unknown extension and a recognized extension whose content
fails its format's own structural check (e.g. a generic `.xlsx` workbook) —
`ensure_supported_source_metadata` translates the latter case so callers see
one consistent unsupported-format error regardless of which case applied.
`neware_excel.NewareExcelError` and its `UnsupportedNewareExcelError`/
`InvalidNewareExcelError` subclasses carry Excel-specific diagnostic detail
without being erased — they are chained (`from exc`) or surfaced verbatim
through `read_header_metadata`'s `error` field rather than being flattened
into a generic message — and additionally inherit from the matching neutral
type (`UnsupportedNewareExcelError` <- `UnsupportedSourceFormatError`,
`InvalidNewareExcelError` <- `InvalidSourceFormatError`), so a caller can
catch either `NewareExcelError` for Excel-specific detail or the neutral
`SourceFormatError` to reject any adapter's bad source uniformly, without
either catch also swallowing a genuine adapter bug. `ValueError` remains in
every one of these types' MRO, so existing `except ValueError` call sites
(e.g. `scanner.py`'s `except (OSError, ValueError)`) are unaffected.
`canonical_cycling.CanonicalCyclingError` remains a separate, later boundary
(`cache.build`/`cache.build_write_behind`) and is deliberately *not* part of
this hierarchy: a source can be recognized and fully parsed by this facade
and still fail canonical validation afterward, and that failure means an
adapter produced an invalid canonical frame — an adapter bug, not a bad
source file — so it must not be catchable by `except SourceFormatError`.

Spec 040.3 note: `parser_identity()` (content-aware, built on
`source_parser_descriptor()`) and `current_parser_identity_for_extension()`
(cheap, no I/O) are the per-source parser identity this module now exposes.
`PARSER_VERSION` remains a legacy transitional constant — some remaining
call sites still read it as a fallback for a source that predates 040.3 and
has no stored `parser_version`, and test fixtures use it as a stand-in
version string — but it is no longer the identity any cache build, cache
lookup, or analysis provenance keys on. See `docs/agent-knowledge/
canonical-cycling-data.md` and `docs/specs/040.3-per-source-parser-cache-
stitching-and-provenance.md` for the full per-source identity design.
"""
from __future__ import annotations

import hashlib
import logging
import os
import re
import zipfile
import xml.etree.ElementTree as ET
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import NewareNDA
import pandas as pd

from . import canonical_cycling, fast_neware, neware_excel
from .source_format_errors import (
    InvalidSourceFormatError,
    SourceFormatError,
    UnsupportedSourceFormatError,
)

logger = logging.getLogger(__name__)

NEWARE_NDA_VERSION: str = NewareNDA.version.__version__
EXCEL_PARSER_REVISION: int = neware_excel.EXCEL_PARSER_REVISION
PARSER_VERSION: str = f"{NEWARE_NDA_VERSION}-cxp{EXCEL_PARSER_REVISION}"
# ^ Transitional global parser-bundle identity (Spec 039), NOT a per-source
# parser identity. Every current cache/provenance consumer — cache.py,
# scanner.py, continuations.py, analysis_engine.py, analysis_cache.py,
# chargeability.py, rate_capability.py, portable_analysis.py,
# routers/library.py, routers/replicates.py, routers/files.py, main.py —
# still keys on this single value regardless of which format actually
# produced a given source. Spec 040.3 replaces this with per-source parser
# identity built from `source_parser_descriptor()` below; until that child
# lands, this stays the one compatibility bundle every one of those call
# sites depends on, so it must keep matching both adapter revisions it is
# built from.


@dataclass(frozen=True)
class SourceFormatDescriptor:
    """Narrow, static identity for one recognized source format.

    This — plus the two module-level instances and the `_EXTENSION_FORMAT_ID`
    lookup built from them below — is the complete "adapter registry" this
    facade needs. It is deliberately not a plugin interface: no dynamic
    loading, no importlib discovery, no abstract base class hierarchy.
    `adapter_revision` is per-format identity information reserved for Spec
    040.3's future per-source parser identity; nothing reads it from a cache
    or provenance boundary in this child.
    """

    format_id: str
    extensions: frozenset[str]
    adapter_revision: str


FORMAT_NEWARE_BINARY = "neware_binary"
FORMAT_NEWARE_EXCEL = "neware_excel"

_NEWARE_BINARY_FORMAT = SourceFormatDescriptor(
    format_id=FORMAT_NEWARE_BINARY,
    extensions=frozenset({".nda", ".ndax"}),
    adapter_revision=NEWARE_NDA_VERSION,
)
_NEWARE_EXCEL_FORMAT = SourceFormatDescriptor(
    format_id=FORMAT_NEWARE_EXCEL,
    extensions=frozenset({".xlsx"}),
    adapter_revision=str(EXCEL_PARSER_REVISION),
)
_FORMAT_DESCRIPTORS: dict[str, SourceFormatDescriptor] = {
    _NEWARE_BINARY_FORMAT.format_id: _NEWARE_BINARY_FORMAT,
    _NEWARE_EXCEL_FORMAT.format_id: _NEWARE_EXCEL_FORMAT,
}
# The one shared extension -> format_id decision table. `parse_timeseries`
# and `read_header_metadata` both dispatch through this exact mapping so
# recognition is deterministic and cannot drift between the two functions.
_EXTENSION_FORMAT_ID: dict[str, str] = {
    **{ext: _NEWARE_BINARY_FORMAT.format_id for ext in _NEWARE_BINARY_FORMAT.extensions},
    **{ext: _NEWARE_EXCEL_FORMAT.format_id for ext in _NEWARE_EXCEL_FORMAT.extensions},
}
SUPPORTED_NEWARE_SOURCE_EXTENSIONS = frozenset(_EXTENSION_FORMAT_ID)


# `UnsupportedSourceFormatError` (raised below for both a wholly unknown
# extension and a recognized extension whose content fails its format's own
# structural check, e.g. a generic `.xlsx` workbook) is re-exported here, not
# redefined: `source_format_errors` is the one place this class — and its
# neutral siblings `SourceFormatError`/`InvalidSourceFormatError` — are
# defined, so there is exactly one `UnsupportedSourceFormatError` class
# regardless of which module imports it. See that module's docstring and
# this module's own docstring "Error taxonomy" note for the full hierarchy.


def source_filename_allowed(filename: str | Path) -> bool:
    """Return whether a filename can enter the Neware source inspection path."""

    return Path(str(filename or "")).suffix.casefold() in SUPPORTED_NEWARE_SOURCE_EXTENSIONS


def source_parser_family(filename: str | Path) -> str | None:
    """Return the parser family selected by a supported Neware suffix.

    Deliberately filename/suffix-only, never content-based: `scanner.py`
    calls this on a bare filename (sometimes for a source it has not
    necessarily re-read) to guard against exact-hash relinking silently
    crossing the binary/Excel family boundary. `recognize_source` below is
    the content-aware counterpart used when an actual readable path is
    available; the two must not be conflated. Return values stay the
    pre-existing short "binary"/"excel" strings rather than the new
    `format_id` spelling — this is a stability-critical safety guard, not
    new dispatch surface, and changing its return values is out of scope.
    """

    value = str(filename or "")
    suffix = Path(value).suffix.casefold()
    if not suffix and value.casefold() in {"nda", "ndax", "xlsx"}:
        suffix = f".{value.casefold()}"
    if suffix == ".xlsx":
        return "excel"
    if suffix in {".nda", ".ndax"}:
        return "binary"
    return None


def recognize_source(path: str | Path) -> str | None:
    """Return the recognized `format_id` for `path`, or `None` if unrecognized.

    Binary recognition is extension-only: NewareNDA performs the real
    format validation during header/full read, so a separate content sniff
    here would mean opening the file twice for no safety benefit (see the
    spec's "Recognition policy" section). Excel recognition additionally
    requires `neware_excel.is_supported_workbook`'s bounded record-sheet
    header check, so a generic `.xlsx` workbook is never recognized by
    extension alone — this preserves Parent 039's structural contract.
    Both checks are cheap: reading a workbook's header row, never its full
    `record` sheet or cycling data.
    """

    suffix = Path(str(path or "")).suffix.casefold()
    format_id = _EXTENSION_FORMAT_ID.get(suffix)
    if format_id is None:
        return None
    if format_id == FORMAT_NEWARE_EXCEL:
        return format_id if neware_excel.is_supported_workbook(path) else None
    return format_id


def source_parser_descriptor(path: str | Path) -> dict[str, Any]:
    """Return the format-neutral adapter identity for `path`.

    Exposes `format_id`, `adapter_revision`, and `canonical_raw_version`
    (Spec 040.1) for Spec 040.3's future per-source parser identity.
    Nothing in this child persists or reads this value from a cache or
    provenance boundary; `PARSER_VERSION` remains the identity every
    current consumer reads.

    Raises:
        UnsupportedSourceFormatError: `path` is not a recognized source —
            same "one clear unsupported-format result" contract as
            `parse_timeseries`/`read_header_metadata`.
    """

    format_id = recognize_source(path)
    if format_id is None:
        raise UnsupportedSourceFormatError(
            f"Unsupported cycling source format: {Path(str(path)).suffix or '<none>'}."
        )
    descriptor = _FORMAT_DESCRIPTORS[format_id]
    return {
        "format_id": descriptor.format_id,
        "adapter_revision": descriptor.adapter_revision,
        "canonical_raw_version": canonical_cycling.CANONICAL_RAW_VERSION,
    }


# Per-source parser identity (Spec 040.3). One compact, documented grammar:
#
#   <prefix>:<adapter_revision>:r<canonical_raw_version>
#
# `<prefix>` is a short per-format token (not `format_id` itself, which is
# longer than the 30-character `SourceFile.parser_version` budget allows for
# some formats once the adapter revision and raw-version suffix are added).
# Measured against the real values 040.2 exposes:
#   nb:v2026.06.11:r1   (Neware binary; 17 characters)
#   nx:6:r1             (Neware Excel; 7 characters)
# both comfortably inside the 30-character bound. `_MAX_PARSER_IDENTITY_LENGTH`
# below is asserted at construction time rather than trusted by eye, so a
# future longer upstream version string fails loudly instead of silently
# producing a value `SourceFile.parser_version` cannot store.
_FORMAT_IDENTITY_PREFIX: dict[str, str] = {
    FORMAT_NEWARE_BINARY: "nb",
    FORMAT_NEWARE_EXCEL: "nx",
}
_MAX_PARSER_IDENTITY_LENGTH = 30  # SourceFile.parser_version = String(30)


def _identity_for_format(format_id: str) -> str:
    descriptor = _FORMAT_DESCRIPTORS[format_id]
    prefix = _FORMAT_IDENTITY_PREFIX[format_id]
    identity = f"{prefix}:{descriptor.adapter_revision}:r{canonical_cycling.CANONICAL_RAW_VERSION}"
    if len(identity) > _MAX_PARSER_IDENTITY_LENGTH:
        raise ValueError(
            f"Parser identity {identity!r} ({len(identity)} chars) exceeds the "
            f"{_MAX_PARSER_IDENTITY_LENGTH}-character SourceFile.parser_version "
            "budget. Shorten the identity grammar rather than adding a migration."
        )
    return identity


def current_parser_identity_for_extension(ext: str | None) -> str | None:
    """Cheap, no-I/O "what identity would building this extension produce now".

    Derived purely from the static format registry — never opens the source
    file. This is what list/current-cache-status checks must use (per the
    spec's "no file I/O, no parser imports... to answer 'is this source's
    cache current'" performance requirement): it answers "current" from a
    stored `SourceFile.ext` alone. It intentionally cannot distinguish a
    genuine Neware Excel export from an arbitrary `.xlsx` (that requires
    content sniffing, which `parser_identity()` below performs) — a
    `SourceFile` only reaches this path after already being accepted at
    registration time, so that distinction is not this function's job.

    Returns ``None`` when the extension is not a recognized suffix for any
    registered format.
    """

    suffix = str(ext or "")
    if suffix and not suffix.startswith("."):
        suffix = f".{suffix}"
    format_id = _EXTENSION_FORMAT_ID.get(suffix.casefold())
    if format_id is None:
        return None
    return _identity_for_format(format_id)


def parser_identity(path: str | Path) -> str:
    """Content-aware effective parser identity for an actual source file.

    Use this at real build/parse time, when `path` is available and
    readable — it calls `recognize_source`, which for Excel additionally
    sniffs the workbook header. For a cheap "is the stored identity still
    current" check with no file I/O, use
    `current_parser_identity_for_extension` instead.

    Raises:
        UnsupportedSourceFormatError: `path` is not a recognized source.
    """

    format_id = recognize_source(path)
    if format_id is None:
        raise UnsupportedSourceFormatError(
            f"Unsupported cycling source format: {Path(str(path)).suffix or '<none>'}."
        )
    return _identity_for_format(format_id)


def ensure_supported_source_metadata(path: str | Path, metadata: dict) -> None:
    """Reject an Excel file whose bounded metadata read identified no Neware export."""

    if Path(path).suffix.casefold() != ".xlsx":
        return
    error = metadata.get("error") if isinstance(metadata, dict) else None
    if error:
        raise UnsupportedSourceFormatError(str(error))

# Vectorized fast paths for NewareNDA — verified output-identical (see
# tests/test_fast_neware.py); the bundle version above still records both parser owners.
if os.environ.get("CELLXPLORER_FAST_NDAX", "1") != "0":
    fast_neware.install()

# canonical column names for the raw time-series cache
RAW_COLUMNS = {
    "Index": "record_index",
    "Cycle": "cycle",
    "Step": "step",
    "Step_Index": "step_index",
    "Status": "status",
    "Time": "time_s",
    "Voltage": "voltage_v",
    "Current(mA)": "current_ma",
    "Charge_Capacity(mAh)": "charge_capacity_mah",
    "Discharge_Capacity(mAh)": "discharge_capacity_mah",
    "Charge_Energy(mWh)": "charge_energy_mwh",
    "Discharge_Energy(mWh)": "discharge_energy_mwh",
    "Timestamp": "timestamp",
}


def compute_hash(path: str | Path) -> str:
    """Content hash = file identity. sha256, streamed."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1024 * 1024):
            h.update(chunk)
    return h.hexdigest()


def parse_timeseries(path: str | Path) -> pd.DataFrame:
    """Full parse of a supported cycling source into a normalized DataFrame.

    This is the shared dispatch point for both binary and Excel sources, but
    it deliberately does NOT enforce the canonical raw contract (Spec 040.1)
    itself: existing dispatch-mechanics tests call this function directly
    with deliberately minimal/mocked frames that are not meant to satisfy the
    full contract. Canonical validation instead runs at the full-parse /
    cache-build boundary in `cache.build` / `cache.build_write_behind`, the
    only production callers of this function.

    Dispatch is deterministic and suffix-based, through the same
    `_EXTENSION_FORMAT_ID` table `read_header_metadata` uses. It does not
    call `recognize_source` (which additionally sniffs Excel content) —
    `neware_excel.parse_timeseries` performs that same structural check
    itself as a side effect of actually parsing, so a second check here
    would open the workbook header twice for no benefit.
    """
    source_path = Path(path)
    format_id = _EXTENSION_FORMAT_ID.get(source_path.suffix.casefold())
    if format_id == FORMAT_NEWARE_EXCEL:
        return neware_excel.parse_timeseries(source_path)
    if format_id == FORMAT_NEWARE_BINARY:
        return _parse_neware_binary_timeseries(source_path)
    raise UnsupportedSourceFormatError(
        f"Unsupported cycling source format: {source_path.suffix or '<none>'}."
    )


def _parse_neware_binary_timeseries(source_path: Path) -> pd.DataFrame:
    """Neware `.nda`/`.ndax` full parse — the only `NewareNDA.read()` call site."""

    df = NewareNDA.read(str(source_path), software_cycle_number=True, log_level="WARNING")
    keep = {src: dst for src, dst in RAW_COLUMNS.items() if src in df.columns}
    df = df.rename(columns=keep)
    # keep any aux columns (temperature etc.) under their original names
    if "timestamp" in df.columns:
        df["timestamp"] = pd.to_datetime(df["timestamp"], errors="coerce")
    if "status" in df.columns:
        df["status"] = df["status"].astype(str)
    return df


def validate_parsed_output(
    path: str | Path,
    raw: pd.DataFrame,
    cycles: pd.DataFrame,
) -> None:
    """Run source-owned independent checks after raw/cycle derivation."""

    if Path(path).suffix.casefold() == ".xlsx":
        neware_excel.validate_cycles(path, raw, cycles)


def _flatten(d: Any, prefix: str = "") -> dict[str, str]:
    out: dict[str, str] = {}
    if isinstance(d, dict):
        for k, v in d.items():
            out.update(_flatten(v, f"{prefix}{k}." if prefix else f"{k}."))
    elif isinstance(d, list):
        for i, v in enumerate(d):
            out.update(_flatten(v, f"{prefix}{i}."))
    else:
        key = prefix.rstrip(".")
        if d is not None and str(d).strip():
            out[key] = str(d)
    return out


class _NdaxXmlFallback(Exception):
    """The direct XML reader cannot preserve a feature of the library parser."""


def _read_ndax_metadata_flat(path: str | Path) -> dict[str, str]:
    """Read NDAX header XML directly into the flattened metadata map.

    NewareNDA currently parses each XML member with ElementTree, serializes
    the result back to XML, and parses that XML a second time with xmltodict.
    Header consumers only need the flattened leaf map, so this walks the
    ElementTree once and reproduces the keys emitted by ``_flatten``.  XML
    namespaces are deliberately delegated to NewareNDA because ElementTree
    represents namespaced tags differently from xmltodict's default output.
    """
    flat: dict[str, str] = {}

    def add_value(key: str, value: object) -> None:
        text = str(value)
        if text.strip():
            # _flatten preserves the value returned by xmltodict; only the
            # emptiness check is whitespace-aware.
            flat[key] = text

    def visit(element: ET.Element, prefix: str) -> None:
        if "{" in element.tag:
            raise _NdaxXmlFallback

        children = list(element)
        has_attributes = bool(element.attrib)
        for key, value in element.attrib.items():
            add_value(f"{prefix}{key}", value)

        text = element.text or ""
        if text.strip():
            text_key = f"{prefix}#text" if has_attributes or children else prefix.rstrip(".")
            add_value(text_key, text)

        counts = Counter(child.tag for child in children)
        seen: Counter[str] = Counter()
        for child in children:
            suffix = ""
            if counts[child.tag] > 1:
                suffix = f".{seen[child.tag]}"
                seen[child.tag] += 1
            visit(child, f"{prefix}{child.tag}{suffix}.")

    with zipfile.ZipFile(str(path)) as archive:
        for xml_file in archive.namelist():
            if not xml_file.endswith(".xml"):
                continue
            document_root = ET.fromstring(archive.read(xml_file).decode(errors="ignore"))
            if "{" in document_root.tag:
                raise _NdaxXmlFallback
            root = document_root.find("config")
            if root is None:
                raise ValueError(f"missing config element in {xml_file}")
            name = xml_file.split("/")[-1].split(".")[0]
            visit(root, f"{name}.")
    return flat


def _read_neware_binary_header_flat(path: Path) -> dict[str, str]:
    """Flattened header for `.nda`/`.ndax`, preferring the direct XML fast path.

    `.ndax` tries the direct-XML flattener first and falls back to
    `NewareNDA.read_metadata` only when that reader hits a feature it
    cannot preserve (`_NdaxXmlFallback`); `.nda` has no XML fast path and
    always uses the library reader. Any other exception propagates to the
    caller's broad `except Exception` in `read_header_metadata` unchanged.
    """

    if path.suffix.casefold() == ".ndax":
        try:
            return _read_ndax_metadata_flat(path)
        except _NdaxXmlFallback:
            pass
    return _flatten(NewareNDA.read_metadata(str(path)))


def read_header_metadata(path: str | Path) -> dict:
    """Cheap header/metadata extraction (no full parse).

    Returns {raw: <flattened dict>, barcode, remarks, device_info, channel,
    start_time, active_mass_mg, nominal_capacity_mah, nda_version}.

    Dispatch uses the same `_EXTENSION_FORMAT_ID` table `parse_timeseries`
    uses, so both functions make the same format decision for a given
    suffix.
    """
    path = Path(path)
    suffix = path.suffix.casefold()
    format_id = _EXTENSION_FORMAT_ID.get(suffix)
    try:
        if format_id == FORMAT_NEWARE_EXCEL:
            meta = neware_excel.read_metadata(path)
            flat = _flatten(meta)
        elif format_id == FORMAT_NEWARE_BINARY:
            flat = _read_neware_binary_header_flat(path)
        else:
            raise UnsupportedSourceFormatError(
                f"Unsupported cycling source format: {path.suffix or '<none>'}."
            )
    except Exception as exc:  # corrupt/unsupported file: still importable
        logger.warning("metadata read failed for %s: %s", path, exc)
        return {"raw": {}, "error": str(exc)}

    result: dict[str, Any] = {"raw": flat}

    def find(*needles: str) -> str | None:
        for key, val in flat.items():
            low = key.lower()
            if any(low.endswith(n) or low == n for n in needles):
                return val
        return None

    def find_path(*parts: str) -> str | None:
        for wanted in parts:
            wanted_low = wanted.lower()
            for key, val in flat.items():
                if wanted_low in key.lower():
                    return val
        return None

    def find_suffix(suffix: str) -> str | None:
        suffix_low = suffix.lower()
        for key, val in flat.items():
            if key.lower().endswith(suffix_low):
                return val
        return None

    def find_all_suffix(suffix: str) -> list[str]:
        suffix_low = suffix.lower()
        return [val for key, val in flat.items() if key.lower().endswith(suffix_low)]

    def as_float(value: str | None) -> float | None:
        if value is None:
            return None
        match = re.search(r"[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?", str(value))
        if not match:
            return None
        try:
            return float(match.group(0))
        except ValueError:
            return None

    def scaled(value: str | None, factor: float) -> float | None:
        number = as_float(value)
        return None if number is None else number / factor

    def scaled_values(values: list[str], factor: float) -> list[float]:
        out: list[float] = []
        for value in values:
            scaled_value = scaled(value, factor)
            if scaled_value is not None:
                out.append(scaled_value)
        return out

    result["barcode"] = find("barcode") or find_path("barcode")
    result["remarks"] = find_path("head_info.remark.value") or find("remarks", "remark")
    result["nda_version"] = None if format_id == FORMAT_NEWARE_EXCEL else find("nda_version", "bts_version", "version")
    result["start_time"] = (
        find("starttime", "start_time", "startime")
        or find_path("starttime", "start_time", "startime")
    )
    result["start_step_id"] = find_suffix("head_info.start_step.value")
    result["part_number"] = find_suffix("head_info.pn.value")
    result["builder"] = find_suffix("head_info.creator.value")
    dev = find("devtype", "device", "devicetype")
    dev_id = find("devid", "deviceid")
    unit = find("unitid")
    chl = find("chlid", "channel", "chl")
    result["device_info"] = " ".join(x for x in (dev, dev_id and f"#{dev_id}") if x) or None
    result["channel"] = "-".join(x for x in (unit, chl) if x) or None
    mass = as_float(find("active_mass_mg", "activemass"))
    if mass is None:
        mass = scaled(find_suffix("head_info.scq.value"), 1000.0)
    result["active_mass_mg"] = mass
    result["active_material_mg"] = mass
    result["nominal_capacity_mah"] = scaled(find_suffix("head_info.multcap.value"), 3600.0)
    uppers = scaled_values(find_all_suffix("protect.main.volt.upper.value"), 10000.0)
    lowers = scaled_values(find_all_suffix("protect.main.volt.lower.value"), 10000.0)
    result["protection_voltage_upper_v"] = uppers[0] if uppers else None
    result["protection_voltage_lower_v"] = lowers[0] if lowers else None
    # Compatibility aliases for existing imports/API consumers. These values
    # are protection limits, not the operational charge/discharge cutoffs.
    result["voltage_upper_v"] = result["protection_voltage_upper_v"]
    result["voltage_lower_v"] = result["protection_voltage_lower_v"]
    from .protocol import reconstruct_protocol

    protocol = reconstruct_protocol(flat, result["nominal_capacity_mah"])
    charge_cutoffs = protocol["summary"]["charge_cutoffs"]
    discharge_cutoffs = protocol["summary"]["discharge_cutoffs"]
    result["charge_cutoff_v"] = charge_cutoffs[0]["voltage_v"] if charge_cutoffs else None
    result["discharge_cutoff_v"] = discharge_cutoffs[0]["voltage_v"] if discharge_cutoffs else None
    record_times = scaled_values(find_all_suffix("record.main.time.value"), 1000.0)
    result["record_interval_s"] = record_times[0] if record_times else None
    if format_id == FORMAT_NEWARE_EXCEL:
        result["source_format"] = "Neware Excel"
        result["capabilities"] = {
            key.removeprefix("Excel.Capabilities.").removesuffix(".Value"): value.casefold() == "true"
            for key, value in flat.items()
            if key.startswith("Excel.Capabilities.") and key.endswith(".Value")
        }
        result["protocol_warnings"] = list(protocol["warnings"])
    return result
