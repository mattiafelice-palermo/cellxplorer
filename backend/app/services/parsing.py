"""Parsing service — format-neutral source dispatch facade (Spec 040.2).

This module is the ONLY place NewareNDA is imported and the single dispatch
point every supported source format funnels through. Route handlers never
call NewareNDA or `neware_excel` directly; they go through here (usually
indirectly via `cache.py`).

It owns:

- stable format identifiers (`FORMAT_NEWARE_BINARY`, `FORMAT_NEWARE_EXCEL`, and
  `FORMAT_BIOLOGIC_MPR`)
  and a narrow static descriptor per format (`SourceFormatDescriptor`) —
  a frozen dataclass registry, not a plugin framework: no dynamic loading,
  no importlib discovery, no base-class hierarchy;
- format recognition (`recognize_source`) and one centralized extension table used by
  import admission, inspection, scanning, direct parsing, and parser identity;
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
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from stat import S_ISREG
from typing import Any

import NewareNDA
import pandas as pd

from . import biologic_gcpl, biologic_mpr, canonical_cycling, fast_neware, neware_excel
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

    This — plus the static module-level descriptors and the explicit extension
    lookups built from them below — is the complete "adapter registry" this
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
FORMAT_BIOLOGIC_MPR = "biologic_mpr"

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
_BIOLOGIC_MPR_FORMAT = SourceFormatDescriptor(
    format_id=FORMAT_BIOLOGIC_MPR,
    extensions=frozenset({".mpr"}),
    adapter_revision=biologic_gcpl.BIOLOGIC_GCPL_ADAPTER_REVISION,
)
_FORMAT_DESCRIPTORS: dict[str, SourceFormatDescriptor] = {
    _NEWARE_BINARY_FORMAT.format_id: _NEWARE_BINARY_FORMAT,
    _NEWARE_EXCEL_FORMAT.format_id: _NEWARE_EXCEL_FORMAT,
    _BIOLOGIC_MPR_FORMAT.format_id: _BIOLOGIC_MPR_FORMAT,
}


def source_glob(*format_ids: str) -> str:
    """Return native-picker patterns derived from the format registry."""

    selected = set(format_ids) if format_ids else set(_FORMAT_DESCRIPTORS)
    extensions = sorted(
        {
            extension
            for format_id, descriptor in _FORMAT_DESCRIPTORS.items()
            if format_id in selected
            for extension in descriptor.extensions
        }
    )
    return " ".join(f"*{extension}" for extension in extensions)


# This is the one user-facing source-admission policy. Every extension is
# derived from the descriptor registry so scanners, import inspection,
# browser enumeration, native filters, direct parsing, and parser identity
# cannot drift into separate format lists.
_EXTENSION_FORMAT_ID: dict[str, str] = {
    extension: format_id
    for format_id, descriptor in _FORMAT_DESCRIPTORS.items()
    for extension in descriptor.extensions
}
SUPPORTED_SOURCE_EXTENSIONS = frozenset(_EXTENSION_FORMAT_ID)
# Compatibility name retained for older callers that only need the Neware
# subset. It is derived from the same registry and is not an admission policy.
SUPPORTED_NEWARE_SOURCE_EXTENSIONS = frozenset(
    extension
    for extension, format_id in _EXTENSION_FORMAT_ID.items()
    if format_id != FORMAT_BIOLOGIC_MPR
)
_DIRECT_EXTENSION_FORMAT_ID = _EXTENSION_FORMAT_ID
SUPPORTED_DIRECT_SOURCE_EXTENSIONS = SUPPORTED_SOURCE_EXTENSIONS

SUPPORTED_SOURCE_DESCRIPTION = (
    "Cycler files: Neware (.nda, .ndax, structured .xlsx) and BioLogic GCPL-family "
    "(.mpr; canonical cycling availability is verified per source)"
)
SUPPORTED_SOURCE_GLOB = source_glob()

_FORMAT_FAMILY = {
    FORMAT_NEWARE_BINARY: "binary",
    FORMAT_NEWARE_EXCEL: "excel",
    FORMAT_BIOLOGIC_MPR: "biologic",
}


# `UnsupportedSourceFormatError` (raised below for both a wholly unknown
# extension and a recognized extension whose content fails its format's own
# structural check, e.g. a generic `.xlsx` workbook) is re-exported here, not
# redefined: `source_format_errors` is the one place this class — and its
# neutral siblings `SourceFormatError`/`InvalidSourceFormatError` — are
# defined, so there is exactly one `UnsupportedSourceFormatError` class
# regardless of which module imports it. See that module's docstring and
# this module's own docstring "Error taxonomy" note for the full hierarchy.


def source_filename_allowed(filename: str | Path) -> bool:
    """Return whether a filename can enter the supported source path."""

    return Path(str(filename or "")).suffix.casefold() in SUPPORTED_SOURCE_EXTENSIONS


def source_parser_family(filename: str | Path) -> str | None:
    """Return the parser family selected by a supported source suffix.

    Deliberately filename/suffix-only, never content-based: `scanner.py`
    calls this on a bare filename (sometimes for a source it has not
    necessarily re-read) to guard against exact-hash relinking silently
    crossing the binary/Excel/BioLogic family boundary. `recognize_source` below is
    the content-aware counterpart used when an actual readable path is
    available; the two must not be conflated. Return values stay the
    stable short family strings rather than the new
    `format_id` spelling — this is a stability-critical safety guard, not
    dispatch surface; changing the family labels would break lifecycle safety.
    """

    value = str(filename or "")
    suffix = Path(value).suffix.casefold()
    if not suffix:
        candidate = f".{value.casefold()}"
        if candidate in _EXTENSION_FORMAT_ID:
            suffix = candidate
    format_id = _EXTENSION_FORMAT_ID.get(suffix)
    return _FORMAT_FAMILY.get(format_id) if format_id is not None else None


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
    format_id = _DIRECT_EXTENSION_FORMAT_ID.get(suffix)
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
    FORMAT_BIOLOGIC_MPR: "bm",
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
    format_id = _DIRECT_EXTENSION_FORMAT_ID.get(suffix.casefold())
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
    """Reject a recognized source whose bounded header read failed.

    Adapter-specific detail remains in ``metadata["error"]`` while the
    concise user-facing taxonomy is carried in ``error_message``.
    """

    suffix = Path(path).suffix.casefold()
    if suffix not in {".xlsx", ".mpr"}:
        return
    error = metadata.get("error") if isinstance(metadata, dict) else None
    if not error:
        return
    message = metadata.get("error_message") or str(error)
    if metadata.get("error_kind") == "unsupported":
        raise UnsupportedSourceFormatError(message)
    if metadata.get("error_kind") == "invalid":
        raise InvalidSourceFormatError(message)
    if suffix == ".mpr":
        raise InvalidSourceFormatError(message)
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

# ``gcpl3`` briefly exposed canonical cycling rows before the logical cycle
# identity requirement was made explicit.  Those rows and their caches are
# not a reproducible historical scientific result: the adapter can no longer
# vouch for their cycle labels.  ``gcpl4`` is a different upgrade boundary:
# R8 withdrew a synthetic-only 15-ID/49-byte binary layout, so persisted
# gcpl4 metadata must be reconciled from its stored data-header evidence
# before it can receive the new identity. ``gcpl5`` and ``gcpl6`` are both
# previous identities whose MPR fallback output must be re-inspected after
# the candidate/verified boundary and declared-direction checks changed.
# Keep these sets explicit so a later BioLogic revision can add its own
# bounded migration decision without changing unrelated source formats.
RETIRED_BIOLOGIC_MPR_PARSER_IDENTITIES = frozenset({"bm:gcpl3:r1"})
PRE_R8_BIOLOGIC_MPR_PARSER_IDENTITIES = frozenset({"bm:gcpl4:r1"})
LEGACY_BIOLOGIC_MPR_PARSER_IDENTITIES = frozenset(
    {"bm:gcpl5:r1", "bm:gcpl6:r1"}
)
BIOLOGIC_MPR_RECONCILIATION_IDENTITIES = (
    RETIRED_BIOLOGIC_MPR_PARSER_IDENTITIES
    | PRE_R8_BIOLOGIC_MPR_PARSER_IDENTITIES
)
BIOLOGIC_MPR_VERIFIED_LAYOUT = "observed_16_id_53_byte"
BIOLOGIC_MPR_WITHDRAWN_LAYOUT = "withdrawn_15_id_49_byte"
BIOLOGIC_MPR_UNKNOWN_LAYOUT = "unknown_or_unrecorded"
RETIRED_BIOLOGIC_MPR_WARNING = (
    "BioLogic MPR canonical cycling from parser bm:gcpl3:r1 is no longer "
    "scientifically valid because logical cycle identity was not independently "
    "verified; this source is metadata-only."
)
BIOLOGIC_MPR_VERIFIED_RECONCILIATION_WARNING = (
    "BioLogic MPR parser bm:gcpl4:r1 was reconciled to the current post-R8 "
    "identity from stored observed 16-ID/53-byte layout evidence; canonical "
    "cycling remains unavailable until logical cycle identity is independently "
    "verified, so this source is metadata-only."
)
BIOLOGIC_MPR_REINSPECTION_WARNING = (
    "This BioLogic MPR was registered under the pre-R8 parser identity, but its "
    "stored binary-layout evidence does not prove the observed 16-ID/53-byte "
    "layout. Re-inspect the source before using it; it remains metadata-only."
)
BIOLOGIC_MPR_LEGACY_REINSPECTION_WARNING = (
    "This BioLogic MPR was registered under a previous parser identity before "
    "the single-direction candidate/verified boundary and declared-direction "
    "checks were added. Re-inspect the source before using it; it remains "
    "metadata-only until the upgrade is verified."
)


def compute_hash(path: str | Path) -> str:
    """Content hash = file identity. sha256, streamed."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1024 * 1024):
            h.update(chunk)
    return h.hexdigest()


