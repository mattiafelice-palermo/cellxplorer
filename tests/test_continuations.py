from __future__ import annotations

import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.services import continuations


def _source(
    key: str,
    *,
    kind: str = "staged",
    filename: str | None = None,
    **fields,
) -> dict:
    base = {
        "key": key,
        "kind": kind,
        "source_file_id": None,
        "filename": filename or f"{key}.ndax",
        "hash": fields.pop("hash", f"hash-{key}"),
        "start_time": "2026-01-01 00:00:00",
        "end_time": None,
        "end_timestamp": None,
        "first_record_timestamp": datetime(2026, 1, 1, tzinfo=timezone.utc),
        "local_cycle_start": 1,
        "local_cycle_end": 3,
        "local_cycle_count": 3,
        "protocol_signature": "protocol-a",
        "device_info": "NEWARE",
        "channel": "1-1",
        "barcode": None,
        "remarks": None,
        "nominal_capacity_mah": 3.0,
        "active_mass_mg": 10.0,
        "inspection_status": "ready",
        "input_order": 0,
        "existing_test_id": None,
        "linked_test_id": None,
        "path_refresh_candidate": False,
        "unsupported_extension": False,
        "missing": False,
        "unreadable": False,
        "changing": False,
    }
    base.update(fields)
    return base


