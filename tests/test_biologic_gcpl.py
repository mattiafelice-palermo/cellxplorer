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
from backend.app.services.biologic_mpr import MPR_RECORD_DTYPE
from tests.biologic_mpr_fixture import (
    encode_gcpl_records,
    encode_gcpl_settings,
    write_gcpl_mpr,
)


def _row(
    time_s: float,
    *,
    cycle: int = 1,
    mode: int = MPR_MODE_GALVANOSTATIC,
    ns: int = 0,
    half_cycle: int = 0,
    control: float = 3600.0,
    q_mAh: float = 0.0,
    dq_mAh: float = 0.0,
    ewe_v: float = 3.5,
    ece_v: float = 0.0,
    voltage_v: float | None = None,
    measured_current_ma: float | None = None,
    ns_changed: bool = False,
    counter_incremented: bool = False,
) -> dict[str, object]:
    return {
        "total_time_s": time_s,
        "cycle": cycle,
        "mode": mode,
        "ns": ns,
        "half_cycle": half_cycle,
        "control": control,
        "q_mAh": q_mAh,
        "raw_dq_mAh": dq_mAh,
        "ewe_v": ewe_v,
        "ece_v": ece_v,
        "voltage_v": ewe_v - ece_v if voltage_v is None else voltage_v,
        "measured_current_ma": control if measured_current_ma is None else measured_current_ma,
        "ns_changed": ns_changed,
        "counter_incremented": counter_incremented,
    }


def _structured_records(
    rows: list[dict[str, object]],
    *,
    dedicated_current: bool = False,
    direct_voltage: bool = True,
    step_time: bool = False,
) -> np.ndarray:
    """Build byte-backed records plus test-only semantic fields at the mapper boundary."""

    extra = [("raw_cycle_index", "<i8")]
    if direct_voltage:
        extra.append(("raw_voltage_v", "<f8"))
    if dedicated_current:
        extra.append(("raw_current_ma", "<f8"))
    if step_time:
        extra.append(("raw_step_time_s", "<f8"))
    dtype = np.dtype(MPR_RECORD_DTYPE.descr + extra)
    base = np.frombuffer(encode_gcpl_records(rows), dtype=MPR_RECORD_DTYPE)
    records = np.zeros(len(rows), dtype=dtype)
    for name in MPR_RECORD_DTYPE.names or ():
        records[name] = base[name]
    records["raw_cycle_index"] = [int(row.get("cycle", 1)) for row in rows]
    if direct_voltage:
        records["raw_voltage_v"] = [
            float(row.get("voltage_v", row.get("ewe_v", 3.5))) for row in rows
        ]
    if dedicated_current:
        records["raw_current_ma"] = [
            float(row.get("measured_current_ma", row.get("control", 0.0))) for row in rows
        ]
    if step_time:
        records["raw_step_time_s"] = [float(row.get("step_time_s", 0.0)) for row in rows]
    return records


def _map_rows(
    rows: list[dict[str, object]],
    *,
    dedicated_current: bool = False,
    direct_voltage: bool = True,
    step_time: bool = False,
):
    return map_gcpl_to_canonical(
        _structured_records(
            rows,
            dedicated_current=dedicated_current,
            direct_voltage=direct_voltage,
            step_time=step_time,
        )
    )