@dataclass(frozen=True)
class SourceFingerprint:
    """Plain, process-safe identity snapshot for one source read."""

    hash: str
    size: int
    mtime_ns: int


class SourceIdentityError(ValueError):
    """The source disappeared, moved, or no longer matches its identity."""


def capture_source_fingerprint(
    path: str | Path,
    *,
    expected_hash: str | None = None,
) -> SourceFingerprint:
    """Hash a regular source between two stat checks.

    This is the shared source-read boundary for inspection, registration,
    scanner updates, and cache publication. It intentionally performs no
    adapter-specific parsing.
    """
    source_path = Path(path)
    try:
        initial = source_path.stat()
    except OSError as exc:
        raise SourceIdentityError(f"Source is missing or unreadable: {source_path}") from exc
    if not S_ISREG(initial.st_mode):
        raise SourceIdentityError(f"Source is not a regular file: {source_path}")
    try:
        file_hash = compute_hash(source_path)
        final = source_path.stat()
    except OSError as exc:
        raise SourceIdentityError(f"Source became unavailable while being read: {source_path}") from exc
    if (initial.st_size, initial.st_mtime_ns) != (final.st_size, final.st_mtime_ns):
        raise SourceIdentityError("Source changed during identity read")
    if expected_hash and file_hash.casefold() != expected_hash.casefold():
        raise SourceIdentityError("Source bytes do not match the inspected content hash")
    return SourceFingerprint(file_hash, final.st_size, final.st_mtime_ns)


