"""Local-only indexed filters. No scientific parser, cache, hash or source I/O."""
from __future__ import annotations

import json
import math
import multiprocessing
import ntpath
import queue
import re
import threading
import time
from collections import defaultdict

from ..models import Analysis, Cell, CellMetadata, ReplicateGroup, ReplicateGroupCell, SourceFile, Test, TestFile
from .import_search_catalog import Catalog, METADATA_FIELDS, path_key, relative_location, query_variants

TEXT_FIELDS = ("any", "filename", "path", "folder", "barcode", "remarks", "part_number", "technique",
               "device_info", "channel", "cell_name", "cell_notes", "cell_metadata", "analysis", "replicate")
NUMBER_FIELDS = ("size", "cycle_count", "active_mass_mg", "nominal_capacity_mah", "duration_s", "folder_count")
DATE_FIELDS = ("modified_at", "file_created_at", "start_time", "first_indexed_at")
OPERATORS = ("contains", "not_contains", "equals", "not_equals", "starts", "ends", "present", "missing", "regex")
SORTS = ("relevance", "name", "modified", "created", "indexed", "started", "size_asc", "size_desc")
REGEX_SLOTS = threading.BoundedSemaphore(2)


def validate_filters(value):
    if value is None:
        value = {}
    if not isinstance(value, dict):
        raise ValueError("Invalid search filters")
    unknown_keys = set(value) - {"root_id", "extension", "supplier", "technique", "ranges", "conditions", "match",
                                 "registered", "analysis_usage", "replicate_usage", "analysis_id", "replicate_id", "sort"}
    if unknown_keys:
        raise ValueError("Unknown search filter")
    output = dict(value)
    for key in ("root_id", "extension", "supplier", "technique"):
        item = value.get(key)
        if item is not None and (not isinstance(item, str) or len(item) > 512):
            raise ValueError("Invalid search facet")
    for key in ("registered", "analysis_usage", "replicate_usage"):
        if value.get(key, "any") not in ("any", "yes", "no"):
            raise ValueError("Invalid membership filter")
    for key in ("analysis_id", "replicate_id"):
        item = value.get(key)
        if item is not None and (type(item) is not int or item < 1):
            raise ValueError("Invalid relationship identifier")
    if value.get("sort", "relevance") not in SORTS or value.get("match", "all") not in ("all", "any"):
        raise ValueError("Invalid search ordering or condition mode")
    ranges = value.get("ranges", {})
    if not isinstance(ranges, dict) or set(ranges) - set(NUMBER_FIELDS + DATE_FIELDS):
        raise ValueError("Invalid range field")
    for field, item in ranges.items():
        if not isinstance(item, dict) or set(item) - {"min", "max", "unknown"}:
            raise ValueError("Invalid range")
        if item.get("unknown", "exclude") not in ("exclude", "include", "only"):
            raise ValueError("Invalid missing-value policy")
        for bound in ("min", "max"):
            number = item.get(bound)
            if number is None:
                continue
            if isinstance(number, bool) or not isinstance(number, (int, float)) or not math.isfinite(number) or number < 0:
                raise ValueError("Range bounds must be finite nonnegative values")
        if item.get("min") is not None and item.get("max") is not None and item["min"] > item["max"]:
            raise ValueError("Range start must not exceed its end")
    conditions = value.get("conditions", [])
    if not isinstance(conditions, list) or len(conditions) > 16:
        raise ValueError("Use at most 16 text conditions")
    for condition in conditions:
        if not isinstance(condition, dict) or set(condition) - {"field", "operator", "value", "case_sensitive"}:
            raise ValueError("Invalid text condition")
        if condition.get("field") not in TEXT_FIELDS or condition.get("operator") not in OPERATORS:
            raise ValueError("Invalid text field or operator")
        text = condition.get("value", "")
        if not isinstance(text, str) or len(text) > (256 if condition["operator"] == "regex" else 512):
            raise ValueError("Text condition is too long")
        if type(condition.get("case_sensitive", False)) is not bool:
            raise ValueError("Invalid case option")
        if condition["operator"] == "regex":
            try:
                re.compile(text, 0 if condition.get("case_sensitive") else re.IGNORECASE)
            except re.error as exc:
                raise ValueError(f"Invalid regular expression: {exc}") from exc
    output["ranges"], output["conditions"] = ranges, conditions
    return output


