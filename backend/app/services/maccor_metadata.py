"""Maccor startup fields used for specimen normalization."""
from __future__ import annotations

import math
import re

from .source_extensions import MACCOR_CHANNEL_FORMAT, extension_key


_MASS_LABEL = r"(?:active(?: material)? (?:mass|weight)|mass of active material)"
_UNIT = r"(?:mg|g|µg|μg|ug)"
_NUMBER = r"[+-]?(?:[0-9]+(?:[.,][0-9]*)?|[.,][0-9]+)(?:[eE][+-]?[0-9]+)?"
_MASS_KEY = re.compile(rf"{_MASS_LABEL}(?:\s*(?:\[({_UNIT})\]|\(({_UNIT})\)))?", re.I)
_VALUE = re.compile(rf"({_NUMBER})\s*({_UNIT})?", re.I)
_TO_MG = {"g": 1000., "mg": 1., "μg": .001, "ug": .001}


def read_startup_pairs(cells, fields: dict) -> None:
    """Collect labelled values from a row of delimited or worksheet startup metadata."""
    for key, value in zip(cells, cells[1:]):
        if not isinstance(key, str) or value in (None, ""):
            continue
        key = key.strip().rstrip(":")
        if key in {"Comment", "Description", "Tester", "Channel"}:
            fields.setdefault(key, str(value))
            continue
        if key not in {"SCap", "C Rate"} and not _MASS_KEY.fullmatch(key):
            continue
        if key in fields and fields[key] != value:
            fields[key] = [fields[key], value]  # preserve conflicting inputs without selecting one
        else:
            fields[key] = value


def _positive(value: str) -> float | None:
    number = float(value.replace(",", "."))
    return number if math.isfinite(number) and number > 0 else None


def _common(values: list[float | None]) -> float | None:
    if not values or values[0] is None:
        return None
    first = values[0]
    return first if all(v is not None and math.isclose(v, first, rel_tol=1e-7) for v in values) else None


def _active_mass_mg(fields: dict) -> float | None:
    entries = list(fields.items())
    for label in ("Comment", "Description"):
        # An explicit assignment can also be entered in a startup note.
        for clause in re.split(r"[;\r\n]", str(fields.get(label) or "")):
            assignment = re.fullmatch(r"\s*([^:=]+?)\s*[:=]\s*(.*?)\s*", clause)
            if assignment:
                entries.append(assignment.groups())
    masses = []
    for key, value in entries:
        label = _MASS_KEY.fullmatch(str(key).strip())
        if not label:
            continue
        parsed = _VALUE.fullmatch(str(value).strip())
        if not parsed:
            return None
        units = {u.casefold() for u in (*label.groups(), parsed[2]) if u}
        number = _positive(parsed[1])
        if len(units) != 1 or number is None:
            return None
        mass = number * _TO_MG[units.pop()]
        masses.append(mass if math.isfinite(mass) and mass > 0 else None)
    return _common(masses)


def normalization(fields: dict) -> dict:
    """Keep the unitless SCap independent of a labelled, unit-bearing active mass."""
    sections = fields.get("Sections")
    if not isinstance(sections, list) or not sections or not all(isinstance(s, dict) for s in sections):
        sections = [fields]
    factors = []
    for section in sections:
        value = str(section.get("SCap", "")).strip()
        factors.append(_positive(value) if re.fullmatch(_NUMBER, value) else None)
    return {"active_mass_mg": _common([_active_mass_mg(s) for s in sections]),
            "maccor_scap": _common(factors)}


def with_normalization(metadata: dict) -> dict:
    values = normalization(metadata["raw"]["Maccor"])
    metadata["raw"]["maccor_normalization"] = values
    metadata.update(values)
    return metadata


def stored_fields(source) -> dict | None:
    extension = extension_key("." + str(source.ext or "").lstrip("."))
    if extension not in {MACCOR_CHANNEL_FORMAT, ".txt", ".csv", ".xlsx"}:
        return None
    if extension == ".xlsx" and source.parser_version and not source.parser_version.startswith("mx:"):
        return None
    fields = (source.header_meta or {}).get("Maccor")
    return fields if isinstance(fields, dict) else None