def assert_source_fingerprint(
    path: str | Path,
    fingerprint: SourceFingerprint,
    *,
    verify_hash: bool = True,
) -> None:
    """Require a source to retain one inspected size/mtime/hash snapshot."""
    source_path = Path(path)
    try:
        before = source_path.stat()
    except OSError as exc:
        raise SourceIdentityError("Source became unavailable while being read") from exc
    if (before.st_size, before.st_mtime_ns) != (fingerprint.size, fingerprint.mtime_ns):
        raise SourceIdentityError("Source changed during identity read")
    try:
        current_hash = compute_hash(source_path) if verify_hash else fingerprint.hash
    except OSError as exc:
        raise SourceIdentityError("Source became unavailable while being read") from exc
    try:
        after = source_path.stat()
    except OSError as exc:
        raise SourceIdentityError("Source became unavailable while being read") from exc
    if (after.st_size, after.st_mtime_ns) != (fingerprint.size, fingerprint.mtime_ns):
        raise SourceIdentityError("Source changed during identity read")
    if current_hash.casefold() != fingerprint.hash.casefold():
        raise SourceIdentityError("Source bytes no longer match the inspected content hash")


def _metadata_capabilities(metadata: dict | None) -> dict | None:
    if not isinstance(metadata, dict):
        return None
    capabilities = metadata.get("capabilities")
    if not isinstance(capabilities, dict):
        raw = metadata.get("raw")
        capabilities = raw.get("capabilities") if isinstance(raw, dict) else None
    return capabilities if isinstance(capabilities, dict) else None


def source_metadata_cycling_pending(metadata: dict | None) -> bool:
    """Return whether header facts describe a candidate awaiting full parsing."""

    capabilities = _metadata_capabilities(metadata)
    if not capabilities:
        return False
    return bool(
        capabilities.get("canonical_cycling_pending")
        or capabilities.get("single_direction_cycle_candidate")
        or capabilities.get("single_direction_cycle_verification") == "pending"
    )


def source_metadata_only(metadata: dict | None) -> bool:
    """Return whether a recognized source has no canonical cycling contract.

    Format adapters may still expose useful header facts while deliberately
    withholding scientific rows.  Keep this decision in the shared parsing
    layer so registration, scanner preparation, and UI responses cannot drift
    into treating those sources as analysis-ready.
    """

    capabilities = _metadata_capabilities(metadata)
    if not capabilities:
        return False
    if capabilities.get("metadata_only") is True:
        return True
    # A settings-eligible BioLogic source has canonical_cycling=False while
    # its decoded-row proof is still pending. It is not metadata-only for
    # registration purposes: it must proceed automatically to full parsing.
    if source_metadata_cycling_pending(metadata):
        return False
    return capabilities.get("canonical_cycling") is False


def source_metadata_only_message(metadata: dict | None) -> str:
    if isinstance(metadata, dict):
        candidates: list[dict] = [metadata]
        raw = metadata.get("raw")
        if isinstance(raw, dict):
            candidates.append(raw)
            declared = raw.get("_cellxplorer_declared_protocol")
            if isinstance(declared, dict):
                candidates.append(declared)
        for candidate in candidates:
            warnings = candidate.get("protocol_warnings") or candidate.get("warnings")
            if isinstance(warnings, (list, tuple)):
                for warning in warnings:
                    text = str(warning).strip()
                    if text and ("cycle" in text.casefold() or "canonical" in text.casefold()):
                        return text
    return (
        "This source has readable metadata but no independently verified canonical cycling "
        "rows yet; it is metadata-only until the source cycle identity is resolved."
    )