def library_snapshot(db, roots):
    """Acquire a real SQLite snapshot, not just SQLAlchemy's logical transaction.

    Python's legacy sqlite transaction mode does not BEGIN for SELECT. Release
    an owned read snapshot before the potentially slow isolated regex worker.
    Respect a caller's real transaction and never autoflush pending edits here.
    """
    connection = db.connection().connection.driver_connection
    owned = not connection.in_transaction
    if owned:
        connection.execute("BEGIN")
    try:
        with db.no_autoflush:
            return _read_library_snapshot(db, roots)
    finally:
        if owned:
            connection.rollback()


def _read_library_snapshot(db, roots):
    """Read current references in a small fixed set of queries; never expand raw headers."""
    cells = {row.id: {"id": row.id, "name": row.name, "notes": row.description or "", "metadata": []}
             for row in db.query(Cell.id, Cell.name, Cell.description).all()}
    for cell_id, key, value in db.query(CellMetadata.cell_id, CellMetadata.key, CellMetadata.value).filter(
        ~CellMetadata.key.startswith("raw."), ~CellMetadata.key.startswith("override.")
    ):
        if cell_id in cells:
            cells[cell_id]["metadata"].append(f"{key}: {value}")
    groups = {row.id: {"id": row.id, "name": row.name} for row in db.query(ReplicateGroup.id, ReplicateGroup.name)}
    group_cells = defaultdict(set)
    cell_groups = defaultdict(list)
    for group_id, cell_id in db.query(ReplicateGroupCell.group_id, ReplicateGroupCell.cell_id):
        if cell_id in cells and group_id in groups:
            group_cells[group_id].add(cell_id)
            cell_groups[cell_id].append(groups[group_id])
    analyses = []
    cell_analyses = defaultdict(list)
    for analysis_id, title, spec in db.query(Analysis.id, Analysis.title, Analysis.spec):
        item = {"id": analysis_id, "name": title}
        analyses.append(item)
        members = set()
        selection = spec.get("selection", {}) if isinstance(spec, dict) else {}
        entries = selection.get("entries", []) if isinstance(selection, dict) else []
        for entry in entries if isinstance(entries, list) else []:
            if not isinstance(entry, dict):
                continue
            ref = entry.get("ref_id")
            if entry.get("kind") == "cell" and ref in cells:
                members.add(ref)
            elif entry.get("kind") == "replicate_group":
                members.update(group_cells.get(ref, ()))
        for member in members:
            cell_analyses[member].append(item)
    rows = db.query(SourceFile.path, SourceFile.size, SourceFile.observed_mtime_ns, SourceFile.cycle_count,
                    SourceFile.active_mass_mg, SourceFile.nominal_capacity_mah, SourceFile.parse_status, SourceFile.location_status, Test.cell_id
                    ).outerjoin(TestFile, TestFile.file_id == SourceFile.id).outerjoin(Test, Test.id == TestFile.test_id)
    facts = {}
    for path, size, mtime, cycles, mass, capacity, status, location_status, cell_id in rows:
        canonical = path_key(path)
        aliases = {canonical}
        for root in roots:
            display, resolved = path_key(root["path"]), root.get("canonical_root")
            if resolved and (canonical == display or canonical.startswith(display.rstrip("\\/") + "\\")):
                aliases.add(path_key(resolved.rstrip("\\/") + "\\" + canonical[len(display):].lstrip("\\/")))
            if resolved and (canonical == resolved or canonical.startswith(resolved.rstrip("\\/") + "\\")):
                aliases.add(path_key(display.rstrip("\\/") + "\\" + canonical[len(resolved):].lstrip("\\/")))
        cell = cells.get(cell_id)
        info = dict(registered=True, cells=[{k: v for k, v in cell.items() if k not in ("metadata", "notes")}] if cell else [],
                    cell_name=cell["name"] if cell else "", cell_notes=cell["notes"] if cell else "",
                    cell_metadata="\n".join(cell["metadata"]) if cell else "",
                    analyses=cell_analyses[cell_id], replicates=cell_groups[cell_id], size=size, mtime=mtime,
                    cycle_count=cycles if status == "parsed" and location_status == "online" else None,
                    active_mass_mg=mass if location_status == "online" else None,
                    nominal_capacity_mah=capacity if location_status == "online" else None)
        for alias in aliases:
            if alias in facts:
                previous = facts[alias]
                for key in ("cells", "analyses", "replicates"):
                    previous[key] = list({v["id"]: v for v in previous[key] + info[key]}.values())
                for key in ("cell_name", "cell_notes", "cell_metadata"):
                    previous[key] += "\n" + info[key]
                # Multiple registered versions at one path cannot establish source facts.
                previous.update(cycle_count=None, active_mass_mg=None, nominal_capacity_mah=None)
            else:
                facts[alias] = dict(info)
    return facts, {"analyses": analyses, "replicates": list(groups.values())}


