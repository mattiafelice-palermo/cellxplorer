from __future__ import annotations

import os
import sys
import threading
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.services import cache, continuations


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
    def test_staged_source_keys_must_be_nonempty_and_unique(self):
        with self.assertRaises(continuations.ContinuationValidationError) as empty_ctx:
            continuations.validate_staged_keys([""])
        self.assertEqual(empty_ctx.exception.status_code, 409)
        self.assertEqual(empty_ctx.exception.payload["code"], "invalid_staged_source_key")

        with self.assertRaises(continuations.ContinuationValidationError) as ctx:
            continuations.validate_staged_keys(["same.ndax", "same.ndax"])
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertEqual(ctx.exception.payload["code"], "duplicate_staged_source_key")
        self.assertEqual(ctx.exception.payload["conflicting_keys"], ["same.ndax"])

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

    def test_timestamp_overlap_is_confirmation(self):
        left_end = datetime(2026, 1, 2, tzinfo=timezone.utc)
        right_start = left_end - timedelta(hours=2)
        result = continuations.analyze_continuation_chain(
            [
                _source("staged-a", end_timestamp=left_end, end_time=left_end.isoformat()),
                _source(
                    "staged-b",
                    hash="hash-b",
                    first_record_timestamp=right_start,
                    start_time=right_start.isoformat(),
                ),
            ],
            staged_keys=["staged-a", "staged-b"],
        )
        overlap = next(item for item in result["findings"] if item["code"] == "timestamp_overlap")
        self.assertEqual(overlap["severity"], "confirmation")

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

    def test_pending_inspection_blocks_and_keeps_header_findings(self):
        first = _source("staged-a", inspection_status="pending", protocol_signature="sig-a")
        second = _source(
            "staged-b",
            hash="hash-b",
            inspection_status="pending",
            protocol_signature="sig-b",
            channel="2-2",
            first_record_timestamp=None,
            local_cycle_start=None,
            local_cycle_end=None,
        )
        result = continuations.analyze_continuation_chain(
            [first, second],
            staged_keys=["staged-a", "staged-b"],
        )

        self.assertFalse(result["inspection_complete"])
        self.assertFalse(result["can_submit"])
        codes = {item["code"] for item in result["findings"]}
        self.assertIn("protocol_changed", codes)
        self.assertIn("channel_changed", codes)

        with self.assertRaises(continuations.ContinuationValidationError) as ctx:
            continuations.ensure_submittable_chain(result, [])
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertEqual(ctx.exception.payload["code"], "inspection_incomplete")

    def test_device_and_channel_changes_are_informational(self):
        result = continuations.analyze_continuation_chain(
            [
                _source("staged-a", device_info="NEWARE-A", channel="1-1"),
                _source(
                    "staged-b",
                    hash="hash-b",
                    device_info="NEWARE-B",
                    channel="2-2",
                    first_record_timestamp=datetime(2026, 1, 2, tzinfo=timezone.utc),
                ),
            ],
            staged_keys=["staged-a", "staged-b"],
        )
        codes = {item["code"] for item in result["findings"]}
        self.assertIn("device_changed", codes)
        self.assertIn("channel_changed", codes)

    def test_protocol_signature_change_is_informational(self):
        result = continuations.analyze_continuation_chain(
            [
                _source("staged-a", protocol_signature="protocol-a"),
                _source(
                    "staged-b",
                    hash="hash-b",
                    protocol_signature="protocol-b",
                    first_record_timestamp=datetime(2026, 1, 2, tzinfo=timezone.utc),
                ),
            ],
            staged_keys=["staged-a", "staged-b"],
        )
        self.assertIn("protocol_changed", {item["code"] for item in result["findings"]})

    def test_finding_ids_change_when_semantic_values_change(self):
        left = _source(
            "staged-a",
            end_timestamp=datetime(2026, 1, 1, 12, tzinfo=timezone.utc),
            end_time="2026-01-01T12:00:00+00:00",
        )
        right = _source(
            "staged-b",
            hash="hash-b",
            protocol_signature="protocol-b",
            first_record_timestamp=datetime(2026, 1, 2, 12, tzinfo=timezone.utc),
            start_time="2026-01-02T12:00:00+00:00",
        )
        same = continuations.analyze_continuation_chain(
            [left, right], staged_keys=["staged-a", "staged-b"]
        )
        same_again = continuations.analyze_continuation_chain(
            [left, right], staged_keys=["staged-a", "staged-b"]
        )
        gap_id = next(item["id"] for item in same["findings"] if item["code"] == "timestamp_gap")
        self.assertEqual(
            gap_id,
            next(item["id"] for item in same_again["findings"] if item["code"] == "timestamp_gap"),
        )

        changed_right = {
            **right,
            "first_record_timestamp": datetime(2026, 1, 3, 12, tzinfo=timezone.utc),
            "start_time": "2026-01-03T12:00:00+00:00",
        }
        changed = continuations.analyze_continuation_chain(
            [left, changed_right], staged_keys=["staged-a", "staged-b"]
        )
        self.assertNotEqual(
            gap_id,
            next(item["id"] for item in changed["findings"] if item["code"] == "timestamp_gap"),
        )

        protocol_changed = continuations.analyze_continuation_chain(
            [left, {**right, "protocol_signature": "protocol-c"}],
            staged_keys=["staged-a", "staged-b"],
        )
        protocol_id = next(item["id"] for item in same["findings"] if item["code"] == "protocol_changed")
        self.assertNotEqual(
            protocol_id,
            next(item["id"] for item in protocol_changed["findings"] if item["code"] == "protocol_changed"),
        )

    def test_enrichment_without_cache_remains_pending(self):
        source = _source(
            "staged-a",
            hash="a" * 64,
            inspection_status="pending",
            local_cycle_start=None,
            local_cycle_end=None,
            local_cycle_count=None,
        )
        with (
            patch.object(continuations.cache, "has_cycles", return_value=False),
            patch.object(
                continuations.cache,
                "raw_path",
                return_value=SimpleNamespace(is_file=lambda: False),
            ),
            patch.object(
                continuations,
                "_maybe_schedule_cache_build",
                return_value={"status": "started", "error": None},
            ) as schedule,
        ):
            enriched = continuations.enrich_source_timing(source, source_path=Path("a.ndax"))

        self.assertEqual(enriched["inspection_status"], "pending")
        self.assertEqual(enriched["cache_build_status"], "started")
        schedule.assert_called_once()

    def test_raw_only_cache_remains_pending_until_cycles_are_available(self):
        source = _source(
            "staged-a",
            hash="a" * 64,
            inspection_status="pending",
            local_cycle_start=None,
            local_cycle_end=None,
            local_cycle_count=None,
        )
        raw = pd.DataFrame(
            {"timestamp": pd.to_datetime(["2026-01-01 00:00:00"], utc=True)}
        )
        with (
            patch.object(continuations.cache, "has_cycles", return_value=False),
            patch.object(
                continuations.cache,
                "raw_path",
                return_value=SimpleNamespace(is_file=lambda: True),
            ),
            patch.object(continuations.cache, "load_raw", return_value=raw),
            patch.object(continuations.cache, "load_cycles", return_value=None),
            patch.object(
                continuations,
                "_maybe_schedule_cache_build",
                return_value={"status": "building", "error": None},
            ),
        ):
            enriched = continuations.enrich_source_timing(source, source_path=Path("a.ndax"))

        self.assertEqual(enriched["inspection_status"], "pending")
        self.assertEqual(enriched["cache_build_status"], "building")
        self.assertIsNotNone(enriched["first_record_timestamp"])
        self.assertIsNone(enriched["local_cycle_count"])

    def test_cycle_only_cache_remains_pending_until_raw_is_available(self):
        source = _source("staged-a", hash="a" * 64, inspection_status="pending")
        cycles = pd.DataFrame({"cycle": [1, 2, 4]})
        with (
            patch.object(continuations.cache, "has_cycles", return_value=True),
            patch.object(
                continuations.cache,
                "raw_path",
                return_value=SimpleNamespace(is_file=lambda: False),
            ),
            patch.object(continuations.cache, "load_cycles", return_value=cycles),
            patch.object(
                continuations,
                "_maybe_schedule_cache_build",
                return_value={"status": "building", "error": None},
            ),
        ):
            enriched = continuations.enrich_source_timing(source, source_path=Path("a.ndax"))

        self.assertEqual(enriched["inspection_status"], "pending")
        self.assertEqual(enriched["cache_build_status"], "building")
        self.assertEqual(enriched["local_cycle_start"], 1)
        self.assertEqual(enriched["local_cycle_count"], 3)

    def test_failed_cache_build_is_blocking_and_does_not_look_ready(self):
        source = _source("staged-a", hash="a" * 64, inspection_status="pending")
        with (
            patch.object(continuations.cache, "has_cycles", return_value=False),
            patch.object(
                continuations.cache,
                "raw_path",
                return_value=SimpleNamespace(is_file=lambda: False),
            ),
            patch.object(
                continuations,
                "_maybe_schedule_cache_build",
                return_value={"status": "failed", "error": "parse failed"},
            ),
        ):
            enriched = continuations.enrich_source_timing(source, source_path=Path("a.ndax"))
        result = continuations.analyze_continuation_chain(
            [enriched], staged_keys=["staged-a"]
        )

        self.assertEqual(enriched["inspection_status"], "error")
        self.assertFalse(result["inspection_complete"])
        self.assertFalse(result["can_submit"])
        self.assertIn("cache_build_failed", {item["code"] for item in result["findings"]})