def is_retired_biologic_parser_identity(
    ext: str | None,
    parser_version: str | None,
) -> bool:
    """Return whether a persisted BioLogic identity has been withdrawn.

    This is deliberately a cheap relational check.  It never opens the MPR,
    consults a cache, or imports an adapter, so list, startup, and analysis
    capability paths can fail closed before any scientific data is read.
    """

    suffix = str(ext or "").casefold().lstrip(".")
    return (
        suffix == "mpr"
        and str(parser_version or "") in RETIRED_BIOLOGIC_MPR_PARSER_IDENTITIES
    )


def source_uses_retired_biologic_parser(source: object) -> bool:
    return is_retired_biologic_parser_identity(
        getattr(source, "ext", None),
        getattr(source, "parser_version", None),
    )


def is_pre_r8_biologic_parser_identity(
    ext: str | None,
    parser_version: str | None,
) -> bool:
    suffix = str(ext or "").casefold().lstrip(".")
    return (
        suffix == "mpr"
        and str(parser_version or "") in PRE_R8_BIOLOGIC_MPR_PARSER_IDENTITIES
    )


def source_uses_pre_r8_biologic_parser(source: object) -> bool:
    return is_pre_r8_biologic_parser_identity(
        getattr(source, "ext", None),
        getattr(source, "parser_version", None),
    )


def is_legacy_biologic_parser_identity(
    ext: str | None,
    parser_version: str | None,
) -> bool:
    suffix = str(ext or "").casefold().lstrip(".")
    return (
        suffix == "mpr"
        and str(parser_version or "") in LEGACY_BIOLOGIC_MPR_PARSER_IDENTITIES
    )


def source_uses_legacy_biologic_parser(source: object) -> bool:
    return is_legacy_biologic_parser_identity(
        getattr(source, "ext", None),
        getattr(source, "parser_version", None),
    )


def _biologic_mpr_header_containers(header_meta: object) -> list[dict]:
    if not isinstance(header_meta, dict):
        return []
    containers = [header_meta]
    raw = header_meta.get("raw")
    if isinstance(raw, dict) and raw is not header_meta:
        containers.append(raw)
    return containers


def source_has_pending_biologic_cycle_verification(source: object) -> bool:
    """Return whether a registered MPR is awaiting decoded-row promotion."""

    if str(getattr(source, "ext", "") or "").casefold().lstrip(".") != "mpr":
        return False
    header = getattr(source, "header_meta", None)
    return any(
        source_metadata_cycling_pending(container)
        for container in _biologic_mpr_header_containers(header)
    )


def _source_has_pending_biologic_cycle_verification_without_header(
    source: object,
) -> bool:
    """Recognize the pending registration state without loading ``header_meta``.

    Registration persists eligible MPR candidates as ``unparsed``/``parsing``
    with no parser identity until the full cache build promotes or downgrades
    them. This scalar state is the fail-closed capability signal for cache-hit,
    artifact, and warmup paths that intentionally defer the header document.
    """

    return (
        str(getattr(source, "ext", "") or "").casefold().lstrip(".") == "mpr"
        and getattr(source, "parse_status", None) in {"unparsed", "parsing"}
        and not getattr(source, "parser_version", None)
    )


def persisted_biologic_mpr_layout(source: object) -> str | None:
    """Classify only the binary-layout evidence already persisted in a source row.

    This helper intentionally performs no path, cache, or adapter I/O.  A
    missing data header is represented as ``None``; an unreadable or
    unrecognized persisted header is represented by the explicit unknown
    layout.  The reconciliation caller treats both as requiring reinspection.
    """

    if str(getattr(source, "ext", "") or "").casefold().lstrip(".") != "mpr":
        return None
    saw_data_header = False
    withdrawn_column_ids = tuple(
        column_id
        for column_id in biologic_mpr.SUPPORTED_GCPL_COLUMN_IDS
        if column_id != 9
    )
    for container in _biologic_mpr_header_containers(getattr(source, "header_meta", None)):
        data = container.get("data")
        if not isinstance(data, dict):
            continue
        saw_data_header = True
        try:
            n_columns = int(data.get("n_columns"))
            column_ids = tuple(int(value) for value in data.get("column_ids") or ())
            record_offset = int(data.get("record_offset"))
            record_itemsize = int(data.get("record_itemsize"))
        except (TypeError, ValueError):
            continue
        if (
            n_columns == len(biologic_mpr.SUPPORTED_GCPL_COLUMN_IDS)
            and column_ids == biologic_mpr.SUPPORTED_GCPL_COLUMN_IDS
            and record_offset == biologic_mpr.VMP_DATA_RECORD_OFFSET
            and record_itemsize == biologic_mpr.VMP_DATA_RECORD_ITEMSIZE
        ):
            return BIOLOGIC_MPR_VERIFIED_LAYOUT
        if (
            n_columns == len(withdrawn_column_ids)
            and column_ids == withdrawn_column_ids
            and record_offset == biologic_mpr.VMP_DATA_RECORD_OFFSET
            and record_itemsize == 49
        ):
            return BIOLOGIC_MPR_WITHDRAWN_LAYOUT
    return BIOLOGIC_MPR_UNKNOWN_LAYOUT if saw_data_header else None


