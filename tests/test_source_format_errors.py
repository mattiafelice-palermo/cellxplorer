"""Format-neutral source-rejection error taxonomy tests (Spec 040.2 follow-up).

Covers `backend/app/services/source_format_errors.py`'s neutral base
(`SourceFormatError`) and its two subclasses (`UnsupportedSourceFormatError`,
`InvalidSourceFormatError`), and their integration into
`neware_excel.py`/`parsing.py`:

1. the neutral base catches both Neware Excel rejection types;
2. adapter-specific (`NewareExcelError`) catches still work;
3. `except ValueError` still works for every type in the hierarchy;
4. no error message changed anywhere;
5. a generic `.xlsx` still produces the exact same type name and message as
   before this change (`neware_excel.UnsupportedNewareExcelError`,
   "Not a recognized Neware Excel export: required record sheet is
   missing.");
6. `parsing.UnsupportedSourceFormatError` is the same object/class as
   `source_format_errors.UnsupportedSourceFormatError` (re-exported, not
   redefined);
7. `canonical_cycling.CanonicalCyclingError` is deliberately NOT part of this
   hierarchy.

See `docs/specs/040.2-source-format-adapter-dispatch.md`'s "Error taxonomy"
section and its implementation record.
"""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from openpyxl import Workbook

from app.services import neware_excel, parsing, source_format_errors
from app.services.canonical_cycling import CanonicalCyclingError
from app.services.source_format_errors import (
    InvalidSourceFormatError,
    SourceFormatError,
    UnsupportedSourceFormatError,
)


def _write_unrelated_workbook(path: Path) -> None:
    """A generic `.xlsx` with no Neware-shaped `record` sheet at all."""
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Sheet1"
    sheet.append(["Date", "Value"])
    sheet.append(["2026-01-01", 1.0])
    workbook.save(path)


class HierarchyShapeTests(unittest.TestCase):
    """The neutral base/subclass shape itself, independent of any adapter."""

    def test_source_format_error_is_a_value_error(self):
        self.assertTrue(issubclass(SourceFormatError, ValueError))

    def test_unsupported_and_invalid_are_source_format_errors(self):
        self.assertTrue(issubclass(UnsupportedSourceFormatError, SourceFormatError))
        self.assertTrue(issubclass(InvalidSourceFormatError, SourceFormatError))

    def test_unsupported_and_invalid_are_distinct_branches(self):
        # Neither neutral subclass is an ancestor of the other.
        self.assertFalse(issubclass(UnsupportedSourceFormatError, InvalidSourceFormatError))
        self.assertFalse(issubclass(InvalidSourceFormatError, UnsupportedSourceFormatError))

    def test_module_imports_nothing_from_parsing_or_neware_excel(self):
        """Constraint: the new module must not create a circular import."""
        import ast

        source_path = ROOT / "backend" / "app" / "services" / "source_format_errors.py"
        tree = ast.parse(source_path.read_text(encoding="utf-8"))
        imported_modules: list[str] = []
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module:
                imported_modules.append(node.module)
            elif isinstance(node, ast.Import):
                imported_modules.extend(alias.name for alias in node.names)
        for name in imported_modules:
            self.assertNotIn("parsing", name)
            self.assertNotIn("neware_excel", name)


class ParsingReExportTests(unittest.TestCase):
    """Case 6/constraint 2: `parsing.UnsupportedSourceFormatError` is a
    re-export, not a redefinition — exactly one class of that name exists."""

    def test_parsing_unsupported_source_format_error_is_the_same_class(self):
        self.assertIs(parsing.UnsupportedSourceFormatError, UnsupportedSourceFormatError)
        self.assertIs(
            parsing.UnsupportedSourceFormatError,
            source_format_errors.UnsupportedSourceFormatError,
        )

    def test_parsing_re_exports_the_full_neutral_trio(self):
        self.assertIs(parsing.SourceFormatError, SourceFormatError)
        self.assertIs(parsing.InvalidSourceFormatError, InvalidSourceFormatError)

    def test_parsing_raised_instance_is_a_source_format_error(self):
        with self.assertRaises(SourceFormatError):
            parsing.parse_timeseries("source.csv")


