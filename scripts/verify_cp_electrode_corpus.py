"""Independent exact-layout oracle for a private CP corpus (Spec 107).

Never writes sources or baseline expectations. Run before capturing a new
parser_regression_corpus snapshot, and alongside verify thereafter.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import struct
import sys
import tempfile

import numpy as np

from parser_regression_corpus import checked_sources, read_manifest

ROOT = Path(__file__).resolve().parents[1]
COLUMNS = (1, 2, 3, 21, 31, 65, 131, 4, 20, 174, 185, 264, 179, 434, 468, 467, 295)


def decode(path: Path) -> dict[str, np.ndarray]:
    """Decode only the independently observed layout, without reader dtypes."""
    content = path.read_bytes()
    # Fixed BioLogic container envelope: 52-byte magic then 65-byte headers.
    if not content.startswith(b'BIO-LOGIC MODULAR FILE'):
        raise ValueError('Unexpected MPR envelope')
    cursor = 52
    data = None
    loop_payloads = []
    technique = None
    while cursor < len(content):
        if content[cursor:cursor + 6] != b'MODULE':
            raise ValueError('Unexpected module boundary')
        name = content[cursor + 6:cursor + 16].strip()
        length = struct.unpack_from('<I', content, cursor + 45)[0]
        payload = content[cursor + 65:cursor + 65 + length]
        if len(payload) != length:
            raise ValueError('Truncated module')
        if name == b'VMP Set': technique = payload[0]
        if name == b'VMP data': data = payload
        if name == b'VMP loop': loop_payloads.append(payload)
        cursor += 65 + length
    if technique != 25 or data is None:
        raise ValueError('Expected CP')
    rows, count = struct.unpack_from('<IB', data)
    columns = struct.unpack_from(f'>{count}H', data, 5)
    if columns != COLUMNS or len(data) - 1007 != rows * 49:
        raise ValueError('Oracle is limited to the observed CP column layout')
    def array(offset, fmt):
        return np.array([struct.unpack_from(fmt, data, 1007 + 49 * i + offset)[0] for i in range(rows)], dtype=float)
    time, we, ce = array(3, '<d'), array(15, '<f'), array(19, '<f')
    if len(loop_payloads) != 1 or len(loop_payloads[0]) != 280:
        raise ValueError('Expected one observed loop table')
    # This corpus oracle deliberately accepts exactly the independently
    # inspected four-block table, rather than reusing production validation.
    expected_loops = (0, 7201, 14402, 21603, 28804)
    if struct.unpack_from('<6I', loop_payloads[0]) != (5, *expected_loops):
        raise ValueError('Unexpected original loop table')
    return {'time': time - time[0], 'voltage': we - ce, 'working_potential': we,
        'counter_potential': ce, 'loop_indexes': np.asarray(expected_loops)}


def verify(root: Path, work: Path) -> dict:
    manifest = read_manifest(root)
    paths = checked_sources(root, manifest)
    oracle = {case: decode(path) for case, path in paths.items()}
    os.environ['CELLXPLORER_DATA'] = str(work)
    sys.path.insert(0, str(ROOT / 'backend'))
    import pandas as pd
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from app.db import Base
    from app.models import Cell, Test, TestFile
    from app.services import analysis_engine, cache, scanner, time_capacity_workers
    cache.CACHE_DIR = work / 'cache'
    engine = create_engine('sqlite://')
    Base.metadata.create_all(engine)
    channels = ['voltage', 'working_potential', 'counter_potential']
    with sessionmaker(bind=engine, expire_on_commit=False)() as db:
        sources = [scanner.ingest_path(db, path, parse_now=True) for path in paths.values()]
        for sf, values in zip(sources, oracle.values()):
            if sf.parse_status != 'parsed': raise ValueError('CP parse failed')
            raw = cache.load_raw(sf.hash, sf.parser_version)
            np.testing.assert_array_equal(raw.time_s, values['time'])
            for q, col in zip(channels, ['voltage_v', 'working_potential_v', 'counter_potential_v']):
                np.testing.assert_array_equal(raw[col], values[q])
            expected_segments = np.repeat(np.arange(1, 5), 7201)
            np.testing.assert_array_equal(raw.mpr_acquisition_segment, expected_segments)
        cell = Cell(name='Private CP regression'); db.add(cell); db.flush()
        internal = Test(cell_id=cell.id, name='internal'); db.add(internal); db.flush()
        db.add_all([TestFile(test_id=internal.id, file_id=sf.id, position=i) for i, sf in enumerate(sources)])
        db.commit()
        spec = analysis_engine.default_spec('CP regression')
        spec['selection']['entries'] = [{'kind': 'cell', 'ref_id': cell.id}]
        spec['computation']['time_capacity'] = {'view': 'voltage_current', 'x_axis': 'time',
            'display_mode': 'consecutive', 'time_unit': 'min', 'cycle_start': 1,
            'voltage_channels': channels, 'max_points_per_cell': 200000}
        x = []; offset = 0.; expected_breaks = []
        for values in oracle.values():
            start = len(x)
            if start: expected_breaks.append(start)
            expected_breaks.extend((start + values['loop_indexes'][1:-1]).tolist())
            x.extend((values['time'] / 60 + offset).tolist()); offset = x[-1]
        for compact, precision in [(False, 'full'), (True, 'full'), (True, 'standard')]:
            result = analysis_engine.compute_time_capacity(db, spec, None, compact=compact, precision=precision)
            trace = result['cell_traces'][0]
            if precision == 'full':
                if trace['display_break_before'] != expected_breaks:
                    raise ValueError('Full-resolution loop/source breaks disagree with the source tables')
                np.testing.assert_allclose(trace['display_x'], x, rtol=0, atol=2e-12)
                for q in channels:
                    np.testing.assert_array_equal(trace['voltage_v_by_channel'][q], np.concatenate([v[q] for v in oracle.values()]))
            else:
                # Compact values are rounded by the production contract.
                self_x = np.asarray(trace['display_x'])
                actual = np.column_stack([trace['voltage_v_by_channel'][q] for q in channels])
                expected = np.column_stack([np.concatenate([v[q] for v in oracle.values()]) for q in channels])
                nearest = np.searchsorted(x, self_x)
                matched = np.zeros(len(self_x), dtype=bool)
                for delta in (-2, -1, 0, 1, 2):
                    indices = np.clip(nearest + delta, 0, len(x) - 1)
                    matched |= ((np.abs(np.asarray(x)[indices] - self_x) <= 1e-5)
                        & np.all(np.abs(actual - expected[indices]) <= 1e-5, axis=1))
                if not matched.all():
                    first = int(np.flatnonzero(~matched)[0])
                    raise ValueError(f'Compact samples disagree: x={self_x[first]}, actual={actual[first]}, nearest={nearest[first]}, expected_x={x[min(nearest[first], len(x)-1)]}, expected={expected[min(nearest[first],len(x)-1)]}')
                if len(trace['display_break_before']) != len(expected_breaks):
                    raise ValueError('Compact loop/source breaks were lost')
                # Every explicit boundary keeps the adjacent original samples.
                for position, boundary in zip(trace['display_break_before'], expected_breaks):
                    np.testing.assert_allclose(self_x[position - 1:position + 1], np.asarray(x)[boundary - 1:boundary + 1], rtol=0, atol=1e-5)
                    np.testing.assert_allclose(actual[position - 1:position + 1], expected[boundary - 1:boundary + 1], rtol=0, atol=1e-5)
            if not all(result['voltage_channels'][q]['available'] for q in channels):
                raise ValueError('Missing channel capability')
        full = analysis_engine.compute_time_capacity(db, spec, None, precision='full', compact=True)
        plan = {'x_title': 'Time (min)', 'traces': [{'cell_id': cell.id, 'group_id': None,
            'current_name': cell.name, 'voltage_series': [{'channel': q, 'name': q,
                'y_title': result['voltage_channels'][q]['label']} for q in channels]}]}
        target = work / 'channels.parquet'
        time_capacity_workers.write_time_capacity_data_export(full, plan,
            analysis_engine.time_capacity_settings(spec['computation']), target,
            export_format='parquet', data_precision='full', x_range=(100., 500.))
        exported = pd.read_parquet(target)
        selected = (np.array(x) >= 100) & (np.array(x) <= 500)
        for q in channels:
            column = next(c for c in exported if c.startswith(q + ' |') and result['voltage_channels'][q]['label'] in c)
            np.testing.assert_array_equal(exported[column], np.concatenate([v[q] for v in oracle.values()])[selected])
    engine.dispose()
    checked_sources(root, manifest)
    return {'sources': len(paths), 'rows': len(x), 'sequential_minutes': offset,
        'channels': channels, 'source_evidenced_loop_boundaries': len(expected_breaks) - len(paths) + 1,
        'independent_bytes_and_export': 'passed'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='cp-oracle-', dir=ROOT / 'tmp') as temporary:
        print(json.dumps(verify(args.root, Path(temporary)), indent=2))
