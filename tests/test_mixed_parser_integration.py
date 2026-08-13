"""Spec 040.5 mixed-parser integration test.

Builds one real Cell whose ordered source chain mixes a Neware binary
fixture (position 1) with a generated Neware Excel continuation (position
2) — the preferred example named by Spec 040.5's "Mixed-parser integration
test" section. Unlike `tests/test_stitch.py`'s `MixedParserIdentityStitchTests`
(which patches `cache.load_cycles`/`cache.load_raw` around synthetic
hashes/frames to test `stitch.py` in isolation), this module registers both
sources through the real `scanner.ingest_path`/`parse_file` path, builds
real Parquet caches, and drives the real `analysis_engine` compute/guard/
cache-key functions end to end. It proves:

1. each source's cache is written and addressable at its OWN parser
   identity (`nb:...` for the binary source, `nx:...` for the Excel one),
   never a shared/global bundle;
2. Cycles and Time/Capacity stitch both sources in position order with
   correct per-segment source-hash provenance;
3. saved/rendered provenance (`result["sources"][0]["files"]`) names both
   identities, and the human-facing summary is the documented "mixed"
   sentinel rather than one source's value silently standing in for both;
4. Parent 034's protocol-derived-analysis guard still fails closed for this
   Cell (Steps/DCIR/Chargeability/Rate Capability), while Cycles and
   Time/Capacity — the supported alternatives named by that guard's own
   message — are unaffected;
5. changing only one source's pinned parser identity changes the analysis
   cache key, and changing the OTHER source's identity produces a
   different key again (no collision), proving per-source resolution
   actually reaches the cache-key boundary for a real mixed-format chain.
"""

from __future__ import annotations

import os
import sys
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory

import pandas as pd
from openpyxl import Workbook
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.config import CALC_VERSION  # noqa: E402
from app.db import Base  # noqa: E402
from app.models import Cell, SourceFile, Test, TestFile  # noqa: E402
from app.services import analysis_cache, analysis_engine, cache, scanner  # noqa: E402

GOLDEN_BINARY = ROOT / "tests" / "fixtures" / "golden_analysis" / "sources" / "cycles_time_steps.ndax"

RECORD_HEADERS = [
    "DataPoint",
    "Cycle Index",
    "Step Index",
    "Step Type",
    "Time(min)",
    "Total Time(min)",
    "Current(mA)",
    "Voltage(V)",
    "Capacity(mAh)",
    "Chg. Cap.(mAh)",
    "DChg. Cap.(mAh)",
    "Date",
    "Power(W)",
]

# Two clean cycles, deliberately labelled 1/2 in the workbook itself:
# stitching maps each source's OWN observed local cycle labels into a dense
# global sequence in position order (docs/agent-knowledge/architecture.md
# "Multi-source continuation stitching") — it does not require the second
# source's local numbering to literally continue the first source's, so a
# minimal self-contained two-cycle workbook is a faithful "continuation"
# fixture for this purpose without depending on the golden source's exact
# (~193) cycle count.
_SEGMENTS = [
    (1, 1, "Rest", [0.0, 1.0], [3.50, 3.50], [0.0, 0.0]),
    (1, 2, "CC Chg", [0.0, 1.0, 2.0], [3.50, 3.60, 3.70], [0.0, 1.0, 2.0]),
    (1, 3, "CC DChg", [0.0, 1.0, 2.0], [3.70, 3.40, 3.10], [0.0, 0.9, 1.8]),
    (2, 1, "Rest", [0.0, 1.0], [3.10, 3.10], [0.0, 0.0]),
    (2, 2, "CC Chg", [0.0, 1.0, 2.0], [3.10, 3.50, 3.75], [0.0, 1.0, 2.0]),
    (2, 3, "CC DChg", [0.0, 1.0, 2.0], [3.75, 3.45, 3.15], [0.0, 0.9, 1.8]),
]


def _phase(step_type: str) -> str:
    if step_type.startswith("CC Chg") or step_type.startswith("CCCV Chg"):
        return "charge"
    if step_type.startswith("CC DChg") or step_type.startswith("CCCV DChg"):
        return "discharge"
    return "rest"


