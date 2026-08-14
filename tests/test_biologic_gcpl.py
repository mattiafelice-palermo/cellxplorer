"""Spec 041.2 GCPL -> canonical cycling mapping tests."""

from __future__ import annotations

from pathlib import Path
import tempfile
import unittest

import numpy as np

from backend.app.services import calc, canonical_cycling, parsing
from backend.app.services.biologic_gcpl import (
    InvalidBiologicGcplError,
    MPR_MODE_GALVANOSTATIC,
    MPR_MODE_POTENTIOSTATIC,
    MPR_MODE_REST,
    UnsupportedBiologicGcplError,
    integrate_capacity_by_step,
    map_gcpl_to_canonical,
)
from backend.app.services.biologic_mpr import MPR_RECORD_DTYPE, read_mpr
from tests.biologic_mpr_fixture import write_gcpl_mpr


def _row(
    time_s: float,
    *,
    mode: int = MPR_MODE_GALVANOSTATIC,
    ns: int = 1,
    half_cycle: int = 0,
    control: float = 3600.0,
    q_mAh: float = 0.0,
    dq_mAh: float = 0.0,
    ewe_v: float = 3.5,
    ece_v: float = 0.0,
    ns_changed: bool = False,
) -> dict[str, object]:
    return {
        "total_time_s": time_s,
        "mode": mode,
        "ns": ns,
        "half_cycle": half_cycle,
        "control": control,
        "q_mAh": q_mAh,
        "raw_dq_mAh": dq_mAh,
        "ewe_v": ewe_v,
        "ece_v": ece_v,
        "ns_changed": ns_changed,
    }


