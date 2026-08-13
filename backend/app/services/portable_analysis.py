"""Single-file portable HTML export/import for CellXplorer analyses.

The HTML is both a standalone report and a versioned data container. Import
parses only the manifest and known payload elements; embedded JavaScript is
never executed by CellXplorer.
"""
from __future__ import annotations

import base64
import gzip
import hashlib
import html
import json
import mmap
import os
import re
import shutil
import tempfile
import time
import uuid
import zlib
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import BinaryIO, Iterable

from fastapi import HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..config import APP_VERSION, CALC_VERSION, IMPORT_DIR
from ..migrations.registry import CURRENT_SCHEMA_REVISION
from ..models import (
    Analysis,
    Cell,
    CellMetadata,
    Folder,
    FolderCell,
    ReplicateGroup,
    ReplicateGroupCell,
    SourceFile,
    Test,
    TestFile,
)
from . import analysis_engine, cache, cache_maintenance, diagnostic_cycles, parsing, scanner
from .activity_log import record_activity
from .entity_ids import next_analysis_id

FORMAT_ID = "cellxplorer-portable-analysis"
FORMAT_VERSION = 2
SUPPORTED_FORMAT_VERSIONS = {1, FORMAT_VERSION}
MANIFEST_ID = "cellxplorer-manifest"
PAYLOAD_PREFIX = "cellxplorer-payload-"
_CHUNK_SIZE = 1024 * 1024
_SAFE_ID = re.compile(r"^[A-Za-z0-9_.-]+$")
_PENDING_MAX_AGE_SECONDS = 24 * 60 * 60


def _deep_link_import_base() -> str:
    from .app_channel import deep_link_import_base

    return deep_link_import_base()


class PortableOriginalSourceError(RuntimeError):
    """Raised when a sources-included export cannot preserve source identity."""


def _plotly_runtime_path() -> Path:
    path = Path(__file__).resolve().parents[1] / "assets" / "plotly.min.js"
    if not path.is_file():
        raise RuntimeError("The portable-report Plotly runtime is unavailable.")
    return path


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _json_bytes(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=True,
        allow_nan=False,
        separators=(",", ":"),
    ).encode("utf-8")


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(_CHUNK_SIZE):
            digest.update(chunk)
    return digest.hexdigest()


def _pending_import_dir() -> Path:
    path = IMPORT_DIR / "portable-pending"
    path.mkdir(parents=True, exist_ok=True)
    return path


def cleanup_pending_imports() -> None:
    cutoff = time.time() - _PENDING_MAX_AGE_SECONDS
    for path in _pending_import_dir().glob("*.html"):
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink(missing_ok=True)
        except OSError:
            continue


def stage_import(source_path: Path, *, preserve_source: bool = False) -> str:
    cleanup_pending_imports()
    token = uuid.uuid4().hex
    destination = _pending_import_dir() / f"{token}.html"
    if preserve_source:
        shutil.copy2(source_path, destination)
    else:
        shutil.move(str(source_path), destination)
    return token


def pending_import_path(token: str) -> Path:
    if not re.fullmatch(r"[a-f0-9]{32}", token):
        raise HTTPException(400, "Invalid portable import token.")
    path = _pending_import_dir() / f"{token}.html"
    if not path.is_file():
        raise HTTPException(404, "This portable import has expired. Select the file again.")
    return path


def discard_pending_import(token: str) -> None:
    pending_import_path(token).unlink(missing_ok=True)


def _copy_and_hash(source: BinaryIO, destination: BinaryIO) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    while chunk := source.read(_CHUNK_SIZE):
        destination.write(chunk)
        digest.update(chunk)
        size += len(chunk)
    return size, digest.hexdigest()


def _prepare_payload(
    temp_dir: Path,
    *,
    payload_id: str,
    kind: str,
    content_type: str,
    source_path: Path | None = None,
    data: bytes | None = None,
    metadata: dict | None = None,
) -> tuple[dict, Path]:
    if not _SAFE_ID.fullmatch(payload_id):
        raise ValueError(f"Unsafe portable payload id: {payload_id}")
    plain_path = temp_dir / f"{payload_id}.plain"
    if source_path is not None:
        with source_path.open("rb") as source, plain_path.open("wb") as destination:
            original_bytes, digest = _copy_and_hash(source, destination)
    else:
        value = data or b""
        plain_path.write_bytes(value)
        original_bytes = len(value)
        digest = hashlib.sha256(value).hexdigest()

    compressed_path = temp_dir / f"{payload_id}.gz"
    with plain_path.open("rb") as source, gzip.open(compressed_path, "wb", compresslevel=9) as output:
        shutil.copyfileobj(source, output, length=_CHUNK_SIZE)
    plain_path.unlink(missing_ok=True)
    descriptor = {
        "id": payload_id,
        "kind": kind,
        "content_type": content_type,
        "encoding": "base64",
        "compression": "gzip",
        "sha256": digest,
        "uncompressed_bytes": original_bytes,
        "compressed_bytes": compressed_path.stat().st_size,
        **(metadata or {}),
    }
    return descriptor, compressed_path


def _write_base64(source_path: Path, destination: BinaryIO) -> None:
    carry = b""
    with source_path.open("rb") as source:
        while chunk := source.read(_CHUNK_SIZE):
            block = carry + chunk
            usable = len(block) - (len(block) % 3)
            if usable:
                destination.write(base64.b64encode(block[:usable]))
            carry = block[usable:]
    if carry:
        destination.write(base64.b64encode(carry))


def _selected_entities(db: Session, analysis: Analysis) -> tuple[list[Cell], list[ReplicateGroup]]:
    units, missing = analysis_engine.resolve_selection(db, analysis.spec)
    if missing:
        refs = ", ".join(f"{item['kind']} #{item['ref_id']}" for item in missing)
        raise HTTPException(409, f"The analysis contains missing references: {refs}")
    cells_by_id: dict[int, Cell] = {}
    for unit in units:
        cells_by_id.setdefault(unit["cell"].id, unit["cell"])
    group_ids = {
        int(entry["ref_id"])
        for entry in analysis.spec.get("selection", {}).get("entries", [])
        if entry.get("kind") == "replicate_group"
    }
    groups = [
        group
        for group_id in sorted(group_ids)
        if (group := db.get(ReplicateGroup, group_id)) is not None
    ]
    return (
        list(cells_by_id.values()),
        groups,
    )


def _portable_saved_plot_spec(base: dict, plot: dict) -> dict:
    spec = deepcopy(base)
    saved_selection = plot.get("selection") or {}
    base_selection = base.get("selection") or {}
    spec["selection"] = {
        "entries": deepcopy(base_selection.get("entries") or []),
        "exclusions": deepcopy(saved_selection.get("exclusions") or []),
        "hidden_replicate_group_ids": deepcopy(
            saved_selection.get("hidden_replicate_group_ids") or []
        ),
    }
    for key in ("computation", "aggregation", "presentation"):
        if plot.get(key) is not None:
            spec[key] = deepcopy(plot[key])
    return spec


def _guard_portable_protocol_family(
    db: Session,
    analysis: Analysis,
    tab: str,
) -> None:
    family = "rate_capability" if tab == "crate" else tab
    detail = analysis_engine.protocol_analysis_guard(db, analysis.spec, family)
    if detail is not None:
        raise HTTPException(status_code=422, detail=detail)


def _report_views(db: Session, analysis: Analysis) -> list[dict]:
    views: list[dict] = []
    saved_plots = analysis.spec.get("saved_plots") or []
    for plot in saved_plots:
        tab = plot.get("tab") or "cycles"
        _guard_portable_protocol_family(db, analysis, tab)
        spec = _portable_saved_plot_spec(analysis.spec, plot)
        result = (
            analysis_engine.compute_time_capacity(db, spec, analysis.provenance)
            if tab == "time_capacity"
            else analysis_engine.compute(db, spec, analysis.provenance)
        )
        presentation = spec.get("presentation", {})
        # A filtered plot must declare what it removed. The result itself always
        # keeps every cycle, so re-importing this report can undo the choice even
        # when the original source files are long gone.
        hidden_cycles: list[int] = []
        if presentation.get("hide_diagnostic_cycles") and tab != "time_capacity":
            hidden_cycles = diagnostic_cycles.find_across(
                result,
                tolerance=float(
                    presentation.get("diagnostic_tolerance")
                    or diagnostic_cycles.DEFAULT_TOLERANCE
                ),
            )
        views.append(
            {
                "id": str(plot.get("id") or uuid.uuid4()),
                "name": plot.get("name") or "Saved plot",
                "subtitle": plot.get("subtitle") or "",
                "description": plot.get("description"),
                "tab": tab,
                "presentation": presentation,
                "hidden_cycles": hidden_cycles,
                "hidden_cycle_ranges": diagnostic_cycles.format_ranges(hidden_cycles),
                "result": result,
            }
        )
    if not views:
        _guard_portable_protocol_family(db, analysis, "cycles")
        views.append(
            {
                "id": "current",
                "name": analysis.title,
                "subtitle": "Current analysis view",
                "description": None,
                "tab": "cycles",
                "presentation": analysis.spec.get("presentation", {}),
                "result": analysis_engine.compute(db, analysis.spec, analysis.provenance),
            }
        )
    return views


def _source_document(source: SourceFile) -> dict:
    return {
        "portable_id": f"source-{source.hash}",
        "original_id": source.id,
        "hash": source.hash,
        "path": source.path,
        "filename": source.filename,
        "size": source.size,
        "ext": source.ext,
        "nda_version": source.nda_version,
        "device_info": source.device_info,
        "channel": source.channel,
        "barcode": source.barcode,
        "remarks": source.remarks,
        "start_time": source.start_time,
        "active_mass_mg": source.active_mass_mg,
        "nominal_capacity_mah": source.nominal_capacity_mah,
        "header_meta": source.header_meta,
        "parser_version": source.parser_version,
        "row_count": source.row_count,
        "cycle_count": source.cycle_count,
        "total_charge_capacity_mah": source.total_charge_capacity_mah,
        "total_discharge_capacity_mah": source.total_discharge_capacity_mah,
        "capacity_summary_status": source.capacity_summary_status,
    }


def _single_internal_test(cell: Cell) -> Test:
    return analysis_engine.require_single_internal_test(cell)


def _ordered_cell_links(cell: Cell) -> list[TestFile]:
    test = _single_internal_test(cell)
    return sorted(test.file_links, key=lambda item: (item.position, item.id))


def _cell_document(cell: Cell) -> dict:
    links = _ordered_cell_links(cell)
    return {
        "portable_id": f"cell-{cell.id}",
        "original_id": cell.id,
        "name": cell.name,
        "description": cell.description,
        "archived": cell.archived,
        "cycling_status": cell.cycling_status,
        "created_at": cell.created_at.isoformat(),
        "metadata": {entry.key: entry.value for entry in cell.metadata_entries},
        "sources": [
            {
                "source_id": f"source-{link.file.hash}",
                "position": position,
                "tracked_tail": position == len(links),
            }
            for position, link in enumerate(links, start=1)
        ],
    }


def _group_document(group: ReplicateGroup) -> dict:
    return {
        "portable_id": f"group-{group.id}",
        "original_id": group.id,
        "name": group.name,
        "description": group.description,
        "created_at": group.created_at.isoformat(),
        "cell_ids": [
            f"cell-{link.cell_id}"
            for link in sorted(group.cell_links, key=lambda item: item.position)
        ],
    }