class ContinuationLifecycleValidationTests(unittest.TestCase):
    def test_unacknowledged_confirmation_blocks_submit(self):
        finding = {
            "id": "confirm-1",
            "code": "order_reversed",
            "severity": "confirmation",
            "source_keys": ["a"],
            "title": "Confirm",
            "message": "Confirm order",
            "details": {},
        }
        analysis = {"can_submit": True, "findings": [finding]}
        with self.assertRaises(continuations.ContinuationValidationError) as ctx:
            continuations.ensure_submittable_chain(analysis, [])
        self.assertEqual(ctx.exception.status_code, 422)

    def test_acknowledged_confirmation_allows_submit(self):
        finding = {
            "id": "confirm-1",
            "code": "order_reversed",
            "severity": "confirmation",
            "source_keys": ["a"],
            "title": "Confirm",
            "message": "Confirm order",
            "details": {},
        }
        analysis = {"can_submit": True, "findings": [finding]}
        continuations.ensure_submittable_chain(analysis, ["confirm-1"])

    def test_validate_exact_permutation_rejects_partial_list(self):
        with self.assertRaises(continuations.ContinuationValidationError) as ctx:
            continuations.validate_exact_file_id_permutation([1, 2, 3], [1, 2])
        self.assertEqual(ctx.exception.status_code, 409)

    def test_analyze_existing_order_chain_flags_reversed_chronology(self):
        earlier = _source(
            "existing-a",
            kind="existing",
            start_time="2026-01-01 00:00:00",
            first_record_timestamp=datetime(2026, 1, 1, tzinfo=timezone.utc),
            input_order=0,
        )
        later = _source(
            "existing-b",
            kind="existing",
            hash="hash-b",
            start_time="2026-01-03 00:00:00",
            first_record_timestamp=datetime(2026, 1, 3, tzinfo=timezone.utc),
            input_order=1,
        )
        result = continuations.analyze_existing_order_chain([later, earlier])
        self.assertTrue(any(item["code"] == "order_reversed" for item in result["findings"]))


