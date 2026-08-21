"""Diagnostic profiling for the Spec 050.2 raw Parquet layout decision.

This deliberately writes only temporary Parquet files and prints JSON.  It is
not a production cache builder and must not be used as a request-path helper.
"""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
import time
from pathlib import Path

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.services import canonical_cycling, parsing  # noqa: E402


def _write(frame: pd.DataFrame, path: Path, row_group_size: int | None) -> float:
    started = time.perf_counter()
    if row_group_size is None:
        frame.to_parquet(path, index=False)
    else:
        pq.write_table(
            pa.Table.from_pandas(frame, preserve_index=False),
            path,
            compression="snappy",
            row_group_size=row_group_size,
        )
    return time.perf_counter() - started


def _measure(path: Path, frame: pd.DataFrame, cycles: list[int]) -> dict:
    parquet = pq.ParquetFile(path)
    row_counts = [
        parquet.metadata.row_group(group).num_rows
        for group in range(parquet.metadata.num_row_groups)
    ]
    labels: list[list[int]] = []
    cycle_to_groups: dict[int, list[int]] = {cycle: [] for cycle in cycles}
    cursor = 0
    for group, row_count in enumerate(row_counts):
        group_labels, errors = canonical_cycling.observed_cycle_labels(
            frame["cycle"].iloc[cursor : cursor + row_count]
        )
        if errors:
            raise ValueError("; ".join(errors))
        labels.append(group_labels)
        for cycle in group_labels:
            cycle_to_groups.setdefault(cycle, []).append(group)
        cursor += row_count

    selected_columns = ["cycle", "time_s", "voltage_v"]
    ranges = {
        "one_cycle": cycles[:1],
        "twenty_cycles": cycles[:20],
        "few_hundred_cycles": cycles[: min(150, len(cycles))],
        "all_cycles": cycles,
    }
    reads: dict[str, dict] = {}
    for name, requested in ranges.items():
        selected_groups = sorted(
            {
                group
                for cycle in requested
                for group in cycle_to_groups.get(cycle, [])
            }
        )
        started = time.perf_counter()
        loaded = parquet.read_row_groups(selected_groups, columns=selected_columns).to_pandas()
        elapsed = time.perf_counter() - started
        returned = loaded.loc[loaded["cycle"].isin(requested)]
        reads[name] = {
            "requested_cycles": len(requested),
            "groups_read": len(selected_groups),
            "groups_total": len(row_counts),
            "rows_physical": sum(row_counts[group] for group in selected_groups),
            "rows_materialized": len(loaded),
            "rows_returned": len(returned),
            "columns_read": selected_columns,
            "read_seconds": round(elapsed, 6),
            "materialized_memory_mb": round(
                loaded.memory_usage(deep=True).sum() / 1_000_000,
                6,
            ),
        }
    return {
        "bytes": path.stat().st_size,
        "row_groups": len(row_counts),
        "rows_per_group": row_counts,
        "reads": reads,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "source",
        nargs="?",
        default=str(ROOT / "tests/fixtures/golden_analysis/sources/cycles_time_steps.ndax"),
    )
    parser.add_argument(
        "--targets",
        default="4096,8192,16384",
        help="comma-separated candidate row-group targets",
    )
    args = parser.parse_args()

    source = Path(args.source)
    frame = parsing.parse_timeseries(source)
    cycles, errors = canonical_cycling.observed_cycle_labels(frame["cycle"])
    if errors:
        raise SystemExit("; ".join(errors))

    with tempfile.TemporaryDirectory(prefix="cellxplorer-raw-profile-") as folder:
        root = Path(folder)
        legacy_path = root / "legacy.parquet"
        legacy_write = _write(frame, legacy_path, None)
        legacy_read_started = time.perf_counter()
        full = pd.read_parquet(legacy_path)
        legacy_read = time.perf_counter() - legacy_read_started
        selected_read_started = time.perf_counter()
        pd.read_parquet(legacy_path, columns=["cycle", "time_s", "voltage_v"])
        selected_read = time.perf_counter() - selected_read_started
        result = {
            "runtime": {"pyarrow": pa.__version__, "pandas": pd.__version__},
            "source": {
                "name": source.name,
                "rows": len(frame),
                "observed_cycles": len(cycles),
                "columns": list(frame.columns),
            },
            "baseline": {
                **_measure(legacy_path, frame, cycles),
                "write_seconds": round(legacy_write, 6),
                "full_read_seconds": round(legacy_read, 6),
                "selected_column_full_read_seconds": round(selected_read, 6),
                "full_materialized_memory_mb": round(
                    full.memory_usage(deep=True).sum() / 1_000_000,
                    6,
                ),
            },
            "candidates": {},
        }
        for raw_target in args.targets.split(","):
            target = int(raw_target.strip())
            candidate_path = root / f"candidate-{target}.parquet"
            write_seconds = _write(frame, candidate_path, target)
            result["candidates"][str(target)] = {
                **_measure(candidate_path, frame, cycles),
                "write_seconds": round(write_seconds, 6),
            }
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
