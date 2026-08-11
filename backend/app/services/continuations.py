"""Read-only continuation compatibility inspection and ordering suggestions.

Pure comparison logic lives here; routers collect source metadata and call
``analyze_continuation_chain``. Findings are deterministic for identical inputs.
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Literal

from ..config import CALC_VERSION
from . import cache, parsing, protocol
from .stitch import observed_local_cycles

InspectionStatus = Literal["ready", "pending", "error"]
FindingSeverity = Literal["info", "warning", "confirmation", "blocking"]
SourceKind = Literal["existing", "staged"]

MATERIAL_MISMATCH_TOLERANCE = 0.05

FindingCode = Literal[
    "duplicate_hash",
    "hash_already_linked",
    "source_missing",
    "source_unreadable",
    "source_changing",
    "unsupported_extension",
    "invalid_proposed_order",
    "inspection_failed",
    "cache_build_failed",
    "timestamp_overlap",
    "order_reversed",
    "nominal_capacity_mismatch",
    "active_mass_mismatch",
    "path_refresh",
    "timestamp_gap",
    "device_changed",
    "channel_changed",
    "remarks_changed",
    "barcode_changed",
    "protocol_changed",
    "local_cycles_restart",
    "local_cycles_continue",
    "local_cycles_overlap",
    "local_cycles_gap",
    "timestamp_confidence_incomplete",
]


def _canonical_fingerprint(value: object) -> str:
    """Serialize semantic finding inputs without presentation-only wording."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def finding_id(
    code: str,
    source_keys: list[str],
    semantic_details: dict[str, Any] | None = None,
) -> str:
    payload = _canonical_fingerprint(
        {
            "code": code,
            "source_keys": list(source_keys),
            "details": semantic_details or {},
        }
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def _norm(value: object | None) -> str:
    return str(value or "").strip().lower()


def _parse_timestamp(value: str | None) -> datetime | None:
    if not value or not str(value).strip():
        return None
    text = str(value).strip()
    for fmt in (
        "%Y-%m-%d %H:%M:%S",
        "%Y/%m/%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M:%S%z",
        "%Y-%m-%d %H:%M:%S.%f",
    ):
        try:
            parsed = datetime.strptime(text, fmt)
            if parsed.tzinfo is None:
                return parsed.replace(tzinfo=timezone.utc)
            return parsed
        except ValueError:
            continue
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=timezone.utc)
        return parsed
    except ValueError:
        return None