def source_requires_biologic_mpr_reinspection(
    source: object,
    *,
    include_header: bool = True,
) -> bool:
    """Return the persisted reinspection state for a BioLogic source.

    ``include_header=False`` is the cache-hit capability path. It treats any
    pre-R8 identity as unavailable until reconciliation and uses the scalar
    parse error for a current metadata-only reinspection marker. It never
    materializes deferred ``header_meta``.
    """

    if str(getattr(source, "ext", "") or "").casefold().lstrip(".") != "mpr":
        return False
    if source_uses_legacy_biologic_parser(source):
        return True
    if source_uses_pre_r8_biologic_parser(source):
        if not include_header:
            return True
    if not include_header:
        parse_error = str(getattr(source, "parse_error", "") or "").casefold()
        return "re-inspect" in parse_error or "reinspect" in parse_error
    for container in _biologic_mpr_header_containers(getattr(source, "header_meta", None)):
        capabilities = container.get("capabilities")
        if isinstance(capabilities, dict) and capabilities.get("requires_reinspection") is True:
            return True
    if not source_uses_pre_r8_biologic_parser(source):
        return False
    return persisted_biologic_mpr_layout(source) != BIOLOGIC_MPR_VERIFIED_LAYOUT


def source_record_metadata_only_message(
    source: object,
    *,
    include_header: bool = True,
) -> str:
    """Return the persisted source's truthful metadata-only explanation."""

    if source_uses_retired_biologic_parser(source):
        return RETIRED_BIOLOGIC_MPR_WARNING
    if source_uses_legacy_biologic_parser(source):
        return BIOLOGIC_MPR_LEGACY_REINSPECTION_WARNING
    if source_requires_biologic_mpr_reinspection(
        source,
        include_header=include_header,
    ):
        if not include_header:
            stored_error = getattr(source, "parse_error", None)
            if stored_error:
                return str(stored_error)
        return BIOLOGIC_MPR_REINSPECTION_WARNING
    if source_uses_pre_r8_biologic_parser(source):
        return BIOLOGIC_MPR_VERIFIED_RECONCILIATION_WARNING
    if (
        getattr(source, "parse_status", None) == "metadata_only"
        and getattr(source, "parse_error", None)
    ):
        return str(source.parse_error)
    if not include_header:
        stored_error = getattr(source, "parse_error", None)
        if stored_error:
            return str(stored_error)
        return source_metadata_only_message(None)
    header = getattr(source, "header_meta", None)
    return source_metadata_only_message({"raw": header} if isinstance(header, dict) else None)


def _mark_biologic_source_metadata_only(
    source: object,
    *,
    warning: str,
    parser_version: str | None,
    requires_reinspection: bool,
) -> None:
    """Persist one bounded BioLogic capability downgrade without source I/O."""

    original = getattr(source, "header_meta", None)
    header = deepcopy(original) if isinstance(original, dict) else {}
    containers = _biologic_mpr_header_containers(header) or [header]

    for container in containers:
        capabilities = container.get("capabilities")
        capabilities = dict(capabilities) if isinstance(capabilities, dict) else {}
        capabilities.update(
            {
                "cycling_rows": False,
                "canonical_cycling": False,
                "canonical_cycling_pending": False,
                "canonical_cycling_verified": False,
                "metadata_only": True,
                "single_direction_cycle_candidate": False,
                "single_direction_cycle_verification": "failed",
                "requires_reinspection": requires_reinspection,
            }
        )
        if "cycle_identity_source" in capabilities:
            capabilities["cycle_identity_source"] = "unresolved"
        container["capabilities"] = capabilities
        warnings = container.get("protocol_warnings")
        warnings = list(warnings) if isinstance(warnings, (list, tuple)) else []
        if warning not in warnings:
            warnings.append(warning)
        container["protocol_warnings"] = warnings

        declared = container.get("_cellxplorer_declared_protocol")
        if isinstance(declared, dict):
            declared_copy = deepcopy(declared)
            declared_capabilities = declared_copy.get("capabilities")
            declared_capabilities = (
                dict(declared_capabilities)
                if isinstance(declared_capabilities, dict)
                else {}
            )
            declared_capabilities.update(
                {
                    "cycling_rows": False,
                    "canonical_cycling": False,
                    "canonical_cycling_pending": False,
                    "canonical_cycling_verified": False,
                    "metadata_only": True,
                    "single_direction_cycle_candidate": False,
                    "single_direction_cycle_verification": "failed",
                    "requires_reinspection": requires_reinspection,
                }
            )
            if "cycle_identity_source" in declared_capabilities:
                declared_capabilities["cycle_identity_source"] = "unresolved"
            declared_copy["capabilities"] = declared_capabilities
            declared_warnings = declared_copy.get("warnings")
            declared_warnings = (
                list(declared_warnings)
                if isinstance(declared_warnings, (list, tuple))
                else []
            )
            if warning not in declared_warnings:
                declared_warnings.append(warning)
            declared_copy["warnings"] = declared_warnings
            container["_cellxplorer_declared_protocol"] = declared_copy

    source.header_meta = header
    source.parser_version = parser_version
    source.parse_status = "metadata_only"
    source.parse_error = warning
    source.row_count = None
    source.cycle_count = None
    source.capacity_summary_status = "unavailable"
    source.total_charge_capacity_mah = None
    source.total_discharge_capacity_mah = None
    source.max_discharge_capacity_mah = None


