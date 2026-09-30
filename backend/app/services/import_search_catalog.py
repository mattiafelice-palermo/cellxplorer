"""Disposable, local source discovery catalog. Queries never touch source paths."""
from __future__ import annotations

import json
import ntpath
import os
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from ..config import APP_DATA_DIR

CATALOG_PATH = APP_DATA_DIR / "search-index" / "catalog.sqlite"
SCHEMA_VERSION = 1
METADATA_VERSION = 1
FORMATS = (".ndax", ".mpr", ".xlsx")
METADATA_FIELDS = ("barcode", "remarks", "part_number", "start_time", "technique")


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def path_key(path: str) -> str:
    if ntpath.splitdrive(path)[0] or "\\" in path:
        return ntpath.normpath(path.replace("/", "\\")).casefold()
    return os.path.normpath(path).casefold()


def search_text(path: str, metadata: dict, canonical: str = "") -> str:
    return (path + "\n" + path_key(path) + "\n" + canonical + "\n" + "\n".join(str(value) for value in metadata.values())).casefold()


def query_variants(term: str) -> list[str]:
    if "/" in term or "\\" in term:
        return list(dict.fromkeys((term, ntpath.normpath(term.replace("/", "\\")).casefold())))
    return [term]


def relative_location(item: dict, owner: dict) -> str:
    # Retained memberships may use an earlier mapped-drive identity after a
    # remap or failed refresh. Their display path still gives a useful location.
    for path, root in ((item["canonical"], owner["canonical_root"] or path_key(owner["path"])),
                       (item["path"], owner["path"])):
        try:
            relative = ntpath.relpath(path, root)
            if relative != ".." and not relative.startswith("..\\"):
                return relative
        except ValueError:
            continue
    return item["name"]


def recover_catalog(path: Path = CATALOG_PATH):
    try:
        return Catalog(path)
    except (sqlite3.DatabaseError, ValueError):
        # Derived search files alone are replaceable. Preferences and scientific
        # data are in a different database and are never touched here.
        suffix = ".discarded-" + uuid.uuid4().hex
        for extension in ("", "-wal", "-shm"):
            candidate = Path(str(path) + extension)
            if candidate.exists():
                candidate.rename(Path(str(candidate) + suffix))
        return Catalog(path)