def _install_library(connection, facts):
    connection.execute("CREATE TEMP TABLE search_library(canonical TEXT PRIMARY KEY, data TEXT NOT NULL, search_text TEXT NOT NULL)")
    connection.executemany("INSERT INTO search_library VALUES(?,?,?)", ((key, json.dumps(value), "\n".join(
        [value.get(field, "") for field in ("cell_name", "cell_notes", "cell_metadata")]
        + [entry["name"] for field in ("analyses", "replicates") for entry in value.get(field, [])]).casefold()) for key, value in facts.items()))


def _query(catalog_path, config, q, filters, offset, limit, library):
    catalog = Catalog.__new__(Catalog)
    from pathlib import Path
    catalog.path = Path(catalog_path)
    with catalog.connect() as connection:
        has_fts = bool(connection.execute("SELECT 1 FROM sqlite_master WHERE name='search_fts'").fetchone())
    root_ids = [r["id"] for r in config["roots"] if r["enabled"] and (not filters.get("root_id") or r["id"] == filters["root_id"])]
    if not root_ids or not config["formats"]:
        return dict(items=[], total=0, offset=offset, limit=limit, has_more=False)
    parameters = []
    def parameter(value):
        parameters.append(value)
        return "?"
    meta_enabled = bool(config["metadata_enabled"])
    def meta(field):
        return f"json_extract(e.metadata_json,'$.{field}')" if meta_enabled else "NULL"
    def lib(field):
        return f"json_extract(l.data,'$.{field}')"
    fields = {"filename": "e.name", "path": "e.path", "folder": "search_folder(e.path)",
              **{field: meta(field) for field in METADATA_FIELDS},
              **{field: lib(field) for field in ("cell_name", "cell_notes", "cell_metadata")},
              "analysis": "(SELECT group_concat(json_extract(value,'$.name'),char(10)) FROM json_each(l.data,'$.analyses'))",
              "replicate": "(SELECT group_concat(json_extract(value,'$.name'),char(10)) FROM json_each(l.data,'$.replicates'))"}
    fields["any"] = " || char(10) || ".join(f"coalesce({fields[field]},'')" for field in TEXT_FIELDS if field != "any")
    numbers = {"size": "e.size", "folder_count": "fc.count"}
    for field in NUMBER_FIELDS[1:-1]:
        stored = f"CASE WHEN {lib('size')}=e.size AND {lib('mtime')}=e.mtime_ns THEN {lib(field)} END"
        numbers[field] = f"search_number(coalesce({meta(field)}, {stored}))"
    numbers.update({"modified_at": "search_date(e.modified_at)", "file_created_at": "search_date(e.file_created_at)",
                    "first_indexed_at": "search_date(e.first_indexed_at)", "start_time": f"search_date({meta('start_time')})"})
    clauses = ["e.recognition!='unsupported'", "e.extension IN (" + ",".join(parameter(v) for v in config["formats"]) + ")",
               "EXISTS(SELECT 1 FROM memberships m WHERE m.canonical=e.canonical AND m.root_id IN ("
               + ",".join(parameter(v) for v in root_ids) + "))"]
    for field in ("extension", "supplier", "technique"):
        if filters.get(field):
            expression = meta("technique") if field == "technique" else f"e.{field}"
            clauses.append(f"casefold({expression})={parameter(filters[field].casefold())}")
    for term in q.strip().casefold().split()[:8]:
        indexed = "e.search_text" if meta_enabled else "casefold(e.path || char(10) || e.canonical)"
        clauses.append("(" + " OR ".join(f"instr({expression},{parameter(variant)})>0"
            for expression in (indexed, "l.search_text") for variant in query_variants(term)) + ")")
        # Keep trigram candidate lookup, including current relational matches.
        # Literal checks above preserve punctuation/path/casefold semantics.
        if has_fts and len(term) >= 3:
            match = " OR ".join('"' + variant.replace('"', '""') + '"' for variant in query_variants(term))
            fts_parameter = parameter(match)
            library_match = " OR ".join(f"instr(search_text,{parameter(variant)})>0" for variant in query_variants(term))
            clauses.append(f"(e.id IN (SELECT rowid FROM search_fts WHERE search_fts MATCH {fts_parameter}) "
                           f"OR e.canonical IN (SELECT canonical FROM search_library WHERE {library_match}))")
    for field, bounds in filters.get("ranges", {}).items():
        expression = numbers[field]
        if bounds.get("unknown") == "only":
            clauses.append(f"{expression} IS NULL")
            continue
        parts = []
        for key, operation in (("min", ">="), ("max", "<=")):
            if bounds.get(key) is not None:
                parts.append(f"{expression}{operation}{parameter(bounds[key])}")
        mode = bounds.get("unknown", "exclude")
        known = " AND ".join(parts) if parts else f"{expression} IS NOT NULL"
        clauses.append(f"{expression} IS NULL" if mode == "only" else
                       f"({expression} IS NULL OR ({known}))" if mode == "include" else f"({expression} IS NOT NULL AND ({known}))")
    for field, expression in (("registered", "l.canonical IS NOT NULL"),
                              ("analysis_usage", f"json_array_length({lib('analyses')})>0"),
                              ("replicate_usage", f"json_array_length({lib('replicates')})>0")):
        state = filters.get(field, "any")
        if state != "any":
            clauses.append(f"coalesce(({expression}),0)={parameter(1 if state == 'yes' else 0)}")
    for field, path in (("analysis_id", "analyses"), ("replicate_id", "replicates")):
        if filters.get(field):
            clauses.append(f"EXISTS(SELECT 1 FROM json_each(l.data,'$.{path}') WHERE json_extract(value,'$.id')={parameter(filters[field])})")
    text_clauses = []
    text_parameters = []
    for condition in filters.get("conditions", []):
        condition_start = len(parameters)
        expression = fields[condition["field"]]
        operation, value = condition["operator"], condition.get("value", "")
        if operation in ("present", "missing"):
            text_clauses.append(f"length(coalesce({expression},'')){'>0' if operation == 'present' else '=0'}")
            continue
        if operation == "regex":
            text_clauses.append(f"search_regex({parameter(value)},coalesce({expression},''),{parameter(int(condition.get('case_sensitive', False)))})")
            text_parameters.extend(parameters[condition_start:])
            continue
        expression = f"coalesce({expression},'')"
        if not condition.get("case_sensitive"):
            expression, value = f"casefold({expression})", value.casefold()
        if operation in ("contains", "not_contains"):
            text_clauses.append(f"instr({expression},{parameter(value)}){'=0' if operation == 'not_contains' else '>0'}")
        elif operation in ("equals", "not_equals"):
            text_clauses.append(f"{expression}{'!=' if operation == 'not_equals' else '='}{parameter(value)}")
        elif operation == "starts":
            text_clauses.append(f"substr({expression},1,{parameter(len(value))})={parameter(value)}")
        else:
            text_clauses.append(f"substr({expression},-{parameter(len(value))})={parameter(value)}")
        text_parameters.extend(parameters[condition_start:])
    if text_clauses:
        clauses.append("(" + (" OR " if filters.get("match") == "any" else " AND ").join(text_clauses) + ")")
    sort = filters.get("sort", "relevance")
    sort_expression = {"modified": numbers["modified_at"], "created": numbers["file_created_at"],
                       "indexed": numbers["first_indexed_at"], "started": numbers["start_time"],
                       "size_asc": "e.size", "size_desc": "e.size"}.get(sort)
    ordering = "e.name_fold,e.canonical"
    if sort_expression:
        ordering = f"{sort_expression} IS NULL,{sort_expression} {'ASC' if sort == 'size_asc' else 'DESC'}," + ordering
    elif sort == "relevance" and q.strip():
        ordering = "CASE WHEN e.name_fold=? THEN 0 WHEN instr(e.name_fold,?)>0 THEN 1 ELSE 2 END," + ordering
    from datetime import datetime, timezone
    def number(value):
        try:
            parsed = float(value)
            return parsed if math.isfinite(parsed) and parsed >= 0 else None
        except (TypeError, ValueError, OverflowError):
            return None
    def date(value):
        try:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
            return (parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)).timestamp()
        except (TypeError, ValueError, OverflowError):
            return None
    patterns = {}
    def regex(pattern, text, sensitive):
        key = (pattern, sensitive)
        if key not in patterns:
            patterns[key] = re.compile(pattern, 0 if sensitive else re.IGNORECASE)
        return int(bool(patterns[key].search(text)))
    with catalog.connect() as connection:
        _install_library(connection, library)
        connection.create_function("search_number", 1, number, deterministic=True)
        connection.create_function("search_date", 1, date, deterministic=True)
        connection.create_function("search_regex", 3, regex, deterministic=True)
        connection.create_function("search_folder", 1, lambda path: ntpath.dirname(path) if "\\" in path else path.rsplit("/", 1)[0], deterministic=True)
        connection.commit()  # Temporary library writes precede the catalog read snapshot.
        connection.execute("BEGIN")
        connection.execute("CREATE TEMP TABLE folder_counts AS SELECT e.folder_key,count(*) AS count FROM entries e "
                           "WHERE e.recognition='recognized' AND e.extension IN (" + ",".join("?" for _ in config["formats"])
                           + ") AND EXISTS(SELECT 1 FROM memberships m WHERE m.canonical=e.canonical AND m.root_id IN ("
                           + ",".join("?" for _ in root_ids) + ")) GROUP BY e.folder_key", (*config["formats"], *root_ids))
        connection.execute("CREATE INDEX folder_counts_key ON folder_counts(folder_key)")
        base = " FROM entries e LEFT JOIN search_library l ON l.canonical=e.canonical LEFT JOIN folder_counts fc ON fc.folder_key=e.folder_key WHERE " + " AND ".join(clauses)
        total = connection.execute("SELECT count(*)" + base, parameters).fetchone()[0]
        rank_params = [q.strip().casefold()] * 2 if sort == "relevance" and q.strip() else []
        match_select = "".join(f",coalesce(({expression}),0) AS match_{index},substr(coalesce({fields[filters['conditions'][index]['field']]},''),1,220) AS value_{index}" for index, expression in enumerate(text_clauses))
        facts_select = "".join(f",{expression} AS effective_{field}" for field, expression in numbers.items())
        rows = connection.execute("SELECT e.*,l.data AS library,fc.count AS folder_count" + facts_select + match_select + base + " ORDER BY " + ordering + " LIMIT ? OFFSET ?",
                                  (*text_parameters, *parameters, *rank_params, limit, offset)).fetchall()
        states = {row["id"]: dict(row) for row in connection.execute("SELECT * FROM roots")}
        items = []
        for row in rows:
            item = dict(row)
            owners = connection.execute("SELECT root_id FROM memberships WHERE canonical=? AND root_id IN ("
                                        + ",".join("?" for _ in root_ids) + ")", (item["canonical"], *root_ids)).fetchall()
            owner = max((states[r[0]] for r in owners), key=lambda root: len(root["path"]))
            info = json.loads(item.pop("library") or "{}")
            item["matched_conditions"] = [index for index in range(len(text_clauses)) if item.pop(f"match_{index}")]
            item["condition_values"] = {str(index): item.pop(f"value_{index}") for index in range(len(text_clauses))}
            item["indexed_values"] = {field: item.pop(f"effective_{field}") for field in numbers}
            library_matches = []
            for field, label in (("cell_name", "Cell name"), ("cell_notes", "Cell notes"), ("cell_metadata", "Cell metadata")):
                text = info.get(field, "")
                for term in q.strip().casefold().split()[:8]:
                    position = text.casefold().find(term)
                    if position >= 0:
                        library_matches.append(f"{label}: {text[max(0, position - 40):position + 120]}")
                        break
            for field, label in (("analyses", "Analysis"), ("replicates", "Replicate")):
                library_matches.extend(f"{label}: {entry['name']}" for entry in info.get(field, [])
                                       if any(term in entry["name"].casefold() for term in q.strip().casefold().split()[:8]))
            item.update(root_id=owner["id"], root_path=owner["path"], root_status=owner["status"],
                        relative_path=relative_location(item, owner), registered=bool(info),
                        metadata=json.loads(item.pop("metadata_json")) if meta_enabled else {},
                        cells=info.get("cells", []), analyses=info.get("analyses", []), replicates=info.get("replicates", []),
                        library_matches=library_matches,
                        folder_count_partial=any(states[r]["status"] != "ready" for r in root_ids))
            for key in ("search_text", "name_fold"):
                item.pop(key, None)
            items.append(item)
        return dict(items=items, total=total, offset=offset, limit=limit, has_more=offset + len(items) < total)


def _regex_job(output, args):
    try:
        output.put((True, _query(*args)))
    except Exception as exc:
        output.put((False, str(exc)))


def filtered_search(catalog, config, query, filters, offset, limit, library):
    filters = validate_filters(filters)
    args = (str(catalog.path), config, query, filters, offset, limit, library)
    if not any(c["operator"] == "regex" for c in filters["conditions"]):
        return _query(*args)
    if not REGEX_SLOTS.acquire(blocking=False):
        raise ValueError("Two pattern searches are already running. Try again shortly.")
    context = multiprocessing.get_context("spawn")
    output = context.Queue(1)
    process = context.Process(target=_regex_job, args=(output, args), daemon=True)
    try:
        started = time.monotonic()
        process.start()
        try:
            success, result = output.get(timeout=max(0.01, 3 - (time.monotonic() - started)))
        except queue.Empty as exc:
            raise ValueError("Pattern search exceeded three seconds. Narrow the search or simplify the expression.") from exc
        if not success:
            raise ValueError(result)
        return result
    finally:
        if process.pid is not None:
            if process.is_alive():
                process.terminate()
            process.join(0.2)
        output.cancel_join_thread()
        output.close()
        REGEX_SLOTS.release()
