"""Spec 040.3 — per-source parser identity: grammar, cache build/current-check
migration, and surgical cross-format cache invalidation.

Complements tests/test_stitch.py (stitching), tests/test_analysis_engine.py
and tests/test_analysis_cache.py (per-source provenance/cache keys and the
silent-recompute regression).
"""
import os
import shutil
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.db import Base
from app.models import SourceFile
from app.services import cache, canonical_cycling, parsing, scanner
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


def _fake_xlsx_recognized():
    """`parser_identity()` for `.xlsx` content-sniffs via
    `neware_excel.is_supported_workbook`; these tests exercise identity
    grammar/dispatch, not real workbook parsing, so recognition is faked
    rather than pulling in a real synthetic workbook writer."""
    return patch.object(parsing.neware_excel, "is_supported_workbook", return_value=True)


class IdentityGrammarTests(unittest.TestCase):
    """Case: locked grammar, measured length, format-specific tokens."""

    def test_binary_and_excel_identities_differ(self):
        binary = parsing.parser_identity("a.ndax")
        with _fake_xlsx_recognized():
            excel = parsing.parser_identity("a.xlsx")
        self.assertNotEqual(binary, excel)

    def test_binary_identity_matches_documented_grammar(self):
        identity = parsing.parser_identity("a.ndax")
        self.assertEqual(
            identity, f"nb:{parsing.NEWARE_NDA_VERSION}:r{canonical_cycling.CANONICAL_RAW_VERSION}"
        )
        self.assertLessEqual(len(identity), 30)

    def test_excel_identity_matches_documented_grammar(self):
        with _fake_xlsx_recognized():
            identity = parsing.parser_identity("a.xlsx")
        self.assertEqual(
            identity,
            f"nx:{parsing.EXCEL_PARSER_REVISION}:r{canonical_cycling.CANONICAL_RAW_VERSION}",
        )
        self.assertLessEqual(len(identity), 30)

    def test_identity_is_deterministic_and_content_independent(self):
        # ".nda"/".ndax" binary recognition is extension-only, so a
        # nonexistent path still resolves deterministically.
        first = parsing.parser_identity("one.ndax")
        second = parsing.parser_identity("two.ndax")
        self.assertEqual(first, second)

    def test_identity_is_independent_of_calc_version(self):
        identity = parsing.parser_identity("a.ndax")
        self.assertNotIn(cache.CALC_VERSION, identity)

    def test_current_identity_for_extension_matches_content_aware_path(self):
        for ext, path in ((".ndax", "a.ndax"), (".nda", "a.nda")):
            with self.subTest(ext=ext):
                self.assertEqual(
                    parsing.current_parser_identity_for_extension(ext),
                    parsing.parser_identity(path),
                )
        with _fake_xlsx_recognized():
            self.assertEqual(
                parsing.current_parser_identity_for_extension(".xlsx"),
                parsing.parser_identity("a.xlsx"),
            )

    def test_current_identity_for_extension_accepts_bare_and_dotted_form(self):
        self.assertEqual(
            parsing.current_parser_identity_for_extension("ndax"),
            parsing.current_parser_identity_for_extension(".ndax"),
        )

    def test_unrecognized_extension_returns_none_cheaply(self):
        self.assertIsNone(parsing.current_parser_identity_for_extension(".csv"))
        self.assertIsNone(parsing.current_parser_identity_for_extension(None))

    def test_unrecognized_extension_raises_on_content_aware_path(self):
        with self.assertRaises(parsing.UnsupportedSourceFormatError):
            parsing.parser_identity("a.csv")


def _minimal_frame():
    import pandas as pd

    return pd.DataFrame(
        {
            "record_index": [0, 1],
            "cycle": [1, 1],
            "step_index": [1, 1],
            "step": [1, 1],
            "status": ["Rest", "Rest"],
            "time_s": [0.0, 1.0],
            "voltage_v": [3.5, 3.5],
            "current_ma": [0.0, 0.0],
            "charge_capacity_mah": [0.0, 0.0],
            "discharge_capacity_mah": [0.0, 0.0],
        }
    )


