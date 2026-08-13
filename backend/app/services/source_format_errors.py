"""Format-neutral source-rejection error taxonomy (Spec 040.2 follow-up).

This module exists solely to break an import cycle: `parsing.py` imports
`neware_excel`, so `neware_excel` cannot import `parsing` to reach a shared
base error type. These three classes are the one place that shared taxonomy
lives; both `parsing.py` and `neware_excel.py` import from here, never from
each other for error types. This module must never import `parsing` or
`neware_excel`.

Shape:

    SourceFormatError(ValueError)              # neutral base
    |-- UnsupportedSourceFormatError            # not a recognized source of this format
    `-- InvalidSourceFormatError                # recognized, but structurally broken

Every current and future adapter-specific error type (e.g.
`neware_excel.UnsupportedNewareExcelError`/`InvalidNewareExcelError`, and any
future `.mpr` adapter's own error types under Parent 041) should multiply
inherit from both its adapter-specific base (for `except <AdapterError>`
call sites that want adapter-specific diagnostic detail) and the matching
class here (for `except SourceFormatError` call sites that want to reject
any unusable source uniformly, regardless of which adapter produced it).
`ValueError` stays in every such type's MRO through this base, so existing
`except ValueError` call sites keep working unchanged.

Deliberately excluded: `canonical_cycling.CanonicalCyclingError`. That error
means an adapter was recognized, ran, and still produced a canonically
invalid frame -- an *adapter bug*, categorically different from "the source
file itself is not a valid/recognizable export of its format". Folding it
into this hierarchy would let a caller's `except SourceFormatError` silently
swallow a real bug alongside a routine bad-file rejection. It stays a
separate `ValueError` subclass raised only from `canonical_cycling.py`.
"""
from __future__ import annotations


class SourceFormatError(ValueError):
    """Neutral base: `path` is not a usable source for the format it was routed to.

    Catch this to reject any adapter's bad source uniformly without also
    catching an adapter bug (see module docstring re: `CanonicalCyclingError`).
    """


class UnsupportedSourceFormatError(SourceFormatError):
    """The source is not a recognized instance of its format at all."""


class InvalidSourceFormatError(SourceFormatError):
    """The source resembles a recognized instance of its format but is unsafe to map."""
