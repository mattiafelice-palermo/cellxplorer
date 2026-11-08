"""Byte-backed evidence gates for GCPL signed settings and neutral boundaries."""
from __future__ import annotations
from backend.app.services.filesystem_cleanup import TemporaryDirectory

from copy import deepcopy
import os
from pathlib import Path
import tempfile
import unittest

import numpy as np

os.environ.setdefault("CELLXPLORER_DATA", str(Path(__file__).resolve().parents[1] / ".test-cellxplorer"))
from backend.app.services import calc
from backend.app.services.biologic_gcpl import (
    BiologicGcplError, decode_gcpl_settings, map_gcpl_to_canonical,
)
from backend.app.services.biologic_gcpl_replay import recover_replayed_blocks
from backend.app.services.biologic_mpr import read_mpr
from tests.biologic_mpr_fixture import encode_gcpl_settings, write_gcpl_mpr
from tests.test_biologic_replay import loop, rows as replay_rows


def row(t, ns, mode, q=0., dq=0., control=0., q13=0.):
    return dict(total_time_s=t, ns=ns, mode=mode, q_mAh=q,
                raw_dq_mAh=dq, control=control, raw_q_minus_q0_mAh=q13,
                ns_changed=False, ewe_v=1.2, ece_v=.1)


class VerifiedVariantTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.counter = 0

    def document(self, rows, sequences, technique_id=0x77):
        self.counter += 1
        payload = encode_gcpl_settings(sequences, technique_id=technique_id)
        doc = read_mpr(write_gcpl_mpr(self.root / f"{self.counter}.mpr", rows,
                                     settings_payload=payload))
        self.addCleanup(doc.close)
        return doc

    def discharge_rows(self):
        final_transfer = -1. * .0002 / 3600.
        return [row(0, 0, 3), row(1, 0, 3),
                row(2, 1, 1, control=-1.), row(3602, 1, 1, -.9, -.9, -1.),
                row(3602.0002, 1, 3, -.9 + final_transfer, final_transfer),
                row(3603, 1, 3, -.9 + final_transfer)]

    def test_short_final_discharge_interval_belongs_to_active_capacity(self):
        rows = self.discharge_rows()
        original = deepcopy(rows)
        frame = map_gcpl_to_canonical(self.document(rows, [{"current": 0.}, {"current": -1.}]))
        self.assertEqual(rows, original)
        self.assertEqual(frame.status.tolist(), ["Rest", "Rest", "CC_DChg", "CC_DChg", "Rest", "Rest"])
        self.assertEqual(frame.discharge_capacity_mah.tolist(), [0., 0., 0., -rows[4]["q_mAh"], 0., 0.])
        self.assertFalse(frame.cycle_complete.any())
        self.assertTrue(calc.per_cycle(frame).empty)
        self.assertEqual(frame.attrs["biologic_gcpl"]["delayed_active_boundary_transfers_mah"][0]["record_index"], 5)

    def test_delayed_rest_transfer_evidence_is_required(self):
        variants = {}
        v=self.discharge_rows(); v[4]["total_time_s"]=3602.1; variants["long gap"]=v
        v=self.discharge_rows(); v[4]["q_mAh"]-=1e-4; variants["counter mismatch"]=v
        v=self.discharge_rows(); v[4]["control"]=-1.; variants["active target"]=v
        v=self.discharge_rows(); v[5]["q_mAh"]-=1e-4; variants["rest drift"]=v
        v=self.discharge_rows(); v[5]["raw_dq_mAh"]=-1e-4; variants["later transfer"]=v
        v=self.discharge_rows(); v[4]["q_mAh"]=-.8999995; v[4]["raw_dq_mAh"]=5e-7; v[5]["q_mAh"]=-.8999995; variants["wrong sign"]=v
        # dQ and cumulative delta agree, but imply nine times the nominal
        # current over the recorded interval. Counter equality alone is unsafe.
        v=self.discharge_rows(); v[4]["q_mAh"]=-.9000005; v[4]["raw_dq_mAh"]=-5e-7; v[5]["q_mAh"]=-.9000005; variants["contradictory physical magnitude"]=v
        for name, rows in variants.items():
            with self.subTest(name=name), self.assertRaises(BiologicGcplError):
                map_gcpl_to_canonical(self.document(rows, [{"current": 0.}, {"current": -1.}]))

    def test_delayed_transfer_after_replay_uses_original_physical_record_index(self):
        values = replay_rows()
        final = values[-1]
        transfer = -1. * .0002 / 3600.
        values += [row(final["total_time_s"] + .0002, 2, 3, final["q_mAh"] + transfer, transfer),
                   row(final["total_time_s"] + 1., 2, 3, final["q_mAh"] + transfer)]
        frame = map_gcpl_to_canonical(self.document(values, [
            {"current": 0., "rest_duration_s": 1.}, {"current": 1.}, {"current": -1.}]))
        self.assertEqual(len(frame), 14)
        self.assertEqual(frame.record_index.tolist(), list(range(1,7)) + list(range(13,21)))
        self.assertEqual(frame.attrs["biologic_gcpl"]["delayed_active_boundary_transfers_mah"][0]["record_index"], 19)
        self.assertAlmostEqual(frame.discharge_capacity_mah.iloc[-3], .9 - transfer, places=14)

    def test_signed_technique04_requires_selector_zero_and_record_agreement(self):
        sequences=[{"current": 0.}, {"current": -1.}]
        document=self.document(self.discharge_rows(), sequences, 0x04)
        settings=decode_gcpl_settings(document.vmp_set)
        self.assertEqual(settings["settings_profile"], "gcpl-technique-04-signed-v1")
        self.assertEqual(settings["ns_change_policy"], "strict")
        self.assertEqual(settings["sequences"][1]["current_ma"], -1.)
        self.assertEqual(len(map_gcpl_to_canonical(document)), 6)
        sequences[1]["sign_code"]=1
        with self.assertRaisesRegex(BiologicGcplError, "selector zero"):
            map_gcpl_to_canonical(self.document(self.discharge_rows(), sequences, 0x04))
        bad=self.discharge_rows();bad[2]["control"]=bad[3]["control"]=1.
        with self.assertRaises(BiologicGcplError):
            map_gcpl_to_canonical(self.document(bad, [{"current": 0.}, {"current": -1.}], 0x04))

    def test_rest_only_recordings_have_curves_and_no_complete_cycle(self):
        frame=map_gcpl_to_canonical(self.document([row(0,0,3),row(1,0,3)], [{"current":0.}]))
        self.assertEqual(frame.status.tolist(), ["Rest", "Rest"])
        self.assertFalse(frame.cycle_complete.any())
        self.assertTrue(calc.per_cycle(frame).empty)
        self.assertTrue(np.isfinite(frame.voltage_v).all())
        bad=[row(0,0,3),row(1,0,3,q=.1,dq=.1)]
        with self.assertRaises(BiologicGcplError):
            map_gcpl_to_canonical(self.document(bad, [{"current":0.}]))

    def first_charge_rows(self):
        return [row(0,0,3),row(1,0,3),
                row(2,1,1,0.,1e-6,1.,1e-6),
                row(1802,1,1,0.,.499999,1.,.5),
                row(3602,1,1,0.,.5,1.,1.),
                row(3603,2,1,-1e-6,-1e-6,-1.,.999999),
                row(6843,2,1,-.9,-.899999,-1.,.1)]

    def test_inert_first_charge_id211_uses_independently_verified_id13(self):
        rows=self.first_charge_rows()
        frame=map_gcpl_to_canonical(self.document(rows,[{"current":0.},{"current":1.},{"current":-1.}]))
        self.assertEqual(frame.attrs["biologic_gcpl"]["capacity_counter_profile"], "gcpl-capacity-id13-leading-charge-id211-v1")
        self.assertAlmostEqual(frame.charge_capacity_mah.max(), .999999)
        self.assertAlmostEqual(frame.discharge_capacity_mah.max(), .899999)
        self.assertEqual(len(calc.per_cycle(frame)),1)
        for key, value in [("raw_q_minus_q0_mAh", .6), ("raw_dq_mAh", .3)]:
            bad=deepcopy(rows);bad[3][key]=value
            with self.subTest(field=key), self.assertRaises(BiologicGcplError):
                map_gcpl_to_canonical(self.document(bad,[{"current":0.},{"current":1.},{"current":-1.}]))
        bad=deepcopy(rows);bad[5]["raw_q_minus_q0_mAh"]+=.01
        with self.assertRaises(BiologicGcplError):
            map_gcpl_to_canonical(self.document(bad,[{"current":0.},{"current":1.},{"current":-1.}]))

    def test_neutral_replay_carry_is_an_exact_endpoint_proof(self):
        earlier=loop(0,0)
        for r in earlier[:2]:
            r["q_mAh"]=-9e-6
            r["raw_q_minus_q0_mAh"]=0.
        earlier[-1]["q_mAh"]=-8.9e-6
        duplicate=deepcopy(earlier)
        for r in duplicate:r["half_cycle"]+=2
        for r in duplicate[:2]:r["q_mAh"]=-8.9e-6
        prefix=[dict(earlier[-1],total_time_s=-1.,q_mAh=-9e-6)]
        document=self.document(prefix+earlier+duplicate+loop(6844,4),
            [{"current":0.},{"current":1.},{"current":-1.}])
        records=document.vmp_data.records
        declared={"settings_profile":"gcpl-technique-77-v1","sequences":[
            {"step_index":1,"direction":"rest"},{"step_index":2,"direction":"charge"},
            {"step_index":3,"direction":"discharge"}]}
        result=recover_replayed_blocks(records,declared,fully_compared_layout=True)
        self.assertEqual(len(result.skipped_blocks),1)
        self.assertEqual(result.skipped_blocks[0]["record_start"],8)
        for index,field in [(0,"raw_q_charge_discharge_mAh"),(7,"raw_q_minus_q0_mAh")]:
            bad=records.copy();bad[field][index]+=1e-8
            self.assertFalse(recover_replayed_blocks(bad,declared,fully_compared_layout=True).skipped_blocks)
        for field, value in [("raw_sample_index",1), ("raw_flags",3),
                             ("raw_flags",9), ("raw_control_v_or_mA",1.)]:
            with self.subTest(prefix_field=field, value=value):
                bad=records.copy();bad[field][0]=value
                self.assertFalse(recover_replayed_blocks(bad,declared,fully_compared_layout=True).skipped_blocks)


if __name__ == "__main__":
    unittest.main()
