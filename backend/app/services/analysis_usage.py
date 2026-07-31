"""Preview and apply analysis impact for cell/group removal.

`preview_removal_usage` is read-only. After replicate explode/ungroup (or group
delete), `strip_replicate_groups_from_analyses` removes those group entries from
surviving analysis specs so the UI is not left with dead "missing reference"
rows the user already acknowledged in the impact modal.
"""

from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from typing import Any, Iterable, Literal

from sqlalchemy.orm import Session

from ..models import Analysis, Cell, ReplicateGroup, ReplicateGroupCell, Test, TestFile
from . import analysis_cache, analysis_engine
from . import cache_maintenance


def _as_id_set(values: Iterable[int] | None) -> set[int]:
    return {int(value) for value in (values or []) if value is not None}


def _group_members(db: Session, group_ids: set[int]) -> dict[int, set[int]]:
    if not group_ids:
        return {}
    rows = (
        db.query(ReplicateGroupCell.group_id, ReplicateGroupCell.cell_id)
        .filter(ReplicateGroupCell.group_id.in_(group_ids))
        .all()
    )
    members: dict[int, set[int]] = {group_id: set() for group_id in group_ids}
    for group_id, cell_id in rows:
        members.setdefault(int(group_id), set()).add(int(cell_id))
    return members


def _groups_for_cells(db: Session, cell_ids: set[int]) -> dict[int, set[int]]:
    """Map cell_id -> group_ids that contain it."""
    if not cell_ids:
        return {}
    rows = (
        db.query(ReplicateGroupCell.cell_id, ReplicateGroupCell.group_id)
        .filter(ReplicateGroupCell.cell_id.in_(cell_ids))
        .all()
    )
    mapping: dict[int, set[int]] = {cell_id: set() for cell_id in cell_ids}
    for cell_id, group_id in rows:
        mapping.setdefault(int(cell_id), set()).add(int(group_id))
    return mapping


def _name_maps(
    db: Session, cell_ids: set[int], group_ids: set[int]
) -> tuple[dict[int, str], dict[int, str]]:
    cell_names = {
        int(row.id): str(row.name)
        for row in db.query(Cell.id, Cell.name).filter(Cell.id.in_(cell_ids)).all()
    } if cell_ids else {}
    group_names = {
        int(row.id): str(row.name)
        for row in db.query(ReplicateGroup.id, ReplicateGroup.name)
        .filter(ReplicateGroup.id.in_(group_ids))
        .all()
    } if group_ids else {}
    return cell_names, group_names


def _exclusion_hides(
    exclusions: list[dict],
    *,
    cell_id: int,
    entry_kind: str,
    entry_ref_id: int,
) -> bool:
    for exclusion in exclusions or []:
        if exclusion.get("cell_id") != cell_id:
            continue
        entry_kind_ex = exclusion.get("entry_kind")
        entry_ref_ex = exclusion.get("entry_ref_id")
        if entry_kind_ex is None and entry_ref_ex is None:
            return True
        if entry_kind_ex is not None and entry_kind_ex != entry_kind:
            continue
        if entry_ref_ex is not None and entry_ref_ex != entry_ref_id:
            continue
        return True
    return False


def _plot_affected(
    plot: dict,
    *,
    becomes_empty: bool,
    lost_units: list[dict[str, Any]],
) -> bool:
    if becomes_empty:
        return True
    if not lost_units:
        return False
    exclusions = (plot.get("selection") or {}).get("exclusions") or []
    return not all(
        _exclusion_hides(
            exclusions,
            cell_id=int(unit["cell_id"]),
            entry_kind=str(unit["entry_kind"]),
            entry_ref_id=int(unit["entry_ref_id"]),
        )
        for unit in lost_units
    )


