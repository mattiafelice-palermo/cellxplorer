"""Read-only real-folder comparison using fresh disposable catalogs, never app data."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import statistics
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def run_one(root, destination, readers, limit):
    from backend.app.services.import_search_catalog import Catalog, FORMATS
    from backend.app.services.import_search_index import SearchIndexer

    destination.mkdir(parents=True, exist_ok=False)
    catalog = Catalog(destination / "catalog.sqlite")
    settings = dict(roots=[dict(id="benchmark", path=str(root), enabled=True)],
        formats=list(FORMATS), metadata_enabled=True, refresh_hours=0, paused=False)
    indexer = SearchIndexer(catalog, monitoring=False, header_readers=readers)
    indexer.start(settings)

    def scan(refresh=False):
        if refresh:
            indexer.refresh()
        started = time.monotonic()
        samples = []
        while time.monotonic() - started < limit:
            state = indexer.root_snapshots()[0]
            sample = {key: state.get(key) for key in ("generation", "scan_phase", "headers_completed", "headers_total", "status")}
            sample["seconds"] = time.monotonic() - started
            if not samples or {k: v for k, v in samples[-1].items() if k != "seconds"} != {k: v for k, v in sample.items() if k != "seconds"}:
                samples.append(sample)
            if state["status"] not in ("queued", "scanning"):
                if state.get("scan_phase") != "complete":
                    raise AssertionError(f"Incomplete scan: {state}")
                break
            time.sleep(0.02)
        else:
            raise TimeoutError("Benchmark exceeded scan deadline")
        elapsed = time.monotonic() - started
        active = [s for s in samples if s["status"] != "queued"]
        metadata = [s for s in active if s["scan_phase"] in ("metadata", "complete")]
        assert len({s["generation"] for s in active if s["generation"]}) == 1, samples
        assert len({s["headers_total"] for s in metadata}) == 1, samples
        completed = [s["headers_completed"] for s in metadata]
        assert completed == sorted(completed), samples
        assert state["headers_completed"] == state["headers_total"], state
        return dict(seconds=elapsed, samples=samples, state=state)

    def content():
        with catalog.connect() as db:
            return [dict(r) for r in db.execute("""SELECT canonical,path,extension,size,mtime_ns,
                recognition,metadata_state,metadata_version,metadata_json,file_created_at,modified_at,supplier
                FROM entries ORDER BY canonical""")]

    try:
        initial = scan()
        entries = content()
        retry_count = sum(e["recognition"] != "unsupported" and e["metadata_state"] == "unavailable" for e in entries)
        rescan = scan(refresh=True)
        assert rescan["state"]["headers_total"] == retry_count, (rescan, retry_count)
        assert content() == entries, "Rescan changed metadata or source identities"
        generation = rescan["state"]["generation"]
        revision = indexer.revision
        time.sleep(2)
        assert indexer.root_snapshots()[0]["generation"] == generation
        assert indexer.revision == revision, "Unexpected background rescan"
        (destination / "entries.json").write_text(json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8")
        result = dict(readers=readers or 1, implementation="legacy" if readers == 0 else "parallel",
            initial=initial, rescan=rescan, entries_digest=digest(entries), entries=len(entries))
        (destination / "result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
        return result, entries
    finally:
        indexer.stop()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path, help="New local benchmark directory")
    parser.add_argument("--order", default="0,2,4,4,2,0", help="0 uses unchanged legacy serial path")
    parser.add_argument("--limit", type=float, default=1800)
    parser.add_argument("--resume", action="store_true", help="Reuse completed runs from this exact benchmark directory")
    args = parser.parse_args()
    order = [int(n) for n in args.order.split(",")]
    if any(n not in (0, 1, 2, 3, 4) for n in order):
        parser.error("Reader counts must be 0 through 4")
    args.output.mkdir(parents=True, exist_ok=args.resume)
    # Set before importing backend modules or spawning children.
    os.environ["CELLXPLORER_DATA"] = str(args.output.resolve() / "isolated-app")
    os.environ["CELLXPLORER_INDEX_TRACE"] = str(args.output.resolve() / "trace")
    results = []
    baseline = None
    for index, readers in enumerate(order):
        print(f"Starting run {index+1}/{len(order)}, {'legacy serial' if readers == 0 else str(readers)+' readers'}", flush=True)
        destination = args.output / f"run-{index+1}-{readers}"
        if args.resume and (destination / "result.json").exists():
            result = json.loads((destination / "result.json").read_text(encoding="utf-8"))
            entries = json.loads((destination / "entries.json").read_text(encoding="utf-8"))
            assert result["initial"]["state"]["path"] == str(args.root), "Resume root differs"
            assert result["entries_digest"] == digest(entries), "Resume artifact changed"
            assert result["readers"] == (readers or 1)
            assert result["implementation"] == ("legacy" if readers == 0 else "parallel")
        else:
            result, entries = run_one(args.root, destination, readers, args.limit)
        if baseline is None:
            baseline = entries
        assert entries == baseline, "Metadata, classification or source identity differs between runs"
        results.append(result)
        print(f"Completed: {result['initial']['seconds']:.2f}s; rescan {result['rescan']['seconds']:.2f}s; {result['entries']} identical entries", flush=True)
        summary = dict(order=order, results=results, exact_parity=True,
            median_seconds={str(n): statistics.median(r["initial"]["seconds"] for r in results if r["implementation"] == ("legacy" if n == 0 else "parallel") and r["readers"] == (n or 1)) for n in set(order[:len(results)])},
            caveat="Fresh application catalogs; OS/NAS caches are not flushed. Alternating order reduces but cannot remove cache/network variation.")
        (args.output / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")


if __name__ == "__main__":
    import multiprocessing
    multiprocessing.freeze_support()
    main()
