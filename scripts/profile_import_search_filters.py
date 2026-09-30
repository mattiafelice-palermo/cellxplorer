"""Disposable Spec 064 whole-catalog filter benchmark; never reads source files."""
from __future__ import annotations

import argparse
import json
import statistics
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.app.services.import_search_catalog import Catalog, path_key
from backend.app.services.import_search_filters import filtered_search


def benchmark(count=50000, rounds=7):
    with tempfile.TemporaryDirectory(prefix="cellxplorer-filter-profile-") as directory:
        catalog = Catalog(Path(directory) / "catalog.sqlite")
        config = dict(roots=[dict(id="root", path="C:\\cycling", enabled=True)],
                      formats=[".ndax", ".mpr", ".xlsx"], metadata_enabled=True)
        catalog.sync_roots(config["roots"])
        catalog.root_state("root", generation="profile", status="ready")
        library = {}
        for start in range(0, count, 256):
            facts = []
            for index in range(start, min(start + 256, count)):
                name = f"BQV_{index:06d}.ndax"
                path = f"C:\\cycling\\folder{index // 100}\\{name}"
                canonical = path_key(path)
                facts.append(dict(canonical=canonical, path=path, name=name, extension=".ndax", size=index * 1000,
                    mtime_ns=1, modified_at="2026-01-01T00:00:00Z", recognition="recognized", metadata_state="ready",
                    metadata_version=2, supplier="Neware", metadata={"cycle_count": str(index % 1000), "part_number": "ALAVA"}))
                if index % 10 == 0:
                    library[canonical] = dict(registered=True, cells=[dict(id=index + 1, name=f"Cell {index}")],
                        cell_name=f"Cell {index}", cell_notes="", cell_metadata="chemistry: LFP",
                        analyses=[dict(id=1, name="Bump study")], replicates=[], size=index * 1000, mtime=1)
            catalog.apply_batch("root", "profile", facts)
        results = []
        for name, q, filters in (
            ("text", "BQV_000", {}),
            ("cycles", "", {"ranges": {"cycle_count": {"min": 500, "max": 700}}, "sort": "size_desc"}),
            ("folder", "", {"ranges": {"folder_count": {"min": 90}}}),
            ("relationships", "LFP", {"analysis_usage": "yes"}),
        ):
            timings = []
            for _ in range(rounds):
                started = time.perf_counter()
                response = filtered_search(catalog, config, q, filters, 0, 100, library)
                json.dumps(response)
                timings.append((time.perf_counter() - started) * 1000)
            results.append(dict(query=name, median_ms=round(statistics.median(timings), 1),
                                best_ms=round(min(timings), 1), matches=response["total"]))
        return dict(entries=count, library_paths=len(library), rounds=rounds, results=results,
                    scope="Local filter query, relationship temp-table installation, result decoration and JSON encoding; excludes HTTP and filesystem discovery")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--count", type=int, default=50000)
    parser.add_argument("--rounds", type=int, default=7)
    args = parser.parse_args()
    if args.count < 1 or args.rounds < 1:
        parser.error("count and rounds must be positive")
    print(json.dumps(benchmark(args.count, args.rounds), indent=2))