def preview_removal_usage(
    db: Session,
    *,
    cell_ids: Iterable[int] | None = None,
    group_ids: Iterable[int] | None = None,
) -> dict[str, Any]:
    """Return analyses/plots impacted by removing the given cells and/or groups."""
    requested_cells = _as_id_set(cell_ids)
    requested_groups = _as_id_set(group_ids)
    if not requested_cells and not requested_groups:
        return {"analyses": [], "empty_after": []}

    groups_containing_cells = _groups_for_cells(db, requested_cells)
    relevant_group_ids = set(requested_groups)
    for group_set in groups_containing_cells.values():
        relevant_group_ids.update(group_set)
    members_by_group = _group_members(db, relevant_group_ids)

    name_cell_ids = set(requested_cells)
    for members in members_by_group.values():
        name_cell_ids.update(members)
    cell_names, group_names = _name_maps(db, name_cell_ids, relevant_group_ids)

    analyses_out: list[dict[str, Any]] = []
    empty_after: list[int] = []

    for analysis in db.query(Analysis).all():
        spec = analysis.spec or {}
        entries = (spec.get("selection") or {}).get("entries") or []
        matched: list[dict[str, Any]] = []
        matched_keys: set[tuple[str, int]] = set()
        lost_units: list[dict[str, Any]] = []
        surviving = 0

        for entry in entries:
            kind = entry.get("kind")
            try:
                ref_id = int(entry.get("ref_id"))
            except (TypeError, ValueError):
                surviving += 1
                continue

            if kind == "cell":
                if ref_id in requested_cells:
                    key = ("cell", ref_id)
                    if key not in matched_keys:
                        matched_keys.add(key)
                        matched.append(
                            {
                                "kind": "cell",
                                "ref_id": ref_id,
                                "name": cell_names.get(ref_id, f"Cell {ref_id}"),
                            }
                        )
                    lost_units.append(
                        {
                            "cell_id": ref_id,
                            "entry_kind": "cell",
                            "entry_ref_id": ref_id,
                        }
                    )
                else:
                    surviving += 1
                continue

            if kind == "replicate_group":
                members = members_by_group.get(ref_id, set())
                if ref_id in requested_groups:
                    key = ("replicate_group", ref_id)
                    if key not in matched_keys:
                        matched_keys.add(key)
                        matched.append(
                            {
                                "kind": "replicate_group",
                                "ref_id": ref_id,
                                "name": group_names.get(ref_id, f"Group {ref_id}"),
                            }
                        )
                    for cell_id in members:
                        lost_units.append(
                            {
                                "cell_id": cell_id,
                                "entry_kind": "replicate_group",
                                "entry_ref_id": ref_id,
                            }
                        )
                    # Explode/ungroup removes the group entry.
                    continue

                hit_cells = members & requested_cells
                if hit_cells:
                    for cell_id in sorted(hit_cells):
                        key = ("cell", cell_id)
                        if key not in matched_keys:
                            matched_keys.add(key)
                            matched.append(
                                {
                                    "kind": "cell",
                                    "ref_id": cell_id,
                                    "name": cell_names.get(cell_id, f"Cell {cell_id}"),
                                }
                            )
                        lost_units.append(
                            {
                                "cell_id": cell_id,
                                "entry_kind": "replicate_group",
                                "entry_ref_id": ref_id,
                            }
                        )
                    # Survive only when at least one member remains after the removal.
                    if members - requested_cells:
                        surviving += 1
                else:
                    surviving += 1
                continue

            surviving += 1

        if not matched:
            continue

        becomes_empty = surviving == 0
        plots_out = []
        for plot in spec.get("saved_plots") or []:
            plot_id = plot.get("id")
            if not plot_id:
                continue
            plots_out.append(
                {
                    "id": str(plot_id),
                    "name": str(plot.get("name") or "Saved plot"),
                    "tab": str(plot.get("tab") or ""),
                    "affected": _plot_affected(
                        plot,
                        becomes_empty=becomes_empty,
                        lost_units=lost_units,
                    ),
                }
            )

        analyses_out.append(
            {
                "id": analysis.id,
                "title": analysis.title,
                "matched": matched,
                "remaining_entry_count": surviving,
                "becomes_empty": becomes_empty,
                "plots": plots_out,
            }
        )
        if becomes_empty:
            empty_after.append(analysis.id)

    analyses_out.sort(key=lambda row: (not row["becomes_empty"], row["title"].casefold(), row["id"]))
    return {"analyses": analyses_out, "empty_after": empty_after}