class CacheBuildIdentityTests(unittest.TestCase):
    """Cases 1, 2, 6: building writes at the source's own identity, and
    SourceFile.parser_version is persisted with the actual built identity."""

    HASH_BINARY = "10" * 32
    HASH_EXCEL = "20" * 32

    def setUp(self):
        self._orig = parsing.parse_timeseries
        parsing.parse_timeseries = lambda path: _minimal_frame()
        for h in (self.HASH_BINARY, self.HASH_EXCEL):
            d = cache.raw_path(h, parsing.PARSER_VERSION).parent
            shutil.rmtree(d, ignore_errors=True)

    def tearDown(self):
        parsing.parse_timeseries = self._orig
        for h in (self.HASH_BINARY, self.HASH_EXCEL):
            shutil.rmtree(cache.raw_path(h, parsing.PARSER_VERSION).parent, ignore_errors=True)

    def test_build_writes_raw_and_cycles_under_the_sources_own_identity(self):
        binary_identity = parsing.parser_identity("source.ndax")
        with _fake_xlsx_recognized():
            excel_identity = parsing.parser_identity("source.xlsx")
        self.assertNotEqual(binary_identity, excel_identity)

        info_binary = cache.build(self.HASH_BINARY, "source.ndax")
        with _fake_xlsx_recognized(), patch.object(
            parsing.neware_excel, "validate_cycles", return_value=None
        ):
            info_excel = cache.build(self.HASH_EXCEL, "source.xlsx")

        self.assertEqual(info_binary["parser_version"], binary_identity)
        self.assertEqual(info_excel["parser_version"], excel_identity)
        self.assertTrue(cache.raw_path(self.HASH_BINARY, binary_identity).exists())
        self.assertTrue(cache.cycles_path(self.HASH_BINARY, binary_identity).exists())
        self.assertTrue(cache.raw_path(self.HASH_EXCEL, excel_identity).exists())
        self.assertTrue(cache.cycles_path(self.HASH_EXCEL, excel_identity).exists())
        # each source's cache lives at ITS OWN identity only
        self.assertFalse(cache.raw_path(self.HASH_BINARY, excel_identity).exists())
        self.assertFalse(cache.raw_path(self.HASH_EXCEL, binary_identity).exists())

    def test_scanner_persists_the_actual_built_identity_on_source_file(self):
        engine = create_engine(
            "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
        )
        Base.metadata.create_all(engine)
        db = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)()
        sf = SourceFile(
            hash=self.HASH_BINARY,
            path="source.ndax",
            filename="source.ndax",
            size=1,
            ext="ndax",
            parse_status="unparsed",
        )
        db.add(sf)
        db.commit()

        scanner.parse_file(db, sf)

        self.assertEqual(sf.parse_status, "parsed")
        self.assertEqual(sf.parser_version, parsing.parser_identity("source.ndax"))
        self.assertNotEqual(sf.parser_version, parsing.PARSER_VERSION)
        db.close()


class SurgicalCacheInvalidationTests(unittest.TestCase):
    """Cases 3, 4: bumping ONE format's adapter revision must not invalidate
    the other; bumping the canonical raw version invalidates both. Proven
    with injected identities rather than by bumping released constants."""

    def test_bumping_excel_revision_does_not_disturb_binary_current_check(self):
        binary_before = parsing.current_parser_identity_for_extension(".ndax")
        excel_before = parsing.current_parser_identity_for_extension(".xlsx")

        bumped_excel_descriptor = parsing.SourceFormatDescriptor(
            format_id=parsing.FORMAT_NEWARE_EXCEL,
            extensions=frozenset({".xlsx"}),
            adapter_revision=str(int(parsing.EXCEL_PARSER_REVISION) + 1),
        )
        with patch.dict(
            parsing._FORMAT_DESCRIPTORS,
            {parsing.FORMAT_NEWARE_EXCEL: bumped_excel_descriptor},
        ):
            binary_after = parsing.current_parser_identity_for_extension(".ndax")
            excel_after = parsing.current_parser_identity_for_extension(".xlsx")

        self.assertEqual(binary_before, binary_after)
        self.assertNotEqual(excel_before, excel_after)

    def test_bumping_binary_revision_does_not_disturb_excel_current_check(self):
        binary_before = parsing.current_parser_identity_for_extension(".ndax")
        excel_before = parsing.current_parser_identity_for_extension(".xlsx")

        bumped_binary_descriptor = parsing.SourceFormatDescriptor(
            format_id=parsing.FORMAT_NEWARE_BINARY,
            extensions=frozenset({".nda", ".ndax"}),
            adapter_revision="v9999.01.01",
        )
        with patch.dict(
            parsing._FORMAT_DESCRIPTORS,
            {parsing.FORMAT_NEWARE_BINARY: bumped_binary_descriptor},
        ):
            binary_after = parsing.current_parser_identity_for_extension(".ndax")
            excel_after = parsing.current_parser_identity_for_extension(".xlsx")

        self.assertNotEqual(binary_before, binary_after)
        self.assertEqual(excel_before, excel_after)

    def test_bumping_canonical_raw_version_changes_both_identities(self):
        binary_before = parsing.current_parser_identity_for_extension(".ndax")
        excel_before = parsing.current_parser_identity_for_extension(".xlsx")

        with patch.object(canonical_cycling, "CANONICAL_RAW_VERSION", 2):
            binary_after = parsing.current_parser_identity_for_extension(".ndax")
            excel_after = parsing.current_parser_identity_for_extension(".xlsx")

        self.assertNotEqual(binary_before, binary_after)
        self.assertNotEqual(excel_before, excel_after)

    def test_stale_source_file_needs_cache_is_format_scoped(self):
        """A source at a stale identity is flagged stale ONLY for its own
        format's registered current identity, mirroring the router-level
        `source_file_needs_cache`/`_has_current_scientific_cache` checks."""
        current_binary = parsing.current_parser_identity_for_extension(".ndax")
        current_excel = parsing.current_parser_identity_for_extension(".xlsx")

        binary_sf = SourceFile(hash="b" * 64, path="b.ndax", filename="b.ndax", size=1, ext="ndax",
                                parser_version=current_binary, parse_status="parsed")
        excel_sf = SourceFile(hash="e" * 64, path="e.xlsx", filename="e.xlsx", size=1, ext="xlsx",
                               parser_version=current_excel, parse_status="parsed")

        bumped_excel_descriptor = parsing.SourceFormatDescriptor(
            format_id=parsing.FORMAT_NEWARE_EXCEL,
            extensions=frozenset({".xlsx"}),
            adapter_revision=str(int(parsing.EXCEL_PARSER_REVISION) + 1),
        )
        with patch.dict(
            parsing._FORMAT_DESCRIPTORS,
            {parsing.FORMAT_NEWARE_EXCEL: bumped_excel_descriptor},
        ):
            # the binary source's expected identity is unaffected
            self.assertEqual(
                binary_sf.parser_version,
                parsing.current_parser_identity_for_extension(binary_sf.ext),
            )
            # the excel source is now stale relative to the bumped revision
            self.assertNotEqual(
                excel_sf.parser_version,
                parsing.current_parser_identity_for_extension(excel_sf.ext),
            )


