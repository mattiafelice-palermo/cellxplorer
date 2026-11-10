"""Spec 107: CP bytes, scoped upgrade, sequential channels and pinned replay."""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import unittest
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
import pandas as pd
from sqlalchemy import create_engine, event
from sqlalchemy.orm import defer, sessionmaker

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault('CELLXPLORER_DATA', str(ROOT / '.test-cellxplorer'))
sys.path.insert(0, str(ROOT / 'backend'))
from app.db import Base
from app.models import Analysis, Cell, SourceFile, Test, TestFile
from app.services import analysis_engine, background_jobs, cache, calc, canonical_cycling, parsing, portable_analysis, scanner, time_capacity_workers
from app.services.filesystem_cleanup import TemporaryDirectory
from app.routers.files import preview_file
from fastapi import HTTPException
from tests.biologic_mpr_fixture import write_cp_mpr


LEGACY = 'bm:gcpl18cpocv1:r1'
HEADER = {'settings': {'technique_id': 25}, 'data': {'field_offsets': {'raw_mean_counter_potential': 19}}}
CHANNELS = ['voltage', 'working_potential', 'counter_potential']


class CpElectrodeMappingTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.cache_patch = patch.object(cache, 'CACHE_DIR', self.root / 'cache')
        self.cache_patch.start()
        self.engine = create_engine('sqlite://')
        Base.metadata.create_all(self.engine)
        self.db = sessionmaker(bind=self.engine, expire_on_commit=False, autoflush=False)()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()
        self.cache_patch.stop()
        self.temp.cleanup()

    def ingest(self, index=0, **options):
        return scanner.ingest_path(self.db, write_cp_mpr(self.root / f'cp{index}.mpr', shift=index / 10, **options), parse_now=True)

    def chain(self, count=2, **options):
        sources = [self.ingest(i, **options) for i in range(count)]
        cell = Cell(name='CP electrodes')
        self.db.add(cell); self.db.flush()
        test = Test(cell_id=cell.id, name='internal')
        self.db.add(test); self.db.flush()
        self.db.add_all([TestFile(test_id=test.id, file_id=sf.id, position=i) for i, sf in enumerate(sources)])
        self.db.commit()
        spec = analysis_engine.default_spec('CP electrodes')
        spec['selection']['entries'] = [{'kind': 'cell', 'ref_id': cell.id}]
        spec['computation']['time_capacity'] = {'view': 'voltage_current', 'x_axis': 'time',
            'display_mode': 'consecutive', 'time_unit': 's', 'cycle_start': 1, 'cycle_end': count,
            'voltage_channels': CHANNELS, 'max_points_per_cell': 10000}
        return sources, cell, spec

    def test_byte_mapping_metadata_reload_and_permissive_clock_fallback(self):
        sf = self.ingest()
        raw = cache.load_raw(sf.hash, sf.parser_version)
        we = np.array([np.float32(.25 + i / 100) for i in range(6)], dtype=float)
        ce = np.array([np.float32(-1.25 + i / 200) for i in range(6)], dtype=float)
        np.testing.assert_array_equal(raw.working_potential_v, we)
        np.testing.assert_array_equal(raw.counter_potential_v, ce)
        np.testing.assert_array_equal(raw.voltage_v, we - ce)
        self.assertEqual(sf.parser_version, LEGACY + ':cp3')
        capabilities = sf.header_meta[canonical_cycling.VOLTAGE_CAPABILITIES_METADATA_KEY]
        self.assertEqual(capabilities['voltage_roles']['voltage_v'], 'cell')
        self.assertTrue(capabilities['voltage_v_derived'])
        selected = cache.load_raw_cycles(sf.hash, sf.parser_version, [1], list(raw.columns))
        pd.testing.assert_frame_equal(raw, selected, check_exact=True)
        path = write_cp_mpr(self.root / 'clock.mpr', times=(0., 10., 3., 7., 8., 9.))
        with self.assertRaises(Exception):
            parsing.parse_timeseries(path)
        exploratory = parsing.parse_timeseries(path, read_mode='permissive')
        np.testing.assert_array_equal(exploratory.voltage_v, we - ce)
        self.assertTrue(exploratory.charge_capacity_mah.isna().all())
        self.assertFalse(exploratory.cycle_complete.any())
        self.assertEqual(exploratory.mpr_elapsed_time_s.tolist(), [0, 10, 3, 7, 8, 9])
        self.assertEqual(parsing.parser_identity(path, read_mode='permissive'), LEGACY + ':cp3:p1')

    def test_loop_breaks_use_declared_indexes_and_never_a_time_threshold(self):
        from app.services import biologic_cp_ocv
        ordinary = write_cp_mpr(self.root / 'ordinary.mpr')
        declared = write_cp_mpr(self.root / 'declared.mpr', loop_indexes=(0, 2, 4, 6))
        baseline = parsing.parse_timeseries(ordinary)
        frame = parsing.parse_timeseries(declared)
        pd.testing.assert_frame_equal(frame.drop(columns='mpr_acquisition_segment'), baseline, check_exact=True)
        self.assertEqual(frame.mpr_acquisition_segment.tolist(), [1, 1, 2, 2, 3, 3])
        self.assertEqual(analysis_engine._phase_from_raw(frame), analysis_engine._phase_from_raw(baseline))
        pd.testing.assert_frame_equal(calc.per_cycle(frame), calc.per_cycle(baseline), check_exact=True)
        sparse = write_cp_mpr(self.root / 'sparse.mpr', times=(0, .5, 1000, 1000.5, 2000, 2000.5))
        self.assertNotIn('mpr_acquisition_segment', parsing.parse_timeseries(sparse))
        with parsing.biologic_mpr.read_mpr(declared) as document:
            self.assertEqual(biologic_cp_ocv.recorded_loop_indexes(document), (0, 2, 4, 6))
        # Unsupported annotations must not withdraw or modify voltage records.
        content = declared.read_bytes()
        variations = {
            'duplicate-module': content + content[-345:],
            'unordered': write_cp_mpr(self.root / 'bad-order.mpr', loop_indexes=(0, 4, 2, 6)).read_bytes(),
            'past-end': write_cp_mpr(self.root / 'bad-end.mpr', loop_indexes=(0, 2, 7)).read_bytes(),
            'no-first-zero': write_cp_mpr(self.root / 'bad-first.mpr', loop_indexes=(1, 2, 6)).read_bytes(),
            'no-terminal': write_cp_mpr(self.root / 'bad-terminal.mpr', loop_indexes=(0, 2, 5)).read_bytes(),
            'nonzero-padding': content[:-1] + b'\1',
        }
        for offset in (-280, -280 - 12, -280 - 16):
            changed = bytearray(content); changed[offset:offset + 4] = b'\xff' * 4
            variations[f'changed-{offset}'] = bytes(changed)
        for name, value in variations.items():
            with self.subTest(annotation=name):
                path = self.root / f'{name}.mpr'; path.write_bytes(value)
                result = parsing.parse_timeseries(path)
                pd.testing.assert_frame_equal(result, baseline, check_exact=True)
        # Explicit permissive fallback keeps both loop and native clock boundaries.
        bad_clock = write_cp_mpr(self.root / 'declared-clock.mpr', times=(0, 1, 2, 0, 1, 2), loop_indexes=(0, 2, 4, 6))
        exploratory = parsing.parse_timeseries(bad_clock, read_mode='permissive')
        self.assertEqual(exploratory.mpr_acquisition_segment.tolist(), [1, 1, 2, 3, 4, 4])
        self.assertEqual(exploratory.cycle.tolist(), [1, 1, 1, 2, 2, 2])
        old_clock = write_cp_mpr(self.root / 'old-clock.mpr', times=(0, 1, 2, 0, 1, 2))
        previous = parsing.parse_timeseries(old_clock, read_mode='permissive')
        pd.testing.assert_frame_equal(exploratory.drop(columns='mpr_acquisition_segment'),
            previous.drop(columns='mpr_acquisition_segment'), check_exact=True)

    def test_source_loop_boundaries_survive_both_paths_and_decimation(self):
        from app.services import time_capacity_reusable
        sources, cell, spec = self.chain(times=tuple(np.arange(1200) / 2), loop_indexes=(0, 399, 801, 1200))
        expected_breaks = [399, 801, 1200, 1599, 2001]
        for baseline in (False, True):
            with patch.object(time_capacity_workers, 'try_compute_time_capacity', return_value=None) if baseline else patch.object(time_capacity_workers, '_run_serial', wraps=time_capacity_workers._run_serial):
                result = analysis_engine.compute_time_capacity(self.db, spec, None, precision='full')
            trace = result['cell_traces'][0]
            self.assertEqual(trace['display_break_before'], expected_breaks)
            self.assertEqual(len(trace['voltage_v']), 2400)
            self.assertNotIn('unverified', trace['phase'])
        plan = {'x_title': 'Time (s)', 'traces': [{'cell_id': cell.id, 'group_id': None,
            'current_name': cell.name, 'voltage_series': [{'channel': q, 'name': q,
                'y_title': result['voltage_channels'][q]['label']} for q in CHANNELS]}]}
        target = self.root / 'loop-records.parquet'
        time_capacity_workers.write_time_capacity_data_export(result, plan,
            analysis_engine.time_capacity_settings(spec['computation']), target,
            export_format='parquet', data_precision='full')
        exported = pd.read_parquet(target)
        self.assertEqual(len(exported), 2400)
        for q in CHANNELS:
            column = next(c for c in exported if c.startswith(q + ' |') and result['voltage_channels'][q]['label'] in c)
            np.testing.assert_array_equal(exported[column], trace['voltage_v_by_channel'][q])
        spec['computation']['time_capacity']['max_points_per_cell'] = 800
        for baseline in (False, True):
            with patch.object(time_capacity_workers, 'try_compute_time_capacity', return_value=None) if baseline else patch.object(time_capacity_workers, '_run_serial', wraps=time_capacity_workers._run_serial), \
                patch.object(analysis_engine, '_downsample_indices', side_effect=lambda length, *args: np.array([0, length - 1], dtype='int64')):
                compact = analysis_engine.compute_time_capacity(self.db, spec, None, precision='standard', compact=True)
            trace = compact['cell_traces'][0]
            self.assertEqual(trace['display_break_before'], [2, 4, 6, 8, 10])
            self.assertEqual(len(trace['display_x']), 12)
        selected = deepcopy(spec); selected['computation']['time_capacity']['cycle_start'] = 2
        trace = analysis_engine.compute_time_capacity(self.db, selected, None, precision='full')['cell_traces'][0]
        self.assertEqual(trace['display_break_before'], [399, 801])
        built = time_capacity_workers._build_jobs(self.db, spec, None, use_current_versions=False,
            viewport_width=1200, precision='standard', compact=True)
        self.assertIsNotNone(built)
        self.assertIsNone(time_capacity_reusable.artifact_key(built[0][0], built[1]))
        # CP2 caches already contain corrected cell voltage and retain that role.
        pins = {'sources': [{'cell_id': cell.id, 'files': []}]}
        for sf in sources:
            cp2 = cache.load_raw(sf.hash, sf.parser_version).drop(columns='mpr_acquisition_segment')
            cache._publish_optimized_raw(cp2, cache.raw_path(sf.hash, LEGACY + ':cp2'), LEGACY + ':cp2')
            pins['sources'][0]['files'].append({'hash': sf.hash, 'parser_version': LEGACY + ':cp2'})
        historical = analysis_engine.compute_time_capacity(self.db, spec, pins, precision='full')
        self.assertEqual(historical['voltage_channels']['voltage']['role'], 'cell')
        self.assertTrue(historical['voltage_channels']['working_potential']['available'])
        self.assertEqual(historical['cell_traces'][0]['display_break_before'], [])

    def test_derivative_stays_inside_declared_loops(self):
        path = write_cp_mpr(self.root / 'derivative.mpr', times=tuple(range(18)), loop_indexes=(0, 6, 12, 18))
        frame = parsing.parse_timeseries(path)
        frame['segment'] = 0
        phase = analysis_engine._phase_from_raw(frame)
        capacity = np.arange(len(frame), dtype=float)
        for view in ('dqdv', 'dvdq'):
            settings = {'view': view, 'smoothing_window': 5}
            actual = analysis_engine._derivative_curve(frame, phase, capacity, capacity, settings)
            separate = [analysis_engine._derivative_curve(frame.iloc[a:b], phase[a:b], capacity[a:b], capacity[a:b], settings)
                for a, b in ((0, 6), (6, 12), (12, 18))]
            for i in (0, 1):
                np.testing.assert_allclose(actual[i], np.concatenate([part[i] for part in separate]), rtol=0, atol=0, equal_nan=True)

    def test_scalar_identity_matches_python_and_does_not_load_deferred_headers(self):
        headers = [HEADER, {'raw': HEADER}, {'technique': 'CP'},
            {'settings': {'technique_id': 11}, 'data': HEADER['data']}, None]
        for i, header in enumerate(headers):
            self.db.add(SourceFile(hash=str(i), path=f'offline{i}', filename=f'{i}.mpr', size=1,
                ext='mpr', header_meta=deepcopy(header), parser_version=LEGACY))
        self.db.commit(); self.db.expunge_all()
        statements = []
        def observed(*args): statements.append(args[2])
        event.listen(self.engine, 'before_cursor_execute', observed)
        try:
            rows = self.db.query(SourceFile).options(defer(SourceFile.header_meta)).order_by(SourceFile.id).all()
            with patch.object(parsing.biologic_mpr, 'read_mpr_header', side_effect=AssertionError('source I/O')):
                actual = [parsing.current_parser_identity_for_source(row) for row in rows]
            self.assertEqual(len(statements), 1)
            self.assertTrue(all('header_meta' not in row.__dict__ for row in rows))
            self.assertEqual(actual, [parsing.current_parser_identity_for_extension('mpr', header_meta=h) for h in headers])
            rows[0].header_meta = None
            self.assertEqual(parsing.current_parser_identity_for_source(rows[0]), LEGACY)
        finally:
            event.remove(self.engine, 'before_cursor_execute', observed)
        class Neware:
            ext = 'ndax'
            @property
            def header_meta(self): raise AssertionError('Neware header access')
        self.assertEqual(parsing.current_parser_identity_for_source(Neware()), parsing.current_parser_identity_for_extension('ndax'))

    def test_upgrade_selection_preserves_legacy_and_unrelated_cache_bytes(self):
        cp = self.ingest()
        corrected = cache.load_raw(cp.hash, cp.parser_version)
        old = corrected.drop(columns=['working_potential_v', 'counter_potential_v']).copy()
        old['voltage_v'] = corrected.working_potential_v
        cache._publish_optimized_raw(old, cache.raw_path(cp.hash, LEGACY), LEGACY)
        old_bytes = cache.raw_path(cp.hash, LEGACY).read_bytes()
        unrelated = cache.raw_path('unrelated', parsing.current_parser_identity_for_extension('ndax'))
        unrelated.parent.mkdir(parents=True, exist_ok=True)
        unrelated.write_bytes(b'unrelated cache bytes')
        cp.parser_version = LEGACY
        self.assertTrue(scanner._needs_identity_bring_forward(cp))
        for ext, header in [('ndax', HEADER), ('mpr', {'settings': {'technique_id': 11}}), ('mpr', {'settings': {'technique_id': 127}})]:
            other = SimpleNamespace(ext=ext, header_meta=header, parser_version=parsing.current_parser_identity_for_extension(ext),
                parse_status='parsed', location_status='online')
            self.assertFalse(scanner._needs_identity_bring_forward(other))
        # The corrected cache already exists (for example after a staged
        # preview). Exercise startup worker publication, not direct parsing.
        cp.header_meta = deepcopy(HEADER)
        self.db.commit()
        source_job = scanner._capacity_source_job(cp, prepare_all_missing=False)
        self.db.commit()
        result = scanner._prepare_capacity_source_worker(source_job)
        self.assertTrue(result['ok'])
        self.assertTrue(result['info']['cached'])
        job_id = background_jobs.create_job(kind='scientific_preparation', title='CP upgrade',
            description='Scoped cache promotion', total=1, items=[{'id': cp.id, 'label': cp.filename}])
        self.assertEqual(scanner._apply_capacity_source_result(self.db, job_id, source_job, result), (1, 0))
        self.db.refresh(cp)
        self.assertEqual(cp.header_meta[canonical_cycling.VOLTAGE_CAPABILITIES_METADATA_KEY]['voltage_roles']['voltage_v'], 'cell')
        self.assertFalse(scanner._needs_identity_bring_forward(cp))
        self.assertEqual(cache.raw_path(cp.hash, LEGACY).read_bytes(), old_bytes)
        self.assertEqual(unrelated.read_bytes(), b'unrelated cache bytes')

    def test_sequential_channels_full_compact_selected_and_legacy_pinned_replay(self):
        sources, cell, spec = self.chain()
        for compact, precision in [(False, 'full'), (True, 'standard')]:
            result = analysis_engine.compute_time_capacity(self.db, spec, None, precision=precision, compact=compact)
            trace = result['cell_traces'][0]
            self.assertEqual(set(trace['voltage_v_by_channel']), set(CHANNELS))
            self.assertEqual(trace['display_x'], [0., 10., 20., 20., 30., 40., 40., 50., 60., 60., 70., 80.])
            for quantity, column in canonical_cycling.VOLTAGE_QUANTITIES.items():
                expected = np.concatenate([cache.load_raw(sf.hash, sf.parser_version)[column].to_numpy() for sf in sources])
                np.testing.assert_allclose(trace['voltage_v_by_channel'][quantity], expected, rtol=1e-6)
        plan = {'x_title': 'Time (s)', 'traces': [{'cell_id': cell.id, 'group_id': None,
            'current_name': cell.name, 'voltage_series': [{'channel': q, 'name': q,
                'y_title': result['voltage_channels'][q]['label']} for q in CHANNELS]}]}
        destination = self.root / 'three-potentials.parquet'
        time_capacity_workers.write_time_capacity_data_export(result, plan,
            analysis_engine.time_capacity_settings(spec['computation']), destination,
            export_format='parquet', data_precision='full')
        exported = pd.read_parquet(destination)
        for quantity in CHANNELS:
            column = next(c for c in exported if c.startswith(quantity + ' |') and result['voltage_channels'][quantity]['label'] in c)
            np.testing.assert_array_equal(exported[column], trace['voltage_v_by_channel'][quantity])
        selected = deepcopy(spec)
        selected['computation']['time_capacity']['cycle_start'] = 2
        narrowed = analysis_engine.compute_time_capacity(self.db, selected, None, precision='full')
        self.assertEqual(len(narrowed['cell_traces'][0]['display_x']), 6)
        pins = {'sources': [{'cell_id': cell.id, 'files': []}]}
        for sf in sources:
            raw = cache.load_raw(sf.hash, sf.parser_version)
            legacy = raw.drop(columns=['working_potential_v', 'counter_potential_v']).copy()
            legacy['voltage_v'] = raw.working_potential_v
            cache._publish_optimized_raw(legacy, cache.raw_path(sf.hash, LEGACY), LEGACY)
            pins['sources'][0]['files'].append({'hash': sf.hash, 'parser_version': LEGACY})
        old_spec = deepcopy(spec)
        old_spec['computation']['time_capacity']['voltage_channels'] = ['voltage']
        for baseline in [False, True]:
            context = patch.object(time_capacity_workers, 'try_compute_time_capacity', return_value=None) if baseline else patch.object(time_capacity_workers, '_run_serial', wraps=time_capacity_workers._run_serial)
            with context:
                old_result = analysis_engine.compute_time_capacity(self.db, old_spec, pins, precision='full')
            trace = old_result['cell_traces'][0]
            expected = np.concatenate([cache.load_raw(sf.hash, LEGACY).voltage_v for sf in sources])
            np.testing.assert_array_equal(trace['voltage_v'], expected)
            self.assertEqual(old_result['voltage_channels']['voltage']['role'], 'working_vs_reference')

    def test_raw_preview_repairs_online_cp_and_rejects_offline_legacy(self):
        sf = self.ingest(); sf.parser_version = LEGACY
        data = preview_file(sf.id, kind='raw', db=self.db)
        self.assertEqual(sf.parser_version, LEGACY + ':cp3')
        self.assertGreater(min(data['voltage_v']), 1.)
        sf.parser_version = LEGACY; sf.path = str(self.root / 'missing.mpr')
        with self.assertRaises(HTTPException) as context:
            preview_file(sf.id, kind='raw', db=self.db)
        self.assertEqual(context.exception.status_code, 409)

    def test_offline_portable_legacy_cp_keeps_actual_identity_until_repaired(self):
        sources, cell, spec = self.chain(1)
        sf = sources[0]
        raw = cache.load_raw(sf.hash, sf.parser_version)
        old = raw.drop(columns=['working_potential_v', 'counter_potential_v']).copy()
        old['voltage_v'] = raw.working_potential_v
        cache._publish_optimized_raw(old, cache.raw_path(sf.hash, LEGACY), LEGACY)
        cache._write_atomic(calc.per_cycle(old), cache.cycles_path(sf.hash, LEGACY))
        sf.parser_version = LEGACY
        spec['computation']['time_capacity']['voltage_channels'] = ['voltage']
        pins = {'sources': [{'cell_id': cell.id, 'files': [{'hash': sf.hash, 'parser_version': LEGACY}]}]}
        analysis = Analysis(title='Historical CP', spec=spec, provenance=pins)
        self.db.add(analysis); self.db.commit()
        report = self.root / 'legacy.html'
        portable_analysis.export_analysis_html(self.db, analysis, report, include_original_files=False)
        original_path = Path(sf.path)
        moved = original_path.with_suffix('.away')
        original_path.rename(moved)
        original_index = portable_analysis._payload_by_kind
        original_decode = portable_analysis._decode_payload
        for mode, identity in [('safe', LEGACY + ':p1'), ('permissive', LEGACY)]:
            def contradictory_report(html, descriptor, destination, *args):
                original_decode(html, descriptor, destination, *args)
                if descriptor['id'] == 'report':
                    document = json.loads(destination.read_text(encoding='utf-8'))
                    document['sources'][0]['read_mode'] = mode
                    document['sources'][0]['parser_version'] = identity
                    destination.write_text(json.dumps(document), encoding='utf-8')
            rejected_engine = create_engine('sqlite://'); Base.metadata.create_all(rejected_engine)
            try:
                with sessionmaker(bind=rejected_engine)() as rejected_db, \
                    patch.object(portable_analysis, '_decode_payload', side_effect=contradictory_report), \
                    patch.object(cache, 'build', side_effect=AssertionError('invalid mode was built')), \
                    self.assertRaises(HTTPException) as caught:
                    portable_analysis.import_analysis_html(rejected_db, report)
                self.assertEqual(caught.exception.status_code, 400)
            finally:
                rejected_engine.dispose()
        def payloads(manifest, kind):
            if kind in {'raw_cache', 'cycle_cache'}:
                return [{'id': kind, 'kind': kind, 'source_id': f'source-{sf.hash}',
                    'parser_version': LEGACY, 'calc_version': cache.CALC_VERSION}]
            return original_index(manifest, kind)
        def decode(html, descriptor, destination, *args):
            if descriptor['id'] == 'raw_cache': old.to_parquet(destination, index=False)
            elif descriptor['id'] == 'cycle_cache': calc.per_cycle(old).to_parquet(destination, index=False)
            else: return original_decode(html, descriptor, destination, *args)
        imported_engine = create_engine('sqlite://'); Base.metadata.create_all(imported_engine)
        try:
            with sessionmaker(bind=imported_engine, expire_on_commit=False)() as imported_db, \
                patch.object(cache, 'CACHE_DIR', self.root / 'imported-cache'), \
                patch.object(portable_analysis, 'IMPORT_DIR', self.root / 'imports'), \
                patch.object(portable_analysis, '_payload_by_kind', side_effect=payloads), \
                patch.object(portable_analysis, '_decode_payload', side_effect=decode):
                imported, warnings = portable_analysis.import_analysis_html(imported_db, report)
                restored = imported_db.query(SourceFile).one()
                self.assertEqual(restored.parser_version, LEGACY)
                self.assertEqual(restored.location_status, 'offline')
                replay = analysis_engine.compute_time_capacity(imported_db, imported.spec, imported.provenance, precision='full')
                np.testing.assert_array_equal(replay['cell_traces'][0]['voltage_v'], old.voltage_v)
                self.assertEqual(replay['voltage_channels']['voltage']['role'], 'working_vs_reference')
                moved.rename(original_path)
                restored.path = str(original_path); restored.location_status = 'online'
                self.assertTrue(scanner._needs_identity_bring_forward(restored))
                scanner.parse_file(imported_db, restored)
                self.assertEqual(restored.parser_version, LEGACY + ':cp3')
                self.assertFalse(scanner._needs_identity_bring_forward(restored))
        finally:
            imported_engine.dispose()


if __name__ == '__main__':
    unittest.main()