def _strip_groups_from_selection(selection: dict | None, group_ids: set[int]) -> bool:
    """Remove exploded/deleted replicate groups from one selection block."""
    if not selection or not group_ids:
        return False
    changed = False
    entries = selection.get("entries")
    if isinstance(entries, list):
        kept = []
        for entry in entries:
            if not isinstance(entry, dict):
                kept.append(entry)
                continue
            if entry.get("kind") == "replicate_group":
                try:
                    ref_id = int(entry.get("ref_id"))
                except (TypeError, ValueError):
                    kept.append(entry)
                    continue
                if ref_id in group_ids:
                    changed = True
                    continue
            kept.append(entry)
        if changed:
            selection["entries"] = kept

    exclusions = selection.get("exclusions")
    if isinstance(exclusions, list):
        kept_exclusions = []
        for exclusion in exclusions:
            if not isinstance(exclusion, dict):
                kept_exclusions.append(exclusion)
                continue
            if exclusion.get("entry_kind") == "replicate_group":
                try:
                    ref_id = int(exclusion.get("entry_ref_id"))
                except (TypeError, ValueError):
                    kept_exclusions.append(exclusion)
                    continue
                if ref_id in group_ids:
                    changed = True
                    continue
            kept_exclusions.append(exclusion)
        if len(kept_exclusions) != len(exclusions):
            selection["exclusions"] = kept_exclusions
            changed = True

    hidden = selection.get("hidden_replicate_group_ids")
    if isinstance(hidden, list):
        kept_hidden = []
        for value in hidden:
            try:
                group_id = int(value)
            except (TypeError, ValueError):
                kept_hidden.append(value)
                continue
            if group_id in group_ids:
                changed = True
                continue
            kept_hidden.append(group_id)
        if len(kept_hidden) != len(hidden):
            selection["hidden_replicate_group_ids"] = kept_hidden
            changed = True

    return changed


def strip_replicate_groups_from_analyses(
    db: Session,
    group_ids: Iterable[int] | None,
) -> dict[str, Any]:
    """Drop deleted/exploded replicate groups from every analysis selection.

    Caller is responsible for committing. Returns modified analysis ids.
    """
    removed_groups = _as_id_set(group_ids)
    if not removed_groups:
        return {"modified_analysis_ids": []}

    modified: list[int] = []
    for analysis in db.query(Analysis).all():
        spec = deepcopy(analysis.spec or {})
        changed = _strip_groups_from_selection(spec.get("selection"), removed_groups)
        for plot in spec.get("saved_plots") or []:
            if isinstance(plot, dict) and _strip_groups_from_selection(
                plot.get("selection"), removed_groups
            ):
                changed = True
        if not changed:
            continue
        analysis.spec = spec
        modified.append(int(analysis.id))
    return {"modified_analysis_ids": modified}


def purge_empty_candidates(
    db: Session,
    analysis_ids: Iterable[int] | None,
) -> dict[str, Any]:
    """Delete only preflight candidates that currently resolve to zero samples.

    Called after a destructive mutation. Does not trust the client to declare
    emptiness — each candidate is re-resolved against the live database.
    """
    candidates = sorted(_as_id_set(analysis_ids))
    deleted: list[int] = []
    for analysis_id in candidates:
        analysis = db.get(Analysis, analysis_id)
        if analysis is None:
            continue
        units, _missing = analysis_engine.resolve_selection(db, analysis.spec or {})
        if units:
            continue
        db.delete(analysis)
        deleted.append(analysis_id)
    if deleted:
        db.commit()
        for analysis_id in deleted:
            analysis_cache.delete_analysis_artifacts(analysis_id)
    return {"deleted_ids": deleted}


SourceChangeOperation = Literal["attach", "reorder", "detach"]


def ordered_test_file_ids(test: Test) -> list[int]:
    return [
        int(link.file_id)
        for link in sorted(test.file_links, key=lambda item: item.position)
    ]


def tracked_source_file_id(cell: Cell) -> int | None:
    """Final file in the Cell's one ordered source chain."""
    links = analysis_engine.ordered_cell_source_links(cell)
    return int(links[-1].file_id) if links else None


def proposed_cell_source_chain(
    cell: Cell,
    target_test: Test,
    *,
    proposed_file_ids: list[int],
    staged_names: list[str] | None = None,
    staged_filenames: list[str] | None = None,
) -> list[dict[str, Any]]:
    """Build the complete ordered Cell source state for one proposed mutation."""
    analysis_engine.require_single_internal_test(cell)
    staged_names = list(staged_names or [])
    staged_filenames = list(staged_filenames or [])
    chain: list[dict[str, Any]] = []
    if target_test.id not in {test.id for test in cell.tests}:
        raise ValueError("Target Test does not belong to the Cell")
    file_ids = list(proposed_file_ids)
    for position, file_id in enumerate(file_ids):
        chain.append(
            {
                "test_id": target_test.id,
                "file_id": int(file_id),
                "position": position,
                "staged_name": None,
                "filename": None,
            }
        )
    for offset, staged_name in enumerate(staged_names, start=len(file_ids)):
        chain.append(
            {
                "test_id": target_test.id,
                "file_id": None,
                "position": offset,
                "staged_name": staged_name,
                "filename": (
                    staged_filenames[offset - len(file_ids)]
                    if offset - len(file_ids) < len(staged_filenames)
                    else staged_name
                ),
            }
        )
    return chain


