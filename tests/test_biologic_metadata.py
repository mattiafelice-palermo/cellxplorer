from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from backend.app.services import parsing
from backend.app.services.biologic_gcpl import (
    UnsupportedBiologicGcplError,
    decode_gcpl_settings,
    read_gcpl_header_metadata,
)
from backend.app.services.biologic_mpr import read_mpr_header
from tests.biologic_mpr_fixture import (
    encode_gcpl_log,
    encode_gcpl_settings,
    write_gcpl_mpr,
)


def _settings(*, reference_electrode: str | None = "Ag/AgCl") -> bytes:
    return encode_gcpl_settings(
        [
            {
                "set_i_c": 0,
                "current": -5.0,
                "t1_s": 10.0,
                "voltage_limit_v": 2.8,
                "record_interval_s": 1.0,
                "rest_duration_s": 3.0,
                "rest_interval_s": 2.0,
                "range_lower_v": -1.0,
                "range_upper_v": 5.0,
            },
            {
                "set_i_c": 2,
                "current": 1.0,
                "c_rate": 0.5,
                "t1_s": 20.0,
                "voltage_limit_v": 4.1,
                "hold_duration_s": 4.0,
                "current_cutoff": 0.1,
                "record_interval_s": 2.0,
                "goto_step": 1,
                "repeat_count": 3,
            },
        ],
        comments="known GCPL settings",
        active_mass_g=0.002,
        electrode_area_cm2=1.25,
        reference_electrode=reference_electrode,
        battery_capacity=2.0,
        battery_capacity_unit=0,
    )


_HEADER_ROWS = [{"total_time_s": 0.0}]


