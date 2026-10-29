"""Independent byte fixtures for repeated GCPL source/Cell scientific identity."""
from __future__ import annotations

from copy import deepcopy
import os
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import pandas as pd

os.environ.setdefault("CELLXPLORER_DATA", str(Path(__file__).resolve().parents[1] / ".test-cellxplorer"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from app.services import biologic_gcpl as gcpl, biologic_gcpl_executions as executions
from app.services import cache, calc, canonical_cycling, continuation_preview, parsing, stitch, time_capacity_path
from tests.biologic_mpr_fixture import encode_gcpl_log, encode_gcpl_settings, write_gcpl_mpr


def repeated_rows(direction: int, *, repeats: int = 3, offset: float = 0.0) -> list[dict]:
    rows = []
    counter = 0.0
    for execution in range(repeats):
        start = offset + execution * 400
        duration = 15.0 if direction < 0 and execution == 0 else 48.0 if direction < 0 and execution == repeats - 1 else 60.0
        transfer = direction * duration / 60.0
        for index, fraction in enumerate((0.0, 0.5, 1.0)):
            rows.append({"ns": 1, "mode": 1, "control": direction * 60.0,
                         "total_time_s": start + duration * fraction,
                         "q_mAh": counter + transfer * fraction,
                         "raw_dq_mAh": 0.0 if index == 0 else transfer / 2,
                         "half_cycle": 0, "ns_changed": index == 0,
                         "control_changed": index == 0,
                         "ewe_v": 3.0 + 0.1 * fraction, "ece_v": 0.1})
        counter += transfer
        for rest_time in (duration + 0.001, duration + 30.0, duration + 60.0):
            rows.append({"ns": 1, "mode": 3, "control": 0.0,
                         "total_time_s": start + rest_time, "q_mAh": counter,
                         "raw_dq_mAh": 0.0, "half_cycle": 0, "ns_changed": False,
                         "ewe_v": 3.1, "ece_v": 0.1})
    return rows


def repeated_settings(direction: int) -> bytes:
    return encode_gcpl_settings([
        {"current": 0.0, "rest_interval_s": 1.0},
        {"current": direction * 60.0, "t1_s": 60.0, "record_interval_s": 30.0,
         "rest_duration_s": 60.0, "rest_interval_s": 30.0},
        {"current": 0.0, "hold_duration_s": 60.0, "rest_interval_s": 30.0},
    ])


def interrupted_rows(direction: int = -1) -> list[dict]:
    """A two-record first phase interrupted before any neutral rest record."""
    rows = repeated_rows(direction)
    removed_transfer = rows[2]["q_mAh"] - rows[1]["q_mAh"]
    tail = deepcopy(rows[6:])
    for row in tail:
        row["q_mAh"] -= removed_transfer
    return [*deepcopy(rows[:2]), *tail]


def write_repeated(path: Path, direction: int, *, rows=None, **log) -> Path:
    return write_gcpl_mpr(path, repeated_rows(direction, offset=200.0 if direction > 0 else 0.0) if rows is None else rows,
                          settings_payload=repeated_settings(direction), include_log=True,
                          log_payload=encode_gcpl_log(ec_lab_version="11.72", **log))


class RepeatedGcplTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="cellxplorer-gcpl-executions-")
        self.root = Path(self.temp.name)
        self.discharge = write_repeated(self.root / "discharge.mpr", -1)
        self.charge = write_repeated(self.root / "charge.mpr", 1)
        self.frames = [parsing.parse_timeseries(path) for path in (self.discharge, self.charge)]

    def tearDown(self):
        from app.services import source_readability

        source_readability.clear()
        self.temp.cleanup()

    def combine(self, frames=None):
        return executions.combine_pair(self.frames if frames is None else frames)

    def test_source_executions_are_not_full_cycles(self):
        for frame in self.frames:
            canonical_cycling.validate_raw_timeseries(frame)
            self.assertEqual(frame["cycle"].unique().tolist(), [1, 2, 3])
            self.assertEqual(frame["step_index"].unique().tolist(), [2])
            self.assertEqual(frame["step"].nunique(), 6)
            self.assertEqual(frame.groupby("step")["time_s"].first().tolist(), [0.0] * 6)
            self.assertFalse(frame["cycle_complete"].any())
            self.assertTrue(calc.per_cycle(frame).empty)
            self.assertEqual(frame.attrs["biologic_gcpl"]["cycle_source"], "verified_repeated_executions")

    def test_charge_then_following_discharge_preserves_partial_halves_and_exact_ce(self):
        merged, segments, count = self.combine()
        self.assertEqual(count, 2)
        self.assertEqual(len(merged), sum(map(len, self.frames)))
        cycles = calc.per_cycle(merged)
        np.testing.assert_allclose(cycles["charge_capacity_mah"], [1.0, 1.0], rtol=0, atol=1e-12)
        np.testing.assert_allclose(cycles["discharge_capacity_mah"], [1.0, 0.8], rtol=0, atol=1e-12)
        np.testing.assert_allclose(cycles["coulombic_efficiency_pct"], [100.0, 80.0], rtol=0, atol=1e-12)
        self.assertTrue(merged["total_time_s"].is_monotonic_increasing)
        self.assertEqual(segments[0]["display_only_source_cycles"], [1])
        self.assertEqual(segments[1]["display_only_source_cycles"], [3])
        for segment, original in enumerate(self.frames):
            restored = merged[merged["segment"] == segment].sort_values("record_index")
            for column in ("record_index", "timestamp", "total_time_s", "current_ma", "voltage_v", "charge_capacity_mah", "discharge_capacity_mah"):
                np.testing.assert_array_equal(restored[column], original[column], err_msg=column)

    def test_reversed_source_order_does_not_change_science(self):
        forward = calc.per_cycle(self.combine()[0])
        reverse = calc.per_cycle(self.combine(list(reversed(self.frames)))[0])
        pd.testing.assert_frame_equal(forward, reverse, check_exact=True)

    def test_marker_and_gap_negative_cases(self):
        base = repeated_rows(-1)
        cases = {}
        cases["inside active"] = deepcopy(base); cases["inside active"][1]["ns_changed"] = True
        cases["inside rest"] = deepcopy(base); cases["inside rest"][4]["ns_changed"] = True
        cases["missing one return"] = deepcopy(base); cases["missing one return"][6]["ns_changed"] = False
        cases["missing all returns"] = deepcopy(base)
        for row in cases["missing all returns"][1:]: row["ns_changed"] = False
        cases["hidden active gap"] = deepcopy(base); cases["hidden active gap"][1]["total_time_s"] = 35.0
        cases["nonmonotonic"] = deepcopy(base); cases["nonmonotonic"][1]["total_time_s"] = -1.0
        cases["instrument error"] = deepcopy(base); cases["instrument error"][1]["error"] = True
        cases["wrong polarity"] = deepcopy(base); cases["wrong polarity"][1]["control"] = 60.0
        cases["counter jump"] = deepcopy(base); cases["counter jump"][6]["q_mAh"] -= 0.01
        for label, rows in cases.items():
            with self.subTest(label=label):
                path = write_repeated(self.root / f"negative-{len(label)}-{label.replace(' ', '-')}.mpr", -1, rows=rows)
                with self.assertRaises((gcpl.UnsupportedBiologicGcplError, gcpl.InvalidBiologicGcplError)):
                    parsing.parse_timeseries(path)

    def test_interrupted_active_phase_splits_steps_without_inventing_rest(self):
        rows = interrupted_rows()
        frame = parsing.parse_timeseries(write_repeated(self.root / "interrupted.mpr", -1, rows=rows))
        canonical_cycling.validate_raw_timeseries(frame)
        self.assertEqual(len(frame), len(rows))
        self.assertEqual(frame["cycle"].unique().tolist(), [1, 2, 3])
        self.assertEqual(frame["step"].nunique(), 5)
        self.assertEqual(frame.loc[:2, "step"].tolist(), [1, 1, 2])
        self.assertEqual(frame.loc[2, "time_s"], 0.0)
        self.assertEqual(frame.loc[1, "time_s"], 7.5)
        self.assertEqual(frame[frame["cycle"] == 1]["status"].tolist(), ["CC_DChg", "CC_DChg"])
        self.assertEqual(frame.loc[2, "discharge_capacity_mah"], 0.0)
        np.testing.assert_array_equal(frame["total_time_s"], [row["total_time_s"] for row in rows])
        paired, _, count = self.combine([frame, self.frames[1]])
        self.assertEqual(count, 2)
        np.testing.assert_allclose(calc.per_cycle(paired)["coulombic_efficiency_pct"], [100.0, 80.0], rtol=0, atol=1e-12)

    def test_interrupted_restart_still_requires_every_boundary_evidence_gate(self):
        base = interrupted_rows()
        cases = {}
        cases["no execution flag"] = deepcopy(base); cases["no execution flag"][2]["ns_changed"] = False
        cases["no control flag"] = deepcopy(base); cases["no control flag"][2]["control_changed"] = False
        cases["no clock gap"] = deepcopy(base); cases["no clock gap"][2]["total_time_s"] = 8.0
        cases["counter jump"] = deepcopy(base); cases["counter jump"][2]["q_mAh"] -= 0.01
        cases["counter reset"] = deepcopy(base); cases["counter reset"][2]["q_mAh"] = 0.0
        cases["incremental transfer"] = deepcopy(base); cases["incremental transfer"][2]["raw_dq_mAh"] = -0.01
        cases["changed control"] = deepcopy(base); cases["changed control"][2]["control"] = -30.0
        cases["changed direction"] = deepcopy(base); cases["changed direction"][2]["control"] = 60.0
        cases["instrument error"] = deepcopy(base); cases["instrument error"][2]["error"] = True
        cases["unsupported mode"] = deepcopy(base); cases["unsupported mode"][2]["mode"] = 0
        cases["time regression"] = deepcopy(base); cases["time regression"][2]["total_time_s"] = -1.0
        cases["changed step"] = deepcopy(base); cases["changed step"][2]["ns"] = 2
        for label, rows in cases.items():
            with self.subTest(label=label):
                path = write_repeated(self.root / (label.replace(" ", "-") + ".mpr"), -1, rows=rows)
                with self.assertRaises((gcpl.UnsupportedBiologicGcplError, gcpl.InvalidBiologicGcplError)):
                    parsing.parse_timeseries(path)

    def test_pairing_rejects_wrong_identity_overlap_missing_phase_and_partial_projection(self):
        for field, value in (("device_serial", "other"), ("channel_serial", 999),
                             ("channel_number", 9), ("ole_timestamp", 45001.0)):
            with self.subTest(field=field):
                other = parsing.parse_timeseries(write_repeated(self.root / f"other-{field}.mpr", 1, **{field: value}))
                self.assertIsNone(self.combine([self.frames[0], other]))
        duplicate = self.frames[0].copy()
        self.assertIsNone(self.combine([self.frames[0], duplicate]))
        overlap = self.frames[1].copy()
        overlap["total_time_s"] -= 150.0
        overlap["timestamp"] -= pd.Timedelta(seconds=150)
        self.assertIsNone(self.combine([self.frames[0], overlap]))
        self.assertIsNone(executions.summary_from_frame(self.frames[0].iloc[6:]))

    def test_whole_cohort_rejects_third_fragment_in_every_order(self):
        left, right = self.frames
        for frames in ([left, right, left.copy()], [left, left.copy(), right], [right, left, left.copy()]):
            with self.subTest(order=[int(f["current_ma"].min()) for f in frames]):
                summaries = [executions.pairing_summary_from_frame(frame) for frame in frames]
                self.assertEqual(executions.eligible_pair_positions(summaries), [])
                refs = [stitch.CachedSourceRef(str(index), "fixture") for index in range(len(frames))]
                raw, _, missing = stitch._stitch_ordered(refs, lambda ref: frames[int(ref.file_hash)], sort_output=False)
                self.assertEqual(missing, [])
                self.assertTrue(calc.per_cycle(raw).empty)

    def test_summary_bounds_and_malformed_clock_refuse_pairing_not_raw_rows(self):
        with patch.object(executions, "MAX_EXECUTIONS", 2):
            self.assertIsNone(executions.summary_from_frame(self.frames[0]))
            self.assertEqual(executions.eligible_pair_positions([
                executions.pairing_summary_from_frame(frame) for frame in self.frames]), [])
        summary = executions.summary_from_frame(self.frames[0])
        summary["identity"]["acquisition_start"] = "not a timestamp"
        self.assertFalse(executions.validate_summary(summary))

    def test_cache_cycle_and_full_stitch_share_science_and_selective_falls_back(self):
        with patch.object(cache, "CACHE_DIR", self.root / "cache"):
            refs = []
            for path in (self.discharge, self.charge):
                fingerprint = parsing.capture_source_fingerprint(path)
                result = cache.build(fingerprint.hash, path, expected_fingerprint=fingerprint, prepare_time_capacity=False)
                ref = stitch.CachedSourceRef(fingerprint.hash, result["parser_version"])
                refs.append(ref)
                loaded = cache.load_raw(ref.file_hash, ref.parser_version)
                pd.testing.assert_frame_equal(loaded, self.frames[len(refs) - 1], check_exact=True)
                self.assertTrue(executions.validate_summary(cache.load_biologic_gcpl_execution_summary(ref.file_hash, ref.parser_version)))
            raw, segments, missing = stitch.stitch_raw(refs)
            cycles, cycle_segments, cycle_missing = stitch.stitch_cycles(refs, cache.CALC_VERSION)
            self.assertEqual(missing + cycle_missing, [])
            self.assertEqual(cycle_segments, segments)
            pd.testing.assert_frame_equal(cycles[calc.CYCLE_COLUMNS], calc.per_cycle(raw), check_exact=True)
            plan = time_capacity_path.build_time_capacity_stitch_plan(refs)
            self.assertNotEqual(plan.path, "indexed")
            self.assertIsNone(stitch.stitch_raw_steps(refs, {}, ["cycle"]))
            summaries = [cache.load_biologic_gcpl_execution_summary(ref.file_hash, ref.parser_version) for ref in refs]
            facts = executions.paired_capacity_totals(summaries)
            self.assertEqual(facts["count"], 2)
            self.assertAlmostEqual(facts["total_discharge_capacity_mah"], 1.8)

    def test_mixed_preview_and_analysis_display_time_do_not_reorder_phases(self):
        from app.services.analysis_engine import _continuous_time

        ordinary = pd.DataFrame({"cycle": [1, 1], "record_index": [1, 2], "step": [1, 1],
                                 "step_index": [1, 1], "time_s": [0.0, 10.0], "status": ["CC_Chg"] * 2,
                                 "current_ma": [1.0, 1.0], "charge_capacity_mah": [0.0, 1.0],
                                 "discharge_capacity_mah": [0.0, 0.0], "voltage_v": [3.0, 3.1]})
        preview = continuation_preview.prepare_stitched_raw([ordinary, *self.frames, ordinary])
        self.assertFalse(preview["preview_time_s"].isna().any())
        self.assertTrue(preview["preview_time_s"].is_monotonic_increasing)
        displayed = _continuous_time(preview)
        np.testing.assert_array_equal(displayed["time_s"], preview["preview_time_s"])
        cohort = preview[preview["segment"].isin([1, 2])]
        np.testing.assert_allclose(cohort["preview_time_s"], cohort["total_time_s"] + 10.0)

    def test_voltage_preview_preserves_execution_breaks_after_sampling_on_both_axes(self):
        for x_axis in ("time", "capacity"):
            for maximum in (None, 6, 3):
                with self.subTest(axis=x_axis, max_points=maximum):
                    prepared = continuation_preview.prepare_segmented_raw([self.frames[0]])
                    preview = continuation_preview.voltage_preview_from_raw(prepared, max_points=maximum, x_axis=x_axis)
                    self.assertEqual(len(preview["display_break_before"]), 2)
                    self.assertEqual(len(preview["x"]), len(preview["y"]))
                    self.assertEqual(len(preview["current_ma"]), len(preview["x"]))
                    self.assertTrue(all(0 < index < len(preview["x"]) for index in preview["display_break_before"]))

    def test_missing_or_busy_index_keeps_exact_cycle_pairing(self):
        with patch.object(cache, "CACHE_DIR", self.root / "legacy-cache"):
            refs = []
            for path in (self.discharge, self.charge):
                fingerprint = parsing.capture_source_fingerprint(path)
                info = cache.build(fingerprint.hash, path, prepare_time_capacity=False)
                refs.append(stitch.CachedSourceRef(fingerprint.hash, info["parser_version"]))
            with patch.object(cache, "try_load_raw_layout_index", return_value=None):
                raw, _, _ = stitch.stitch_raw(refs)
                cycles, _, _ = stitch.stitch_cycles(refs, cache.CALC_VERSION)
            self.assertEqual(len(cycles), 2)
            pd.testing.assert_frame_equal(cycles[calc.CYCLE_COLUMNS], calc.per_cycle(raw), check_exact=True)


if __name__ == "__main__":
    unittest.main()
