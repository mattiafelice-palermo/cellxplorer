from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

from backend.app.services import parsing, protocol as protocol_service
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
        self.assertEqual(metadata["channel"], "3")
        self.assertEqual(metadata["channel_number"], 2)
        self.assertEqual(metadata["software_version"], "11.60")
        expected_start = datetime(1899, 12, 30) + timedelta(days=45000.25)
        self.assertEqual(
            metadata["start_time"], expected_start.isoformat(timespec="microseconds")
        )
        self.assertTrue(metadata["absolute_timestamps"])

        declared_protocol = metadata["protocol"]
        self.assertEqual([step["number"] for step in declared_protocol["steps"]], [1, 2])
        self.assertEqual(declared_protocol["steps"][0]["type_id"], 2)
        self.assertEqual(declared_protocol["steps"][1]["type_id"], 7)
        self.assertEqual(declared_protocol["steps"][1]["c_rate"], 0.5)
        self.assertEqual(declared_protocol["steps"][1]["loop_start_step"], 1)
        self.assertEqual(declared_protocol["steps"][1]["loop_count"], 3)
        repeated = next(group for group in declared_protocol["groups"] if group["kind"] == "repeated_block")
        self.assertEqual(repeated["all_step_numbers"], [1, 2])
        self.assertEqual(repeated["end_step"], 2)
        self.assertEqual(declared_protocol["steps"][0]["rest_duration_s"], 3.0)
        self.assertTrue(declared_protocol["capabilities"]["explicit_rate_available"])
        self.assertTrue(declared_protocol["capabilities"]["operational_cutoffs_available"])
        self.assertTrue(declared_protocol["capabilities"]["loop_structure_available"])
        self.assertFalse(declared_protocol["capabilities"]["semantic_conditions_available"])
        self.assertTrue(
            any(
                item["kind"] == "voltage"
                for item in declared_protocol["summary"]["operational_cutoffs"]
            )
        )
        self.assertTrue(all("substeps" not in step for step in declared_protocol["steps"]))
        self.assertIsNone(metadata["protection_voltage_upper_v"])
        self.assertTrue(metadata["voltage_capabilities"]["capabilities"]["working_potential"])
        self.assertEqual(
            metadata["voltage_capabilities"]["voltage_v_origin"],
            "derived_working_minus_counter",
        )
        self.assertEqual(
            metadata["raw"][protocol_service.DECLARED_PROTOCOL_METADATA_KEY]["signature"],
            declared_protocol["signature"],
        )
        self.assertEqual(
            declared_protocol["signature"],
            protocol_service.reconstruct_protocol(metadata["raw"])["signature"],
        )
        self.assertEqual(
            declared_protocol["signature"],
            protocol_service.reconstruct_declared_protocol(metadata["raw"])["signature"],
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
        self.assertIsNone(step["raw_sequence"]["voltage_limit_v"])
        self.assertEqual(step["raw_sequence"]["voltage_limit_raw_v"], 0.0)

    def test_active_zero_and_negative_voltage_limits_are_not_erased(self) -> None:
        settings = encode_gcpl_settings(
            [
                {
                    "set_i_c": 0,
                    "current": -5.0,
                    "t1_s": 10.0,
                    "voltage_limit_v": 0.0,
                },
                {
                    "set_i_c": 0,
                    "current": -5.0,
                    "t1_s": 10.0,
                    "voltage_limit_v": -0.1,
                },
            ]
        )
        with tempfile.TemporaryDirectory() as temp:
            path = write_gcpl_mpr(Path(temp) / "active-voltage-limits.mpr", _HEADER_ROWS, settings_payload=settings)
            with read_mpr_header(path) as document:
                decoded = decode_gcpl_settings(document.vmp_set)
        self.assertEqual(decoded["sequences"][0]["voltage_cutoff_v"], 0.0)
        self.assertAlmostEqual(decoded["sequences"][1]["voltage_cutoff_v"], -0.1, places=6)

    def test_unresolved_c_rate_direction_does_not_fabricate_a_cv_discharge(self) -> None:
        settings = encode_gcpl_settings(
            [
                {
                    "set_i_c": 2,
                    "current": 0.0,
                    "c_rate": 0.5,
                    "voltage_limit_v": 4.1,
                    "hold_duration_s": 4.0,
                }
            ]
        )
        with tempfile.TemporaryDirectory() as temp:
            path = write_gcpl_mpr(
                Path(temp) / "unresolved-rate.mpr",
                _HEADER_ROWS,
                settings_payload=settings,
            )
            metadata = read_gcpl_header_metadata(path)
        step = metadata["protocol"]["steps"][0]
        self.assertEqual(step["type_id"], 21)
        self.assertIsNone(step["target_voltage_v"])
        self.assertIsNone(step["stop_voltage_v"])
        self.assertNotIn("substeps", step)
        self.assertIn("no independently resolvable current direction", " ".join(metadata["protocol_warnings"]))

    def test_unknown_units_and_sign_encodings_fail_closed(self) -> None:
        base = 0x1847 + 4
        for offset, value, message in (
            (base + 5, 9, "current unit code"),
            (base + 44, 9, "current unit code"),
            (base + 62, 9, "capacity unit code"),
            (base + 71, 9, "capacity unit code"),
            (0x0260, 9, "capacity unit code"),
            (base + 6, 9, "current-reference code"),
            (base + 14, 9, "current-sign code"),
        ):
            payload = bytearray(_settings())
            if offset in {base + 6, base + 14}:
                struct.pack_into("<I", payload, offset, value)
            else:
                payload[offset] = value
            with tempfile.TemporaryDirectory() as temp:
                path = write_gcpl_mpr(
                    Path(temp) / "unknown-code.mpr",
                    _HEADER_ROWS,
                    settings_payload=bytes(payload),
                )
                with read_mpr_header(path) as document:
                    with self.assertRaisesRegex(UnsupportedBiologicGcplError, message):
                        decode_gcpl_settings(document.vmp_set)


if __name__ == "__main__":
    unittest.main()