class ListEndpointNoIOTests(unittest.TestCase):
    """Case 23: current-identity checks must not open the source file."""

    def test_current_identity_check_does_not_touch_the_filesystem(self):
        sf = SourceFile(
            hash="f" * 64,
            path="C:/does/not/exist/source.ndax",
            filename="source.ndax",
            size=1,
            ext="ndax",
            parser_version="stale-value",
            parse_status="parsed",
        )
        with patch("builtins.open", side_effect=AssertionError("must not open files")):
            expected = parsing.current_parser_identity_for_extension(sf.ext)
            self.assertTrue(sf.parser_version != expected)

    def test_has_current_scientific_cache_uses_extension_only(self):
        sf = SourceFile(
            hash="g" * 64,
            path="C:/does/not/exist/source.ndax",
            filename="source.ndax",
            size=1,
            ext="ndax",
            parser_version=parsing.current_parser_identity_for_extension("ndax"),
            parse_status="parsed",
        )
        with patch("builtins.open", side_effect=AssertionError("must not open files")):
            # returns False (no cache files exist) without ever reading the
            # (nonexistent, unreadable) source path
            self.assertFalse(scanner._has_current_scientific_cache(sf))

    def test_needs_identity_bring_forward_uses_extension_and_db_fields_only(self):
        """Spec 042 test 8: the startup-preparation work-set decision must be
        pure relational lookup — extension and stored fields only, no file
        I/O — because it runs over every parsed source on every startup."""
        current = parsing.current_parser_identity_for_extension("ndax")
        stale = SourceFile(
            hash="h" * 64,
            path="C:/does/not/exist/stale.ndax",
            filename="stale.ndax",
            size=1,
            ext="ndax",
            parser_version="nb:vOLD.00.00:r1",
            parse_status="parsed",
            location_status="online",
        )
        already_current = SourceFile(
            hash="i" * 64,
            path="C:/does/not/exist/current.ndax",
            filename="current.ndax",
            size=1,
            ext="ndax",
            parser_version=current,
            parse_status="parsed",
            location_status="online",
        )
        offline_stale = SourceFile(
            hash="j" * 64,
            path="C:/does/not/exist/offline.ndax",
            filename="offline.ndax",
            size=1,
            ext="ndax",
            parser_version="nb:vOLD.00.00:r1",
            parse_status="parsed",
            location_status="offline",
        )
        with patch("builtins.open", side_effect=AssertionError("must not open files")):
            self.assertTrue(scanner._needs_identity_bring_forward(stale))
            # deliberately-cleaned-but-still-current is left alone (Spec 042
            # test 2's distinguishing fact): equal `parser_version` alone
            # decides it, never cache-file presence.
            self.assertFalse(scanner._needs_identity_bring_forward(already_current))
            # unreachable/changed sources are excluded so they are not
            # retried on every startup (Spec 042 test 3).
            self.assertFalse(scanner._needs_identity_bring_forward(offline_stale))


if __name__ == "__main__":
    unittest.main()