class NewareExcelRebaseTests(unittest.TestCase):
    """Cases 1-3, 5: Neware Excel error classes carry the neutral base
    without losing their adapter-specific catchability, and `ValueError`
    stays in every MRO."""

    def test_unsupported_neware_excel_error_mro(self):
        mro_names = [cls.__name__ for cls in neware_excel.UnsupportedNewareExcelError.__mro__]
        self.assertEqual(
            mro_names,
            [
                "UnsupportedNewareExcelError",
                "NewareExcelError",
                "UnsupportedSourceFormatError",
                "SourceFormatError",
                "ValueError",
                "Exception",
                "BaseException",
                "object",
            ],
        )

    def test_invalid_neware_excel_error_mro(self):
        mro_names = [cls.__name__ for cls in neware_excel.InvalidNewareExcelError.__mro__]
        self.assertEqual(
            mro_names,
            [
                "InvalidNewareExcelError",
                "NewareExcelError",
                "InvalidSourceFormatError",
                "SourceFormatError",
                "ValueError",
                "Exception",
                "BaseException",
                "object",
            ],
        )

    def test_neutral_base_catches_both_neware_excel_rejection_types(self):
        """Case: `except SourceFormatError` catches both, uniformly."""
        with self.assertRaises(SourceFormatError):
            raise neware_excel.UnsupportedNewareExcelError("boom")
        with self.assertRaises(SourceFormatError):
            raise neware_excel.InvalidNewareExcelError("boom")

    def test_neutral_subclasses_route_to_the_matching_branch(self):
        with self.assertRaises(UnsupportedSourceFormatError):
            raise neware_excel.UnsupportedNewareExcelError("boom")
        with self.assertRaises(InvalidSourceFormatError):
            raise neware_excel.InvalidNewareExcelError("boom")
        # And the branches don't cross.
        with self.assertRaises(neware_excel.UnsupportedNewareExcelError):
            try:
                raise neware_excel.UnsupportedNewareExcelError("boom")
            except InvalidSourceFormatError:  # pragma: no cover - must not catch
                raise AssertionError("InvalidSourceFormatError must not catch Unsupported*")

    def test_adapter_specific_catch_still_works(self):
        """Case 2: `except NewareExcelError` still catches both subclasses,
        proving the multiply-inherited MRO did not break the pre-existing
        adapter-specific catch sites."""
        with self.assertRaises(neware_excel.NewareExcelError):
            raise neware_excel.UnsupportedNewareExcelError("boom")
        with self.assertRaises(neware_excel.NewareExcelError):
            raise neware_excel.InvalidNewareExcelError("boom")

    def test_value_error_still_catches_every_type(self):
        """Case 3 / constraint 4, including the exact scanner.py:843 shape
        (`except (OSError, ValueError)`)."""
        for exc_type in (
            neware_excel.UnsupportedNewareExcelError,
            neware_excel.InvalidNewareExcelError,
            parsing.UnsupportedSourceFormatError,
            SourceFormatError,
            UnsupportedSourceFormatError,
            InvalidSourceFormatError,
        ):
            with self.subTest(exc_type=exc_type.__name__):
                with self.assertRaises(ValueError):
                    raise exc_type("boom")
                try:
                    raise exc_type("boom")
                except (OSError, ValueError):
                    pass
                else:  # pragma: no cover
                    raise AssertionError("expected (OSError, ValueError) to catch")

    def test_error_messages_unchanged(self):
        """Constraint 3: no message text changed, only the type hierarchy."""
        unsupported = neware_excel.UnsupportedNewareExcelError("only .xlsx is supported")
        invalid = neware_excel.InvalidNewareExcelError("Neware Excel foo is required.")
        self.assertEqual(str(unsupported), "only .xlsx is supported")
        self.assertEqual(str(invalid), "Neware Excel foo is required.")


class GenericXlsxUnchangedBehaviorTests(unittest.TestCase):
    """Case 4/5: a generic `.xlsx` (no Neware `record` sheet) must still
    fail with the exact same type name and message as before this change."""

    def test_generic_xlsx_raises_unsupported_neware_excel_error_unchanged_message(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "unrelated.xlsx"
            _write_unrelated_workbook(path)
            with self.assertRaises(neware_excel.UnsupportedNewareExcelError) as ctx:
                neware_excel.parse_timeseries(path)
            self.assertEqual(type(ctx.exception).__name__, "UnsupportedNewareExcelError")
            self.assertEqual(
                str(ctx.exception),
                "Not a recognized Neware Excel export: required record sheet is missing.",
            )

    def test_generic_xlsx_through_parsing_facade_is_also_unchanged(self):
        """`parsing.parse_timeseries` does not catch/translate the Excel
        adapter's own exception (per the module docstring) — it propagates
        verbatim, so this is the same type/message as calling the adapter
        directly, just reached through the facade's dispatch."""
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "unrelated.xlsx"
            _write_unrelated_workbook(path)
            with self.assertRaises(neware_excel.UnsupportedNewareExcelError) as ctx:
                parsing.parse_timeseries(path)
            self.assertEqual(type(ctx.exception).__name__, "UnsupportedNewareExcelError")
            self.assertEqual(
                str(ctx.exception),
                "Not a recognized Neware Excel export: required record sheet is missing.",
            )
            # And it is still catchable as a neutral rejection, uniformly.
            self.assertIsInstance(ctx.exception, SourceFormatError)
            self.assertIsInstance(ctx.exception, UnsupportedSourceFormatError)


class CanonicalCyclingErrorStaysSeparateTests(unittest.TestCase):
    """Constraint 6: `CanonicalCyclingError` is deliberately NOT folded into
    this hierarchy — an adapter bug is not a bad-source rejection."""

    def test_canonical_cycling_error_is_not_a_source_format_error(self):
        self.assertFalse(issubclass(CanonicalCyclingError, SourceFormatError))

    def test_source_format_error_does_not_catch_canonical_cycling_error(self):
        with self.assertRaises(CanonicalCyclingError):
            try:
                raise CanonicalCyclingError("adapter produced an invalid canonical frame")
            except SourceFormatError:  # pragma: no cover - must not catch
                raise AssertionError("SourceFormatError must not catch CanonicalCyclingError")


if __name__ == "__main__":
    unittest.main()