def _write_excel_continuation(path: Path) -> None:
    """A compact, self-contained Neware-shaped Excel continuation workbook."""
    base = datetime(2026, 2, 1, 8, 0, 0)
    rows: list[dict[str, object]] = []
    total_time_min = 0.0
    data_point = 1
    for cycle, step_index, step_type, times, voltages, capacities in _SEGMENTS:
        phase = _phase(step_type)
        current = 1.0 if phase == "charge" else -1.0 if phase == "discharge" else 0.0
        dates = [base + timedelta(minutes=total_time_min + value) for value in times]
        total_times = [total_time_min + value for value in times]
        for time, total, voltage, capacity, timestamp in zip(times, total_times, voltages, capacities, dates):
            rows.append(
                {
                    "DataPoint": data_point,
                    "Cycle Index": cycle,
                    "Step Index": step_index,
                    "Step Type": step_type,
                    "Time(min)": time,
                    "Total Time(min)": total,
                    "Current(mA)": current,
                    "Voltage(V)": voltage,
                    "Capacity(mAh)": capacity,
                    "Chg. Cap.(mAh)": capacity if phase == "charge" else 0.0,
                    "DChg. Cap.(mAh)": capacity if phase == "discharge" else 0.0,
                    "Date": timestamp,
                    "Power(W)": abs(current) * voltage / 1000.0,
                }
            )
            data_point += 1
        total_time_min = total_times[-1]

    workbook = Workbook()
    record_sheet = workbook.active
    record_sheet.title = "record"
    record_sheet.append(RECORD_HEADERS)
    for row in rows:
        record_sheet.append([row[header] for header in RECORD_HEADERS])
    workbook.save(path)