def mark_biologic_mpr_canonical(source: object) -> bool:
    """Promote a settings-only MPR candidate after a successful full parse."""

    if not source_has_pending_biologic_cycle_verification(source):
        return False
    original = getattr(source, "header_meta", None)
    header = deepcopy(original) if isinstance(original, dict) else {}
    containers = _biologic_mpr_header_containers(header) or [header]
    for container in containers:
        capabilities = container.get("capabilities")
        capabilities = dict(capabilities) if isinstance(capabilities, dict) else {}
        capabilities.update(
            {
                "cycling_rows": True,
                "canonical_cycling": True,
                "canonical_cycling_pending": False,
                "canonical_cycling_verified": True,
                "metadata_only": False,
                "single_direction_cycle_candidate": False,
                "single_direction_cycle_verification": "verified",
                "cycle_identity_source": "single_direction_inferred",
            }
        )
        container["capabilities"] = capabilities
        warnings = container.get("protocol_warnings")
        if isinstance(warnings, (list, tuple)):
            warnings = [
                warning
                for warning in warnings
                if "canonical cycling remains pending" not in str(warning).casefold()
            ]
            container["protocol_warnings"] = warnings

        declared = container.get("_cellxplorer_declared_protocol")
        if isinstance(declared, dict):
            declared_copy = deepcopy(declared)
            declared_capabilities = declared_copy.get("capabilities")
            declared_capabilities = (
                dict(declared_capabilities)
                if isinstance(declared_capabilities, dict)
                else {}
            )
            declared_capabilities.update(
                {
                    "cycling_rows": True,
                    "canonical_cycling": True,
                    "canonical_cycling_pending": False,
                    "canonical_cycling_verified": True,
                    "metadata_only": False,
                    "single_direction_cycle_candidate": False,
                    "single_direction_cycle_verification": "verified",
                    "cycle_identity_source": "single_direction_inferred",
                }
            )
            declared_copy["capabilities"] = declared_capabilities
            declared_warnings = declared_copy.get("warnings")
            if isinstance(declared_warnings, (list, tuple)):
                declared_copy["warnings"] = [
                    warning
                    for warning in declared_warnings
                    if "canonical cycling remains pending"
                    not in str(warning).casefold()
                ]
            container["_cellxplorer_declared_protocol"] = declared_copy
    source.header_meta = header
    return True


def mark_biologic_mpr_cycle_verification_failed(
    source: object,
    *,
    detail: str | None = None,
) -> None:
    """Persist a fail-closed downgrade after candidate row verification fails."""

    detail_text = str(detail or "decoded rows did not satisfy the fallback contract").strip()
    warning = (
        "BioLogic MPR decoded rows did not verify the declared single-direction "
        "cycle-1 contract; this source is metadata-only."
    )
    _mark_biologic_source_metadata_only(
        source,
        warning=warning,
        parser_version=current_parser_identity_for_extension(getattr(source, "ext", None)),
        requires_reinspection=False,
    )
    source.parse_error = f"{warning} Last row verification failure: {detail_text}"


def reclassify_retired_biologic_source(source: object) -> bool:
    """Downgrade one withdrawn BioLogic registration without source I/O.

    Old parser caches are intentionally left on disk for later forensic
    cleanup.  The relational registration and its persisted capability flags
    are the live authority, so every current consumer sees the source as
    metadata-only after this bounded state transition.
    """

    if not source_uses_retired_biologic_parser(source):
        return False
    _mark_biologic_source_metadata_only(
        source,
        warning=RETIRED_BIOLOGIC_MPR_WARNING,
        parser_version=current_parser_identity_for_extension(getattr(source, "ext", None)),
        requires_reinspection=False,
    )
    return True


def reclassify_pre_r8_biologic_source(source: object) -> bool:
    """Reconcile a pre-R8 MPR row from its persisted binary-layout evidence."""

    if not source_uses_pre_r8_biologic_parser(source):
        return False
    layout = persisted_biologic_mpr_layout(source)
    if layout == BIOLOGIC_MPR_VERIFIED_LAYOUT:
        _mark_biologic_source_metadata_only(
            source,
            warning=BIOLOGIC_MPR_VERIFIED_RECONCILIATION_WARNING,
            parser_version=current_parser_identity_for_extension(getattr(source, "ext", None)),
            requires_reinspection=False,
        )
    else:
        _mark_biologic_source_metadata_only(
            source,
            warning=BIOLOGIC_MPR_REINSPECTION_WARNING,
            parser_version=None,
            requires_reinspection=True,
        )
    return True