class Catalog:
    def __init__(self, path: Path = CATALOG_PATH):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version not in (0, SCHEMA_VERSION):
                raise ValueError("Search catalog version changed; rebuild the search index.")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS roots (
                    id TEXT PRIMARY KEY, path TEXT NOT NULL, canonical_root TEXT,
                    status TEXT NOT NULL DEFAULT 'queued', last_attempt TEXT, last_success TEXT,
                    message TEXT, generation TEXT, discovered INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS entries (
                    id INTEGER PRIMARY KEY, canonical TEXT UNIQUE NOT NULL, path TEXT NOT NULL,
                    name TEXT NOT NULL, name_fold TEXT NOT NULL, extension TEXT NOT NULL,
                    size INTEGER NOT NULL, mtime_ns INTEGER NOT NULL, modified_at TEXT NOT NULL,
                    recognition TEXT NOT NULL, metadata_state TEXT NOT NULL,
                    metadata_json TEXT NOT NULL DEFAULT '{}', metadata_version INTEGER NOT NULL DEFAULT 0,
                    supplier TEXT NOT NULL, technique TEXT, search_text TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS memberships (
                    root_id TEXT NOT NULL, canonical TEXT NOT NULL, generation TEXT NOT NULL,
                    PRIMARY KEY(root_id, canonical)
                );
                CREATE INDEX IF NOT EXISTS member_path ON memberships(canonical);
                CREATE INDEX IF NOT EXISTS entry_format ON entries(extension);
                CREATE INDEX IF NOT EXISTS entry_name ON entries(name_fold,canonical);
                CREATE INDEX IF NOT EXISTS entry_search_state ON entries(canonical,recognition,metadata_state);
                CREATE INDEX IF NOT EXISTS entry_technique ON entries(technique);
            """)
            try:
                existed = db.execute("SELECT 1 FROM sqlite_master WHERE name='search_fts'").fetchone()
                db.execute("CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(search_text, content='entries', content_rowid='id', tokenize='trigram')")
                db.executescript("""
                    CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
                      INSERT INTO search_fts(rowid, search_text) VALUES(new.id, new.search_text); END;
                    CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
                      INSERT INTO search_fts(search_fts,rowid,search_text) VALUES('delete',old.id,old.search_text); END;
                    CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE OF search_text ON entries BEGIN
                      INSERT INTO search_fts(search_fts,rowid,search_text) VALUES('delete',old.id,old.search_text);
                      INSERT INTO search_fts(rowid,search_text) VALUES(new.id,new.search_text); END;
                """)
                self.fts = True
                if not existed:
                    db.execute("INSERT INTO search_fts(search_fts) VALUES('rebuild')")
            except sqlite3.OperationalError:
                self.fts = False
            db.execute(f"PRAGMA user_version={SCHEMA_VERSION}")

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=1)
        db.row_factory = sqlite3.Row
        db.create_function("casefold", 1, lambda value: value.casefold() if value is not None else None, deterministic=True)
        try:
            with db:
                yield db
        finally:
            db.close()

    def sync_roots(self, roots: list[dict]):
        ids = {root["id"] for root in roots}
        with self.connect() as db:
            for root in roots:
                old = db.execute("SELECT path FROM roots WHERE id=?", (root["id"],)).fetchone()
                if old and path_key(old[0]) != path_key(root["path"]):
                    db.execute("DELETE FROM memberships WHERE root_id=?", (root["id"],))
                    db.execute("DELETE FROM roots WHERE id=?", (root["id"],))
                db.execute("INSERT INTO roots(id,path) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path", (root["id"], root["path"]))
            for row in db.execute("SELECT id FROM roots").fetchall():
                if row["id"] not in ids:
                    db.execute("DELETE FROM memberships WHERE root_id=?", (row["id"],))
                    db.execute("DELETE FROM roots WHERE id=?", (row["id"],))
            self._prune(db)

    @staticmethod
    def _prune(db):
        db.execute("DELETE FROM entries WHERE NOT EXISTS (SELECT 1 FROM memberships m WHERE m.canonical=entries.canonical)")

    def roots(self, *, counts=True) -> list[dict]:
        with self.connect() as db:
            if not counts:
                return [dict(row) for row in db.execute("SELECT * FROM roots ORDER BY path")]
            # A covering state index avoids reading every large header JSON twice
            # for each status poll (and for each search API response).
            return [dict(row) for row in db.execute("""SELECT r.*,
                coalesce(s.count,0) AS count, coalesce(s.pending,0) AS pending
                FROM roots r LEFT JOIN (
                  SELECT m.root_id,
                    sum(e.recognition!='unsupported') AS count,
                    sum(e.recognition='pending' OR e.metadata_state='pending') AS pending
                  FROM memberships m JOIN entries e INDEXED BY entry_search_state ON e.canonical=m.canonical
                  GROUP BY m.root_id
                ) s ON s.root_id=r.id ORDER BY r.path""")]

    def root_state(self, root_id: str, **values):
        allowed = {"status", "last_attempt", "last_success", "message", "generation", "canonical_root", "discovered"}
        if not values or not set(values).issubset(allowed):
            raise ValueError("Invalid catalog root state")
        with self.connect() as db:
            db.execute(f"UPDATE roots SET {','.join(f'{key}=?' for key in values)} WHERE id=?", (*values.values(), root_id))

    def remove_scope(self, root_id: str, generation: str, canonical: str, *, retain_current=False):
        """Remove this root's memberships only, after a worker confirmed accessible scope.

        SQL prefix equality avoids treating wildcard characters in filenames as patterns.
        Overlapping roots retain their independent memberships.
        """
        separator = "\\" if "\\" in canonical else os.sep
        prefix = canonical.rstrip(separator) + separator
        with self.connect() as db:
            row = db.execute("SELECT generation FROM roots WHERE id=?", (root_id,)).fetchone()
            if not row or row[0] != generation:
                return False
            db.execute("DELETE FROM memberships WHERE root_id=? AND (canonical=? OR substr(canonical,1,?)=?)"
                + (" AND generation!=?" if retain_current else ""),
                (root_id, canonical, len(prefix), prefix, *([generation] if retain_current else [])))
            self._prune(db)
        return True

    def apply_batch(self, root_id: str, generation: str, facts: list[dict]):
        with self.connect() as db:
            row = db.execute("SELECT generation FROM roots WHERE id=?", (root_id,)).fetchone()
            if not row or row[0] != generation:
                return False
            for fact in facts:
                metadata = fact.get("metadata", {})
                values = (fact["canonical"], fact["path"], fact["name"], fact["name"].casefold(), fact["extension"],
                          fact["size"], fact["mtime_ns"], fact["modified_at"], fact["recognition"], fact["metadata_state"],
                          json.dumps(metadata, ensure_ascii=False), fact.get("metadata_version", 0), fact["supplier"],
                          metadata.get("technique"), search_text(fact["path"], metadata, fact["canonical"]))
                db.execute("""INSERT INTO entries(canonical,path,name,name_fold,extension,size,mtime_ns,modified_at,
                    recognition,metadata_state,metadata_json,metadata_version,supplier,technique,search_text)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(canonical) DO UPDATE SET
                    path=excluded.path,name=excluded.name,name_fold=excluded.name_fold,extension=excluded.extension,
                    size=excluded.size,mtime_ns=excluded.mtime_ns,modified_at=excluded.modified_at,
                    recognition=excluded.recognition,metadata_state=excluded.metadata_state,
                    metadata_json=excluded.metadata_json,metadata_version=excluded.metadata_version,
                    supplier=excluded.supplier,technique=excluded.technique,search_text=excluded.search_text""", values)
                db.execute("INSERT INTO memberships VALUES(?,?,?) ON CONFLICT(root_id,canonical) DO UPDATE SET generation=excluded.generation", (root_id, fact["canonical"], generation))
            return True

    def reconcile(self, root_id: str, generation: str):
        # Call only for a complete traversal. Partial/denied/timed-out scans
        # preserve unseen entries; an inaccessible subtree is never empty.
        with self.connect() as db:
            row = db.execute("SELECT generation FROM roots WHERE id=?", (root_id,)).fetchone()
            if row and row[0] == generation:
                db.execute("DELETE FROM memberships WHERE root_id=? AND generation!=?", (root_id, generation))
                self._prune(db)

    def techniques(self, config: dict, root_id: str | None = None) -> list[str]:
        roots = [r["id"] for r in config["roots"] if r["enabled"] and (root_id is None or r["id"] == root_id)]
        if not config["metadata_enabled"] or not roots or not config["formats"]:
            return []
        with self.connect() as db:
            rows = db.execute("""SELECT DISTINCT e.technique FROM entries e
                WHERE e.technique IS NOT NULL AND e.technique!='' AND e.recognition='recognized'
                AND e.extension IN (""" + ",".join("?" for _ in config["formats"]) + ") AND EXISTS "
                "(SELECT 1 FROM memberships m WHERE m.canonical=e.canonical AND m.root_id IN ("
                + ",".join("?" for _ in roots) + ")) ORDER BY casefold(e.technique)", (*config["formats"], *roots)).fetchall()
            return list(dict.fromkeys(row[0] for row in rows))

    def search(self, config: dict, *, query: str = "", root_id: str | None = None,
               extension: str | None = None, supplier: str | None = None, technique: str | None = None,
               offset: int = 0, limit: int = 100) -> dict:
        roots = [root for root in config["roots"] if root["enabled"] and (root_id is None or root["id"] == root_id)]
        if not roots or not config["formats"]:
            return {"items": [], "total": 0, "offset": offset, "limit": limit, "has_more": False, "engine": "trigram" if self.fts else "literal"}
        parameters: list = []
        clauses = ["e.recognition!='unsupported'", "e.extension IN (" + ",".join("?" for _ in config["formats"]) + ")"]
        parameters.extend(config["formats"])
        root_ids = [root["id"] for root in roots]
        root_clause = "m.root_id IN (" + ",".join("?" for _ in root_ids) + ")"
        clauses.append(f"EXISTS(SELECT 1 FROM memberships m WHERE m.canonical=e.canonical AND {root_clause})")
        parameters.extend(root_ids)
        for column, value in (("extension", extension), ("supplier", supplier), ("technique", technique)):
            if value:
                if column == "technique" and not config["metadata_enabled"]:
                    clauses.append("0")
                else:
                    clauses.append(f"casefold(e.{column})=?" if column == "technique" else f"e.{column}=?")
                    parameters.append(value.casefold() if column == "technique" else value)
        base_where = " AND ".join(clauses)
        base_parameters = tuple(parameters)
        text = query.strip().casefold()
        terms = text.split()[:8]
        long_terms = [term for term in terms if len(term) >= 3]
        if self.fts and long_terms:
            clauses.append("e.id IN (SELECT rowid FROM search_fts WHERE search_fts MATCH ?)")
            parameters.append(" AND ".join("(" + " OR ".join('"' + variant.replace('"', '""') + '"' for variant in query_variants(term)) + ")" for term in long_terms))
        for term in terms:
            variants = query_variants(term)
            columns = ["e.search_text"] if config["metadata_enabled"] else ["casefold(e.path)", "e.canonical"]
            clauses.append("(" + " OR ".join(f"instr({column},?)>0" for column in columns for _ in variants) + ")")
            parameters.extend(variant for _ in columns for variant in variants)
        where = " AND ".join(clauses)
        with self.connect() as db:
            db.execute("BEGIN")  # Results, ownership and count share a WAL read snapshot.
            total = db.execute("SELECT count(*) FROM entries e WHERE " + where, parameters).fetchone()[0]
            # Rank with bounded ordered probes rather than sorting every broad
            # match. Identifier fragments are literal; filename exact/prefix
            # matches still precede metadata-only results.
            if total <= 1000:
                rows = db.execute("SELECT e.* FROM entries e WHERE " + where + """ ORDER BY
                    CASE WHEN name_fold=? THEN 0 WHEN substr(name_fold,1,length(?))=? THEN 1
                    WHEN instr(name_fold,?)>0 THEN 2 ELSE 3 END, name_fold, canonical LIMIT ? OFFSET ?""",
                    (*parameters, text, text, text, text, limit, offset)).fetchall()
            else:
                rows = []
                remaining_offset = offset
                if not text:
                    tiers = [("1", ())]
                else:
                    upper = text + chr(0x10ffff)
                    tiers = [("name_fold=?", (text,)),
                             ("name_fold>=? AND name_fold<? AND name_fold!=?", (text, upper, text))]
                    has_name = db.execute("SELECT 1 FROM entries WHERE instr(name_fold,?)>0 LIMIT 1", (text,)).fetchone()
                    if has_name:
                        tiers.append(("instr(name_fold,?)>0 AND NOT(name_fold>=? AND name_fold<?)", (text, text, upper)))
                    tiers.append(("instr(name_fold,?)=0", (text,)))
                for condition, rank_params in tiers:
                    name_tier = bool(text) and condition != "instr(name_fold,?)=0"
                    tier_where = (base_where if name_tier else where) + " AND " + condition
                    params = (*(base_parameters if name_tier else parameters), *rank_params)
                    if remaining_offset:
                        tier_total = db.execute("SELECT count(*) FROM entries e WHERE " + tier_where, params).fetchone()[0]
                        if remaining_offset >= tier_total:
                            remaining_offset -= tier_total
                            continue
                    rows.extend(db.execute("SELECT e.* FROM entries e INDEXED BY entry_name WHERE " + tier_where
                        + " ORDER BY name_fold,canonical LIMIT ? OFFSET ?", (*params, limit - len(rows), remaining_offset)).fetchall())
                    remaining_offset = 0
                    if len(rows) >= limit:
                        break
            states = {row["id"]: dict(row) for row in db.execute("SELECT * FROM roots")}
            items = []
            for row in rows:
                item = dict(row)
                owners = db.execute(f"SELECT root_id FROM memberships m WHERE canonical=? AND {root_clause}", (row["canonical"], *root_ids)).fetchall()
                owner = max((states[r[0]] for r in owners), key=lambda root: len(root["path"]))
                item.update(root_id=owner["id"], root_path=owner["path"], root_status=owner["status"],
                            relative_path=relative_location(item, owner),
                            metadata=json.loads(item.pop("metadata_json")) if config["metadata_enabled"] else {})
                item.pop("search_text")
                item.pop("name_fold")
                items.append(item)
            return {"items": items, "total": total, "offset": offset, "limit": limit,
                    "has_more": offset + len(items) < total, "engine": "trigram" if self.fts else "literal"}