def _iso_timestamp(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()


def _format_duration(seconds: float) -> str:
    seconds = max(0.0, float(seconds))
    if seconds < 60:
        return f"{seconds:.0f} seconds"
    minutes = seconds / 60
    if minutes < 60:
        return f"{minutes:.1f} minutes"
    hours = minutes / 60
    if hours < 48:
        return f"{hours:.1f} hours"
    days = hours / 24
    if days < 14:
        return f"{days:.1f} days"
    weeks = days / 7
    return f"{weeks:.1f} weeks"


def materially_differs(left: float | None, right: float | None) -> bool:
    if left is None or right is None:
        return False
    if left <= 0 or right <= 0:
        return False
    baseline = max(abs(left), abs(right))
    return abs(left - right) / baseline > MATERIAL_MISMATCH_TOLERANCE


def cycle_range_from_frame(cycles_frame) -> tuple[int | None, int | None, int | None, list[str]]:
    if cycles_frame is None or getattr(cycles_frame, "empty", True):
        return None, None, None, []
    if "cycle" not in cycles_frame.columns:
        return None, None, None, []
    labels, errors = observed_local_cycles(cycles_frame["cycle"])
    if errors:
        return None, None, None, errors
    if not labels:
        return None, None, None, []
    return labels[0], labels[-1], len(labels), []


def timestamp_range_from_raw(raw_frame) -> tuple[datetime | None, datetime | None]:
    if raw_frame is None or getattr(raw_frame, "empty", True):
        return None, None
    if "timestamp" not in raw_frame.columns:
        return None, None
    parsed: list[datetime] = []
    for value in raw_frame["timestamp"].dropna():
        if hasattr(value, "to_pydatetime"):
            dt = value.to_pydatetime()
        else:
            dt = _parse_timestamp(str(value))
        if dt is None:
            continue
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        parsed.append(dt)
    if not parsed:
        return None, None
    return min(parsed), max(parsed)


def protocol_signature_from_header(header_meta: dict[str, str] | None, nominal_capacity_mah: float | None) -> str | None:
    if not header_meta:
        return None
    reconstructed = protocol.reconstruct_protocol(header_meta, nominal_capacity_mah)
    return reconstructed.get("signature")


def _chronological_sort_key(source: dict[str, Any]) -> tuple:
    first_ts = source.get("first_record_timestamp")
    start_ts = _parse_timestamp(source.get("start_time"))
    reliable = 0 if first_ts is not None else 1
    primary = first_ts or start_ts or datetime.max.replace(tzinfo=timezone.utc)
    return (reliable, primary, source.get("input_order", 0))


def suggest_chronological_order(sources: list[dict[str, Any]]) -> list[str]:
    """Chronological order for any source list using the staged suggestion rules."""
    return [source["key"] for source in sorted(sources, key=_chronological_sort_key)]


def suggest_staged_order(sources: list[dict[str, Any]]) -> list[str]:
    staged = [source for source in sources if source.get("kind") == "staged"]
    return suggest_chronological_order(staged)


def _append_finding(
    findings: list[dict[str, Any]],
    *,
    code: FindingCode,
    severity: FindingSeverity,
    source_keys: list[str],
    title: str,
    message: str,
    details: dict[str, Any] | None = None,
) -> None:
    findings.append(
        {
            "id": finding_id(code, source_keys),
            "code": code,
            "severity": severity,
            "source_keys": source_keys,
            "title": title,
            "message": message,
            "details": details or {},
        }
    )


def validate_proposed_order(
    staged_keys: list[str],
    proposed_order: list[str] | None,
) -> list[dict[str, Any]]:
    if proposed_order is None:
        return []
    staged_set = set(staged_keys)
    proposed_set = set(proposed_order)
    if proposed_set != staged_set or len(proposed_order) != len(staged_keys):
        return [
            {
                "id": finding_id("invalid_proposed_order", staged_keys),
                "code": "invalid_proposed_order",
                "severity": "blocking",
                "source_keys": staged_keys,
                "title": "Proposed order is invalid",
                "message": (
                    "The proposed order must list every newly selected source exactly once."
                ),
                "details": {
                    "expected": staged_keys,
                    "proposed": proposed_order,
                },
            }
        ]
    return []


def validate_staged_keys(staged_keys: list[str]) -> None:
    """Reject ambiguous request-local identities before source inspection begins."""
    empty = [key for key in staged_keys if not str(key or "").strip()]
    duplicates = sorted(
        {key for key in staged_keys if key and staged_keys.count(key) > 1}
    )
    if not empty and not duplicates:
        return
    conflicting = empty or duplicates
    raise ContinuationValidationError(
        409,
        {
            "code": "duplicate_staged_source_key" if duplicates else "invalid_staged_source_key",
            "message": (
                "Every staged source needs a non-empty unique request key."
                if not duplicates
                else "Each staged source request key must be unique."
            ),
            "conflicting_keys": conflicting,
            "findings": [],
        },
    )


def _identity_findings(source: dict[str, Any]) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    key = source["key"]
    if source.get("unsupported_extension"):
        _append_finding(
            findings,
            code="unsupported_extension",
            severity="blocking",
            source_keys=[key],
            title="Unsupported file type",
            message=(
                "Only Neware .nda, .ndax, and structured .xlsx exports can be used as continuations."
            ),
        )
    if source.get("missing"):
        _append_finding(
            findings,
            code="source_missing",
            severity="blocking",
            source_keys=[key],
            title="Source file is missing",
            message="The selected file could not be found at its path.",
        )
    if source.get("unreadable"):
        _append_finding(
            findings,
            code="source_unreadable",
            severity="blocking",
            source_keys=[key],
            title="Source file could not be read",
            message=source.get("unreadable_message")
            or "The file could not be hashed or inspected.",
        )
    if source.get("changing"):
        _append_finding(
            findings,
            code="source_changing",
            severity="blocking",
            source_keys=[key],
            title="Source file is still changing",
            message="Wait for the cycler write to finish, then inspect again.",
        )
    if source.get("inspection_status") == "error" and not source.get("hash"):
        _append_finding(
            findings,
            code="inspection_failed",
            severity="blocking",
            source_keys=[key],
            title="Inspection failed",
            message=source.get("inspection_error")
            or "The source identity could not be established.",
        )
    if source.get("cache_build_error"):
        _append_finding(
            findings,
            code="cache_build_failed",
            severity="blocking",
            source_keys=[key],
            title="Source cache preparation failed",
            message=(
                "The source could not be prepared for complete continuation inspection. "
                "Inspect again after the problem is resolved."
            ),
            details={"error": source["cache_build_error"]},
        )
    linked_test_id = source.get("linked_test_id")
    existing_test_id = source.get("existing_test_id")
    if (
        source.get("kind") == "staged"
        and linked_test_id is not None
        and linked_test_id != existing_test_id
    ):
        _append_finding(
            findings,
            code="hash_already_linked",
            severity="blocking",
            source_keys=[key],
            title="Source already belongs to another test",
            message="Each Neware file can belong to only one test.",
            details={"linked_test_id": linked_test_id},
        )
    if source.get("path_refresh_candidate"):
        _append_finding(
            findings,
            code="path_refresh",
            severity="confirmation",
            source_keys=[key],
            title="Known source path would be refreshed",
            message=(
                "This file content is already indexed but stored at a different path. "
                "Attaching it will refresh the stored path and header metadata."
            ),
        )
    return findings


def _pair_findings(
    left: dict[str, Any],
    right: dict[str, Any],
    *,
    baseline: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    keys = [left["key"], right["key"]]
    baseline = baseline or left

    left_end = left.get("end_timestamp") or _parse_timestamp(left.get("end_time"))
    right_start = right.get("first_record_timestamp") or _parse_timestamp(right.get("start_time"))

    if left_end and right_start and left_end > right_start:
        _append_finding(
            findings,
            code="timestamp_overlap",
            severity="confirmation",
            source_keys=keys,
            title="Recorded timestamps overlap",
            message=(
                "The later file starts before the earlier file ends. "
                "Review the order if these files should represent a strict continuation."
            ),
            details={
                "left_end": _iso_timestamp(left_end),
                "right_start": _iso_timestamp(right_start),
            },
        )
    elif left_end and right_start and right_start >= left_end:
        gap_seconds = (right_start - left_end).total_seconds()
        if gap_seconds > 0:
            _append_finding(
                findings,
                code="timestamp_gap",
                severity="warning" if gap_seconds >= 3600 else "info",
                source_keys=keys,
                title="Gap between source files",
                message=(
                    f"There is about {_format_duration(gap_seconds)} between the end of "
                    f"{left.get('filename')} and the start of {right.get('filename')}."
                ),
                details={
                    "gap_seconds": gap_seconds,
                    "gap_label": _format_duration(gap_seconds),
                    "left_end": _iso_timestamp(left_end),
                    "right_start": _iso_timestamp(right_start),
                },
            )

    if left.get("inspection_status") != "ready" or right.get("inspection_status") != "ready":
        if not left_end or not right_start:
            _append_finding(
                findings,
                code="timestamp_confidence_incomplete",
                severity="info",
                source_keys=keys,
                title="Timestamp confidence is incomplete",
                message=(
                    "Some timing details are still pending cache preparation. "
                    "Re-inspect after parsing finishes for final gap/overlap findings."
                ),
            )

    reference = baseline
    ref_capacity = reference.get("nominal_capacity_mah")
    ref_mass = reference.get("active_mass_mg")
    for label, field, code in (
        ("Nominal capacity", "nominal_capacity_mah", "nominal_capacity_mismatch"),
        ("Active mass", "active_mass_mg", "active_mass_mismatch"),
    ):
        right_value = right.get(field)
        reference_value = ref_capacity if field == "nominal_capacity_mah" else ref_mass
        if materially_differs(right_value, reference_value):
            _append_finding(
                findings,
                code=code,
                severity="confirmation",
                source_keys=[baseline["key"], right["key"]],
                title=f"{label} differs materially",
                message=(
                    f"{label} in {right.get('filename')} differs by more than 5% from "
                    f"{baseline.get('filename')}."
                ),
                details={
                    "baseline": reference_value,
                    "value": right_value,
                },
            )

    for field, code, title in (
        ("device_info", "device_changed", "Device information differs"),
        ("channel", "channel_changed", "Channel differs"),
        ("remarks", "remarks_changed", "Remarks differ"),
        ("barcode", "barcode_changed", "Barcode differs"),
    ):
        left_value = _norm(left.get(field))
        right_value = _norm(right.get(field))
        if left_value and right_value and left_value != right_value:
            _append_finding(
                findings,
                code=code,
                severity="info",
                source_keys=keys,
                title=title,
                message=f"{title} between {left.get('filename')} and {right.get('filename')}.",
                details={"left": left.get(field), "right": right.get(field)},
            )

    left_sig = left.get("protocol_signature")
    right_sig = right.get("protocol_signature")
    if left_sig and right_sig and left_sig != right_sig:
        _append_finding(
            findings,
            code="protocol_changed",
            severity="info",
            source_keys=keys,
            title="Protocol signatures differ",
            message=(
                "The continuation uses a different protocol signature. "
                "This is common after removing completed steps."
            ),
            details={
                "left_protocol_signature": left_sig,
                "right_protocol_signature": right_sig,
            },
        )

    left_start_cycle = left.get("local_cycle_start")
    left_end_cycle = left.get("local_cycle_end")
    right_start_cycle = right.get("local_cycle_start")
    right_end_cycle = right.get("local_cycle_end")
    if (
        left_start_cycle is None
        or left_end_cycle is None
        or right_start_cycle is None
        or right_end_cycle is None
    ):
        return findings

    if right_start_cycle <= 1 and left_end_cycle >= 1:
        _append_finding(
            findings,
            code="local_cycles_restart",
            severity="info",
            source_keys=keys,
            title="Local cycle numbers restart",
            message=(
                f"{right.get('filename')} restarts local cycle numbering after "
                f"{left.get('filename')}."
            ),
            details={
                "left_end": left_end_cycle,
                "right_start": right_start_cycle,
            },
        )
    elif right_start_cycle == left_end_cycle + 1:
        _append_finding(
            findings,
            code="local_cycles_continue",
            severity="info",
            source_keys=keys,
            title="Local cycle numbers continue",
            message=(
                f"{right.get('filename')} continues local cycle numbering from "
                f"{left.get('filename')}."
            ),
            details={
                "left_end": left_end_cycle,
                "right_start": right_start_cycle,
            },
        )
    elif right_start_cycle <= left_end_cycle:
        _append_finding(
            findings,
            code="local_cycles_overlap",
            severity="info",
            source_keys=keys,
            title="Local cycle numbers overlap",
            message=(
                f"{right.get('filename')} reuses local cycle numbers already present in "
                f"{left.get('filename')}."
            ),
            details={
                "left_range": [left_start_cycle, left_end_cycle],
                "right_range": [right_start_cycle, right_end_cycle],
            },
        )
    elif right_start_cycle > left_end_cycle + 1:
        _append_finding(
            findings,
            code="local_cycles_gap",
            severity="info",
            source_keys=keys,
            title="Local cycle numbers have a gap",
            message=(
                f"{right.get('filename')} starts at local cycle {right_start_cycle} after "
                f"{left.get('filename')} ended at {left_end_cycle}."
            ),
            details={
                "left_end": left_end_cycle,
                "right_start": right_start_cycle,
            },
        )

    return findings


def _duplicate_hash_findings(ordered_sources: list[dict[str, Any]]) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    seen: dict[str, str] = {}
    for source in ordered_sources:
        file_hash = source.get("hash")
        if not file_hash:
            continue
        if file_hash in seen:
            keys = sorted({seen[file_hash], source["key"]})
            _append_finding(
                findings,
                code="duplicate_hash",
                severity="blocking",
                source_keys=keys,
                title="Duplicate source content",
                message="The same file content appears more than once in the proposed chain.",
                details={"hash": file_hash},
            )
        else:
            seen[file_hash] = source["key"]
    return findings


def _order_reversed_findings(
    staged_keys: list[str],
    proposed_staged_order: list[str],
    suggested_order: list[str],
) -> list[dict[str, Any]]:
    if not staged_keys or proposed_staged_order == suggested_order:
        return []
    if proposed_staged_order != list(reversed(suggested_order)):
        return []
    return [
        {
            "id": finding_id("order_reversed", staged_keys),
            "code": "order_reversed",
            "severity": "confirmation",
            "source_keys": staged_keys,
            "title": "Order reverses the suggested chronology",
            "message": (
                "The selected order runs opposite to the suggested chronological order. "
                "Confirm this is intentional before continuing."
            ),
            "details": {
                "suggested_order": suggested_order,
                "proposed_order": proposed_staged_order,
            },
        }
    ]


def _continuation_chain_response(
    ordered_sources: list[dict[str, Any]],
    *,
    findings: list[dict[str, Any]],
    suggested_order: list[str],
) -> dict[str, Any]:
    deduped: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    sources_by_key = {source["key"]: source for source in ordered_sources}
    for finding in findings:
        # Include the ordered source identity in the semantic fingerprint. This
        # makes an acknowledgement expire when a registered source hash or the
        # proposed order changes, while title/message edits remain presentation
        # changes only.
        finding["id"] = finding_id(
            finding["code"],
            list(finding.get("source_keys") or []),
            {
                "details": finding.get("details") or {},
                "source_identity": [
                    {
                        "key": key,
                        "hash": sources_by_key.get(key, {}).get("hash"),
                    }
                    for key in finding.get("source_keys") or []
                ],
            },
        )
        if finding["id"] in seen_ids:
            continue
        seen_ids.add(finding["id"])
        deduped.append(finding)

    inspection_complete = all(
        source.get("inspection_status") == "ready" for source in ordered_sources
    )
    can_submit = inspection_complete and not any(
        item["severity"] == "blocking" for item in deduped
    )
    response_sources = []
    for source in ordered_sources:
        response_sources.append(
            {
                "key": source["key"],
                "kind": source["kind"],
                "source_file_id": source.get("source_file_id"),
                "filename": source.get("filename"),
                "source_path": source.get("source_path"),
                "hash": source.get("hash"),
                "start_time": source.get("start_time"),
                "end_time": source.get("end_time"),
                "local_cycle_start": source.get("local_cycle_start"),
                "local_cycle_end": source.get("local_cycle_end"),
                "local_cycle_count": source.get("local_cycle_count"),
                "protocol_signature": source.get("protocol_signature"),
                "device_info": source.get("device_info"),
                "channel": source.get("channel"),
                "nominal_capacity_mah": source.get("nominal_capacity_mah"),
                "active_mass_mg": source.get("active_mass_mg"),
                "inspection_status": source.get("inspection_status", "pending"),
                "inspection_error": source.get("inspection_error"),
                "cache_build_status": source.get("cache_build_status"),
                "location_status": source.get("location_status"),
                "parse_status": source.get("parse_status"),
                "row_count": source.get("row_count"),
            }
        )

    return {
        "sources": response_sources,
        "suggested_order": suggested_order,
        "findings": deduped,
        "inspection_complete": inspection_complete,
        "can_submit": can_submit,
    }


def analyze_existing_order_chain(
    ordered_sources: list[dict[str, Any]],
) -> dict[str, Any]:
    """Inspect a proposed order of sources already attached to a test."""
    findings: list[dict[str, Any]] = []
    for source in ordered_sources:
        findings.extend(_identity_findings(source))
    findings.extend(_duplicate_hash_findings(ordered_sources))

    source_keys = [source["key"] for source in ordered_sources]
    suggested_order = suggest_chronological_order(ordered_sources)
    findings.extend(
        _order_reversed_findings(source_keys, source_keys, suggested_order)
    )

    baseline = ordered_sources[0] if ordered_sources else None
    for left, right in zip(ordered_sources, ordered_sources[1:]):
        findings.extend(_pair_findings(left, right, baseline=baseline))

    return _continuation_chain_response(
        ordered_sources,
        findings=findings,
        suggested_order=suggested_order,
    )


def analyze_continuation_chain(
    ordered_sources: list[dict[str, Any]],
    *,
    staged_keys: list[str],
    proposed_staged_order: list[str] | None = None,
) -> dict[str, Any]:
    findings: list[dict[str, Any]] = []
    findings.extend(validate_proposed_order(staged_keys, proposed_staged_order))
    for source in ordered_sources:
        findings.extend(_identity_findings(source))
    findings.extend(_duplicate_hash_findings(ordered_sources))

    suggested_order = suggest_staged_order(ordered_sources)
    effective_staged_order = proposed_staged_order if proposed_staged_order is not None else staged_keys
    findings.extend(
        _order_reversed_findings(staged_keys, effective_staged_order, suggested_order)
    )

    baseline = ordered_sources[0] if ordered_sources else None
    for left, right in zip(ordered_sources, ordered_sources[1:]):
        findings.extend(_pair_findings(left, right, baseline=baseline))

    return _continuation_chain_response(
        ordered_sources,
        findings=findings,
        suggested_order=suggested_order,
    )


def _maybe_schedule_cache_build(file_hash: str, source_path) -> dict[str, str | None]:
    if source_path is None:
        return {"status": "failed", "error": "Source path is unavailable for cache preparation."}
    return cache.schedule_build(file_hash, source_path)


def enrich_source_timing(source: dict[str, Any], *, source_path=None) -> dict[str, Any]:
    """Fill timing/cycle fields from existing caches when available."""
    file_hash = source.get("hash")
    if not file_hash:
        source["inspection_status"] = "error"
        source.setdefault("inspection_error", "Missing content hash")
        return source

    cycles_ready = cache.has_cycles(file_hash, parsing.PARSER_VERSION, CALC_VERSION)
    raw_ready = cache.raw_path(file_hash, parsing.PARSER_VERSION).is_file()
    cycles_frame = None
    raw_frame = None

    if raw_ready:
        raw_frame = cache.load_raw(file_hash, parsing.PARSER_VERSION)
        raw_ready = raw_frame is not None

    # A raw-only cache can derive the current cycle cache without rereading the
    # source. The result is still incomplete if that derivation is unavailable.
    if cycles_ready or raw_ready:
        cycles_frame = cache.load_cycles(file_hash, parsing.PARSER_VERSION, CALC_VERSION)
        cycles_ready = cycles_frame is not None

    if cycles_ready:
        start, end, count, errors = cycle_range_from_frame(cycles_frame)
        if errors:
            source["inspection_status"] = "error"
            source["inspection_error"] = "; ".join(errors)
            return source
        source["local_cycle_start"] = start
        source["local_cycle_end"] = end
        source["local_cycle_count"] = count

    if raw_ready:
        first_ts, last_ts = timestamp_range_from_raw(raw_frame)
        source["first_record_timestamp"] = first_ts
        if last_ts is not None:
            source["end_time"] = _iso_timestamp(last_ts)
            source["end_timestamp"] = last_ts

    missing_cache = []
    if not cycles_ready:
        missing_cache.append("cycle")
    if not raw_ready:
        missing_cache.append("raw")
    if missing_cache:
        build_result = _maybe_schedule_cache_build(file_hash, source_path)
        source["cache_build_status"] = build_result["status"]
        if build_result["status"] == "failed":
            source["inspection_status"] = "error"
            source["cache_build_error"] = build_result.get("error") or (
                "Cache preparation failed."
            )
            source["inspection_error"] = source["cache_build_error"]
        else:
            source["inspection_status"] = "pending"
        return source

    source["cache_build_status"] = "ready"
    source["inspection_status"] = "ready"
    return source


def header_fields_from_metadata(meta: dict[str, Any]) -> dict[str, Any]:
    header_meta = meta.get("raw") or {}
    nominal = meta.get("nominal_capacity_mah")
    return {
        "start_time": meta.get("start_time"),
        "device_info": meta.get("device_info"),
        "channel": meta.get("channel"),
        "barcode": meta.get("barcode"),
        "remarks": meta.get("remarks"),
        "nominal_capacity_mah": nominal,
        "active_mass_mg": meta.get("active_mass_mg"),
        "protocol_signature": protocol_signature_from_header(header_meta, nominal),
        "metadata_error": meta.get("error"),
    }


class ContinuationValidationError(Exception):
    """Structured rejection for lifecycle mutations."""

    def __init__(self, status_code: int, payload: dict[str, Any]):
        self.status_code = status_code
        self.payload = payload
        super().__init__(payload.get("message") or "Continuation validation failed")


def hash_prefix(file_hash: str | None) -> str | None:
    if not file_hash:
        return None
    return file_hash[:8]


def unacknowledged_confirmation_findings(
    findings: list[dict[str, Any]],
    acknowledged_finding_ids: list[str] | None,
) -> list[dict[str, Any]]:
    acknowledged = set(acknowledged_finding_ids or [])
    return [
        finding
        for finding in findings
        if finding.get("severity") == "confirmation" and finding["id"] not in acknowledged
    ]


def ensure_submittable_chain(
    analysis: dict[str, Any],
    acknowledged_finding_ids: list[str] | None,
) -> None:
    sources = analysis.get("sources") or []
    incomplete_sources = [
        source
        for source in sources
        if source.get("inspection_status", "pending") != "ready"
    ]
    if analysis.get("inspection_complete") is False or incomplete_sources:
        raise ContinuationValidationError(
            409,
            {
                "code": "inspection_incomplete",
                "message": "Complete source inspection is required before submission.",
                "sources": [
                    {
                        "key": source.get("key"),
                        "inspection_status": source.get("inspection_status"),
                        "inspection_error": source.get("inspection_error"),
                    }
                    for source in incomplete_sources
                ],
                "findings": analysis.get("findings") or [],
            },
        )
    if not analysis.get("can_submit"):
        blocking = [
            finding for finding in analysis.get("findings") or [] if finding.get("severity") == "blocking"
        ]
        raise ContinuationValidationError(
            409,
            {
                "message": "The proposed continuation chain cannot be submitted.",
                "findings": blocking,
            },
        )
    unacknowledged = unacknowledged_confirmation_findings(
        analysis.get("findings") or [],
        acknowledged_finding_ids,
    )
    if unacknowledged:
        raise ContinuationValidationError(
            422,
            {
                "message": "Confirmation is required before continuing.",
                "findings": unacknowledged,
            },
        )


def validate_exact_file_id_permutation(
    current_file_ids: list[int],
    proposed_file_ids: list[int],
) -> None:
    current = list(current_file_ids)
    proposed = list(proposed_file_ids)
    if len(proposed) != len(current):
        raise ContinuationValidationError(
            409,
            {
                "message": "Reorder must list every current test source exactly once.",
                "findings": [
                    {
                        "id": finding_id("invalid_proposed_order", [str(value) for value in current]),
                        "code": "invalid_proposed_order",
                        "severity": "blocking",
                        "source_keys": [str(value) for value in current],
                        "title": "Reorder is not a full permutation",
                        "message": (
                            "The reorder request must include every attached source ID exactly once."
                        ),
                        "details": {
                            "expected_count": len(current),
                            "received_count": len(proposed),
                            "expected": current,
                            "proposed": proposed,
                        },
                    }
                ],
            },
        )
    if len(set(proposed)) != len(proposed):
        raise ContinuationValidationError(
            409,
            {
                "message": "Reorder cannot contain duplicate source IDs.",
                "findings": [],
            },
        )
    if set(proposed) != set(current):
        raise ContinuationValidationError(
            409,
            {
                "message": "Reorder cannot include unknown or foreign source IDs.",
                "findings": [],
            },
        )


def inspect_path_integrity(path) -> dict[str, Any]:
    from .scanner import source_signature

    if not path.exists() or not path.is_file():
        return {
            "missing": True,
            "unreadable": False,
            "changing": False,
            "message": None,
            "hash": None,
        }
    try:
        before = source_signature(path)
    except OSError as exc:
        return {
            "missing": False,
            "unreadable": True,
            "changing": False,
            "message": str(exc),
            "hash": None,
        }
    try:
        file_hash = parsing.compute_hash(path)
    except OSError as exc:
        return {
            "missing": False,
            "unreadable": True,
            "changing": False,
            "message": str(exc),
            "hash": None,
        }
    try:
        after = source_signature(path)
    except OSError as exc:
        return {
            "missing": False,
            "unreadable": True,
            "changing": False,
            "message": str(exc),
            "hash": file_hash,
        }
    if before != after:
        return {
            "missing": False,
            "unreadable": False,
            "changing": True,
            "message": None,
            "hash": file_hash,
        }
    return {
        "missing": False,
        "unreadable": False,
        "changing": False,
        "message": None,
        "hash": file_hash,
    }