class BiologicGcplMappingTests(unittest.TestCase):
    def test_direct_identity_is_registered_without_user_extension_admission(self) -> None:
        self.assertEqual(parsing.recognize_source("source.mpr"), parsing.FORMAT_BIOLOGIC_MPR)
        self.assertEqual(
            parsing.source_parser_descriptor("source.mpr"),
            {
                "format_id": parsing.FORMAT_BIOLOGIC_MPR,
                "adapter_revision": "gcpl2",
                "canonical_raw_version": canonical_cycling.CANONICAL_RAW_VERSION,
            },
        )
        self.assertEqual(parsing.parser_identity("source.mpr"), "bm:gcpl2:r1")
        self.assertTrue(parsing.source_filename_allowed("source.mpr"))

    def test_direct_mpr_dispatch_defers_unresolved_cycle_and_three_electrode_voltage(self) -> None:
        rows = [
            _row(0.0, ns_changed=True),
            _row(1.0, q_mAh=1.0, dq_mAh=1.0),
            _row(2.0, mode=MPR_MODE_REST, ns=1, control=0.0, q_mAh=1.0, ns_changed=True),
            _row(3.0, mode=MPR_MODE_REST, ns=1, control=0.0, q_mAh=1.0),
            _row(
                4.0,
                ns=2,
                half_cycle=0,
                control=-3600.0,
                q_mAh=1.0,
                ns_changed=True,
            ),
            _row(5.0, ns=2, half_cycle=0, control=-3600.0, q_mAh=0.0, dq_mAh=-1.0),
        ]
        with tempfile.TemporaryDirectory() as temp:
            path = write_gcpl_mpr(
                Path(temp) / "fixture.mpr",
                rows,
                settings_payload=encode_gcpl_settings(
                    [
                        {"set_i_c": 0, "current": 1.0},
                        {"set_i_c": 0, "current": 1.0},
                        {"set_i_c": 0, "current": -1.0},
                    ]
                ),
            )
            with self.assertRaisesRegex(UnsupportedBiologicGcplError, "cycle identity"):
                parsing.parse_timeseries(path)

        frame = _map_rows(rows)

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
                "working_potential_v",
                "counter_potential_v",
                "timestamp",
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
        np.testing.assert_allclose(frame["working_potential_v"], 3.5)
        np.testing.assert_allclose(frame["counter_potential_v"], 0.0)
        self.assertFalse(frame.attrs["biologic_gcpl"]["voltage_v_derived"])

    def test_full_mpr_mapping_rejects_observed_ns_outside_declared_settings(self) -> None:
        rows = [_row(0.0, ns=2, ns_changed=True)]
        with tempfile.TemporaryDirectory() as temp:
            path = write_gcpl_mpr(
                Path(temp) / "undeclared-ns.mpr",
                rows,
                settings_payload=encode_gcpl_settings(
                    [{"set_i_c": 0, "current": 1.0}]
                ),
            )
            with self.assertRaisesRegex(UnsupportedBiologicGcplError, "not declared"):
                parsing.parse_timeseries(path)

    def test_synchronized_ewe_ece_are_subtracted_with_the_verified_sign(self) -> None:
        rows = [
            _row(0.0, ewe_v=1.2, ece_v=0.2, ns_changed=True),
            _row(1.0, ewe_v=1.0, ece_v=-0.5, q_mAh=1.0, dq_mAh=1.0),
        ]
        frame = _map_rows(rows, direct_voltage=False)
        np.testing.assert_allclose(frame["working_potential_v"], [1.2, 1.0])
        np.testing.assert_allclose(frame["counter_potential_v"], [0.2, -0.5])
        np.testing.assert_allclose(frame["voltage_v"], [1.0, 1.5])
        self.assertTrue(frame.attrs["biologic_gcpl"]["voltage_v_derived"])
        self.assertEqual(
            frame.attrs["biologic_gcpl"]["voltage_v_origin"],
            "derived_working_minus_counter",
        )

    def test_absolute_timestamps_are_acquisition_start_plus_total_time(self) -> None:
        rows = [
            _row(0.0, ns_changed=True),
            _row(2.5, q_mAh=1.0, dq_mAh=1.0),
        ]
        frame = map_gcpl_to_canonical(
            _structured_records(rows),
            acquisition_start="2026-07-10T14:41:20.744000",
        )
        self.assertEqual(
            frame["timestamp"].astype(str).tolist(),
            ["2026-07-10 14:41:20.744", "2026-07-10 14:41:23.244"],
        )
        self.assertTrue(frame.attrs["biologic_gcpl"]["absolute_timestamps"])

    def test_two_electrode_direct_voltage_does_not_require_auxiliary_fields(self) -> None:
        full = _structured_records(
            [_row(0.0, ns_changed=True), _row(1.0, q_mAh=1.0, dq_mAh=1.0)]
        )
        keep = [
            name
            for name in full.dtype.names or ()
            if name not in {"raw_ewe_v", "raw_ece_v"}
        ]
        two_dtype = np.dtype([(name, full.dtype.fields[name][0]) for name in keep])
        two = np.zeros(len(full), dtype=two_dtype)
        for name in keep:
            two[name] = full[name]
        frame = map_gcpl_to_canonical(two)
        self.assertNotIn("working_potential_v", frame.columns)
        self.assertNotIn("counter_potential_v", frame.columns)
        np.testing.assert_allclose(frame["voltage_v"], 3.5)

    def test_two_electrode_ewe_primary_voltage_does_not_publish_fake_auxiliary_fields(self) -> None:
        full = _structured_records(
            [_row(0.0, ns_changed=True), _row(1.0, q_mAh=1.0, dq_mAh=1.0)],
            direct_voltage=False,
        )
        keep = [name for name in full.dtype.names or () if name != "raw_ece_v"]
        two_dtype = np.dtype([(name, full.dtype.fields[name][0]) for name in keep])
        two = np.zeros(len(full), dtype=two_dtype)
        for name in keep:
            two[name] = full[name]
        frame = map_gcpl_to_canonical(two)
        self.assertNotIn("working_potential_v", frame.columns)
        self.assertNotIn("counter_potential_v", frame.columns)
        np.testing.assert_allclose(frame["voltage_v"], 3.5)
        self.assertEqual(frame.attrs["biologic_gcpl"]["voltage_v_origin"], "measured")

    def test_programmed_sequence_is_preserved_and_repeated_execution_gets_new_step(self) -> None:
        rows = [
            _row(0.0, ns=0, ns_changed=True),
            _row(1.0, ns=1, half_cycle=0, control=-3600.0, ns_changed=True),
            _row(2.0, ns=0, half_cycle=0, ns_changed=True),
        ]
        frame = _map_rows(rows)

        self.assertEqual(frame["step_index"].tolist(), [1, 2, 1])
        self.assertEqual(frame["step"].tolist(), [1, 2, 3])
        self.assertEqual(frame["cycle"].tolist(), [1, 1, 1])

    def test_explicit_cycle_field_is_copied_without_invention(self) -> None:
        rows = [
            _row(0.0, cycle=4, ns_changed=True),
            _row(1.0, cycle=4, q_mAh=1.0, dq_mAh=1.0),
        ]
        frame = _map_rows(rows)
        self.assertEqual(frame["cycle"].tolist(), [4, 4])

    def test_cycle_regression_fails_closed(self) -> None:
        rows = [
            _row(0.0, cycle=2, ns_changed=True),
            _row(1.0, cycle=1, q_mAh=1.0, dq_mAh=1.0),
        ]
        with self.assertRaisesRegex(UnsupportedBiologicGcplError, "regresses or resets"):
            _map_rows(rows)

    def test_cycle_transition_starts_a_new_executed_step(self) -> None:
        rows = [
            _row(0.0, cycle=1, ns_changed=True),
            _row(1.0, cycle=1, q_mAh=1.0, dq_mAh=1.0),
            _row(2.0, cycle=2, q_mAh=1.0),
        ]
        frame = _map_rows(rows)
        self.assertEqual(frame["cycle"].tolist(), [1, 1, 2])
        self.assertEqual(frame["step"].tolist(), [1, 1, 2])

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
                measured_current_ma=3600.0,
            ),
        ]
        frame = _map_rows(rows, dedicated_current=True)

        self.assertEqual(frame["step"].tolist(), [1, 1, 1])
        self.assertEqual(frame["status"].unique().tolist(), ["CCCV_Chg"])
        np.testing.assert_allclose(frame["current_ma"], [3600.0, 3600.0, 3600.0])
        np.testing.assert_allclose(frame["charge_capacity_mah"], [0.0, 1.0, 2.0])

    def test_ambiguous_mixed_direction_fails_closed(self) -> None:
        rows = [
            _row(0.0, ns_changed=True),
            _row(1.0, control=-3600.0, q_mAh=-1.0, dq_mAh=-1.0),
        ]
        with self.assertRaises(InvalidBiologicGcplError):
            _map_rows(rows)

    def test_zero_current_active_block_fails_closed(self) -> None:
        rows = [
            _row(0.0, control=0.0, ns_changed=True),
            _row(1.0, control=0.0, q_mAh=1.0, dq_mAh=1.0),
        ]
        with self.assertRaises(InvalidBiologicGcplError):
            _map_rows(rows)

    def test_capacity_transfer_during_rest_fails_closed(self) -> None:
        rows = [
            _row(0.0, mode=MPR_MODE_REST, control=0.0, ns_changed=True),
            _row(1.0, mode=MPR_MODE_REST, control=0.0, q_mAh=1.0, dq_mAh=1.0),
        ]
        with self.assertRaises(InvalidBiologicGcplError):
            _map_rows(rows)

    def test_nonzero_dedicated_current_during_rest_is_invalid(self) -> None:
        rows = [
            _row(
                0.0,
                mode=MPR_MODE_REST,
                control=0.0,
                measured_current_ma=1.0,
                ns_changed=True,
            ),
            _row(
                1.0,
                mode=MPR_MODE_REST,
                control=0.0,
                measured_current_ma=1.0,
            ),
        ]
        with self.assertRaises(InvalidBiologicGcplError):
            _map_rows(rows, dedicated_current=True)

    def test_current_capacity_and_incremental_signs_must_agree(self) -> None:
        rows = [
            _row(0.0, control=3600.0, ns_changed=True),
            _row(1.0, control=3600.0, q_mAh=1.0, dq_mAh=-1.0),
        ]
        with self.assertRaises(InvalidBiologicGcplError):
            _map_rows(rows)

    def test_capacity_transfer_at_step_boundary_fails_closed(self) -> None:
        rows = [
            _row(0.0, ns=0, ns_changed=True),
            _row(1.0, ns=1, ns_changed=True, q_mAh=1.0, dq_mAh=1.0),
        ]
        with self.assertRaises(UnsupportedBiologicGcplError):
            _map_rows(rows)

    def test_unexplained_ns_changed_flag_fails_closed(self) -> None:
        rows = [
            _row(0.0, ns=0, ns_changed=True),
            _row(1.0, ns=0, ns_changed=True, q_mAh=1.0, dq_mAh=1.0),
        ]
        with self.assertRaisesRegex(UnsupportedBiologicGcplError, "Ns-change flag"):
            _map_rows(rows)

    def test_nonfinite_dedicated_current_is_invalid_source_data(self) -> None:
        rows = [
            _row(0.0, ns_changed=True),
            _row(1.0, q_mAh=1.0, dq_mAh=1.0),
        ]
        records = _structured_records(rows, dedicated_current=True)
        records["raw_current_ma"][1] = np.nan
        with self.assertRaises(InvalidBiologicGcplError):
            map_gcpl_to_canonical(records)

    def test_reversed_cv_to_cc_control_history_fails_closed(self) -> None:
        rows = [
            _row(
                0.0,
                mode=MPR_MODE_POTENTIOSTATIC,
                control=3.7,
                measured_current_ma=3600.0,
                ns_changed=True,
            ),
            _row(
                1.0,
                mode=MPR_MODE_POTENTIOSTATIC,
                control=3.7,
                measured_current_ma=3600.0,
                q_mAh=1.0,
                dq_mAh=1.0,
            ),
            _row(2.0, control=3600.0, q_mAh=2.0, dq_mAh=1.0, measured_current_ma=3600.0),
        ]
        with self.assertRaises(UnsupportedBiologicGcplError):
            _map_rows(rows, dedicated_current=True)

    def test_reentering_cc_after_cv_control_history_fails_closed(self) -> None:
        rows = [
            _row(0.0, control=3600.0, measured_current_ma=3600.0, ns_changed=True),
            _row(1.0, control=3600.0, measured_current_ma=3600.0, q_mAh=1.0, dq_mAh=1.0),
            _row(
                2.0,
                mode=MPR_MODE_POTENTIOSTATIC,
                control=3.7,
                measured_current_ma=3600.0,
                q_mAh=2.0,
                dq_mAh=1.0,
            ),
            _row(3.0, control=3600.0, q_mAh=3.0, dq_mAh=1.0, measured_current_ma=3600.0),
        ]
        with self.assertRaises(UnsupportedBiologicGcplError):
            _map_rows(rows, dedicated_current=True)

    def test_capacity_counter_decrease_within_step_fails_closed(self) -> None:
        rows = [
            _row(0.0, ns_changed=True),
            _row(1.0, q_mAh=2.0, dq_mAh=2.0),
            _row(2.0, q_mAh=1.0, dq_mAh=1.0),
        ]
        with self.assertRaises(InvalidBiologicGcplError):
            _map_rows(rows)

    def test_capacity_counter_reset_to_baseline_within_step_fails_closed(self) -> None:
        rows = [
            _row(0.0, ns_changed=True),
            _row(1.0, q_mAh=1.0, dq_mAh=1.0),
            _row(2.0, q_mAh=0.0, dq_mAh=1.0),
        ]
        with self.assertRaises(InvalidBiologicGcplError):
            _map_rows(rows)

    def test_counter_increment_flag_is_not_assumed_irrelevant_to_cycle(self) -> None:
        rows = [
            _row(0.0, ns_changed=True, counter_incremented=True),
            _row(1.0, q_mAh=1.0, dq_mAh=1.0),
        ]
        with self.assertRaisesRegex(UnsupportedBiologicGcplError, "counter-increment"):
            _map_rows(rows)

    def test_dedicated_current_is_preserved_instead_of_using_control_setpoint(self) -> None:
        rows = [
            _row(0.0, control=1000.0, measured_current_ma=2000.0, ns_changed=True),
            _row(1.0, control=1000.0, measured_current_ma=2000.0, q_mAh=2.0, dq_mAh=2.0),
        ]
        frame = _map_rows(rows, dedicated_current=True)
        np.testing.assert_allclose(frame["current_ma"], [2000.0, 2000.0])

    def test_error_flag_fails_closed(self) -> None:
        rows = [
            _row(0.0, ns_changed=True),
            {**_row(1.0, q_mAh=1.0, dq_mAh=1.0), "error": True},
        ]
        with self.assertRaises(InvalidBiologicGcplError):
            _map_rows(rows)

    def test_standalone_cv_discharge_is_not_mislabelled(self) -> None:
        rows = [
            _row(
                0.0,
                mode=MPR_MODE_POTENTIOSTATIC,
                control=3.0,
                measured_current_ma=-3600.0,
                ns_changed=True,
            ),
            _row(
                1.0,
                mode=MPR_MODE_POTENTIOSTATIC,
                control=3.0,
                q_mAh=-1.0,
                dq_mAh=-1.0,
                measured_current_ma=-3600.0,
            ),
        ]
        with self.assertRaises(UnsupportedBiologicGcplError):
            _map_rows(rows, dedicated_current=True)

    def test_potentiostatic_rows_require_measured_current(self) -> None:
        rows = [
            _row(0.0, mode=MPR_MODE_POTENTIOSTATIC, control=3.0, ns_changed=True),
            _row(1.0, mode=MPR_MODE_POTENTIOSTATIC, control=3.0, q_mAh=1.0, dq_mAh=1.0),
        ]
        with self.assertRaisesRegex(UnsupportedBiologicGcplError, "measured-current"):
            _map_rows(rows)

    def test_unvalidated_half_cycle_progression_fails_closed(self) -> None:
        rows = [
            _row(0.0, half_cycle=0, ns_changed=True),
            _row(1.0, half_cycle=0, q_mAh=1.0, dq_mAh=1.0),
            _row(2.0, half_cycle=1, ns=1, control=-3600.0, q_mAh=0.0, ns_changed=True),
            _row(3.0, half_cycle=1, ns=1, control=-3600.0, q_mAh=-1.0, dq_mAh=-1.0),
            _row(4.0, half_cycle=2, ns=2, q_mAh=0.0, ns_changed=True),
            _row(5.0, half_cycle=2, ns=2, q_mAh=1.0, dq_mAh=1.0),
        ]
        with self.assertRaises(UnsupportedBiologicGcplError):
            _map_rows(rows)

    def test_half_cycle_regression_or_reset_fails_closed(self) -> None:
        rows = [
            _row(0.0, half_cycle=0, ns_changed=True),
            _row(1.0, half_cycle=1, q_mAh=1.0, dq_mAh=1.0),
            _row(2.0, half_cycle=0, ns=1, q_mAh=2.0, dq_mAh=1.0, ns_changed=True),
        ]
        with self.assertRaisesRegex(UnsupportedBiologicGcplError, "regresses or resets"):
            _map_rows(rows)

    def test_calc_per_cycle_consumes_canonical_frame_without_biologic_branch(self) -> None:
        rows = [
            _row(0.0, ns_changed=True, voltage_v=3.5),
            _row(1.0, voltage_v=3.7, q_mAh=1.0, dq_mAh=1.0),
            _row(2.0, mode=MPR_MODE_POTENTIOSTATIC, voltage_v=3.7, control=3.7, q_mAh=1.8, dq_mAh=0.8, measured_current_ma=3500.0),
            _row(3.0, mode=MPR_MODE_POTENTIOSTATIC, voltage_v=3.7, control=3.7, q_mAh=2.8, dq_mAh=1.0, measured_current_ma=3000.0),
            _row(4.0, ns=1, control=-3600.0, voltage_v=3.7, q_mAh=2.8, ns_changed=True),
            _row(5.0, ns=1, control=-3600.0, voltage_v=3.4, q_mAh=1.8, dq_mAh=-1.0),
            _row(6.0, ns=1, control=-3600.0, voltage_v=3.0, q_mAh=0.0, dq_mAh=-1.8),
        ]
        frame = _map_rows(rows, dedicated_current=True)
        cycles = calc.per_cycle(frame)
        self.assertEqual(cycles["cycle"].tolist(), [1])
        self.assertAlmostEqual(cycles.loc[0, "charge_capacity_mah"], 2.8)
        self.assertAlmostEqual(cycles.loc[0, "discharge_capacity_mah"], 2.8)
        self.assertEqual(cycles.loc[0, "coulombic_efficiency_pct"], 100.0)
        self.assertAlmostEqual(cycles.loc[0, "charge_time_h"], 3.0 / 3600.0)
        self.assertAlmostEqual(cycles.loc[0, "discharge_time_h"], 2.0 / 3600.0)
        self.assertAlmostEqual(cycles.loc[0, "mean_charge_voltage_v"], (3.5 + 3.7 + 3.7 + 3.7) / 4.0)
        self.assertAlmostEqual(cycles.loc[0, "first_charge_voltage_v"], 3.5)
        self.assertAlmostEqual(cycles.loc[0, "last_charge_voltage_v"], 3.7)
        self.assertAlmostEqual(cycles.loc[0, "mean_discharge_voltage_v"], (3.7 + 3.4 + 3.0) / 3.0)
        self.assertAlmostEqual(cycles.loc[0, "first_discharge_voltage_v"], 3.7)
        self.assertAlmostEqual(cycles.loc[0, "last_discharge_voltage_v"], 3.0)
        self.assertAlmostEqual(cycles.loc[0, "cv_charge_time_h"], 2.0 / 3600.0)
        self.assertAlmostEqual(cycles.loc[0, "cv_charge_capacity_mah"], 1.8)
        self.assertAlmostEqual(cycles.loc[0, "cv_charge_fraction_pct"], 1.8 / 2.8 * 100.0)
        self.assertEqual(cycles.loc[0, "cv_charge_event_count"], 1.0)
        self.assertEqual(cycles.loc[0, "cv_reached"], 1.0)
        self.assertTrue(np.isnan(cycles.loc[0, "cycle_duration_h"]))
        self.assertTrue(np.isnan(cycles.loc[0, "charge_energy_mwh"]))
        self.assertTrue(np.isnan(cycles.loc[0, "discharge_energy_mwh"]))

        malformed = frame.copy()
        malformed.loc[1, "step_index"] = 2
        with self.assertRaises(canonical_cycling.CanonicalCyclingError):
            canonical_cycling.validate_raw_timeseries(malformed)

    def test_integration_cross_check_is_diagnostic_only(self) -> None:
        rows = [
            _row(0.0, ns_changed=True),
            _row(1.0, q_mAh=1.0, dq_mAh=1.0),
        ]
        frame = _map_rows(rows)
        integrated = integrate_capacity_by_step(frame)
        self.assertAlmostEqual(integrated[1], 1.0, places=9)
        self.assertAlmostEqual(frame["charge_capacity_mah"].iloc[-1], 1.0, places=9)
        self.assertNotIn("charge_energy_mwh", frame.columns)

    def test_explicit_step_time_reset_is_a_boundary_when_available(self) -> None:
        dtype = np.dtype(
            MPR_RECORD_DTYPE.descr
            + [
                ("raw_cycle_index", "<i8"),
                ("raw_voltage_v", "<f8"),
                ("raw_step_time_s", "<f8"),
            ]
        )
        records = np.zeros(3, dtype=dtype)
        records["raw_cycle_index"] = [1, 1, 1]
        records["raw_flags"] = [0x21, 0x01, 0x01]
        records["raw_sample_index"] = [0, 0, 0]
        records["elapsed_time_s"] = [10.0, 11.0, 12.0]
        records["raw_dq_mAh"] = [0.0, 1.0, 0.0]
        records["raw_control_v_or_mA"] = [3600.0, 3600.0, 3600.0]
        records["raw_ewe_v"] = [3.5, 3.5, 3.5]
        records["raw_ece_v"] = [0.0, 0.0, 0.0]
        records["raw_voltage_v"] = [3.5, 3.5, 3.5]
        records["raw_q_charge_discharge_mAh"] = [0.0, 1.0, 1.0]
        records["raw_half_cycle_index"] = [0, 0, 0]
        records["raw_step_time_s"] = [0.0, 1.0, 0.0]
        frame = map_gcpl_to_canonical(records)
        self.assertEqual(frame["step"].tolist(), [1, 1, 2])
        self.assertEqual(frame["step_index"].tolist(), [1, 1, 1])

    def test_explicit_step_time_is_published_instead_of_rederived(self) -> None:
        rows = [
            {**_row(10.0, ns_changed=True), "step_time_s": 5.0},
            {**_row(20.0, q_mAh=1.0, dq_mAh=1.0), "step_time_s": 6.0},
            {**_row(30.0, q_mAh=1.0), "step_time_s": 0.0},
        ]
        frame = _map_rows(rows, step_time=True)
        np.testing.assert_allclose(frame["time_s"], [5.0, 6.0, 0.0])
        self.assertEqual(frame["step"].tolist(), [1, 1, 2])

    def test_explicit_step_time_must_reset_at_non_time_step_boundary(self) -> None:
        rows = [
            {**_row(0.0, ns=0, ns_changed=True), "step_time_s": 0.0},
            {**_row(1.0, ns=0, q_mAh=1.0, dq_mAh=1.0), "step_time_s": 1.0},
            {**_row(2.0, ns=1, q_mAh=1.0, ns_changed=True), "step_time_s": 2.0},
        ]
        with self.assertRaisesRegex(InvalidBiologicGcplError, "does not reset"):
            _map_rows(rows, step_time=True)

    def test_invalid_single_row_step_time_is_rejected(self) -> None:
        records = _structured_records(
            [_row(0.0, ns_changed=True)],
            step_time=True,
        )
        records["raw_step_time_s"][0] = -1.0
        with self.assertRaises(InvalidBiologicGcplError):
            map_gcpl_to_canonical(records)

    def test_invalid_total_time_is_rejected_before_canonical_validation(self) -> None:
        rows = [_row(0.0, ns_changed=True), _row(-1.0)]
        with self.assertRaises(InvalidBiologicGcplError):
            _map_rows(rows)


if __name__ == "__main__":
    unittest.main()
