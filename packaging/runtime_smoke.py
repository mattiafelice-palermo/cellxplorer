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


def timezone_signature() -> dict:
    """Force packaged IANA resources, not an OS database or developer fallback."""
    import importlib.resources
    import tzdata
    import zoneinfo
    import zipfile

    if getattr(sys, "frozen", False):
        expected = Path(sys._MEIPASS) / "tzdata.zip"
        if not str(tzdata.__file__).startswith(str(expected) + os.sep):
            raise AssertionError("Frozen tzdata did not load from its archive")
        if (Path(sys._MEIPASS) / "tzdata").exists():
            raise AssertionError("Loose timezone resources remain in the frozen bundle")
        if not isinstance(importlib.resources.files("tzdata.zoneinfo"), zipfile.Path):
            raise AssertionError("Timezone resources are not archive backed")
    previous = zoneinfo.TZPATH
    zoneinfo.reset_tzpath(())
    ZoneInfo.clear_cache()
    try:
        names = sorted(zoneinfo.available_timezones())
        if len(names) < 500:
            raise AssertionError("Incomplete IANA timezone collection")
        values = []
        for name in names:
            zone = ZoneInfo(name)
            offsets = []
            for year, month in [(1900, 1), (1970, 1), (2010, 7), (2026, 1), (2026, 7)]:
                date = datetime(year, month, 1, tzinfo=zone)
                offsets.append([date.utcoffset().total_seconds(), date.dst().total_seconds(), date.tzname()])
            values.append([name, offsets])
        folds = [datetime(2026, 10, 25, 2, 30, tzinfo=ZoneInfo("Europe/Paris"), fold=fold).utcoffset().total_seconds() for fold in (0, 1)]
        try:
            ZoneInfo("CellXplorer/Invalid_Zone")
        except zoneinfo.ZoneInfoNotFoundError:
            pass
        else:
            raise AssertionError("Unknown timezone was not rejected")
        return {"version": tzdata.__version__, "zones": len(names), "fold_offsets": folds,
                "sha256": hashlib.sha256(json.dumps(values, ensure_ascii=True).encode()).hexdigest()}
    finally:
        ZoneInfo.clear_cache()
        zoneinfo.reset_tzpath(previous)


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
    import pyarrow.dataset as ds
    import pyarrow.orc as orc
    import pyarrow.json as arrow_json
    import pyarrow.fs as fs
    import pyarrow.parquet.encryption
    import tkinter
    from tkinter import filedialog
    from tcl_timezone_probe import signature as tcl_timezone_signature
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
    codec_support = {}
    payload = b'CellXplorer lossless Arrow codec check\x00' * 128
    for codec in ('snappy', 'gzip', 'brotli', 'zstd', 'lz4', 'bz2'):
        codec_support[codec] = pa.Codec.is_available(codec)
        if codec_support[codec]:
            if codec == 'bz2':
                output = pa.BufferOutputStream()
                with pa.CompressedOutputStream(output, codec) as compressed:
                    compressed.write(payload)
                with pa.CompressedInputStream(pa.BufferReader(output.getvalue()), codec) as compressed:
                    decoded = compressed.read()
            else:
                encoded = pa.compress(payload, codec=codec)
                decoded = pa.decompress(encoded, decompressed_size=len(payload), codec=codec).to_pybytes()
            if decoded != payload:
                raise AssertionError(f'Arrow codec roundtrip failed: {codec}')
    small = pa.table({'x': [1, 2, 3]})
    if ds.dataset(small).to_table(filter=ds.field('x') > 1).column('x').to_pylist() != [2, 3]:
        raise AssertionError('Arrow Dataset/Acero failed')
    orc_path = root / 'roundtrip.orc'
    orc.write_table(small, orc_path)
    if not orc.ORCFile(orc_path).read().equals(small):
        raise AssertionError('Arrow ORC failed')
    if arrow_json.read_json(pa.BufferReader(b'{"x":1}\n')).num_rows != 1:
        raise AssertionError('Arrow JSON failed')
    if fs.LocalFileSystem().get_file_info(str(orc_path)).size <= 0:
        raise AssertionError('Arrow local filesystem failed')
    tcl = tkinter.Tcl().eval("info patchlevel")
    if not callable(filedialog.askopenfilenames):
        raise AssertionError("Native file picker module missing")
    asset = (Path(sys._MEIPASS) / "app/assets/plotly.min.js") if getattr(sys, "frozen", False) else Path(__file__).resolve().parents[1] / "backend/app/assets/plotly.min.js"
    plotly = asset.read_bytes()
    if len(plotly) < 10000:
        raise AssertionError("Portable-report Plotly runtime missing")
    zones = {zone: datetime(2026, 7, 1, tzinfo=ZoneInfo(zone)).utcoffset().total_seconds() for zone in ["UTC", "Europe/Paris", "Atlantic/Canary", "Asia/Tokyo"]}
    result = {"sources": sources, "arrow_codecs": codec_support, "tcl": tcl, "tcl_timezone_signature": tcl_timezone_signature(), "zones": zones, "timezone_signature": timezone_signature(), "plotly_sha256": hashlib.sha256(plotly).hexdigest()}
    (root / "runtime-verification.json").write_text(json.dumps(result, sort_keys=True), encoding="utf-8")