class ContinuationPolicyTests(unittest.TestCase):
    def test_suggest_staged_order_uses_first_record_timestamp(self):
        sources = [
            _source(
                "staged-b",
                first_record_timestamp=datetime(2026, 1, 3, tzinfo=timezone.utc),
                input_order=1,
            ),
            _source(
                "staged-a",
                first_record_timestamp=datetime(2026, 1, 1, tzinfo=timezone.utc),
                input_order=0,
            ),
        ]
        self.assertEqual(
            continuations.suggest_staged_order(sources),
            ["staged-a", "staged-b"],
        )

    def test_duplicate_hash_blocks_submit(self):
        first = _source("staged-a", hash="same-hash")
        second = _source("staged-b", hash="same-hash")
        result = continuations.analyze_continuation_chain(
            [first, second],
            staged_keys=["staged-a", "staged-b"],
        )
        self.assertFalse(result["can_submit"])
        codes = {finding["code"] for finding in result["findings"]}
        self.assertIn("duplicate_hash", codes)

    def test_hash_already_linked_blocks_submit(self):
        staged = _source("staged-a", linked_test_id=99, existing_test_id=1)
        result = continuations.analyze_continuation_chain([staged], staged_keys=["staged-a"])
        self.assertFalse(result["can_submit"])
        self.assertTrue(any(item["code"] == "hash_already_linked" for item in result["findings"]))

    def test_protocol_and_channel_differences_are_informational(self):
        first = _source("staged-a", protocol_signature="sig-a", channel="1-1")
        second = _source(
            "staged-b",
            hash="hash-b",
            protocol_signature="sig-b",
            channel="2-2",
            local_cycle_start=1,
            local_cycle_end=2,
            first_record_timestamp=datetime(2026, 1, 4, tzinfo=timezone.utc),
            end_timestamp=datetime(2026, 1, 4, 1, tzinfo=timezone.utc),
            start_time="2026-01-04 00:00:00",
        )
        result = continuations.analyze_continuation_chain(
            [first, second],
            staged_keys=["staged-a", "staged-b"],
        )
        self.assertTrue(result["can_submit"])
        codes = {finding["code"] for finding in result["findings"]}
        self.assertIn("protocol_changed", codes)
        self.assertIn("channel_changed", codes)

    def test_timestamp_gap_includes_human_readable_duration(self):
        left_end = datetime(2026, 1, 1, 12, tzinfo=timezone.utc)
        right_start = left_end + timedelta(days=6)
        first = _source(
            "staged-a",
            end_timestamp=left_end,
            end_time=left_end.isoformat(),
        )
        second = _source(
            "staged-b",
            hash="hash-b",
            first_record_timestamp=right_start,
            start_time=right_start.strftime("%Y-%m-%d %H:%M:%S"),
            local_cycle_start=1,
            local_cycle_end=1,
        )
        result = continuations.analyze_continuation_chain(
            [first, second],
            staged_keys=["staged-a", "staged-b"],
        )
        gap = next(item for item in result["findings"] if item["code"] == "timestamp_gap")
        self.assertIn("days", gap["message"].lower())
        self.assertIn("gap_label", gap["details"])

    def test_reversed_order_requires_confirmation(self):
        sources = [
            _source(
                "staged-a",
                first_record_timestamp=datetime(2026, 1, 1, tzinfo=timezone.utc),
                input_order=0,
            ),
            _source(
                "staged-b",
                hash="hash-b",
                first_record_timestamp=datetime(2026, 1, 3, tzinfo=timezone.utc),
                input_order=1,
                local_cycle_start=1,
                local_cycle_end=2,
            ),
        ]
        result = continuations.analyze_continuation_chain(
            sources,
            staged_keys=["staged-a", "staged-b"],
            proposed_staged_order=["staged-b", "staged-a"],
        )
        self.assertTrue(result["can_submit"])
        self.assertTrue(any(item["code"] == "order_reversed" for item in result["findings"]))

    def test_reversed_input_order_without_proposed_order_requires_confirmation(self):
        later = _source(
            "staged-b",
            hash="hash-b",
            first_record_timestamp=datetime(2026, 1, 3, tzinfo=timezone.utc),
            input_order=0,
            local_cycle_start=1,
            local_cycle_end=2,
        )
        earlier = _source(
            "staged-a",
            first_record_timestamp=datetime(2026, 1, 1, tzinfo=timezone.utc),
            input_order=1,
        )
        result = continuations.analyze_continuation_chain(
            [later, earlier],
            staged_keys=["staged-b", "staged-a"],
        )
        self.assertTrue(result["can_submit"])
        self.assertTrue(any(item["code"] == "order_reversed" for item in result["findings"]))

    def test_material_mismatch_uses_five_percent_tolerance(self):
        baseline = _source("staged-a", nominal_capacity_mah=3.0, active_mass_mg=10.0)
        close = _source(
            "staged-b",
            hash="hash-b",
            nominal_capacity_mah=3.1,
            active_mass_mg=10.2,
            first_record_timestamp=datetime(2026, 1, 2, tzinfo=timezone.utc),
            local_cycle_start=1,
            local_cycle_end=1,
        )
        far = _source(
            "staged-c",
            hash="hash-c",
            nominal_capacity_mah=4.0,
            active_mass_mg=12.0,
            first_record_timestamp=datetime(2026, 1, 3, tzinfo=timezone.utc),
            local_cycle_start=1,
            local_cycle_end=1,
        )
        close_result = continuations.analyze_continuation_chain(
            [baseline, close],
            staged_keys=["staged-a", "staged-b"],
        )
        far_result = continuations.analyze_continuation_chain(
            [baseline, far],
            staged_keys=["staged-a", "staged-c"],
        )
        close_codes = {item["code"] for item in close_result["findings"]}
        far_codes = {item["code"] for item in far_result["findings"]}
        self.assertNotIn("nominal_capacity_mismatch", close_codes)
        self.assertIn("nominal_capacity_mismatch", far_codes)
        self.assertIn("active_mass_mismatch", far_codes)

    def test_invalid_proposed_order_is_blocking(self):
        result = continuations.analyze_continuation_chain(
            [_source("staged-a"), _source("staged-b", hash="hash-b")],
            staged_keys=["staged-a", "staged-b"],
            proposed_staged_order=["staged-a"],
        )
        self.assertFalse(result["can_submit"])
        self.assertTrue(
            any(item["code"] == "invalid_proposed_order" for item in result["findings"])
        )

    def test_findings_are_deterministic(self):
        sources = [
            _source("staged-a"),
            _source(
                "staged-b",
                hash="hash-b",
                protocol_signature="sig-b",
                channel="2-2",
                first_record_timestamp=datetime(2026, 1, 4, tzinfo=timezone.utc),
                local_cycle_start=1,
                local_cycle_end=2,
            ),
        ]
        first = continuations.analyze_continuation_chain(
            sources,
            staged_keys=["staged-a", "staged-b"],
        )
        second = continuations.analyze_continuation_chain(
            sources,
            staged_keys=["staged-a", "staged-b"],
        )
        self.assertEqual(first, second)

    def test_cycle_range_from_frame_uses_observed_labels_only(self):
        frame = pd.DataFrame({"cycle": [7, 8, 10]})
        start, end, count, errors = continuations.cycle_range_from_frame(frame)
        self.assertEqual(errors, [])
        self.assertEqual(start, 7)
        self.assertEqual(end, 10)
        self.assertEqual(count, 3)

    def test_timestamp_range_from_raw_uses_min_and_max(self):
        frame = pd.DataFrame(
            {
                "timestamp": pd.to_datetime(
                    [
                        "2026-01-03 12:00:00",
                        "2026-01-01 08:00:00",
                        "2026-01-02 18:00:00",
                    ],
                    utc=True,
                )
            }
        )
        start, end = continuations.timestamp_range_from_raw(frame)
        self.assertEqual(start, datetime(2026, 1, 1, 8, tzinfo=timezone.utc))
        self.assertEqual(end, datetime(2026, 1, 3, 12, tzinfo=timezone.utc))

    def test_local_cycle_restart_is_reported(self):
        first = _source("staged-a", local_cycle_start=1, local_cycle_end=73)
        second = _source(
            "staged-b",
            hash="hash-b",
            local_cycle_start=1,
            local_cycle_end=5,
            first_record_timestamp=datetime(2026, 1, 4, tzinfo=timezone.utc),
        )
        result = continuations.analyze_continuation_chain(
            [first, second],
            staged_keys=["staged-a", "staged-b"],
        )
        self.assertTrue(any(item["code"] == "local_cycles_restart" for item in result["findings"]))


if __name__ == "__main__":
    unittest.main()
