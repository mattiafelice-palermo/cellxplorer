"""Spec 060: disposable 100k catalog benchmark, no source or library changes."""
from __future__ import annotations
import argparse
from contextlib import nullcontext
import json
import statistics
import math
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.app.services.import_search_catalog import Catalog, path_key


def benchmark(count=100000, rounds=12, directory=None):
    with (nullcontext(directory) if directory else tempfile.TemporaryDirectory(prefix="cellxplorer-search-profile-")) as directory:
        catalog = Catalog(Path(directory) / "catalog.sqlite")
        config = dict(roots=[dict(id="root", path="\\\\lab\\cycling", enabled=True)],
                      formats=[".ndax", ".mpr", ".xlsx"], metadata_enabled=True)
        catalog.sync_roots(config["roots"])
        catalog.root_state("root", generation="profile", status="ready")
        start = time.perf_counter()
        with catalog.connect() as db:
            seeded = db.execute("SELECT count(*) FROM entries").fetchone()[0] == count
        for begin in ([] if seeded else range(0, count, 256)):
            facts = []
            for index in range(begin, min(begin + 256, count)):
                name = f"NG_{index:06d}_LFP_CY_FC.ndax"
                path = f"\\\\lab\\cycling\\group-{index % 100}\\{name}"
                facts.append(dict(canonical=path_key(path), path=path, name=name, extension=".ndax", size=1000,
                    mtime_ns=1, modified_at="2026-01-01T00:00:00Z", recognition="recognized", metadata_state="ready",
                    metadata_version=1, supplier="Neware", metadata={"barcode": f"CELL_{index:06d}", "remarks": "Äccent 25%", "technique": "GCPL"}))
            catalog.apply_batch("root", "profile", facts)
        elapsed = time.perf_counter() - start
        results = []
        for fallback in (False, True):
            original = catalog.fts
            if fallback:
                catalog.fts = False
            for query in ("", "LFP", "050123", "CELL_050123", "missing", "25%", "_", "a", "äccent"):
                timings = []
                for _ in range(rounds):
                    start = time.perf_counter()
                    response = catalog.search(config, query=query)
                    json.dumps(response)
                    timings.append((time.perf_counter() - start) * 1000)
                results.append(dict(engine="fallback" if fallback else "trigram" if original else "fallback", query=query,
                    median_ms=round(statistics.median(timings), 2), p95_ms=round(sorted(timings)[math.ceil(rounds * .95) - 1], 2),
                    best_ms=round(min(timings), 2), matches=response["total"]))
            catalog.fts = original
        return dict(entries=count, seed_seconds=round(elapsed, 2), rounds=rounds, results=results)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--count", type=int, default=100000)
    parser.add_argument("--rounds", type=int, default=12)
    parser.add_argument("--directory", help="Reuse a disposable benchmark catalog, never an application catalog")
    args = parser.parse_args()
    print(json.dumps(benchmark(args.count, args.rounds, args.directory), indent=2, ensure_ascii=False))