class CacheBuildCoordinationTests(unittest.TestCase):
    def test_schedule_build_deduplicates_inflight_and_retries_after_failure_cooldown(self):
        file_hash = "a" * 64
        source_path = Path("source.ndax")
        started = threading.Event()
        release = threading.Event()
        calls = []

        def blocked_build(*_args, **_kwargs):
            calls.append("build")
            started.set()
            release.wait(timeout=2)

        with (
            patch.object(cache, "raw_path", return_value=SimpleNamespace(is_file=lambda: False)),
            patch.object(cache, "cycles_path", return_value=SimpleNamespace(is_file=lambda: False)),
            patch.object(cache, "build", side_effect=blocked_build),
        ):
            self.assertEqual(cache.schedule_build(file_hash, source_path)["status"], "started")
            self.assertTrue(started.wait(timeout=2))
            self.assertEqual(cache.schedule_build(file_hash, source_path)["status"], "building")
            with cache._background_build_lock:
                thread = cache._background_builds[(file_hash, cache.parsing.PARSER_VERSION, cache.CALC_VERSION)]
            release.set()
            thread.join(timeout=2)

        self.assertEqual(calls, ["build"])

        failing_calls = []

        def make_failing_build(started_event, release_event):
            def failing_build(*_args, **_kwargs):
                failing_calls.append("build")
                started_event.set()
                release_event.wait(timeout=2)
                raise RuntimeError("broken source")

            return failing_build

        first_failure_started = threading.Event()
        first_failure_release = threading.Event()

        with (
            patch.object(cache, "raw_path", return_value=SimpleNamespace(is_file=lambda: False)),
            patch.object(cache, "cycles_path", return_value=SimpleNamespace(is_file=lambda: False)),
            patch.object(
                cache,
                "build",
                side_effect=make_failing_build(first_failure_started, first_failure_release),
            ),
            patch.object(cache.time, "monotonic", return_value=0.0),
        ):
            self.assertEqual(cache.schedule_build(file_hash, source_path)["status"], "started")
            self.assertTrue(first_failure_started.wait(timeout=2))
            with cache._background_build_lock:
                thread = cache._background_builds[(file_hash, cache.parsing.PARSER_VERSION, cache.CALC_VERSION)]
            first_failure_release.set()
            thread.join(timeout=2)
            self.assertEqual(cache.schedule_build(file_hash, source_path)["status"], "failed")

        retry_failure_started = threading.Event()
        retry_failure_release = threading.Event()

        with (
            patch.object(cache, "raw_path", return_value=SimpleNamespace(is_file=lambda: False)),
            patch.object(cache, "cycles_path", return_value=SimpleNamespace(is_file=lambda: False)),
            patch.object(
                cache,
                "build",
                side_effect=make_failing_build(retry_failure_started, retry_failure_release),
            ),
            patch.object(cache.time, "monotonic", return_value=cache.BACKGROUND_BUILD_RETRY_DELAY_SECONDS + 1),
        ):
            self.assertEqual(cache.schedule_build(file_hash, source_path)["status"], "started")
            self.assertTrue(retry_failure_started.wait(timeout=2))
            with cache._background_build_lock:
                thread = cache._background_builds[(file_hash, cache.parsing.PARSER_VERSION, cache.CALC_VERSION)]
            retry_failure_release.set()
            thread.join(timeout=2)

        self.assertEqual(failing_calls, ["build", "build"])


if __name__ == "__main__":
    unittest.main()