def estimate_export(db: Session, analysis: Analysis) -> dict:
    cells, _ = _selected_entities(db, analysis)
    source_rows = _analysis_sources(analysis, db)
    original_bytes = 0
    missing_originals = 0
    for source, _cell in source_rows:
        source_path = Path(source.path)
        if source_path.is_file():
            original_bytes += source_path.stat().st_size
        else:
            missing_originals += 1
    runtime_data = _plotly_runtime_path().read_bytes()
    runtime_bytes = len(runtime_data)
    runtime_compressed_bytes = len(gzip.compress(runtime_data, compresslevel=9))
    runtime_embedded_bytes = ((runtime_compressed_bytes + 2) // 3) * 4
    plot_count = max(1, len(analysis.spec.get("saved_plots") or []))
    # Figure density varies considerably. This estimate models the measured
    # fixed report shell/runtime and a modest per-plot allowance without
    # recomputing every saved plot merely to open the modal.
    report_shell_bytes = 96 * 1024
    estimated_per_plot_bytes = 128 * 1024
    estimated_without_originals = (
        runtime_embedded_bytes
        + report_shell_bytes
        + plot_count * estimated_per_plot_bytes
    )
    estimated_with_originals = int(
        estimated_without_originals + original_bytes * 4 / 3
    )
    return {
        "cells": len(cells),
        "sources": len(source_rows),
        "cache_bytes": 0,
        "runtime_bytes": runtime_bytes,
        "runtime_embedded_bytes": runtime_embedded_bytes,
        "plot_count": plot_count,
        "report_shell_bytes": report_shell_bytes,
        "estimated_per_plot_bytes": estimated_per_plot_bytes,
        "original_bytes": original_bytes,
        "missing_originals": missing_originals,
        "estimated_without_originals": estimated_without_originals,
        "estimated_with_originals": estimated_with_originals,
    }


def _analysis_sources(analysis: Analysis, db: Session) -> list[tuple[SourceFile, Cell]]:
    cells, _ = _selected_entities(db, analysis)
    sources: dict[int, tuple[SourceFile, Cell]] = {}
    for cell in cells:
        for link in _ordered_cell_links(cell):
            sources.setdefault(link.file.id, (link.file, cell))
    return list(sources.values())


def preflight_original_sources(db: Session, analysis: Analysis) -> dict:
    """Hash selected originals without adopting them and report export readiness."""
    items: list[dict] = []
    changed_cell_ids: set[int] = set()
    for source, cell in _analysis_sources(analysis, db):
        item = {
            "source_id": source.id,
            "filename": source.filename,
            "path": source.path,
            "cell_id": cell.id,
            "cell_name": cell.name,
            "status": "error",
            "expected_size": None,
            "expected_mtime_ns": None,
            "message": None,
        }
        path = Path(source.path)
        try:
            expected = scanner.source_signature(path)
        except FileNotFoundError:
            item["status"] = "unavailable"
            item["message"] = "The recorded source path is unavailable."
            items.append(item)
            continue
        except OSError as exc:
            item["message"] = f"The source could not be read: {exc}"
            items.append(item)
            continue

        item["expected_size"] = expected[0]
        # Nanosecond timestamps exceed JavaScript's safe integer range. Keep
        # the exact stability token while it crosses the frontend.
        item["expected_mtime_ns"] = str(expected[1])
        try:
            observed_hash = parsing.compute_hash(path)
            current = scanner.source_signature(path)
        except FileNotFoundError:
            item["status"] = "unavailable"
            item["message"] = "The source became unavailable while it was checked."
        except OSError as exc:
            item["message"] = f"The source could not be read: {exc}"
        else:
            if current != expected:
                item["status"] = "changing"
                item["message"] = "The source is still changing. Wait for the cycler write to finish."
            elif observed_hash == source.hash:
                item["status"] = "current"
                item["message"] = "The source matches the version stored by CellXplorer."
            else:
                item["status"] = "changed"
                item["message"] = "The source contents differ from the stored version."
                changed_cell_ids.add(cell.id)
        items.append(item)

    counts = {
        status: sum(item["status"] == status for item in items)
        for status in ("current", "changed", "unavailable", "changing", "error")
    }
    affected_analysis_ids = cache_maintenance.dependent_analysis_ids(
        db, changed_cell_ids
    )
    return {
        "ready": counts["current"] == len(items),
        "sources": items,
        **counts,
        "affected_analysis_ids": affected_analysis_ids,
        "affected_analyses": len(affected_analysis_ids),
    }


def update_original_sources(
    db: Session,
    analysis: Analysis,
    updates: list[dict],
) -> dict:
    """Adopt explicitly selected, stable source versions used by an analysis."""
    selected = {
        source.id: (source, cell)
        for source, cell in _analysis_sources(analysis, db)
    }
    updated_source_ids: list[int] = []
    updated_cell_ids: set[int] = set()
    errors: list[dict] = []
    seen: set[int] = set()
    for update in updates:
        source_id = int(update["source_id"])
        if source_id in seen:
            continue
        seen.add(source_id)
        selected_item = selected.get(source_id)
        if selected_item is None:
            errors.append(
                {
                    "source_id": source_id,
                    "filename": f"Source #{source_id}",
                    "error": "This source does not belong to the analysis.",
                }
            )
            continue
        source, cell = selected_item
        try:
            scanner.update_source_from_path_if_stable(
                db,
                source,
                expected_size=int(update["expected_size"]),
                expected_mtime_ns=int(update["expected_mtime_ns"]),
            )
        except scanner.SourceChangedDuringRead as exc:
            errors.append(
                {
                    "source_id": source_id,
                    "filename": source.filename,
                    "error": str(exc),
                }
            )
        except Exception as exc:
            errors.append(
                {
                    "source_id": source_id,
                    "filename": source.filename,
                    "error": str(exc),
                }
            )
        else:
            updated_source_ids.append(source_id)
            updated_cell_ids.add(cell.id)

    result = {
        "updated": len(updated_source_ids),
        "updated_source_ids": updated_source_ids,
        "updated_cell_ids": sorted(updated_cell_ids),
        "errors": errors,
        "preflight": preflight_original_sources(db, analysis),
    }
    if updated_source_ids or errors:
        record_activity(
            db,
            category="analysis",
            action="update_sources_for_portable_export",
            message=(
                f'Updated {len(updated_source_ids)} source file'
                f'{"s" if len(updated_source_ids) != 1 else ""} before exporting '
                f'"{analysis.title}".'
            ),
            entity_type="analysis",
            entity_id=analysis.id,
            details={
                "updated_source_ids": updated_source_ids,
                "updated_cell_ids": sorted(updated_cell_ids),
                "error_count": len(errors),
            },
        )
        db.commit()
    return result


def export_analysis_html(
    db: Session,
    analysis: Analysis,
    destination: Path,
    *,
    include_original_files: bool,
    strict_original_files: bool = False,
    views: list[dict] | None = None,
) -> dict:
    cells, groups = _selected_entities(db, analysis)
    source_rows = _analysis_sources(analysis, db)
    sources = [source for source, _cell in source_rows]
    for view in views or []:
        _guard_portable_protocol_family(db, analysis, str(view.get("tab") or "cycles"))
    export_id = str(uuid.uuid4())
    warnings: list[str] = []

    with tempfile.TemporaryDirectory(prefix="cellxplorer-portable-") as temporary:
        temp_dir = Path(temporary)
        payloads: list[dict] = []
        payload_paths: dict[str, Path] = {}

        source_documents = [_source_document(source) for source in sources]
        # Draft plots are local workspace state — never ship them in a portable report.
        export_spec = deepcopy(analysis.spec or {})
        export_spec.pop("draft_plot", None)
        export_spec.pop("draft_plots", None)
        package = {
            "package_version": FORMAT_VERSION,
            "export_id": export_id,
            "created_at": _now_iso(),
            "analysis": {
                "original_id": analysis.id,
                "title": analysis.title,
                "spec": export_spec,
                "provenance": analysis.provenance,
                "created_at": analysis.created_at.isoformat(),
                "modified_at": analysis.modified_at.isoformat(),
            },
            "cells": [_cell_document(cell) for cell in cells],
            "replicate_groups": [_group_document(group) for group in groups],
            "sources": source_documents,
            "views": views if views is not None else _report_views(db, analysis),
            "warnings": warnings,
        }
        descriptor, path = _prepare_payload(
            temp_dir,
            payload_id="report",
            kind="report",
            content_type="application/json",
            data=_json_bytes(package),
        )
        payloads.append(descriptor)
        payload_paths[descriptor["id"]] = path

        descriptor, path = _prepare_payload(
            temp_dir,
            payload_id="plotly-runtime",
            kind="plotly_runtime",
            content_type="application/javascript",
            source_path=_plotly_runtime_path(),
        )
        payloads.append(descriptor)
        payload_paths[descriptor["id"]] = path

        for source in sources:
            if include_original_files:
                source_path = Path(source.path)
                if not source_path.is_file():
                    if strict_original_files:
                        raise PortableOriginalSourceError(
                            f"Original source is unavailable: {source.filename}."
                        )
                    warnings.append(f"Original source is unavailable: {source.filename}.")
                    continue
                payload_id = f"original-{source.hash}"
                descriptor, path = _prepare_payload(
                    temp_dir,
                    payload_id=payload_id,
                    kind="original_source",
                    content_type="application/octet-stream",
                    source_path=source_path,
                    metadata={
                        "source_id": f"source-{source.hash}",
                        "source_hash": source.hash,
                        "filename": source.filename,
                    },
                )
                if descriptor["sha256"] != source.hash:
                    path.unlink(missing_ok=True)
                    if strict_original_files:
                        raise PortableOriginalSourceError(
                            f"Original source changed while the report was being prepared: "
                            f"{source.filename}."
                        )
                    warnings.append(
                        f"Original source changed and was not embedded: {source.filename}."
                    )
                    continue
                payloads.append(descriptor)
                payload_paths[payload_id] = path

        # Warnings may have been appended after the report payload was built.
        package["warnings"] = warnings
        descriptor, path = _prepare_payload(
            temp_dir,
            payload_id="report",
            kind="report",
            content_type="application/json",
            data=_json_bytes(package),
        )
        payloads[0] = descriptor
        payload_paths["report"] = path

        manifest = {
            "format": FORMAT_ID,
            "format_version": FORMAT_VERSION,
            "application": {"name": "CellXplorer", "version": APP_VERSION},
            "database_schema_revision": CURRENT_SCHEMA_REVISION,
            "analysis_spec_version": analysis.spec.get("spec_version"),
            "created_at": _now_iso(),
            "export_id": export_id,
            "analysis_title": analysis.title,
            "includes_original_files": any(
                item["kind"] == "original_source" for item in payloads
            ),
            "payloads": payloads,
        }
        _write_html(destination, manifest, payload_paths)

    record_activity(
        db,
        category="analysis",
        action="export_portable_analysis",
        message=f'Exported portable analysis "{analysis.title}".',
        entity_type="analysis",
        entity_id=analysis.id,
        details={
            "include_original_files": include_original_files,
            "embedded_original_files": sum(
                item["kind"] == "original_source" for item in manifest["payloads"]
            ),
            "cell_count": len(cells),
            "source_count": len(sources),
            "plot_count": len(package["views"]),
            "warning_count": len(warnings),
        },
    )
    db.commit()
    return {"manifest": manifest, "warnings": warnings}


def _write_html(destination: Path, manifest: dict, payload_paths: dict[str, Path]) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    manifest_text = json.dumps(manifest, ensure_ascii=True, separators=(",", ":")).replace(
        "<", "\\u003c"
    )
    title = html.escape(str(manifest.get("analysis_title") or "CellXplorer analysis"))
    with destination.open("wb") as output:
        output.write(_html_head(title).encode("utf-8"))
        output.write(
            f'<script id="{MANIFEST_ID}" type="application/json">{manifest_text}</script>\n'.encode(
                "utf-8"
            )
        )
        for descriptor in manifest["payloads"]:
            payload_id = descriptor["id"]
            output.write(
                (
                    f'<script id="{PAYLOAD_PREFIX}{payload_id}" '
                    'type="application/octet-stream">'
                ).encode("ascii")
            )
            _write_base64(payload_paths[payload_id], output)
            output.write(b"</script>\n")
        output.write(_html_tail().encode("utf-8"))


def _html_head(title: str) -> str:
    deep_link = _deep_link_import_base()
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="application-name" content="CellXplorer">
<meta name="theme-color" content="#12b886">
<meta name="description" content="Portable CellXplorer battery cycling analysis">
<meta property="og:title" content="{title} - CellXplorer">
<meta property="og:description" content="Portable battery cycling analysis">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='12' fill='%2312b886'/%3E%3Cpath d='M17 13l15 19 15-19h-9L32 21l-6-8zm0 38h9l6-8 6 8h9L32 32z' fill='white'/%3E%3C/svg%3E">
<title>{title} - CellXplorer portable analysis</title>
<style>
:root{{--teal:#12b886;--ink:#17212b;--muted:#7c8794;--line:#dfe4e8;--soft:#f7f8f9}}
*{{box-sizing:border-box}} body{{margin:0;font:14px system-ui,Segoe UI,sans-serif;color:var(--ink);background:#fff}}
header{{border-bottom:1px solid var(--line);padding:18px 28px;display:flex;justify-content:space-between;gap:20px}}
main{{padding:22px 28px;display:grid;grid-template-columns:260px minmax(0,1fr);gap:20px}}
h1{{font-size:22px;margin:0}} h2{{font-size:17px;margin:0 0 12px}} p{{margin:4px 0}}
.muted{{color:var(--muted)}} .panel{{border:1px solid var(--line);border-radius:7px;padding:16px;background:#fff}}
#views button{{width:100%;text-align:left;border:1px solid transparent;background:transparent;padding:10px;border-radius:5px;cursor:pointer}}
#views button:hover{{background:var(--soft)}} #views button.active{{background:#e6f8f3;border-color:#b8eadc}}
#chart{{width:100%;min-height:520px}} .toolbar{{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:10px}}
#chart .frozen-plot{{display:block;width:100%;height:auto;min-height:360px}}
#series-controls{{display:flex;flex-wrap:wrap;gap:8px 16px;margin:8px 0 2px}} #series-controls label{{font-size:12px}}
button.action,.action-link{{border:1px solid var(--line);background:#fff;border-radius:5px;padding:8px 12px;cursor:pointer;color:inherit;text-decoration:none;font:inherit}}
.header-actions{{display:flex;align-items:center;gap:12px}} .primary{{background:var(--teal)!important;color:#fff;border-color:var(--teal)!important}}
#report-cover{{position:fixed;inset:0;z-index:1000;background:#fff;display:flex;align-items:center;justify-content:center;text-align:center;padding:32px}}
.cover-mark{{width:64px;height:64px;margin:0 auto 16px;border-radius:12px;background:var(--teal);color:#fff;font-size:44px;line-height:58px;font-weight:300}}
dialog{{width:min(760px,calc(100vw - 32px));max-height:calc(100vh - 48px);border:1px solid var(--line);border-radius:8px;padding:0;box-shadow:0 18px 55px #17212b33}}
dialog::backdrop{{background:#17212b55}} .dialog-head,.dialog-foot{{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 18px}}
.dialog-head{{border-bottom:1px solid var(--line)}} .dialog-foot{{border-top:1px solid var(--line);justify-content:flex-end}} .dialog-body{{padding:8px 18px 18px;overflow:auto}}
.source-group{{border:1px solid var(--line);border-radius:6px;margin-top:10px;overflow:hidden}} .source-group h3{{font-size:14px;margin:0;padding:10px 12px;background:var(--soft)}}
table{{border-collapse:collapse;width:100%}} th,td{{border-bottom:1px solid var(--line);padding:8px;text-align:left;font-size:12px}}
.warning{{background:#fff4e6;border:1px solid #ffd8a8;padding:9px;border-radius:5px;margin-top:8px}}
.runtime-note{{background:#f7f8f9;border:1px solid var(--line);padding:9px;border-radius:5px;margin:8px 0;color:var(--muted)}}
/* Unconditional, not a toggle: a reader who has zoomed to the healthy band
   would see nothing change when un-hiding, and conclude nothing was hidden. */
.hidden-chip{{margin:0 0 10px;padding:8px 12px;border-radius:8px;font-size:12px;
  background:#fff4e6;color:#8a4b08;border:1px solid #ffd8a8}}
@media print{{.hidden-chip{{background:#fff4e6 !important;-webkit-print-color-adjust:exact;print-color-adjust:exact}}}}
@media(max-width:800px){{main{{grid-template-columns:1fr}} #chart{{height:390px}}}}
</style>
</head>
<body>
<div id="report-cover"><div><div class="cover-mark">X</div><h1>{title}</h1><p class="muted">CellXplorer portable battery analysis</p></div></div>
<header><div><h1 id="title">Portable analysis</h1><p class="muted" id="subtitle">Loading report...</p></div><div class="header-actions"><a class="action-link primary" id="open-cellxplorer" href="{deep_link}">Open in CellXplorer</a><button class="action" id="download-originals" hidden>Download source files</button><strong style="color:var(--teal)">CellXplorer</strong></div></header>
<main>
<aside class="panel"><h2>Saved plots</h2><div id="views"></div><div id="warnings"></div></aside>
<section>
<div class="panel">
<div class="toolbar"><div><h2 id="view-title"></h2><p class="muted" id="view-subtitle"></p></div><div class="toolbar"><select class="action" id="csv-precision" aria-label="CSV numeric precision"><option value="standard">Standard precision</option><option value="full">Full precision</option></select><button class="action" id="csv">Export CSV</button></div></div>
<div id="hidden-chip" class="hidden-chip" hidden></div>
<div id="chart" role="img" aria-label="Analysis plot"></div>
</div>
<div class="panel" id="hidden-panel" style="margin-top:16px" hidden><h2>Hidden cycles</h2><div id="hidden-report"></div></div>
<div class="panel" style="margin-top:16px"><h2>Summary</h2><div id="summary"></div></div>
<div class="panel" style="margin-top:16px"><h2>Cell metadata</h2><div id="metadata"></div></div>
<div class="panel" style="margin-top:16px"><h2>Source files</h2><div id="sources"></div></div>
</section>
</main>
<dialog id="source-downloads">
  <div class="dialog-head"><div><h2>Download source files</h2><p class="muted">Download one embedded file or the complete cell-organized archive.</p></div><button class="action" id="close-source-downloads" aria-label="Close">Close</button></div>
  <div class="dialog-body" id="source-download-list"></div>
  <div class="dialog-foot"><button class="action primary" id="download-all-originals">Download all as ZIP</button></div>
</dialog>
"""


def _html_tail() -> str:
    return r"""
<script>
(() => {
  "use strict";
  const byId = (id) => document.getElementById(id);
  const manifest = JSON.parse(byId("cellxplorer-manifest").textContent);
  let report = null;
  let active = null;
  let hiddenSeries = new Set();
  const decodePayload = async (id) => {
    const encoded = byId("cellxplorer-payload-" + id).textContent.trim();
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    if (!("DecompressionStream" in window)) throw new Error("This browser cannot decompress the embedded report.");
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };
  const loadPlotly = async () => {
    if (window.Plotly) return;
    const descriptor = (manifest.payloads || []).find((item) => item.kind === "plotly_runtime");
    if (!descriptor) throw new Error("This report does not contain the Plotly runtime.");
    const bytes = await decodePayload(descriptor.id);
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/javascript" }));
    try {
      await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = url;
        script.onload = resolve;
        script.onerror = () => reject(new Error("Could not load the embedded Plotly runtime."));
        document.head.append(script);
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  };
  const text = (node, value) => { node.textContent = value == null ? "" : String(value); };
  const safeNumber = (value) => {
    if (value === null || value === undefined || value === "") return null;
    return Number.isFinite(Number(value)) ? Number(value) : null;
  };
  const normalizedQuantityMap = {
    discharge_capacity: { column: "discharge_capacity_mah_g", label: "Discharge capacity (mAh/g)" },
    charge_capacity: { column: "charge_capacity_mah_g", label: "Charge capacity (mAh/g)" },
    discharge_energy: { column: "discharge_energy_mwh_g", label: "Discharge energy (mWh/g)" },
    charge_energy: { column: "charge_energy_mwh_g", label: "Charge energy (mWh/g)" },
    discharge_capacity_loss: {
      column: "discharge_capacity_loss_mah_g_cycle",
      label: "Discharge capacity loss (mAh/g/cycle)"
    },
    charge_capacity_loss: {
      column: "charge_capacity_loss_mah_g_cycle",
      label: "Charge capacity loss (mAh/g/cycle)"
    },
    cv_charge_capacity: { column: "cv_charge_capacity_mah_g", label: "CV charge capacity (mAh/g)" }
  };
  function viewColumn(view) {
    const quantity = view.presentation?.quantity || "discharge_capacity";
    if (view.presentation?.normalize_by_mass && normalizedQuantityMap[quantity]) {
      return normalizedQuantityMap[quantity];
    }
    const info = (view.result.quantities || []).find((item) => item.key === quantity);
    return { key: info?.column || "discharge_capacity_mah", label: info?.label || quantity.replaceAll("_", " ") };
  }
  function cycleRows(view) {
    const column = viewColumn(view);
    const rows = [];
    for (const series of view.result.cell_series || []) {
      if (series.excluded) continue;
      const values = series.quantities?.[column.key] || [];
      (series.x || []).forEach((x, index) => rows.push({ series: series.label, x, y: values[index] }));
    }
    return { rows, xLabel: "Cycle", yLabel: column.label };
  }
  function timeRows(view) {
    const rows = [];
    for (const series of view.result.cell_traces || []) {
      if (series.excluded) continue;
      const settings = view.result.settings || {};
      const xKey = settings.x_axis === "capacity_mah_g" ? "capacity_mah_g" : settings.x_axis === "capacity_mah" ? "capacity_mah" : "time_s";
      const yKey = settings.view === "dqdv" || settings.view === "dvdq" ? "derivative_y" : "voltage_v";
      const xs = series[xKey] || [];
      const ys = series[yKey] || [];
      xs.forEach((x, index) => rows.push({ series: series.label, x, y: ys[index] }));
    }
    return { rows, xLabel: view.result.settings?.x_axis || "Time", yLabel: "Voltage / derivative" };
  }
  function dataRows(view) { return view.tab === "time_capacity" ? timeRows(view) : cycleRows(view); }
  function figureRows(view) {
    const layout = view.figure?.layout || {};
    const rows = [];
    let xLabel = "X", yLabel = "Y";
    for (const trace of view.figure?.data || []) {
      if (trace.visible === false || trace.visible === "legendonly" || trace.fill === "toself") continue;
      const xs = Array.isArray(trace.x) ? trace.x : [];
      const ys = Array.isArray(trace.y) ? trace.y : [];
      if (!xs.length || !ys.length) continue;
      const series = String(trace.name || `Series ${rows.length + 1}`);
      xLabel = axisTitle(layout, trace, "x");
      yLabel = axisTitle(layout, trace, "y");
      const count = Math.min(xs.length, ys.length);
      for (let index = 0; index < count; index++) {
        rows.push({ series, x: xs[index], y: ys[index] });
      }
    }
    return { rows, xLabel, yLabel };
  }
  function renderFrozenSvg(chart, rawSvg) {
    if (!rawSvg) return false;
    const parsed = new DOMParser().parseFromString(rawSvg, "image/svg+xml");
    if (parsed.querySelector("parsererror") || parsed.documentElement.localName !== "svg") return false;
    parsed.querySelectorAll("script,foreignObject,iframe,object,embed").forEach((node) => node.remove());
    parsed.querySelectorAll("*").forEach((node) => {
      [...node.attributes].forEach((attribute) => {
        const name = attribute.name.toLowerCase();
        const value = attribute.value.trim().toLowerCase();
        if (name.startsWith("on") || value.startsWith("javascript:")) node.removeAttribute(attribute.name);
        if ((name === "href" || name === "xlink:href") && !value.startsWith("#") && !value.startsWith("data:image/")) {
          node.removeAttribute(attribute.name);
        }
      });
    });
    const svg = document.importNode(parsed.documentElement, true);
    svg.classList.add("frozen-plot");
    svg.setAttribute("width", "100%");
    svg.removeAttribute("height");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    chart.replaceChildren(svg);
    return true;
  }
  function renderChart(view) {
    const chart = byId("chart");
    if (!view.figure?.data?.length && !view.svg) {
      chart.replaceChildren();
      const message = document.createElement("p");
      message.className = "muted";
      text(message, "No plottable data in this view.");
      chart.append(message);
      return;
    }
    if (window.Plotly) {
      const layout = {
        ...(view.figure.layout || {}),
        autosize: true,
        width: undefined
      };
      const config = {
        displaylogo: false,
        responsive: true,
        ...(view.figure.config || {})
      };
      if (chart.dataset.plotlyReady === "true") {
        window.Plotly.react(chart, view.figure.data, layout, config);
      } else {
        chart.replaceChildren();
        window.Plotly.newPlot(chart, view.figure.data, layout, config);
        chart.dataset.plotlyReady = "true";
      }
      return;
    }
    if (renderFrozenSvg(chart, view.svg)) return;
    chart.replaceChildren();
    const svg = document.createElementNS("http://www.w3.org/2000/svg","svg");
    const width = Math.max(640, chart.clientWidth || 900), height = Math.max(360, chart.clientHeight || 520);
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width","100%"); svg.setAttribute("height",String(height));
    chart.append(svg);
    const { rows, xLabel, yLabel } = figureRows(view);
    const valid = rows.filter((r) => !hiddenSeries.has(r.series) && safeNumber(r.x) !== null && safeNumber(r.y) !== null);
    if (!valid.length) {
      const message = document.createElementNS("http://www.w3.org/2000/svg", "text");
      message.setAttribute("x", "24"); message.setAttribute("y", "42"); text(message, "No plottable data in this view.");
      svg.append(message); return;
    }
    const margin = { left: 72, right: 22, top: 18, bottom: 58 };
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    valid.forEach((row) => {
      const x = Number(row.x), y = Number(row.y);
      if (x < xmin) xmin = x; if (x > xmax) xmax = x;
      if (y < ymin) ymin = y; if (y > ymax) ymax = y;
    });
    if (xmin === xmax) xmax = xmin + 1; if (ymin === ymax) ymax = ymin + 1;
    const px = (x) => margin.left + (x - xmin) / (xmax - xmin) * (width - margin.left - margin.right);
    const py = (y) => height - margin.bottom - (y - ymin) / (ymax - ymin) * (height - margin.top - margin.bottom);
    const ns = "http://www.w3.org/2000/svg";
    for (let i = 0; i <= 5; i++) {
      const gx = margin.left + i / 5 * (width - margin.left - margin.right);
      const gy = margin.top + i / 5 * (height - margin.top - margin.bottom);
      for (const [x1,y1,x2,y2] of [[gx,margin.top,gx,height-margin.bottom],[margin.left,gy,width-margin.right,gy]]) {
        const line = document.createElementNS(ns,"line");
        line.setAttribute("x1",x1); line.setAttribute("y1",y1); line.setAttribute("x2",x2); line.setAttribute("y2",y2);
        line.setAttribute("stroke","#e9ecef"); svg.append(line);
      }
      const xTick = document.createElementNS(ns,"text");
      xTick.setAttribute("x",gx); xTick.setAttribute("y",height-margin.bottom+20);
      xTick.setAttribute("text-anchor","middle"); xTick.setAttribute("fill","#687481");
      text(xTick,(xmin + i / 5 * (xmax - xmin)).toLocaleString(undefined,{maximumSignificantDigits:4})); svg.append(xTick);
      const yTick = document.createElementNS(ns,"text");
      yTick.setAttribute("x",margin.left-10); yTick.setAttribute("y",gy+4);
      yTick.setAttribute("text-anchor","end"); yTick.setAttribute("fill","#687481");
      text(yTick,(ymax - i / 5 * (ymax - ymin)).toLocaleString(undefined,{maximumSignificantDigits:4})); svg.append(yTick);
    }
    const colors = ["#12b886","#4dabf7","#ff6b6b","#845ef7","#fcc419","#20c997","#f06595"];
    const seriesNames = [...new Set(valid.map((r) => r.series))];
    seriesNames.forEach((name,index) => {
      const points = valid.filter((r) => r.series === name).map((r) => `${px(Number(r.x))},${py(Number(r.y))}`).join(" ");
      const poly = document.createElementNS(ns,"polyline");
      poly.setAttribute("points",points); poly.setAttribute("fill","none"); poly.setAttribute("stroke",colors[index % colors.length]);
      poly.setAttribute("stroke-width","2"); poly.setAttribute("stroke-linejoin","round"); svg.append(poly);
    });
    const axis = document.createElementNS(ns,"path");
    axis.setAttribute("d",`M${margin.left},${margin.top}V${height-margin.bottom}H${width-margin.right}`);
    axis.setAttribute("fill","none"); axis.setAttribute("stroke","#343a40"); svg.append(axis);
    const xTitle = document.createElementNS(ns,"text"); xTitle.setAttribute("x",width/2); xTitle.setAttribute("y",height-15); xTitle.setAttribute("text-anchor","middle"); text(xTitle,xLabel); svg.append(xTitle);
    const yTitle = document.createElementNS(ns,"text"); yTitle.setAttribute("transform",`translate(18 ${height/2}) rotate(-90)`); yTitle.setAttribute("text-anchor","middle"); text(yTitle,yLabel); svg.append(yTitle);
  }
  function renderSummary(view) {
    const target = byId("summary"); target.replaceChildren();
    const rows = view.summary || [];
    const table = document.createElement("table");
    table.innerHTML = "<thead><tr><th>Sample</th><th>Cycles</th><th>Status</th></tr></thead>";
    const body = document.createElement("tbody");
    rows.forEach((row) => {
      const tr = document.createElement("tr");
      [row.label, row.cycles ?? "", row.status ?? "Visible"].forEach((value) => {
        const td = document.createElement("td"); text(td,value); tr.append(td);
      });
      body.append(tr);
    });
    table.append(body); target.append(table);
  }
  function renderSeriesControls(view) {
    const target = byId("series-controls"); target.replaceChildren();
    const names = [...new Set(dataRows(view).rows.map((row) => row.series))];
    names.forEach((name) => {
      const label = document.createElement("label");
      const input = document.createElement("input"); input.type = "checkbox"; input.checked = !hiddenSeries.has(name);
      input.addEventListener("change",() => {
        if (input.checked) hiddenSeries.delete(name); else hiddenSeries.add(name);
        renderChart(view);
      });
      label.append(input,document.createTextNode(" " + name)); target.append(label);
    });
  }
  function renderSources() {
    const target = byId("sources"); target.replaceChildren();
    const originals = new Map(
      (manifest.payloads || [])
        .filter((item) => item.kind === "original_source")
        .map((item) => [item.source_id, item])
    );
    const table = document.createElement("table");
    table.innerHTML = "<thead><tr><th>File</th><th>SHA-256</th><th></th></tr></thead>";
    const body = document.createElement("tbody");
    (report.sources || []).forEach((source) => {
      const tr = document.createElement("tr");
      const name = document.createElement("td"); text(name,source.filename); tr.append(name);
      const hash = document.createElement("td"); text(hash,String(source.hash || "").slice(0,16) + "…"); tr.append(hash);
      const action = document.createElement("td");
      const descriptor = originals.get(source.portable_id);
      if (descriptor) {
        const button = document.createElement("button"); button.className = "action"; text(button,"Extract original");
        button.addEventListener("click", async () => {
          button.disabled = true; text(button,"Extracting...");
          try {
            const bytes = await decodePayload(descriptor.id);
            const link = document.createElement("a");
            link.href = URL.createObjectURL(new Blob([bytes],{type:"application/octet-stream"}));
            link.download = descriptor.filename || source.filename; link.click(); URL.revokeObjectURL(link.href);
            text(button,"Extract original");
          } catch (error) {
            text(button,error.message || "Extraction failed");
          } finally {
            button.disabled = false;
          }
        });
        action.append(button);
      } else {
        action.className = "muted"; text(action,"Not embedded");
      }
      tr.append(action); body.append(tr);
    });
    table.append(body); target.append(table);
  }
  async function downloadEmbeddedFile(descriptor, fallbackName, button) {
    const originalLabel = button ? button.textContent : "Download";
    if (button) { button.disabled = true; text(button,"Preparing..."); }
    try {
      const bytes = await decodePayload(descriptor.id);
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([bytes],{type:"application/octet-stream"}));
      link.download = descriptor.filename || fallbackName || "source-file";
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href),1000);
    } catch (error) {
      alert(error.message || "Could not download the embedded source file.");
    } finally {
      if (button) { button.disabled = false; text(button,originalLabel); }
    }
  }
  function cellSourceIds(cell) {
    if (Array.isArray(cell.sources)) {
      return cell.sources
        .filter((item) => item && item.source_id)
        .slice()
        .sort((left, right) => Number(left.position || 0) - Number(right.position || 0))
        .map((item) => item.source_id);
    }
    if (Array.isArray(cell.source_ids)) return cell.source_ids.slice();
    const sourceIds = [];
    for (const test of cell.tests || []) {
      for (const sourceId of test.source_ids || []) sourceIds.push(sourceId);
    }
    return sourceIds;
  }
  function renderSourceDownloads() {
    const target = byId("source-download-list"); target.replaceChildren();
    const originals = new Map(
      (manifest.payloads || []).filter((item) => item.kind === "original_source").map((item) => [item.source_id,item])
    );
    const sources = new Map((report.sources || []).map((source) => [source.portable_id,source]));
    for (const cell of report.cells || []) {
      const sourceIds = [];
      const seen = new Set();
      for (const sourceId of cellSourceIds(cell)) {
        if (originals.has(sourceId) && !seen.has(sourceId)) { seen.add(sourceId); sourceIds.push(sourceId); }
      }
      if (!sourceIds.length) continue;
      const group = document.createElement("section"); group.className = "source-group";
      const heading = document.createElement("h3"); text(heading,cell.name); group.append(heading);
      const table = document.createElement("table");
      const body = document.createElement("tbody");
      sourceIds.forEach((sourceId) => {
        const descriptor = originals.get(sourceId), source = sources.get(sourceId) || {};
        const row = document.createElement("tr");
        const name = document.createElement("td"); text(name,descriptor.filename || source.filename || "Source file"); row.append(name);
        const size = document.createElement("td"); size.className = "muted"; text(size,descriptor.uncompressed_bytes ? `${(descriptor.uncompressed_bytes / 1024 / 1024).toFixed(1)} MB` : ""); row.append(size);
        const action = document.createElement("td"); action.style.textAlign = "right";
        const button = document.createElement("button"); button.className = "action"; text(button,"Download");
        button.addEventListener("click",() => downloadEmbeddedFile(descriptor,source.filename,button));
        action.append(button); row.append(action); body.append(row);
      });
      table.append(body); group.append(table); target.append(group);
    }
  }
  const zipU16 = (view, offset, value) => view.setUint16(offset, value, true);
  const zipU32 = (view, offset, value) => view.setUint32(offset, value >>> 0, true);
  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  function safeZipName(value) {
    const cleaned = String(value || "cell").replace(/[<>:"/\\|?*\x00-\x1f]/g,"-").replace(/[. ]+$/g,"").trim();
    return cleaned || "cell";
  }
  function zipBlob(entries) {
    const encoder = new TextEncoder();
    const localParts = [], centralParts = [];
    let offset = 0, centralSize = 0;
    for (const entry of entries) {
      const name = encoder.encode(entry.name.replaceAll("\\","/"));
      const checksum = crc32(entry.bytes);
      const local = new Uint8Array(30 + name.length), lv = new DataView(local.buffer);
      zipU32(lv,0,0x04034b50); zipU16(lv,4,20); zipU16(lv,6,0x0800); zipU16(lv,8,0);
      zipU16(lv,10,0); zipU16(lv,12,0); zipU32(lv,14,checksum);
      zipU32(lv,18,entry.bytes.length); zipU32(lv,22,entry.bytes.length); zipU16(lv,26,name.length); zipU16(lv,28,0);
      local.set(name,30); localParts.push(local,entry.bytes);
      const central = new Uint8Array(46 + name.length), cv = new DataView(central.buffer);
      zipU32(cv,0,0x02014b50); zipU16(cv,4,20); zipU16(cv,6,20); zipU16(cv,8,0x0800); zipU16(cv,10,0);
      zipU16(cv,12,0); zipU16(cv,14,0); zipU32(cv,16,checksum);
      zipU32(cv,20,entry.bytes.length); zipU32(cv,24,entry.bytes.length); zipU16(cv,28,name.length);
      zipU16(cv,30,0); zipU16(cv,32,0); zipU16(cv,34,0); zipU16(cv,36,0); zipU32(cv,38,0); zipU32(cv,42,offset);
      central.set(name,46); centralParts.push(central); centralSize += central.length;
      offset += local.length + entry.bytes.length;
    }
    const end = new Uint8Array(22), ev = new DataView(end.buffer);
    zipU32(ev,0,0x06054b50); zipU16(ev,4,0); zipU16(ev,6,0); zipU16(ev,8,entries.length); zipU16(ev,10,entries.length);
    zipU32(ev,12,centralSize); zipU32(ev,16,offset); zipU16(ev,20,0);
    return new Blob([...localParts,...centralParts,end],{type:"application/zip"});
  }
  async function downloadOriginals() {
    const button = byId("download-all-originals");
    const originals = new Map(
      (manifest.payloads || []).filter((item) => item.kind === "original_source").map((item) => [item.source_id,item])
    );
    const sources = new Map((report.sources || []).map((source) => [source.portable_id,source]));
    const entries = [], seen = new Set();
    button.disabled = true; text(button,"Preparing files...");
    try {
      for (const cell of report.cells || []) {
        for (const sourceId of cellSourceIds(cell)) {
          const descriptor = originals.get(sourceId);
          if (!descriptor || seen.has(sourceId)) continue;
          seen.add(sourceId);
          const source = sources.get(sourceId) || {};
          entries.push({
            name: `${safeZipName(cell.name)}/${safeZipName(descriptor.filename || source.filename)}`,
            bytes: await decodePayload(descriptor.id)
          });
        }
      }
      if (!entries.length) throw new Error("No embedded source files are available.");
      const link = document.createElement("a");
      link.href = URL.createObjectURL(zipBlob(entries));
      link.download = `${safeZipName(report.analysis?.title || "CellXplorer analysis")}-sources.zip`;
      link.click(); setTimeout(() => URL.revokeObjectURL(link.href),1000);
    } catch (error) {
      alert(error.message || "Could not prepare the embedded source files.");
    } finally {
      button.disabled = false; text(button,"Download all as ZIP");
    }
  }
  function renderMetadata() {
    const target = byId("metadata"); target.replaceChildren();
    (report.cells || []).forEach((cell) => {
      const details = document.createElement("details");
      const summary = document.createElement("summary"); text(summary,cell.name); details.append(summary);
      const table = document.createElement("table");
      const body = document.createElement("tbody");
      const values = { Description: cell.description || "", Status: cell.cycling_status || "", ...(cell.metadata || {}) };
      Object.entries(values).forEach(([key,value]) => {
        const tr = document.createElement("tr");
        const label = document.createElement("th"); text(label,key); tr.append(label);
        const content = document.createElement("td"); text(content,value); tr.append(content);
        body.append(tr);
      });
      table.append(body); details.append(table); target.append(details);
    });
  }
  function openView(view) {
    active = view;
    hiddenSeries = new Set();
    text(byId("view-title"), view.name);
    text(byId("view-subtitle"), view.subtitle || view.tab.replaceAll("_"," "));
    document.querySelectorAll("#views button").forEach((button) => button.classList.toggle("active", button.dataset.id === view.id));
    renderChart(view); renderSummary(view); renderHiddenCycles(view);
  }
  function renderHiddenCycles(view) {
    const chip = byId("hidden-chip");
    const panel = byId("hidden-panel");
    const report = byId("hidden-report");
    const hidden = Array.isArray(view.hidden_cycles) ? view.hidden_cycles : [];
    if (!chip || !panel || !report) return;
    if (hidden.length === 0) {
      chip.hidden = true; panel.hidden = true; return;
    }
    const shown = new Set();
    for (const series of (view.result?.cell_series || [])) {
      if (series.excluded) continue;
      for (const cycle of (series.x || [])) shown.add(cycle);
    }
    const total = shown.size;
    chip.hidden = false;
    text(chip,
      hidden.length + " diagnostic cycle" + (hidden.length === 1 ? "" : "s") +
      " are hidden from this plot (" + (total - hidden.length) + " shown). " +
      "See \\u201cHidden cycles\\u201d below. The stored data is complete.");
    panel.hidden = false;
    report.replaceChildren();
    const summary = document.createElement("p");
    summary.className = "muted";
    text(summary,
      "Cycles removed from the plot because their charge or discharge time " +
      "deviates from neighbouring cycles \\u2014 typically DCIR pulses and rate " +
      "checks. This affects the plot only: the report still contains every " +
      "cycle, so re-importing it into CellXplorer restores them.");
    const list = document.createElement("p");
    list.style.fontFamily = "ui-monospace,SFMono-Regular,Menlo,monospace";
    list.style.fontSize = "12px";
    text(list, view.hidden_cycle_ranges || hidden.join(", "));
    report.append(summary, list);
  }
  function axisTitle(layout, trace, direction) {
    const reference = String(trace[direction + "axis"] || direction);
    const suffix = reference === direction ? "" : reference.slice(1);
    const axis = layout[direction + "axis" + suffix] || {};
    return String(axis.title?.text || direction);
  }
  function plottedColumns() {
    const chart = byId("chart");
    const traces = chart.data || active?.figure?.data || [];
    const layout = chart.layout || active?.figure?.layout || {};
    const columns = [];
    for (const trace of traces) {
      if (trace.fill === "toself" || trace.visible === false || trace.visible === "legendonly") continue;
      const xs = Array.from(trace.x || []);
      const ys = Array.from(trace.y || []);
      if (!ys.length) continue;
      const name = String(trace.name || "series");
      columns.push({ header: `${name} | ${axisTitle(layout, trace, "x")}`, values: xs });
      columns.push({ header: `${name} | ${axisTitle(layout, trace, "y")}`, values: ys });
    }
    return columns;
  }
  function exportCsv() {
    if (!active) return;
    const columns = plottedColumns();
    const precision = byId("csv-precision").value;
    const decimals = (header) => {
      const value = String(header || "").toLowerCase();
      if (value.includes("cycle")) return 0;
      if (value.includes("time")) return 3;
      if (value.includes("voltage") || value.includes("current")) return 5;
      if (value.includes("derivative") || value.includes("dq/dv") || value.includes("dv/dq")) return 7;
      return 6;
    };
    const csvValue = (value, header) => {
      if (value === null || value === undefined || value === "") return "";
      if (typeof value === "number") {
        if (!Number.isFinite(value)) return "";
        return String(precision === "full" ? value : Number(value.toFixed(decimals(header))));
      }
      const string = String(value);
      return /[,"\r\n]/.test(string) ? `"${string.replaceAll('"','""')}"` : string;
    };
    const rowCount = columns.reduce((maximum, column) => Math.max(maximum, column.values.length), 0);
    const rows = [columns.map((column) => column.header)];
    for (let index = 0; index < rowCount; index += 1) {
      rows.push(columns.map((column) => column.values[index] ?? ""));
    }
    const csv = rows.map((row, rowIndex) =>
      row.map((value, columnIndex) => csvValue(value, rowIndex ? columns[columnIndex]?.header : "")).join(",")
    ).join("\r\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"}));
    link.download = `${active.name || "analysis-data"}.csv`; link.click(); URL.revokeObjectURL(link.href);
  }
  async function start() {
    const openCellXplorer = byId("open-cellxplorer");
    if (openCellXplorer && window.location.protocol === "file:") {
      openCellXplorer.href = "%%DEEP_LINK_BASE%%?source=" + encodeURIComponent(window.location.href);
    }
    const bytes = await decodePayload("report");
    report = JSON.parse(new TextDecoder().decode(bytes));
    text(byId("title"), report.analysis.title);
    text(byId("subtitle"), `Portable analysis created ${new Date(report.created_at).toLocaleString()} · ${report.cells.length} cell(s)`);
    const views = byId("views");
    report.views.forEach((view) => {
      const button = document.createElement("button"); button.dataset.id = view.id;
      const strong = document.createElement("strong"); text(strong,view.name); button.append(strong);
      const small = document.createElement("div"); small.className = "muted"; text(small,view.tab.replaceAll("_"," ")); button.append(small);
      button.addEventListener("click",() => openView(view)); views.append(button);
    });
    (report.warnings || []).forEach((warning) => {
      const item = document.createElement("div"); item.className = "warning"; text(item,warning); byId("warnings").append(item);
    });
    byId("csv").addEventListener("click",exportCsv);
    const hasOriginals = (manifest.payloads || []).some((item) => item.kind === "original_source");
    if (hasOriginals) {
      byId("download-originals").hidden = false;
      renderSourceDownloads();
      byId("download-originals").addEventListener("click",() => {
        const dialog = byId("source-downloads");
        if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open","");
      });
      byId("close-source-downloads").addEventListener("click",() => {
        const dialog = byId("source-downloads");
        if (typeof dialog.close === "function") dialog.close(); else dialog.removeAttribute("open");
      });
      byId("download-all-originals").addEventListener("click",downloadOriginals);
    }
    renderMetadata();
    renderSources();
    openView(report.views[0]);
    byId("report-cover")?.remove();
    try {
      await loadPlotly();
      if (active) renderChart(active);
    } catch (error) {
      const note = document.createElement("div"); note.className = "runtime-note";
      text(note,"Interactive Plotly controls are unavailable in this preview. The plots, data exports and embedded files remain available.");
      byId("view-subtitle").parentElement.append(note);
      console.warn(error);
    }
  }
  start().catch((error) => { text(byId("subtitle"), error.message || "Could not load this portable report."); console.error(error); });
})();
</script>
</body></html>
""".replace("%%DEEP_LINK_BASE%%", _deep_link_import_base())


def _index_script_bounds(path: Path) -> dict[str, tuple[int, int]]:
    bounds: dict[str, tuple[int, int]] = {}
    script_start_marker = b"<script"
    id_pattern = re.compile(br'\bid="([^"]+)"')
    with path.open("rb") as source, mmap.mmap(
        source.fileno(), length=0, access=mmap.ACCESS_READ
    ) as data:
        position = 0
        while True:
            script_start = data.find(script_start_marker, position)
            if script_start < 0:
                break
            content_start = data.find(b">", script_start)
            if content_start < 0:
                raise HTTPException(400, "Malformed script element in portable analysis.")
            content_end = data.find(b"</script>", content_start + 1)
            if content_end < 0:
                raise HTTPException(400, "Unterminated script element in portable analysis.")
            match = id_pattern.search(data[script_start:content_start])
            if match:
                try:
                    element_id = match.group(1).decode("ascii")
                except UnicodeDecodeError as exc:
                    raise HTTPException(400, "Portable payload IDs must be ASCII.") from exc
                bounds[element_id] = (content_start + 1, content_end)
            position = content_end + len(b"</script>")
    return bounds


def _element_bounds(
    path: Path,
    element_id: str,
    bounds: dict[str, tuple[int, int]] | None = None,
) -> tuple[int, int]:
    indexed = bounds if bounds is not None else _index_script_bounds(path)
    if element_id not in indexed:
        raise HTTPException(400, f"Missing portable payload element: {element_id}")
    return indexed[element_id]


def read_manifest(
    path: Path,
    bounds: dict[str, tuple[int, int]] | None = None,
) -> dict:
    start, end = _element_bounds(path, MANIFEST_ID, bounds)
    with path.open("rb") as source:
        source.seek(start)
        raw = source.read(end - start)
    try:
        manifest = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(400, f"Invalid portable analysis manifest: {exc}") from exc
    if manifest.get("format") != FORMAT_ID:
        raise HTTPException(400, "This is not a CellXplorer portable analysis.")
    if manifest.get("format_version") not in SUPPORTED_FORMAT_VERSIONS:
        raise HTTPException(
            409,
            f"Portable analysis format {manifest.get('format_version')} is not supported.",
        )
    payloads = manifest.get("payloads")
    if not isinstance(payloads, list):
        raise HTTPException(400, "The portable analysis manifest has no payload list.")
    for payload in payloads:
        if not isinstance(payload, dict) or not _SAFE_ID.fullmatch(str(payload.get("id", ""))):
            raise HTTPException(400, "The portable analysis contains an invalid payload descriptor.")
    return manifest


def _decode_payload(
    path: Path,
    descriptor: dict,
    destination: Path,
    bounds: dict[str, tuple[int, int]] | None = None,
) -> None:
    start, end = _element_bounds(
        path,
        f"{PAYLOAD_PREFIX}{descriptor['id']}",
        bounds,
    )
    decoder = zlib.decompressobj(wbits=31)
    digest = hashlib.sha256()
    written = 0
    carry = b""
    with path.open("rb") as source, destination.open("wb") as output:
        source.seek(start)
        remaining = end - start
        while remaining:
            chunk = source.read(min(_CHUNK_SIZE, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            block = carry + b"".join(chunk.split())
            usable = len(block) - (len(block) % 4)
            if usable:
                try:
                    compressed = base64.b64decode(block[:usable], validate=True)
                    plain = decoder.decompress(compressed)
                except (ValueError, zlib.error) as exc:
                    raise HTTPException(400, f"Payload {descriptor['id']} is corrupt.") from exc
                if plain:
                    output.write(plain)
                    digest.update(plain)
                    written += len(plain)
            carry = block[usable:]
        try:
            compressed = base64.b64decode(carry, validate=True) if carry else b""
            plain = decoder.decompress(compressed) + decoder.flush()
        except (ValueError, zlib.error) as exc:
            raise HTTPException(400, f"Payload {descriptor['id']} is corrupt.") from exc
        if plain:
            output.write(plain)
            digest.update(plain)
            written += len(plain)
    if written != int(descriptor.get("uncompressed_bytes", -1)):
        destination.unlink(missing_ok=True)
        raise HTTPException(400, f"Payload {descriptor['id']} has an invalid size.")
    if digest.hexdigest() != descriptor.get("sha256"):
        destination.unlink(missing_ok=True)
        raise HTTPException(400, f"Payload {descriptor['id']} failed its checksum.")


def _payload_by_kind(manifest: dict, kind: str) -> list[dict]:
    return [item for item in manifest["payloads"] if item.get("kind") == kind]


def _unique_name(db: Session, model, name: str, suffix: str = "imported") -> str:
    clean = name.strip() or f"Untitled {suffix}"
    if db.query(model).filter(model.name == clean).first() is None:
        return clean
    index = 2
    while db.query(model).filter(model.name == f"{clean} ({suffix} {index})").first():
        index += 1
    return f"{clean} ({suffix} {index})"


def _unique_analysis_title(db: Session, title: str, folder_id: int | None) -> str:
    clean = title.strip() or "Imported analysis"
    query = lambda value: db.query(Analysis.id).filter(
        Analysis.title == value,
        Analysis.folder_id == folder_id if folder_id is not None else Analysis.folder_id.is_(None),
    ).first()
    if query(clean) is None:
        return clean
    index = 2
    while query(f"{clean} (imported {index})"):
        index += 1
    return f"{clean} (imported {index})"


def _cell_source_hashes(cell: Cell) -> list[str]:
    return [
        link.file.hash
        for link in _ordered_cell_links(cell)
    ]


def _portable_chain_error(
    message: str,
    *,
    code: str = "malformed_portable_source_chain",
    cell_name: object = None,
) -> HTTPException:
    detail = {"code": code, "message": message}
    if cell_name:
        detail["cell_name"] = str(cell_name)
    return HTTPException(400, detail=detail)


def _strict_source_id_list(
    value: object,
    *,
    label: str,
    known_source_ids: set[str] | None,
    cell_name: object,
) -> list[str]:
    if not isinstance(value, list) or not value:
        raise _portable_chain_error(
            f'Portable Cell "{cell_name or "Unnamed"}" must contain a non-empty {label} list.',
            cell_name=cell_name,
        )
    source_ids: list[str] = []
    for source_id in value:
        if not isinstance(source_id, str) or not source_id:
            raise _portable_chain_error(
                f'Portable Cell "{cell_name or "Unnamed"}" contains an invalid source reference.',
                cell_name=cell_name,
            )
        if source_id in source_ids:
            raise _portable_chain_error(
                f'Portable Cell "{cell_name or "Unnamed"}" repeats source "{source_id}".',
                code="duplicate_portable_source_id",
                cell_name=cell_name,
            )
        if known_source_ids is not None and source_id not in known_source_ids:
            raise _portable_chain_error(
                f'Portable Cell "{cell_name or "Unnamed"}" references unknown source "{source_id}".',
                code="unknown_portable_source_reference",
                cell_name=cell_name,
            )
        source_ids.append(source_id)
    return source_ids


def _portable_source_ids(
    document: dict,
    *,
    known_source_ids: set[str] | None = None,
) -> list[str]:
    """Decode one strict Cell source chain without silently normalizing it."""
    if not isinstance(document, dict):
        raise _portable_chain_error("Each portable Cell must be an object.")
    cell_name = document.get("name")

    if "sources" in document:
        sources = document["sources"]
        if not isinstance(sources, list) or not sources:
            raise _portable_chain_error(
                f'Portable Cell "{cell_name or "Unnamed"}" must contain a non-empty sources list.',
                cell_name=cell_name,
            )
        if "tests" in document or "source_ids" in document:
            raise _portable_chain_error(
                f'Portable Cell "{cell_name or "Unnamed"}" contains ambiguous source-chain shapes.',
                cell_name=cell_name,
            )
        positions: list[int] = []
        source_ids: list[str] = []
        tail_fields = 0
        true_tail_positions: list[int] = []
        for item in sources:
            if not isinstance(item, dict):
                raise _portable_chain_error(
                    f'Portable Cell "{cell_name or "Unnamed"}" contains a non-object source entry.',
                    cell_name=cell_name,
                )
            source_id = item.get("source_id")
            if not isinstance(source_id, str) or not source_id:
                raise _portable_chain_error(
                    f'Portable Cell "{cell_name or "Unnamed"}" contains an invalid source reference.',
                    cell_name=cell_name,
                )
            if source_id in source_ids:
                raise _portable_chain_error(
                    f'Portable Cell "{cell_name or "Unnamed"}" repeats source "{source_id}".',
                    code="duplicate_portable_source_id",
                    cell_name=cell_name,
                )
            if known_source_ids is not None and source_id not in known_source_ids:
                raise _portable_chain_error(
                    f'Portable Cell "{cell_name or "Unnamed"}" references unknown source "{source_id}".',
                    code="unknown_portable_source_reference",
                    cell_name=cell_name,
                )
            position = item.get("position")
            if type(position) is not int:
                raise _portable_chain_error(
                    f'Portable Cell "{cell_name or "Unnamed"}" has a non-integer source position.',
                    cell_name=cell_name,
                )
            positions.append(position)
            source_ids.append(source_id)
            if "tracked_tail" in item:
                tail_fields += 1
                if type(item["tracked_tail"]) is not bool:
                    raise _portable_chain_error(
                        f'Portable Cell "{cell_name or "Unnamed"}" has an invalid tracked-tail flag.',
                        cell_name=cell_name,
                    )
                if item["tracked_tail"]:
                    true_tail_positions.append(position)
        expected_positions = list(range(1, len(sources) + 1))
        if sorted(positions) != expected_positions:
            raise _portable_chain_error(
                f'Portable Cell "{cell_name or "Unnamed"}" source positions must be exactly 1..N.',
                cell_name=cell_name,
            )
        if tail_fields and (
            tail_fields != len(sources)
            or true_tail_positions != [len(sources)]
        ):
            raise _portable_chain_error(
                f'Portable Cell "{cell_name or "Unnamed"}" must mark only its final source as tracked_tail.',
                cell_name=cell_name,
            )
        ordered = sorted(zip(positions, source_ids), key=lambda item: item[0])
        return [source_id for _, source_id in ordered]

    if "source_ids" in document:
        return _strict_source_id_list(
            document["source_ids"],
            label="source_ids",
            known_source_ids=known_source_ids,
            cell_name=cell_name,
        )

    if "tests" not in document:
        raise _portable_chain_error(
            f'Portable Cell "{cell_name or "Unnamed"}" has no supported source-chain shape.',
            cell_name=cell_name,
        )
    tests = document["tests"]
    if not isinstance(tests, list) or len(tests) != 1:
        raise _portable_chain_error(
            f'Portable Cell "{cell_name or "Unnamed"}" must contain exactly one legacy Test envelope.',
            code="unsupported_legacy_source_chain",
            cell_name=cell_name,
        )
    envelope = tests[0]
    if not isinstance(envelope, dict):
        raise _portable_chain_error(
            f'Portable Cell "{cell_name or "Unnamed"}" has an invalid legacy Test envelope.',
            cell_name=cell_name,
        )
    return _strict_source_id_list(
        envelope.get("source_ids"),
        label="legacy Test source_ids",
        known_source_ids=known_source_ids,
        cell_name=cell_name,
    )


def _validate_portable_source_chains(package: dict) -> None:
    sources = package.get("sources")
    if not isinstance(sources, list):
        raise _portable_chain_error("The portable report must contain a source catalog.")
    known_source_ids: set[str] = set()
    for source in sources:
        if not isinstance(source, dict) or not isinstance(source.get("portable_id"), str) or not source["portable_id"]:
            raise _portable_chain_error("The portable source catalog contains an invalid source.")
        portable_id = source["portable_id"]
        if portable_id in known_source_ids:
            raise _portable_chain_error(
                f'Portable source catalog repeats "{portable_id}".',
                code="duplicate_portable_source_id",
            )
        known_source_ids.add(portable_id)
    cells = package.get("cells")
    if not isinstance(cells, list):
        raise _portable_chain_error("The portable report must contain a Cell list.")
    for document in cells:
        _portable_source_ids(document, known_source_ids=known_source_ids)


def _remap_selection(selection: dict, cell_map: dict[int, int], group_map: dict[int, int]) -> dict:
    result = deepcopy(selection)
    entries = []
    for entry in result.get("entries", []):
        old = int(entry.get("ref_id"))
        mapped = cell_map.get(old) if entry.get("kind") == "cell" else group_map.get(old)
        if mapped is not None:
            entry["ref_id"] = mapped
            entries.append(entry)
    result["entries"] = entries
    exclusions = []
    for exclusion in result.get("exclusions", []):
        mapped_cell = cell_map.get(int(exclusion.get("cell_id")))
        if mapped_cell is None:
            continue
        exclusion["cell_id"] = mapped_cell
        if exclusion.get("entry_kind") == "cell":
            mapped_ref = cell_map.get(int(exclusion.get("entry_ref_id")))
            if mapped_ref is None:
                continue
            exclusion["entry_ref_id"] = mapped_ref
        elif exclusion.get("entry_kind") == "replicate_group":
            mapped_ref = group_map.get(int(exclusion.get("entry_ref_id")))
            if mapped_ref is None:
                continue
            exclusion["entry_ref_id"] = mapped_ref
        exclusions.append(exclusion)
    result["exclusions"] = exclusions
    result["hidden_replicate_group_ids"] = [
        group_map[group_id]
        for value in result.get("hidden_replicate_group_ids", [])
        if (group_id := int(value)) in group_map
    ]
    return result


def _remap_spec(spec: dict, cell_map: dict[int, int], group_map: dict[int, int]) -> dict:
    result = deepcopy(spec)
    result.pop("draft_plot", None)
    result.pop("draft_plots", None)
    result["selection"] = _remap_selection(result.get("selection", {}), cell_map, group_map)
    for plot in result.get("saved_plots", []) or []:
        plot["selection"] = _remap_selection(plot.get("selection", {}), cell_map, group_map)
    return result


def _load_package(html_path: Path) -> tuple[dict, dict, tuple[int, int]]:
    bounds = _index_script_bounds(html_path)
    manifest = read_manifest(html_path, bounds)
    report_descriptors = _payload_by_kind(manifest, "report")
    if len(report_descriptors) != 1:
        raise HTTPException(400, "The portable analysis must contain one report payload.")
    with tempfile.TemporaryDirectory(prefix="cellxplorer-portable-read-") as temporary:
        report_path = Path(temporary) / "report.json"
        _decode_payload(html_path, report_descriptors[0], report_path, bounds)
        try:
            package = json.loads(report_path.read_text(encoding="utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise HTTPException(400, f"The report payload is invalid: {exc}") from exc
    if int(package.get("package_version", -1)) not in SUPPORTED_FORMAT_VERSIONS:
        raise HTTPException(409, "The report payload version is not supported.")
    spec_version = int(package.get("analysis", {}).get("spec", {}).get("spec_version", 0))
    if spec_version > analysis_engine.SPEC_VERSION:
        raise HTTPException(
            409,
            f"This analysis uses spec version {spec_version}; update CellXplorer to import it.",
        )
    _validate_portable_source_chains(package)
    return manifest, package, bounds


def _normalized(value: object) -> str:
    return str(value or "").strip().casefold()


def _source_comparison(document: dict, existing: SourceFile) -> str:
    """Describe which same-lineage source appears to contain more cycling data."""
    for field in ("cycle_count", "row_count", "size"):
        imported_value = document.get(field)
        library_value = getattr(existing, field, None)
        if imported_value is None or library_value is None:
            continue
        try:
            imported_number = int(imported_value)
            library_number = int(library_value)
        except (TypeError, ValueError):
            continue
        if library_number > imported_number:
            return "library_newer"
        if imported_number > library_number:
            return "embedded_newer"
    return "unknown"


def _library_source_candidate(source: SourceFile, document: dict, matched_on: list[str]) -> dict:
    link = source.test_link
    cell = link.test.cell if link is not None else None
    return {
        "source_file_id": source.id,
        "filename": source.filename,
        "path": source.path,
        "hash": source.hash,
        "cell_id": cell.id if cell is not None else None,
        "cell_name": cell.name if cell is not None else None,
        "matched_on": matched_on,
        "comparison": _source_comparison(document, source),
        "cycle_count": source.cycle_count,
        "row_count": source.row_count,
        "size": source.size,
        "location_status": source.location_status,
    }


def _possible_source_candidates(db: Session, document: dict) -> list[dict]:
    filename = _normalized(Path(str(document.get("filename") or "")).name)
    metadata = {
        key: _normalized(document.get(key))
        for key in ("barcode", "channel", "start_time", "remarks")
    }
    candidates: list[tuple[int, SourceFile, list[str]]] = []
    for source in db.query(SourceFile).all():
        if source.hash == str(document.get("hash") or ""):
            continue
        matched_on: list[str] = []
        if filename and filename == _normalized(source.filename):
            matched_on.append("filename")
        for key, value in metadata.items():
            if value and value == _normalized(getattr(source, key, None)):
                matched_on.append(key)
        strong_metadata_match = len([key for key in matched_on if key != "filename"]) >= 3
        if "filename" not in matched_on and not strong_metadata_match:
            continue
        score = (4 if "filename" in matched_on else 0) + len(matched_on)
        candidates.append((score, source, matched_on))
    candidates.sort(key=lambda item: (-item[0], item[1].id))
    return [
        _library_source_candidate(source, document, matched_on)
        for _, source, matched_on in candidates[:5]
    ]


def inspect_analysis_html(db: Session, html_path: Path) -> dict:
    manifest, package, _ = _load_package(html_path)
    originals = {
        item.get("source_id") for item in _payload_by_kind(manifest, "original_source")
    }
    source_reviews: dict[str, dict] = {}
    for document in package.get("sources", []):
        source_id = str(document["portable_id"])
        source_hash = str(document["hash"])
        exact = db.query(SourceFile).filter(SourceFile.hash == source_hash).first()
        embedded = source_id in originals
        if exact is not None:
            link = exact.test_link
            source_reviews[source_id] = {
                "source_id": source_id,
                "filename": document["filename"],
                "hash": source_hash,
                "status": "exact",
                "embedded": embedded,
                "cycle_count": document.get("cycle_count"),
                "row_count": document.get("row_count"),
                "size": document.get("size"),
                "exact_match": _library_source_candidate(exact, document, ["checksum"]),
                "candidates": [],
                "suggested_action": "use_library",
            }
            if link is None:
                source_reviews[source_id]["message"] = (
                    "The checksum already exists as an unassigned library source."
                )
            elif Path(exact.path).is_file():
                source_reviews[source_id]["message"] = (
                    f'Exact checksum match: the embedded file will be discarded and '
                    f'library cell "{link.test.cell.name}" will be used.'
                )
            elif embedded:
                source_reviews[source_id]["message"] = (
                    "Exact checksum match, but the library path is unavailable. "
                    "The embedded copy will restore that source."
                )
            else:
                source_reviews[source_id]["message"] = (
                    "Exact checksum match found, but its library path is unavailable."
                )
            continue

        candidates = _possible_source_candidates(db, document)
        if candidates:
            preferred = candidates[0]
            suggested = (
                "use_library"
                if preferred["comparison"] == "library_newer"
                else "import_embedded"
            )
            source_reviews[source_id] = {
                "source_id": source_id,
                "filename": document["filename"],
                "hash": source_hash,
                "status": "possible_update",
                "embedded": embedded,
                "cycle_count": document.get("cycle_count"),
                "row_count": document.get("row_count"),
                "size": document.get("size"),
                "exact_match": None,
                "candidates": candidates,
                "suggested_library_source_id": preferred["source_file_id"],
                "suggested_action": suggested,
                "message": (
                    "A library source has the same filename or matching test metadata, "
                    "but a different checksum. Choose which version this analysis should use."
                ),
            }
            continue

        source_reviews[source_id] = {
            "source_id": source_id,
            "filename": document["filename"],
            "hash": source_hash,
            "status": "new",
            "embedded": embedded,
            "cycle_count": document.get("cycle_count"),
            "row_count": document.get("row_count"),
            "size": document.get("size"),
            "exact_match": None,
            "candidates": [],
            "suggested_action": "import_embedded",
            "message": (
                "No checksum or likely lineage match was found. "
                + (
                    "The embedded source and cell will be added to the library."
                    if embedded
                    else "The source reference will be added and linked if its recorded path is available."
                )
            ),
        }

    cells: list[dict] = []
    for document in package.get("cells", []):
        source_ids = _portable_source_ids(
            document,
            known_source_ids=set(source_reviews),
        )
        reviews = [source_reviews[source_id] for source_id in source_ids]
        if any(review["status"] == "possible_update" for review in reviews):
            status = "review"
        elif reviews and all(review["status"] == "exact" for review in reviews):
            exact_cell_ids = {
                review["exact_match"]["cell_id"]
                for review in reviews
                if review["exact_match"] is not None
                and review["exact_match"]["cell_id"] is not None
            }
            status = "reuse" if len(exact_cell_ids) == 1 else "add"
        else:
            status = "add"
        cells.append(
            {
                "cell_id": document["portable_id"],
                "name": document["name"],
                "status": status,
                "sources": reviews,
            }
        )

    analysis_document = package.get("analysis") or {}
    return {
        "analysis_title": analysis_document.get("title") or "Imported analysis",
        "created_at": analysis_document.get("created_at"),
        "includes_original_files": bool(manifest.get("includes_original_files")),
        "plot_count": len(package.get("views") or []),
        "cells": cells,
        "sources": list(source_reviews.values()),
        "requires_resolution": any(
            review["status"] == "possible_update" for review in source_reviews.values()
        ),
    }


def import_analysis_html(
    db: Session,
    html_path: Path,
    *,
    folder_id: int | None = None,
    title: str | None = None,
    add_cells_to_folder: bool = False,
    source_resolutions: dict[str, dict] | None = None,
    cell_names: dict[str, str] | None = None,
) -> tuple[Analysis, list[str]]:
    manifest, loaded_package, bounds = _load_package(html_path)
    report_descriptors = _payload_by_kind(manifest, "report")
    warnings: list[str] = []
    with tempfile.TemporaryDirectory(prefix="cellxplorer-import-") as temporary:
        temp_dir = Path(temporary)
        report_path = temp_dir / "report.json"
        _decode_payload(html_path, report_descriptors[0], report_path, bounds)
        package = loaded_package

        descriptors = {item["id"]: item for item in manifest["payloads"]}
        source_documents = {
            source["portable_id"]: source for source in package.get("sources", [])
        }
        source_rows: dict[str, SourceFile] = {}
        originals = {
            item.get("source_id"): item for item in _payload_by_kind(manifest, "original_source")
        }
        raw_caches = {
            item.get("source_id"): item for item in _payload_by_kind(manifest, "raw_cache")
        }
        cycle_caches = {
            item.get("source_id"): item for item in _payload_by_kind(manifest, "cycle_cache")
        }
        import_root = IMPORT_DIR / "portable" / str(package.get("export_id") or uuid.uuid4())
        import_root.mkdir(parents=True, exist_ok=True)
        resolutions = source_resolutions or {}
        imported_cell_names = cell_names or {}
        explicitly_reused_sources: set[str] = set()
        imported_hash_to_effective_hash: dict[str, str] = {}

        for source_id, document in source_documents.items():
            source_hash = str(document["hash"])
            resolution = resolutions.get(source_id) or {}
            action = str(resolution.get("action") or "")
            exact_source = db.query(SourceFile).filter(SourceFile.hash == source_hash).first()
            possible_candidates = (
                [] if exact_source is not None else _possible_source_candidates(db, document)
            )
            if possible_candidates and action not in {"use_library", "import_embedded"}:
                raise HTTPException(
                    422,
                    f'Choose which version to use for "{document["filename"]}".',
                )
            existing: SourceFile | None
            if action == "use_library":
                try:
                    selected_source_id = int(resolution["library_source_file_id"])
                except (KeyError, TypeError, ValueError) as exc:
                    raise HTTPException(
                        422,
                        f'Select a library source for "{document["filename"]}".',
                    ) from exc
                allowed_ids = {
                    int(item["source_file_id"]) for item in possible_candidates
                }
                existing = db.get(SourceFile, selected_source_id)
                if existing is None or existing.id not in allowed_ids:
                    raise HTTPException(
                        409,
                        f'The selected library source is not a valid match for "{document["filename"]}".',
                    )
                explicitly_reused_sources.add(source_id)
            else:
                existing = exact_source
            original_descriptor = originals.get(source_id)
            extracted_path: Path | None = None
            recorded_path: Path | None = None
            recorded_value = str(document.get("path") or "").strip()
            if recorded_value:
                candidate = Path(recorded_value)
                if candidate.is_file():
                    try:
                        if _sha256_file(candidate) == source_hash:
                            recorded_path = candidate
                    except OSError:
                        recorded_path = None
            existing_path_matches = False
            if existing is not None and Path(existing.path).is_file():
                try:
                    existing_path_matches = _sha256_file(Path(existing.path)) == existing.hash
                except OSError:
                    existing_path_matches = False
            if (
                original_descriptor is not None
                and not existing_path_matches
                and source_id not in explicitly_reused_sources
            ):
                safe_name = Path(str(original_descriptor.get("filename") or document["filename"])).name
                extracted_path = import_root / f"{source_hash[:12]}-{safe_name}"
                _decode_payload(html_path, original_descriptor, extracted_path, bounds)
                if _sha256_file(extracted_path) != source_hash:
                    extracted_path.unlink(missing_ok=True)
                    raise HTTPException(400, f"Original source checksum mismatch for {safe_name}.")
            resolved_path = extracted_path or recorded_path
            available_path = Path(existing.path) if existing_path_matches and existing is not None else resolved_path

            if existing is None:
                existing = SourceFile(
                    hash=source_hash,
                    path=str(resolved_path or f"portable://{package.get('export_id')}/{document['filename']}"),
                    filename=document["filename"],
                    size=int(document.get("size") or document.get("row_count") or 0),
                    ext=document.get("ext") or Path(document["filename"]).suffix.lstrip(".").lower(),
                    nda_version=document.get("nda_version"),
                    device_info=document.get("device_info"),
                    channel=document.get("channel"),
                    barcode=document.get("barcode"),
                    remarks=document.get("remarks"),
                    start_time=document.get("start_time"),
                    active_mass_mg=document.get("active_mass_mg"),
                    nominal_capacity_mah=document.get("nominal_capacity_mah"),
                    header_meta=document.get("header_meta"),
                    location_status="online" if resolved_path else "offline",
                    parse_status="parsed" if source_id in raw_caches or source_id in cycle_caches else "unparsed",
                    parser_version=document.get("parser_version") or parsing.PARSER_VERSION,
                    row_count=document.get("row_count"),
                    cycle_count=document.get("cycle_count"),
                    total_charge_capacity_mah=document.get("total_charge_capacity_mah"),
                    total_discharge_capacity_mah=document.get("total_discharge_capacity_mah"),
                    capacity_summary_status=document.get("capacity_summary_status") or "pending",
                )
                db.add(existing)
                db.flush()
            elif resolved_path is not None and not existing_path_matches:
                existing.path = str(resolved_path)
                existing.location_status = "online"
            source_rows[source_id] = existing
            effective_hash = existing.hash
            imported_hash_to_effective_hash[source_hash] = effective_hash

            for descriptor, target in (
                (
                    None if source_id in explicitly_reused_sources else raw_caches.get(source_id),
                    cache.raw_path(
                        effective_hash,
                        (raw_caches.get(source_id) or {}).get("parser_version")
                        or document.get("parser_version")
                        or parsing.PARSER_VERSION,
                    ),
                ),
                (
                    None if source_id in explicitly_reused_sources else cycle_caches.get(source_id),
                    cache.cycles_path(
                        effective_hash,
                        (cycle_caches.get(source_id) or {}).get("parser_version")
                        or document.get("parser_version")
                        or parsing.PARSER_VERSION,
                        (cycle_caches.get(source_id) or {}).get("calc_version") or CALC_VERSION,
                    ),
                ),
            ):
                if descriptor is None:
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                decoded = temp_dir / f"{descriptor['id']}.parquet"
                _decode_payload(html_path, descriptor, decoded, bounds)
                os.replace(decoded, target)

            # Spec 040.3: "current" is per-source now, resolved from this
            # source's own extension — a global bundle default here would
            # look at the wrong content-addressed path and trigger a
            # needless rebuild (or miss a genuinely stale cache) once raw/
            # cycle caches are keyed by per-source identity.
            expected_identity = (
                parsing.current_parser_identity_for_extension(existing.ext)
                or parsing.PARSER_VERSION
            )
            has_current_cache = (
                cache.raw_path(effective_hash, expected_identity).exists()
                and cache.cycles_path(effective_hash, expected_identity).exists()
            )
            if available_path is not None and not has_current_cache:
                existing.parse_status = "parsing"
                existing.capacity_summary_status = "pending"
                try:
                    info = cache.build(effective_hash, available_path)
                    existing.parse_status = "parsed"
                    existing.parse_error = None
                    existing.parser_version = info["parser_version"]
                    existing.row_count = info["rows"]
                    existing.cycle_count = info["cycles"]
                    scanner.apply_capacity_summary(existing, info)
                except Exception as exc:
                    existing.parse_status = "error"
                    existing.parse_error = str(exc)
                    existing.capacity_summary_status = "error"
                    warnings.append(
                        f'Could not rebuild cached data for "{document["filename"]}": {exc}'
                    )
            elif available_path is None and not has_current_cache:
                warnings.append(
                    f'Source "{document["filename"]}" was not found at its recorded path. '
                    "Relink it before recalculating the imported analysis."
                )

        cell_map: dict[int, int] = {}
        portable_cell_map: dict[str, Cell] = {}
        for document in package.get("cells", []):
            source_ids = _portable_source_ids(
                document,
                known_source_ids=set(source_documents),
            )
            if not source_ids:
                raise HTTPException(
                    400,
                    f'Portable Cell "{document.get("name") or "Unnamed"}" has no sources.',
                )
            exported_hashes = [source_documents[source_id]["hash"] for source_id in source_ids]
            linked_cells = {
                source_rows[source_id].test_link.test.cell
                for source_id in source_ids
                if source_rows[source_id].test_link is not None
            }
            cell: Cell | None = None
            if len(linked_cells) == 1:
                candidate = next(iter(linked_cells))
                if _cell_source_hashes(candidate) == exported_hashes or (
                    len(source_ids) == 1 and source_ids[0] in explicitly_reused_sources
                ):
                    cell = candidate
            if linked_cells and cell is None:
                raise HTTPException(
                    409,
                    f'Imported cell "{document["name"]}" partially overlaps existing source data.',
                )
            if cell is None:
                requested_cell_name = str(
                    imported_cell_names.get(document["portable_id"]) or document["name"]
                ).strip()
                cell = Cell(
                    name=_unique_name(db, Cell, requested_cell_name, "imported"),
                    description=document.get("description"),
                    archived=bool(document.get("archived", False)),
                    cycling_status=document.get("cycling_status") or "active",
                )
                db.add(cell)
                db.flush()
                for key, value in (document.get("metadata") or {}).items():
                    db.add(CellMetadata(cell_id=cell.id, key=str(key), value=str(value)))
                test = Test(
                    cell_id=cell.id,
                    name="Imported source chain",
                )
                db.add(test)
                db.flush()
                for position, source_id in enumerate(source_ids):
                    source = source_rows[source_id]
                    db.add(TestFile(test_id=test.id, file_id=source.id, position=position))
            original_id = int(document["original_id"])
            cell_map[original_id] = cell.id
            portable_cell_map[document["portable_id"]] = cell

        group_map: dict[int, int] = {}
        for document in package.get("replicate_groups", []):
            member_ids = [
                portable_cell_map[portable_id].id for portable_id in document.get("cell_ids", [])
            ]
            existing = db.query(ReplicateGroup).filter(ReplicateGroup.name == document["name"]).first()
            if existing and [link.cell_id for link in existing.cell_links] == member_ids:
                group = existing
            else:
                group = ReplicateGroup(
                    name=_unique_name(db, ReplicateGroup, document["name"], "imported"),
                    description=document.get("description"),
                )
                db.add(group)
                db.flush()
                for position, cell_id in enumerate(member_ids):
                    db.add(
                        ReplicateGroupCell(
                            group_id=group.id,
                            cell_id=cell_id,
                            position=position,
                        )
                    )
            group_map[int(document["original_id"])] = group.id

        analysis_document = package["analysis"]
        requested_title = (title or "").strip()
        if requested_title:
            title_conflict = db.query(Analysis.id).filter(
                Analysis.folder_id == folder_id
                if folder_id is not None
                else Analysis.folder_id.is_(None),
                func.lower(Analysis.title) == requested_title.casefold(),
            ).first()
            if title_conflict is not None:
                raise HTTPException(
                    409,
                    f'An analysis named "{requested_title}" already exists in that folder.',
                )
            imported_title = requested_title
        else:
            imported_title = _unique_analysis_title(
                db,
                analysis_document["title"],
                folder_id,
            )
        spec = _remap_spec(analysis_document["spec"], cell_map, group_map)
        spec["title"] = imported_title
        spec["modified_at"] = _now_iso()
        provenance = deepcopy(analysis_document.get("provenance"))
        if provenance:
            for source in provenance.get("sources", []):
                old_cell_id = int(source.get("cell_id"))
                if old_cell_id in cell_map:
                    source["cell_id"] = cell_map[old_cell_id]
                source["file_hashes"] = [
                    imported_hash_to_effective_hash.get(str(file_hash), str(file_hash))
                    for file_hash in source.get("file_hashes", [])
                ]
                # Spec 040.3: per-source pinned identity entries key on hash
                # too, so they must be remapped exactly like `file_hashes`
                # above — otherwise a reused-but-different-hash import would
                # silently lose its pinned parser identity (falling back to
                # current-identity resolution) instead of carrying it over.
                entry_files = source.get("files")
                if isinstance(entry_files, list):
                    for file_entry in entry_files:
                        if not isinstance(file_entry, dict):
                            continue
                        old_hash = file_entry.get("hash")
                        if old_hash is not None:
                            file_entry["hash"] = imported_hash_to_effective_hash.get(
                                str(old_hash), str(old_hash)
                            )
        analysis = Analysis(
            id=next_analysis_id(db),
            title=imported_title,
            folder_id=folder_id,
            spec=spec,
            provenance=provenance,
        )
        db.add(analysis)
        db.flush()
        if folder_id is not None and add_cells_to_folder:
            if db.get(Folder, folder_id) is None:
                raise HTTPException(404, "No such folder")
            existing_folder_cells = {
                row[0]
                for row in db.query(FolderCell.cell_id)
                .filter(FolderCell.folder_id == folder_id)
                .all()
            }
            position = max(
                (
                    row[0]
                    for row in db.query(FolderCell.position)
                    .filter(FolderCell.folder_id == folder_id)
                    .all()
                ),
                default=-1,
            ) + 1
            for cell_id in dict.fromkeys(cell_map.values()):
                if cell_id in existing_folder_cells:
                    continue
                db.add(FolderCell(folder_id=folder_id, cell_id=cell_id, position=position))
                existing_folder_cells.add(cell_id)
                position += 1
        warnings.extend(package.get("warnings") or [])
        if not manifest.get("includes_original_files") and any(
            row.location_status == "offline" for row in source_rows.values()
        ):
            warnings.append(
                "Some original Neware files were not included or could not be found at their recorded paths."
            )
        record_activity(
            db,
            category="analysis",
            action="import_portable_analysis",
            message=f'Imported portable analysis "{imported_title}".',
            entity_type="analysis",
            entity_id=analysis.id,
            details={
                "cell_count": len(cell_map),
                "replicate_group_count": len(group_map),
                "includes_original_files": bool(manifest.get("includes_original_files")),
                "added_cells_to_folder": bool(folder_id is not None and add_cells_to_folder),
                "warning_count": len(warnings),
            },
        )
        db.commit()
        return analysis, list(dict.fromkeys(warnings))
