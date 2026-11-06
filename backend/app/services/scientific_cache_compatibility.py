"""Explicit scientific equivalence; never infer compatibility by version order.

The 1.6.5 change affected BioLogic acquisition-cohort stitching only. Neware
per-source cycle tables and prepared phase/capacity values retain 1.6.4 meaning.
Parser identity, content hash, physical layout and schema are still exact keys.
BioLogic-specific changes belong in its adapter identity, not CALC_VERSION.
"""
from __future__ import annotations

import re

_NEWARE_IDENTITY = re.compile(r"(?:nb:[A-Za-z0-9_.-]+|nx:[0-9]+):r[0-9]+")
_NEWARE_EQUIVALENT_CALCULATIONS = ("1.6.4", "1.6.5")


def compatible_calculation_versions(parser_version: str, requested: str) -> tuple[str, ...]:
    """Prefer exact artifacts; allow only this reviewed format/version pair."""
    if (_NEWARE_IDENTITY.fullmatch(str(parser_version))
            and requested in _NEWARE_EQUIVALENT_CALCULATIONS):
        return (requested, *(version for version in _NEWARE_EQUIVALENT_CALCULATIONS
                             if version != requested))
    return (requested,)