def mark_biologic_mpr_reinspection_required(
    source: object,
    *,
    detail: str | None = None,
) -> None:
    """Persist a failed adapter-upgrade reinspection without exposing caches."""

    _mark_biologic_source_metadata_only(
        source,
        warning=BIOLOGIC_MPR_LEGACY_REINSPECTION_WARNING,
        parser_version=None,
        requires_reinspection=True,
    )
    if detail:
        source.parse_error = (
            f"{BIOLOGIC_MPR_LEGACY_REINSPECTION_WARNING} "
            f"Last reinspection attempt failed: {detail}"
        )


def source_record_metadata_only(
    source: object,
    *,
    include_header: bool = True,
) -> bool:
    """Return the persisted capability boundary without opening the source.

    Registered sources must be safe to inspect from database state alone. In
    particular, a metadata-only BioLogic source must never be reparsed merely
    because a cache or preview consumer asks for cycling data. Set
    ``include_header=False`` for cache-hit capability checks where deferred
    ``header_meta`` must remain unloaded.
    """

    if (
        source_uses_retired_biologic_parser(source)
        or source_uses_pre_r8_biologic_parser(source)
        or source_uses_legacy_biologic_parser(source)
        or getattr(source, "parse_status", None) == "metadata_only"
    ):
        return True
    pending = (
        source_has_pending_biologic_cycle_verification(source)
        if include_header
        else _source_has_pending_biologic_cycle_verification_without_header(source)
    )
    if pending:
        # A pending candidate is not metadata-only for registration: the
        # scanner explicitly bypasses this capability gate while it builds the
        # full cache. It is nevertheless unavailable to every scientific
        # consumer until promotion, so fail closed here.
        return True
    if not include_header:
        return False
    if source_requires_biologic_mpr_reinspection(source):
        return True
    header = getattr(source, "header_meta", None)
    return source_metadata_only({"raw": header} if isinstance(header, dict) else None)


def source_record_capability(
    source: object,
    *,
    include_header: bool = True,
) -> dict[str, object]:
    """Describe the stable persisted scientific capability of one source."""

    pending = (
        source_has_pending_biologic_cycle_verification(source)
        if include_header
        else _source_has_pending_biologic_cycle_verification_without_header(source)
    )
    if pending:
        return {
            "status": "pending",
            "metadata_only": False,
            "canonical_cycling": False,
            "canonical_cycling_pending": True,
            "warning": source_record_metadata_only_message(
                source,
                include_header=include_header,
            ),
            "requires_reinspection": False,
        }
    metadata_only = source_record_metadata_only(source, include_header=include_header)
    warning = (
        source_record_metadata_only_message(source, include_header=include_header)
        if metadata_only
        else None
    )
    return {
        "status": "metadata_only" if metadata_only else "canonical_cycling",
        "metadata_only": metadata_only,
        "canonical_cycling": not metadata_only,
        "canonical_cycling_pending": False,
        "warning": warning,
        "requires_reinspection": source_requires_biologic_mpr_reinspection(
            source,
            include_header=include_header,
        ),
    }


def _bounded_source_presentation_text(value: object, limit: int = 96) -> str | None:
    if value is None:
        return None
    text = " ".join(str(value).split())
    if not text:
        return None
    return text[:limit] if len(text) <= limit else text[: limit - 3] + "..."


def source_presentation(source: object) -> dict[str, object]:
    """Return bounded BioLogic facts for source-list/detail presentation.

    ``SourceFile.header_meta`` is the persisted raw header document. This
    helper reads only the small normalized settings/log/capability facts that
    the UI needs and never returns the full decoded settings payload. Other
    formats retain the existing source-detail shape by receiving null facts.
    """

    empty = {
        "source_format": None,
        "technique": None,
        "software_version": None,
        "reference_electrode": None,
        "voltage_capabilities": None,
        "voltage_v_origin": None,
        "voltage_v_derived": None,
    }
    ext = str(getattr(source, "ext", "") or "").casefold().lstrip(".")
    if ext != "mpr":
        return empty

    header = getattr(source, "header_meta", None)
    if not isinstance(header, dict):
        return {**empty, "source_format": "BioLogic EC-Lab"}

    voltage = header.get(canonical_cycling.VOLTAGE_CAPABILITIES_METADATA_KEY)
    if not isinstance(voltage, dict):
        voltage = header.get("voltage_capabilities")
    voltage = voltage if isinstance(voltage, dict) else {}
    raw_capabilities = voltage.get("capabilities")
    capabilities = (
        {
            key: bool(raw_capabilities.get(key))
            for key in (
                "primary_voltage",
                "working_potential",
                "counter_potential",
            )
            if key in raw_capabilities
        }
        if isinstance(raw_capabilities, dict)
        else {}
    )
    raw_roles = voltage.get("voltage_roles")
    roles = (
        {
            key: _bounded_source_presentation_text(raw_roles.get(key), 64)
            for key in (
                "voltage_v",
                "working_potential_v",
                "counter_potential_v",
            )
            if isinstance(raw_roles.get(key), str) and raw_roles.get(key).strip()
        }
        if isinstance(raw_roles, dict)
        else {}
    )
    settings = header.get("settings")
    settings = settings if isinstance(settings, dict) else {}
    log = header.get("log")
    log = log if isinstance(log, dict) else {}
    reference = _bounded_source_presentation_text(voltage.get("reference_electrode"))
    origin = _bounded_source_presentation_text(voltage.get("voltage_v_origin"), 64)
    return {
        "source_format": "BioLogic EC-Lab",
        "technique": _bounded_source_presentation_text(settings.get("technique"), 64),
        "software_version": _bounded_source_presentation_text(
            log.get("ec_lab_version"), 64
        ),
        "reference_electrode": reference,
        "voltage_capabilities": {
            "capabilities": capabilities,
            "voltage_roles": roles,
            "reference_electrode": reference,
            "voltage_v_origin": origin,
            "voltage_v_derived": bool(voltage.get("voltage_v_derived")),
        },
        "voltage_v_origin": origin,
        "voltage_v_derived": bool(voltage.get("voltage_v_derived")),
    }


