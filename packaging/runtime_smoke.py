"""Explicit frozen-runtime verification; never runs during ordinary app startup."""
from __future__ import annotations

from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
from zoneinfo import ZoneInfo


def validate_root() -> Path:
    root = Path(os.environ["CELLXPLORER_DATA"]).resolve()
    if (not root.name.startswith("cellxplorer-runtime-") or not root.is_dir()
            or root.parent != Path(tempfile.gettempdir()).resolve()):
        raise ValueError("Runtime verification requires its disposable data root")
    return root


def frame_signature(frame) -> dict:
    """Lossless IPC values plus both Arrow and pandas dtype/schema identity."""
    import pyarrow as pa

    clean = frame.copy()
    clean.attrs = {}
    table = pa.Table.from_pandas(clean, preserve_index=True)
    output = pa.BufferOutputStream()
    with pa.ipc.new_stream(output, table.schema) as writer:
        writer.write_table(table)
    return {"rows": len(frame), "pandas_dtypes": [[str(name), repr(dtype)] for name, dtype in frame.dtypes.items()],
            "index_dtype": repr(frame.index.dtype), "arrow_schema_hex": table.schema.serialize().to_pybytes().hex(),
            "ipc_sha256": hashlib.sha256(output.getvalue().to_pybytes()).hexdigest()}


def verify() -> None:
    # Validate the test root before importing any application configuration.
    root = validate_root()
    import numpy as np
    import pandas as pd
    import pyarrow as pa
    import pyarrow.compute as pc
    import pyarrow.csv as csv
    import pyarrow.parquet as pq
    import tkinter
    from tkinter import filedialog
    from app.services import calc, parsing

    # This mode is deliberately restricted to a script-created disposable root.
    fixtures = root / "fixtures"
    names = json.loads((fixtures / "manifest.json").read_text(encoding="utf-8"))
    sources = {}
    for name in names:
        source = (fixtures / name).resolve()
        if not source.is_relative_to(fixtures) or not source.is_file():
            raise ValueError("Invalid runtime verification fixture")
        frame = parsing.parse_timeseries(source)
        if frame.empty:
            raise AssertionError(f"Empty parsed source: {name}")
        parsing.read_header_metadata(source)
        cycles = calc.per_cycle(frame)
        if cycles.empty:
            raise AssertionError(f"Missing cycle summaries: {name}")
        # Match raw-cache's column data, not adapter-local attrs, in Arrow storage.
        data = frame.reset_index(drop=True).copy()
        data.attrs = {}
        parquet = root / f"{source.stem}.parquet"
        pq.write_table(pa.Table.from_pandas(data, preserve_index=False), parquet, compression="zstd", row_group_size=128)
        restored = pq.read_table(parquet).to_pandas()
        if not data.equals(restored):
            raise AssertionError(f"Parquet raw columns/dtypes changed: {name}")
        sources[name] = {"raw": frame_signature(frame), "cycles": frame_signature(cycles)}
    if not np.array_equal(np.linalg.solve([[2.0, 0.0], [0.0, 4.0]], [4.0, 8.0]), [2.0, 2.0]):
        raise AssertionError("NumPy native linear algebra failed")
    if pc.sum(pa.array([1, 2, 3])).as_py() != 6:
        raise AssertionError("Arrow compute failed")
    if csv.read_csv(pa.BufferReader(b"x,y\n1,2\n")).num_rows != 1:
        raise AssertionError("Arrow CSV failed")
    tcl = tkinter.Tcl().eval("info patchlevel")
    if not callable(filedialog.askopenfilenames):
        raise AssertionError("Native file picker module missing")
    asset = (Path(sys._MEIPASS) / "app/assets/plotly.min.js") if getattr(sys, "frozen", False) else Path(__file__).resolve().parents[1] / "backend/app/assets/plotly.min.js"
    plotly = asset.read_bytes()
    if len(plotly) < 10000:
        raise AssertionError("Portable-report Plotly runtime missing")
    zones = {zone: datetime(2026, 7, 1, tzinfo=ZoneInfo(zone)).utcoffset().total_seconds() for zone in ["UTC", "Europe/Paris", "Atlantic/Canary", "Asia/Tokyo"]}
    result = {"sources": sources, "tcl": tcl, "zones": zones, "plotly_sha256": hashlib.sha256(plotly).hexdigest()}
    (root / "runtime-verification.json").write_text(json.dumps(result, sort_keys=True), encoding="utf-8")