def _analysis_plot_summaries(db: Session, analysis_ids: list[int]) -> list[dict[str, Any]]:
    if not analysis_ids:
        return []
    rows = db.query(Analysis).filter(Analysis.id.in_(analysis_ids)).all()
    rows.sort(key=lambda row: (row.title.casefold(), row.id))
    summaries: list[dict[str, Any]] = []
    for analysis in rows:
        plots = analysis.spec.get("saved_plots") if isinstance(analysis.spec, dict) else []
        plot_rows = []
        for plot in plots or []:
            if not isinstance(plot, dict):
                continue
            plot_id = plot.get("id")
            if not plot_id:
                continue
            plot_rows.append(
                {
                    "id": str(plot_id),
                    "name": str(plot.get("name") or "Saved plot"),
                    "tab": str(plot.get("tab") or ""),
                }
            )
        summaries.append(
            {
                "id": analysis.id,
                "title": analysis.title,
                "plot_count": len(plot_rows),
                "plots": plot_rows,
            }
        )
    return summaries


def source_change_impact_token(
    *,
    test_id: int,
    operation: SourceChangeOperation,
    proposed_file_ids: list[int],
    detach_file_id: int | None = None,
    staged_names: list[str] | None = None,
    proposed_chain: list[dict[str, Any]] | None = None,
) -> str:
    payload = json.dumps(
        {
            "test_id": test_id,
            "operation": operation,
            "proposed_file_ids": proposed_file_ids,
            "detach_file_id": detach_file_id,
            "staged_names": staged_names or [],
            "proposed_chain": proposed_chain or [],
        },
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:32]


def preview_source_change_impact(
    db: Session,
    *,
    test: Test,
    operation: SourceChangeOperation,
    proposed_file_ids: list[int],
    detach_file_id: int | None = None,
    staged_filenames: list[str] | None = None,
    staged_names: list[str] | None = None,
) -> dict[str, Any]:
    cell = test.cell
    current_file_ids = ordered_test_file_ids(test)
    current_chain = proposed_cell_source_chain(
        cell,
        test,
        proposed_file_ids=current_file_ids,
    )
    proposed_chain = proposed_cell_source_chain(
        cell,
        test,
        proposed_file_ids=proposed_file_ids,
        staged_names=staged_names,
        staged_filenames=staged_filenames,
    )
    old_tail = current_chain[-1] if current_chain else None
    new_tail = proposed_chain[-1] if proposed_chain else None
    old_tracked = old_tail.get("file_id") if old_tail else None
    new_tracked = new_tail.get("file_id") if new_tail else None
    new_tracked_staged_name = new_tail.get("staged_name") if new_tail else None
    new_tracked_filename = new_tail.get("filename") if new_tail else None
    if operation == "attach":
        global_cycles_change = bool(staged_filenames)
        destructive = False
        reversible = True
        tracked_tail_changes = (
            old_tracked != new_tracked or bool(new_tracked_staged_name)
        )
    elif operation == "reorder":
        global_cycles_change = proposed_file_ids != current_file_ids
        destructive = False
        reversible = True
        tracked_tail_changes = old_tracked != new_tracked
    else:
        global_cycles_change = True
        destructive = True
        reversible = False
        tracked_tail_changes = old_tracked != new_tracked

    analysis_ids = cache_maintenance.dependent_analysis_ids(db, [cell.id])
    analyses = _analysis_plot_summaries(db, analysis_ids)
    plot_count = sum(item["plot_count"] for item in analyses)
    return {
        "cell_id": cell.id,
        "cell_name": cell.name,
        "test_id": test.id,
        "test_name": test.name,
        "operation": operation,
        "current_file_ids": current_file_ids,
        "proposed_file_ids": proposed_file_ids,
        "staged_filenames": staged_filenames or [],
        "old_tracked_source_id": old_tracked,
        "new_tracked_source_id": new_tracked,
        "new_tracked_staged_name": new_tracked_staged_name,
        "new_tracked_filename": new_tracked_filename,
        "tracked_tail_changes": tracked_tail_changes,
        "global_cycle_numbering_changes": global_cycles_change,
        "destructive": destructive,
        "reversible_by_reordering": reversible,
        "analysis_count": len(analyses),
        "saved_plot_count": plot_count,
        "analyses": analyses,
        "confirmation_token": source_change_impact_token(
            test_id=test.id,
            operation=operation,
            proposed_file_ids=proposed_file_ids,
            detach_file_id=detach_file_id,
            staged_names=staged_names,
            proposed_chain=proposed_chain,
        ),
    }