class BiologicMetadataTests(unittest.TestCase):
    def test_modern_settings_log_and_protocol_are_normalized(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = write_gcpl_mpr(
                Path(temp) / "known.mpr",
                _HEADER_ROWS,
                settings_payload=_settings(),
                log_payload=encode_gcpl_log(ole_timestamp=45000.25),
                include_log=True,
            )
            metadata = parsing.read_header_metadata(path)

        self.assertNotIn("error", metadata)
        self.assertEqual(metadata["source_format"], "biologic_mpr")
        self.assertEqual(metadata["remarks"], "known GCPL settings")
        self.assertAlmostEqual(metadata["active_mass_mg"], 2.0, places=5)
        self.assertAlmostEqual(metadata["nominal_capacity_mah"], 2000.0, places=5)
        self.assertAlmostEqual(metadata["electrode_area_cm2"], 1.25, places=5)
        self.assertEqual(metadata["reference_electrode"], "Ag/AgCl")
        self.assertEqual(metadata["channel"], "2")
        self.assertEqual(metadata["software_version"], "11.60")
        expected_start = datetime(1899, 12, 30) + timedelta(days=45000.25)
        self.assertEqual(
            metadata["start_time"], expected_start.isoformat(timespec="microseconds")
        )
        self.assertTrue(metadata["absolute_timestamps"])

        protocol = metadata["protocol"]
        self.assertEqual([step["number"] for step in protocol["steps"]], [1, 2])
        self.assertEqual(protocol["steps"][0]["type_id"], 2)
        self.assertEqual(protocol["steps"][1]["type_id"], 7)
        self.assertEqual(protocol["steps"][1]["c_rate"], 0.5)
        self.assertEqual(protocol["steps"][1]["loop_start_step"], 1)
        self.assertEqual(protocol["steps"][1]["loop_count"], 3)
        self.assertEqual(protocol["steps"][0]["rest_duration_s"], 3.0)
        self.assertTrue(protocol["capabilities"]["explicit_rate_available"])
        self.assertTrue(protocol["capabilities"]["operational_cutoffs_available"])
        self.assertTrue(protocol["capabilities"]["loop_structure_available"])
        self.assertFalse(protocol["capabilities"]["semantic_conditions_available"])
        self.assertTrue(
            any(item["kind"] == "voltage" for item in protocol["summary"]["operational_cutoffs"])
        )
        self.assertIsNone(metadata["protection_voltage_upper_v"])
        self.assertTrue(metadata["voltage_capabilities"]["capabilities"]["working_potential"])
        self.assertEqual(
            metadata["voltage_capabilities"]["voltage_v_origin"],
            "derived_working_minus_counter",
        )

    def test_reference_placeholder_is_not_promoted_to_a_reference_identity(self) -> None:
        settings = _settings(reference_electrode="(unspecified)")
        with tempfile.TemporaryDirectory() as temp:
            path = write_gcpl_mpr(Path(temp) / "placeholder.mpr", _HEADER_ROWS, settings_payload=settings)
            metadata = read_gcpl_header_metadata(path)
        self.assertIsNone(metadata["reference_electrode"])
        self.assertEqual(metadata["raw"]["settings"]["reference_electrode_raw"], "(unspecified)")

    def test_missing_or_unreliable_log_leaves_absolute_time_unavailable(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            without_log = write_gcpl_mpr(
                Path(temp) / "without-log.mpr", _HEADER_ROWS, settings_payload=_settings()
            )
            missing = read_gcpl_header_metadata(without_log)
            unreliable = write_gcpl_mpr(
                Path(temp) / "unreliable-log.mpr",
                _HEADER_ROWS,
                settings_payload=_settings(),
                log_payload=encode_gcpl_log(ole_timestamp=None),
                include_log=True,
            )
            invalid = read_gcpl_header_metadata(unreliable)

        for metadata in (missing, invalid):
            self.assertFalse(metadata["absolute_timestamps"])
            self.assertIsNone(metadata["start_time"])
            self.assertIn("absolute timestamps", " ".join(metadata["protocol_warnings"]))

    def test_unknown_settings_discriminator_fails_closed(self) -> None:
        payload = bytearray(_settings())
        payload[0] = 0x04
        with tempfile.TemporaryDirectory() as temp:
            path = write_gcpl_mpr(Path(temp) / "unknown.mpr", _HEADER_ROWS, settings_payload=bytes(payload))
            metadata = parsing.read_header_metadata(path)
        self.assertIn("technique discriminator", metadata["error"])
        with tempfile.TemporaryDirectory() as temp:
            path = write_gcpl_mpr(Path(temp) / "unknown-direct.mpr", _HEADER_ROWS, settings_payload=bytes(payload))
            with read_mpr_header(path) as document:
                with self.assertRaisesRegex(UnsupportedBiologicGcplError, "technique discriminator"):
                    decode_gcpl_settings(document.vmp_set)

    def test_header_reader_does_not_construct_record_array(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = write_gcpl_mpr(Path(temp) / "header-only.mpr", _HEADER_ROWS, settings_payload=_settings())
            with patch("backend.app.services.biologic_mpr.np.frombuffer", side_effect=AssertionError("full decode")):
                with read_mpr_header(path) as document:
                    self.assertIsNone(document.vmp_data.records)
                    self.assertEqual(document.vmp_data.n_datapoints, 1)
                metadata = read_gcpl_header_metadata(path)
            self.assertEqual(metadata["source_format"], "biologic_mpr")

    def test_zero_current_t_m_without_voltage_target_is_a_declared_rest(self) -> None:
        settings = encode_gcpl_settings(
            [
                {
                    "set_i_c": 0,
                    "current": 0.0,
                    "hold_duration_s": 3600.0,
                    "rest_interval_s": 120.0,
                }
            ]
        )
        with tempfile.TemporaryDirectory() as temp:
            path = write_gcpl_mpr(Path(temp) / "rest.mpr", _HEADER_ROWS, settings_payload=settings)
            metadata = read_gcpl_header_metadata(path)
        step = metadata["protocol"]["steps"][0]
        self.assertEqual(step["type_id"], 4)
        self.assertEqual(step["direction"], "rest")
        self.assertEqual(step["time_limit_s"], 3600.0)
        self.assertIsNone(step["current_ma"])
        self.assertEqual(step["summary"], "Rest | 1 h")


if __name__ == "__main__":
    unittest.main()