class BiologicGcplMappingTests(unittest.TestCase):
    def test_direct_identity_is_registered_without_user_extension_admission(self) -> None:
        self.assertEqual(parsing.recognize_source("source.mpr"), parsing.FORMAT_BIOLOGIC_MPR)
        self.assertEqual(
            parsing.source_parser_descriptor("source.mpr"),
            {
                "format_id": parsing.FORMAT_BIOLOGIC_MPR,
                "adapter_revision": "gcpl1",
                "canonical_raw_version": canonical_cycling.CANONICAL_RAW_VERSION,
            },
        )
        self.assertEqual(parsing.parser_identity("source.mpr"), "bm:gcpl1:r1")
        self.assertFalse(parsing.source_filename_allowed("source.mpr"))

    def test_direct_mpr_dispatch_returns_valid_canonical_frame(self) -> None:
        rows = [
            _row(0.0, ns_changed=True),
            _row(1.0, q_mAh=1.0, dq_mAh=1.0),
            _row(2.0, mode=MPR_MODE_REST, ns=2, control=0.0, q_mAh=1.0, ns_changed=True),
            _row(3.0, mode=MPR_MODE_REST, ns=2, control=0.0, q_mAh=1.0),
            _row(
                4.0,
                ns=3,
                half_cycle=1,
                control=-3600.0,
                q_mAh=1.0,
                ns_changed=True,
            ),
            _row(5.0, ns=3, half_cycle=1, control=-3600.0, q_mAh=0.0, dq_mAh=-1.0),
        ]
        with tempfile.TemporaryDirectory() as temp:
            path = write_gcpl_mpr(Path(temp) / "fixture.mpr", rows)
            frame = parsing.parse_timeseries(path)

        self.assertEqual(
            list(frame.columns),
            [
                "record_index",
                "cycle",
                "step",
                "step_index",
                "status",
                "time_s",
                "total_time_s",
                "voltage_v",
                "current_ma",
                "charge_capacity_mah",
                "discharge_capacity_mah",
            ],
        )
        canonical_cycling.validate_raw_timeseries(frame)
        self.assertEqual(frame["record_index"].tolist(), [1, 2, 3, 4, 5, 6])
        self.assertEqual(frame["step"].tolist(), [1, 1, 2, 2, 3, 3])
        self.assertEqual(frame["step_index"].tolist(), [1, 1, 2, 2, 3, 3])
        self.assertEqual(frame["cycle"].tolist(), [1, 1, 1, 1, 1, 1])
        self.assertEqual(
            frame["status"].tolist(),
            ["CC_Chg", "CC_Chg", "Rest", "Rest", "CC_DChg", "CC_DChg"],
        )
        self.assertEqual(frame["current_ma"].tolist(), [3600.0, 3600.0, 0.0, 0.0, -3600.0, -3600.0])
        self.assertEqual(frame["time_s"].tolist(), [0.0, 1.0, 0.0, 1.0, 0.0, 1.0])
        np.testing.assert_allclose(frame["voltage_v"], 3.5)
        np.testing.assert_allclose(frame["charge_capacity_mah"], [0.0, 1.0, 0.0, 0.0, 0.0, 0.0])
        np.testing.assert_allclose(frame["discharge_capacity_mah"], [0.0, 0.0, 0.0, 0.0, 0.0, 1.0])
        self.assertTrue(frame.attrs["biologic_gcpl"]["voltage_v_derived"])

    def test_programmed_sequence_is_preserved_and_repeated_execution_gets_new_step(self) -> None:
        rows = [
            _row(0.0, ns=1, ns_changed=True),
            _row(1.0, ns=2, half_cycle=1, control=-3600.0, q_mAh=-1.0, dq_mAh=-1.0, ns_changed=True),
            _row(2.0, ns=1, half_cycle=2, q_mAh=0.0, ns_changed=True),
        ]
        with tempfile.TemporaryDirectory() as temp:
            path = write_gcpl_mpr(Path(temp) / "loop.mpr", rows)
            with read_mpr(path) as document:
                frame = map_gcpl_to_canonical(document)

        self.assertEqual(frame["step_index"].tolist(), [1, 2, 1])
        self.assertEqual(frame["step"].tolist(), [1, 2, 3])
        self.assertEqual(frame["cycle"].tolist(), [1, 1, 2])

    def test_cc_cv_transition_stays_one_executed_step_and_maps_cccv(self) -> None:
        rows = [
            _row(0.0, ns_changed=True),
            _row(1.0, q_mAh=1.0, dq_mAh=1.0),
            _row(
                2.0,
                mode=MPR_MODE_POTENTIOSTATIC,
                control=3.7,
                q_mAh=2.0,
                dq_mAh=1.0,
            ),
        ]
        with tempfile.TemporaryDirectory() as temp:
            path = write_gcpl_mpr(Path(temp) / "cccv.mpr", rows)
            frame = parsing.parse_timeseries(path)

        self.assertEqual(frame["step"].tolist(), [1, 1, 1])
        self.assertEqual(frame["status"].unique().tolist(), ["CCCV_Chg"])
        np.testing.assert_allclose(frame["current_ma"], [3600.0, 3600.0, 3600.0])
        np.testing.assert_allclose(frame["charge_capacity_mah"], [0.0, 1.0, 2.0])

    def test_ambiguous_mixed_direction_fails_closed(self) -> None:
        rows = [
            _row(0.0, ns_changed=True),
            _row(1.0, control=-3600.0, q_mAh=-1.0, dq_mAh=-1.0),
        ]
        with tempfile.TemporaryDirectory() as temp:
            path = write_gcpl_mpr(Path(temp) / "ambiguous.mpr", rows)
            with self.assertRaises(UnsupportedBiologicGcplError):
                parsing.parse_timeseries(path)

    def test_standalone_cv_discharge_is_not_mislabelled(self) -> None:
        rows = [
            _row(0.0, mode=MPR_MODE_POTENTIOSTATIC, control=3.0, ns_changed=True),
            _row(1.0, mode=MPR_MODE_POTENTIOSTATIC, control=3.0, q_mAh=-1.0, dq_mAh=-1.0),
        ]
        with tempfile.TemporaryDirectory() as temp:
            path = write_gcpl_mpr(Path(temp) / "cv-discharge.mpr", rows)
            with self.assertRaises(UnsupportedBiologicGcplError):
                parsing.parse_timeseries(path)

    def test_half_cycle_formula_and_capacity_reset_are_deterministic(self) -> None:
        rows = [
            _row(0.0, half_cycle=0, ns_changed=True),
            _row(1.0, half_cycle=0, q_mAh=1.0, dq_mAh=1.0),
            _row(2.0, half_cycle=1, ns=2, control=-3600.0, q_mAh=0.0, ns_changed=True),
            _row(3.0, half_cycle=1, ns=2, control=-3600.0, q_mAh=-1.0, dq_mAh=-1.0),
            _row(4.0, half_cycle=2, ns=3, q_mAh=0.0, ns_changed=True),
            _row(5.0, half_cycle=2, ns=3, q_mAh=1.0, dq_mAh=1.0),
        ]
        with tempfile.TemporaryDirectory() as temp:
            path = write_gcpl_mpr(Path(temp) / "cycles.mpr", rows)
            frame = parsing.parse_timeseries(path)

        self.assertEqual(frame["cycle"].tolist(), [1, 1, 1, 1, 2, 2])
        np.testing.assert_allclose(frame["charge_capacity_mah"], [0.0, 1.0, 0.0, 0.0, 0.0, 1.0])
        np.testing.assert_allclose(frame["discharge_capacity_mah"], [0.0, 0.0, 0.0, 1.0, 0.0, 0.0])

    def test_calc_per_cycle_consumes_canonical_frame_without_biologic_branch(self) -> None:
        rows = [
            _row(0.0, ns_changed=True),
            _row(1.0, q_mAh=1.0, dq_mAh=1.0),
            _row(2.0, ns=2, half_cycle=1, control=-3600.0, q_mAh=1.0, ns_changed=True),
            _row(3.0, ns=2, half_cycle=1, control=-3600.0, q_mAh=0.0, dq_mAh=-1.0),
        ]
        with tempfile.TemporaryDirectory() as temp:
            path = write_gcpl_mpr(Path(temp) / "calc.mpr", rows)
            frame = parsing.parse_timeseries(path)
        cycles = calc.per_cycle(frame)
        self.assertEqual(cycles["cycle"].tolist(), [1])
        self.assertEqual(cycles.loc[0, "charge_capacity_mah"], 1.0)
        self.assertEqual(cycles.loc[0, "discharge_capacity_mah"], 1.0)
        self.assertEqual(cycles.loc[0, "coulombic_efficiency_pct"], 100.0)
        self.assertTrue(np.isnan(cycles.loc[0, "charge_energy_mwh"]))
        self.assertTrue(np.isnan(cycles.loc[0, "discharge_energy_mwh"]))

    def test_integration_cross_check_is_diagnostic_only(self) -> None:
        rows = [
            _row(0.0, ns_changed=True),
            _row(1.0, q_mAh=1.0, dq_mAh=1.0),
        ]
        with tempfile.TemporaryDirectory() as temp:
            path = write_gcpl_mpr(Path(temp) / "integration.mpr", rows)
            frame = parsing.parse_timeseries(path)
        integrated = integrate_capacity_by_step(frame)
        self.assertAlmostEqual(integrated[1], 1.0, places=9)
        self.assertAlmostEqual(frame["charge_capacity_mah"].iloc[-1], 1.0, places=9)
        self.assertNotIn("charge_energy_mwh", frame.columns)

    def test_explicit_step_time_reset_is_a_boundary_when_available(self) -> None:
        dtype = np.dtype(MPR_RECORD_DTYPE.descr + [("raw_step_time_s", "<f8")])
        records = np.zeros(3, dtype=dtype)
        records["raw_flags"] = [0x21, 0x01, 0x01]
        records["raw_sample_index"] = [1, 1, 1]
        records["elapsed_time_s"] = [10.0, 11.0, 12.0]
        records["raw_dq_mAh"] = [0.0, 1.0, 1.0]
        records["raw_control_v_or_mA"] = [3600.0, 3600.0, 3600.0]
        records["raw_ewe_v"] = [3.5, 3.5, 3.5]
        records["raw_ece_v"] = [0.0, 0.0, 0.0]
        records["raw_q_charge_discharge_mAh"] = [0.0, 1.0, 2.0]
        records["raw_half_cycle_index"] = [0, 0, 0]
        records["raw_step_time_s"] = [0.0, 1.0, 0.0]
        frame = map_gcpl_to_canonical(records)
        self.assertEqual(frame["step"].tolist(), [1, 1, 2])
        self.assertEqual(frame["step_index"].tolist(), [1, 1, 1])

    def test_invalid_total_time_is_rejected_before_canonical_validation(self) -> None:
        rows = [_row(0.0, ns_changed=True), _row(-1.0)]
        with tempfile.TemporaryDirectory() as temp:
            path = write_gcpl_mpr(Path(temp) / "time.mpr", rows)
            with self.assertRaises(InvalidBiologicGcplError):
                parsing.parse_timeseries(path)


if __name__ == "__main__":
    unittest.main()