class MixedParserIntegrationTests(unittest.TestCase):
    """Real Cell, real caches, real analysis_engine — two parser identities."""

    @classmethod
    def setUpClass(cls) -> None:
        if not GOLDEN_BINARY.exists():
            raise unittest.SkipTest("golden binary fixture not available")
        cls._tempdir = TemporaryDirectory()
        cls.excel_path = Path(cls._tempdir.name) / "continuation.xlsx"
        _write_excel_continuation(cls.excel_path)

    @classmethod
    def tearDownClass(cls) -> None:
        cls._tempdir.cleanup()

    def setUp(self) -> None:
        engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        self.db = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)()

        self.source_a = scanner.ingest_path(self.db, GOLDEN_BINARY, parse_now=True)
        self.source_b = scanner.ingest_path(self.db, self.excel_path, parse_now=True)
        self.assertEqual(self.source_a.parse_status, "parsed", self.source_a.parse_error)
        self.assertEqual(self.source_b.parse_status, "parsed", self.source_b.parse_error)

        self.cell = Cell(name="Mixed-parser integration cell")
        self.db.add(self.cell)
        self.db.flush()
        test = Test(cell_id=self.cell.id, name="internal source chain")
        self.db.add(test)
        self.db.flush()
        self.db.add(TestFile(test_id=test.id, file_id=self.source_a.id, position=0))
        self.db.add(TestFile(test_id=test.id, file_id=self.source_b.id, position=1))
        self.db.commit()

        self.spec = analysis_engine.default_spec("Mixed-parser integration")
        self.spec["selection"]["entries"] = [{"kind": "cell", "ref_id": self.cell.id}]

    def tearDown(self) -> None:
        for source in (self.source_a, self.source_b):
            try:
                cache.remove_hash_cache(source.hash)
            except (OSError, ValueError):
                pass
        self.db.close()

    # ---- 1. distinct, source-specific parser identity -------------------

    def test_each_source_gets_its_own_parser_identity(self) -> None:
        self.assertTrue(self.source_a.parser_version.startswith("nb:"), self.source_a.parser_version)
        self.assertTrue(self.source_b.parser_version.startswith("nx:"), self.source_b.parser_version)
        self.assertNotEqual(self.source_a.parser_version, self.source_b.parser_version)

    def test_each_cache_is_addressable_only_at_its_own_identity(self) -> None:
        # The real cache written for the binary source is NOT readable under
        # the Excel source's identity and vice versa — caches are keyed per
        # source-specific identity, not a shared global bundle.
        self.assertIsNotNone(cache.load_raw(self.source_a.hash, self.source_a.parser_version))
        self.assertIsNotNone(cache.load_raw(self.source_b.hash, self.source_b.parser_version))
        self.assertIsNone(cache.load_raw(self.source_a.hash, self.source_b.parser_version))
        self.assertIsNone(cache.load_raw(self.source_b.hash, self.source_a.parser_version))

    # ---- 2 & 3. stitched Cycles/Time-Capacity + provenance ---------------

    def test_cycles_stitch_both_sources_in_order_with_mixed_provenance(self) -> None:
        result = analysis_engine.compute(self.db, self.spec, None, use_current_versions=True)
        series = result["cell_series"][0]

        # Ordered, position-correct segment provenance.
        segments = series["segments"]
        self.assertEqual(len(segments), 2)
        self.assertEqual(segments[0]["file_hash"], self.source_a.hash)
        self.assertEqual(segments[1]["file_hash"], self.source_b.hash)

        # Dense global cycle numbering: the golden source's own cycles,
        # immediately followed by the Excel continuation's two cycles with
        # no gap or overlap.
        golden_cycle_count = self.source_a.cycle_count
        self.assertGreater(golden_cycle_count, 0)
        expected_tail = [golden_cycle_count + 1, golden_cycle_count + 2]
        self.assertEqual(series["x"][-2:], expected_tail)
        self.assertEqual(series["x"], sorted(series["x"]))
        self.assertEqual(len(series["x"]), len(set(series["x"])))

        # Provenance names BOTH identities explicitly...
        source_entry = result["sources"][0]
        files_by_hash = {f["hash"]: f["parser_version"] for f in source_entry["files"]}
        self.assertEqual(files_by_hash[self.source_a.hash], self.source_a.parser_version)
        self.assertEqual(files_by_hash[self.source_b.hash], self.source_b.parser_version)
        # ...and the compact human-facing summary is truthfully "mixed"
        # rather than one source's identity silently standing in for both.
        self.assertEqual(result["parser_version"], "mixed")
        self.assertEqual(result["current_parser_version"], "mixed")

    def test_time_capacity_stitches_both_sources(self) -> None:
        result = analysis_engine.compute_time_capacity(
            self.db, self.spec, None, use_current_versions=True
        )
        trace = result["cell_traces"][0]
        self.assertEqual(
            set(trace["source_filename"]),
            {self.source_a.filename, self.source_b.filename},
        )
        self.assertEqual(result["parser_version"], "mixed")

    # ---- 4. Parent 034 multi-source protocol guard stays fail-closed -----

    def test_protocol_derived_families_fail_closed_for_this_cell(self) -> None:
        for family in ("steps", "dcir", "chargeability", "rate_capability"):
            with self.subTest(family=family):
                detail = analysis_engine.protocol_analysis_guard(self.db, self.spec, family)
                self.assertIsNotNone(detail)
                self.assertEqual(detail["code"], "multi_source_protocol_mapping_required")
                cell_ids = {entry["id"] for entry in detail["unsupported_cells"]}
                self.assertIn(self.cell.id, cell_ids)
                self.assertEqual(detail["supported_alternatives"], ["cycles", "time_capacity"])

    def test_cycles_and_time_capacity_are_not_guarded(self) -> None:
        for family in ("cycles", "time_capacity"):
            with self.subTest(family=family):
                self.assertIsNone(
                    analysis_engine.protocol_analysis_guard(self.db, self.spec, family)
                )

    # ---- 5. per-source cache-key resolution -------------------------------

    def _provenance(self, identity_a: str, identity_b: str) -> dict:
        return {
            "calc_version": CALC_VERSION,
            "sources": [
                {
                    "cell_id": self.cell.id,
                    "file_hashes": [self.source_a.hash, self.source_b.hash],
                    "files": [
                        {"hash": self.source_a.hash, "position": 1, "parser_version": identity_a},
                        {"hash": self.source_b.hash, "position": 2, "parser_version": identity_b},
                    ],
                }
            ],
        }

    def test_changing_one_sources_identity_changes_only_that_pairs_key(self) -> None:
        baseline = self._provenance(self.source_a.parser_version, self.source_b.parser_version)
        changed_b = self._provenance(self.source_a.parser_version, "nx:old-legacy-rev:r1")
        changed_a = self._provenance("nb:vOLD.00.00:r1", self.source_b.parser_version)

        key_baseline = analysis_cache.result_key(
            self.db, "cycles", self.spec, baseline, use_current_versions=False
        )
        key_baseline_repeat = analysis_cache.result_key(
            self.db, "cycles", self.spec, baseline, use_current_versions=False
        )
        key_changed_b = analysis_cache.result_key(
            self.db, "cycles", self.spec, changed_b, use_current_versions=False
        )
        key_changed_a = analysis_cache.result_key(
            self.db, "cycles", self.spec, changed_a, use_current_versions=False
        )

        # Deterministic for identical inputs.
        self.assertEqual(key_baseline, key_baseline_repeat)
        # Changing EITHER source's pinned identity changes the fingerprint...
        self.assertNotEqual(key_baseline, key_changed_b)
        self.assertNotEqual(key_baseline, key_changed_a)
        # ...and the two single-source changes do not collide with each other.
        self.assertNotEqual(key_changed_a, key_changed_b)


if __name__ == "__main__":
    unittest.main()