def parse_timeseries(path: str | Path) -> pd.DataFrame:
    """Full parse of a supported cycling source into a normalized DataFrame.

    This is the shared dispatch point for both binary and Excel sources, but
    it deliberately does NOT enforce the canonical raw contract (Spec 040.1)
    itself: existing dispatch-mechanics tests call this function directly
    with deliberately minimal/mocked frames that are not meant to satisfy the
    full contract. Canonical validation instead runs at the full-parse /
    cache-build boundary in `cache.build` / `cache.build_write_behind`, the
    only production callers of this function.

    Dispatch is deterministic and suffix-based, through the centralized
    adapter registry. It does not
    call `recognize_source` (which additionally sniffs Excel content) —
    `neware_excel.parse_timeseries` performs that same structural check
    itself as a side effect of actually parsing, so a second check here
    would open the workbook header twice for no benefit.
    """
    source_path = Path(path)
    format_id = _DIRECT_EXTENSION_FORMAT_ID.get(source_path.suffix.casefold())
    if format_id == FORMAT_NEWARE_EXCEL:
        return neware_excel.parse_timeseries(source_path)
    if format_id == FORMAT_NEWARE_BINARY:
        return _parse_neware_binary_timeseries(source_path)
    if format_id == FORMAT_BIOLOGIC_MPR:
        return biologic_gcpl.parse_timeseries(source_path)
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

    Returns the normalized source metadata contract.  Neware sources retain
    the historical flattened ``raw`` map; direct BioLogic MPR metadata carries
    bounded decoded ``settings``, ``log``, and data-header objects in ``raw``.

    The complete raw header stays server-side. Import routes expose only a
    bounded scalar preview, while registration persists this raw document in
    ``SourceFile.header_meta``.
    """
    path = Path(path)
    suffix = path.suffix.casefold()
    format_id = _DIRECT_EXTENSION_FORMAT_ID.get(suffix)
    try:
        if format_id == FORMAT_BIOLOGIC_MPR:
            return biologic_gcpl.read_gcpl_header_metadata(path)
        if format_id == FORMAT_NEWARE_EXCEL:
            meta = neware_excel.read_metadata(path)
            flat = _flatten(meta)
        elif format_id == FORMAT_NEWARE_BINARY:
            flat = _read_neware_binary_header_flat(path)
        else:
            raise UnsupportedSourceFormatError(
                f"Unsupported cycling source format: {path.suffix or '<none>'}."
            )
    except SourceFormatError as exc:
        logger.warning("metadata read failed for %s: %s", path, exc)
        if isinstance(exc, UnsupportedSourceFormatError):
            error_kind = "unsupported"
        else:
            error_kind = "invalid"
        if suffix == ".mpr":
            unrecognized = "is not a BioLogic MPR file" in str(exc)
            error_message = (
                "The selected .mpr file is not a BioLogic MPR container."
                if unrecognized
                else "Unsupported BioLogic .mpr technique or file layout; "
                "CellXplorer does not support this source yet."
                if error_kind == "unsupported"
                else "Invalid BioLogic .mpr; the file is corrupt or could not be read safely."
            )
        else:
            error_message = str(exc)
        result = {
            "raw": {},
            "error": str(exc),
            "error_kind": error_kind,
            "error_message": error_message,
        }
        if suffix == ".mpr":
            result["source_format"] = FORMAT_BIOLOGIC_MPR
        return result
    except Exception as exc:
        if suffix == ".mpr":
            # An unexpected adapter defect is not a user/source rejection and
            # must remain visible to the caller and test harness.
            logger.exception("unexpected BioLogic metadata failure for %s", path)
            raise
        logger.warning("metadata read failed for %s: %s", path, exc)
        return {
            "raw": {},
            "source_format": None,
            "error": str(exc),
            "error_kind": None,
            "error_message": str(exc),
        }

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
    # Spec 040.4: bounded, format-neutral voltage-role capability (distinct
    # from the Excel-only `Excel.Capabilities.*` block above, which predates
    # this and covers unrelated header features). Legacy Neware adapters use
    # the two-electrode default here; the direct BioLogic MPR path returns its
    # verified roles from `biologic_gcpl` before reaching this facade.
    result["voltage_capabilities"] = canonical_cycling.voltage_capabilities()
    return result
