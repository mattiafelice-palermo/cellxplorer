"""Independent byte fixtures for narrowly proven GCPL replay omission."""
from __future__ import annotations

from copy import deepcopy
import os
from pathlib import Path
import tempfile
import unittest
import uuid
from unittest.mock import patch

import numpy as np
import pandas as pd

os.environ.setdefault("CELLXPLORER_DATA", str(Path(__file__).resolve().parents[1] / ".test-cellxplorer"))
from backend.app.services import cache, calc, parsing
from backend.app.services.biologic_gcpl import map_gcpl_to_canonical, InvalidBiologicGcplError
from backend.app.services.biologic_gcpl_replay import recover_replayed_blocks
from backend.app.services.biologic_mpr import read_mpr
from tests.biologic_mpr_fixture import encode_gcpl_settings, write_gcpl_mpr


def settings():
    return encode_gcpl_settings([
        {"current": 0., "rest_duration_s": 1.}, {"current": 1.},
        {"current": -1., "goto_step": 0, "repeat_count": 3},
    ])


def loop(t, half):
    return [dict(total_time_s=t+dt, ns=ns, mode=mode, half_cycle=half+h,
                 control=current, q_mAh=q, raw_dq_mAh=dq, ns_changed=False,
                 ewe_v=3.5 + dt/100000, ece_v=.1)
            for dt, ns, mode, h, current, q, dq in [
                (0,0,3,0,0.,-.9,0.), (1,0,3,0,1.,-.9,0.),
                (2,1,1,1,1.,0.,0.), (3602,1,1,1,1.,1.,1.),
                (3603,2,1,2,-1.,0.,0.), (6843,2,1,2,-1.,-.9,-.9),
            ]]


def rows():
    original = loop(0, 0)
    duplicate = deepcopy(original)
    for row in duplicate:
        row['half_cycle'] += 2
    return original + duplicate + loop(6844, 4)


class ReplayTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def document(self, values=None):
        document = read_mpr(write_gcpl_mpr(self.root/f'{uuid.uuid4().hex}.mpr', rows() if values is None else values,
                                         settings_payload=settings()))
        self.addCleanup(document.close)
        return document

    def recover(self, records, **kwargs):
        declared = {'settings_profile': 'gcpl-technique-77-v1', 'sequences': [
            {'step_index': 1,'direction':'rest'}, {'step_index':2,'direction':'charge'},
            {'step_index':3,'direction':'discharge'}]}
        return recover_replayed_blocks(records, kwargs.get('settings', declared),
                                       fully_compared_layout=kwargs.get('layout', True))

    def test_exact_science_and_original_positions(self):
        dirty = rows()
        recovered = map_gcpl_to_canonical(self.document(dirty))
        clean = map_gcpl_to_canonical(self.document(dirty[:6] + dirty[12:]))
        pd.testing.assert_frame_equal(recovered.drop(columns='record_index'), clean.drop(columns='record_index'),
                                      check_exact=True)
        pd.testing.assert_frame_equal(calc.per_cycle(recovered), calc.per_cycle(clean), check_exact=True)
        self.assertEqual(recovered.record_index.tolist(), list(range(1,7)) + list(range(13,19)))
        self.assertEqual(len(calc.per_cycle(recovered)), 2)
        np.testing.assert_allclose(calc.per_cycle(recovered).coulombic_efficiency_pct, [90.,90.], rtol=0,atol=1e-12)
        self.assertEqual(recovered.attrs['biologic_gcpl']['parser_warnings'][0]['count'], 6)

    def test_every_compared_field_is_fail_closed(self):
        records = self.document().vmp_data.records
        for name in records.dtype.names:
            with self.subTest(field=name):
                changed = records.copy()
                # An active row: neither the rest counter exception nor half-cycle
                # offset is allowed to hide a changed scientific/control field.
                changed[name][9] += 1
                result = self.recover(changed)
                self.assertIs(result.records, changed)
                self.assertFalse(result.skipped_blocks)

    def test_all_admission_gates(self):
        records = self.document().vmp_data.records
        for kwargs in ({'layout':False}, {'settings':None}, {'settings':{}},
                       {'settings':{'settings_profile':'unknown','sequences':[]}}):
            with self.subTest(kwargs=kwargs):
                self.assertFalse(self.recover(records, **kwargs).skipped_blocks)
        variants = {}
        v=records.copy();v['raw_q_charge_discharge_mAh'][6:8]=[1e-9,2e-9];variants['variable rest counter']=v
        v=records.copy();v['raw_q_charge_discharge_mAh'][6:8]=3e-8;variants['large rest counter']=v
        v=records.copy();v['raw_dq_mAh'][6]=1e-12;variants['nonzero rest dq']=v
        v=records.copy();v['raw_flags'][0:2] |= 8;v['raw_flags'][6:8] |= 8;variants['instrument error']=v
        v=records.copy();v['elapsed_time_s'][12]=v['elapsed_time_s'][5];variants['no forward join']=v
        v=records.copy();v['elapsed_time_s'][13]=0;variants['another unmatched regression']=v
        v=records.copy();v['raw_sample_index'][12]=2;variants['partial replay discharge']=v
        v=records.copy();v['raw_ewe_v'][7]=np.nan;variants['nonfinite']=v
        variants['truncated copy']=records[:11].copy()
        # Ambiguous matching timestamp at two earlier positions.
        v=records.copy();v['elapsed_time_s'][1]=v['elapsed_time_s'][0];variants['ambiguous match']=v
        for name, variant in variants.items():
            with self.subTest(gate=name):
                self.assertFalse(self.recover(variant).skipped_blocks)
        with patch('backend.app.services.biologic_gcpl_replay.MAX_REPLAY_ROWS',5):
            self.assertFalse(self.recover(records).skipped_blocks)
        with patch('backend.app.services.biologic_gcpl_replay.MAX_REPLAY_BLOCKS',0):
            self.assertFalse(self.recover(records).skipped_blocks)

    def test_neutral_counter_exception_and_next_control_target(self):
        records = self.document().vmp_data.records.copy()
        records['raw_q_charge_discharge_mAh'][6:8] += 1e-9
        self.assertEqual(len(self.recover(records).skipped_blocks),1)
        # A matching suffix of the original Rest is insufficient evidence.
        suffix=np.concatenate([records[:1],records])
        suffix['elapsed_time_s'][0]=-1
        self.assertFalse(self.recover(suffix).skipped_blocks)

    def test_unknown_bytes_fields_and_measured_rest_current_reject(self):
        records=self.document().vmp_data.records.copy()
        for field,kind in [('raw_current_ma','<f8'),('unknown_payload','S4')]:
            extended=np.zeros(len(records),dtype=records.dtype.descr+[(field,kind)])
            for name in records.dtype.names:extended[name]=records[name]
            if field=='raw_current_ma':
                self.assertEqual(len(self.recover(extended).skipped_blocks),1)
                extended[field][0]=extended[field][6]=1e-12
            self.assertFalse(self.recover(extended).skipped_blocks)
        missing=records[[name for name in records.dtype.names if name!='raw_dq_mAh']]
        self.assertFalse(self.recover(missing).skipped_blocks)
        padded=np.zeros(len(records),dtype=np.dtype(records.dtype.descr,align=True))
        for name in records.dtype.names:padded[name]=records[name]
        self.assertFalse(self.recover(padded).skipped_blocks)
        settings_wrong={'settings_profile':'gcpl-technique-77-v1','sequences':[
            {'step_index':1,'direction':'rest'},{'step_index':2,'direction':'discharge'},
            {'step_index':3,'direction':'charge'}]}
        self.assertFalse(self.recover(records,settings=settings_wrong).skipped_blocks)

    def test_recovery_is_atomic_with_two_blocks(self):
        values=rows()+loop(13688,6)
        duplicate=deepcopy(values[-6:])
        for row in duplicate:row['half_cycle']+=2
        values+=duplicate+loop(20532,10)
        document=self.document(values)
        self.assertEqual(len(self.recover(document.vmp_data.records).skipped_blocks),2)
        broken=document.vmp_data.records.copy();broken['raw_ece_v'][-9]+=.01
        self.assertFalse(self.recover(broken).skipped_blocks)

    def test_cache_reload_diagnostics_and_selective_rows(self):
        p=write_gcpl_mpr(self.root/'cached.mpr',rows(),settings_payload=settings())
        digest=parsing.compute_hash(p);identity=parsing.parser_identity(p)
        with patch.object(cache,'CACHE_DIR',self.root/'cache'):
            cache.build(digest,p)
            raw=cache.load_raw(digest,identity)
            self.assertEqual(raw.record_index.tolist(),list(range(1,7))+list(range(13,19)))
            notice=cache.load_parser_warnings(digest,identity)[0]
            self.assertEqual(notice['severity'],'info')
            self.assertEqual(notice['examples'][0]['record_start'],7)
            selected=cache.load_raw_cycles(digest,identity,[2],list(raw.columns))
            pd.testing.assert_frame_equal(selected.reset_index(drop=True),raw[raw.cycle==2].reset_index(drop=True))
            self.assertEqual(raw.attrs['biologic_gcpl']['retained_record_count'],12)

    def test_changed_replay_still_rejected_by_public_parser(self):
        values=rows();values[9]['ece_v']=.9
        with self.assertRaises(InvalidBiologicGcplError):
            map_gcpl_to_canonical(self.document(values))


if __name__=='__main__':unittest.main()
