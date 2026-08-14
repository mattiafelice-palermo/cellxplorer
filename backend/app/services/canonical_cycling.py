"""CellXplorer canonical cycling data contract and validation (Spec 040.1,
extended by Spec 040.4 for multi-voltage capability).

This module is the single, narrow owner of the canonical raw cycling-data
*contract*: the column names/meanings every source adapter must produce, and a
small structural validator that asserts a parsed frame is safe for downstream
scientific code to consume. It also owns the bounded voltage-role capability
representation (`voltage_capabilities`, `VOLTAGE_QUANTITIES`) that
`parsing.read_header_metadata` and `analysis_engine.compute_time_capacity`
build on (Spec 040.4).

It deliberately owns nothing else:

- it does not parse any source format (`parsing.py`, `neware_excel.py` own that);
- it does not build or read caches (`cache.py` owns that);
- it does not compute cycle/step aggregates (`calc.py`, `step_blocks.py` own that);
- it does not reconstruct protocol structure (`protocol.py` owns that).

See ``docs/agent-knowledge/canonical-cycling-data.md`` for the full narrative
contract (why the model is Neware-like, the verified current-sign convention,
programmed vs. executed step identity, etc). This module is the enforceable,
testable half of that document; the Markdown file is the explanatory half.

``CANONICAL_RAW_VERSION`` names the contract described here. It is not yet
wired into any parser identity or cache key — that is Spec 040.3's job — but a
future bump of this constant is the signal that the *meaning* of a canonical
column changed, independent of which adapter produced it.
"""
from __future__ import annotations

import warnings
from typing import Any

import numpy as np
import pandas as pd

CANONICAL_RAW_VERSION = 1

# Every source that claims normal cycling capability must produce all of
# these columns. This is Parent 040's "Required core columns" table minus
# `timestamp`: current binary Neware parsing only adds a `timestamp` column
# when NewareNDA's own output happens to include one (see
# `parsing.parse_timeseries`'s `if "timestamp" in df.columns:` guard), so
# nothing in the current codebase actually guarantees the column exists.
# Treating it as required here would let this validator start rejecting an
# already-supported source with no scientific basis for the new failure,
# which Spec 040.1 forbids. `timestamp` is therefore validated as a standard
# *optional* column instead — see `docs/agent-knowledge/canonical-cycling-data.md`
# point 8 for the full reasoning.
REQUIRED_CYCLING_COLUMNS: tuple[str, ...] = (
    "record_index",
    "cycle",
    "step_index",
    "step",
    "status",
    "time_s",
    "voltage_v",
    "current_ma",
    "charge_capacity_mah",
    "discharge_capacity_mah",
)

# First-class canonical fields a source may provide without being required
# to. `working_potential_v` / `counter_potential_v` flow end to end as of
# Spec 040.4 (cache/stitch/Time-Capacity API/UI/export/saved-plot/portable),
# BioLogic's GCPL adapter is the first shipped source that populates them.
STANDARD_OPTIONAL_COLUMNS: tuple[str, ...] = (
    "total_time_s",
    "charge_energy_mwh",
    "discharge_energy_mwh",
    "timestamp",
    "working_potential_v",
    "counter_potential_v",
)

# Status vocabulary actually verified to exist in current production code as
# of this child (binary NewareNDA output across the four golden-corpus
# sources, and `neware_excel._STATUS_ALIASES`). This is documentation only —
# the validator never rejects an unrecognized status string; see
# `docs/agent-knowledge/canonical-cycling-data.md` point 3. Notably `CV_DChg`
# is NOT in this list: it appears in the Spec 040 parent's illustrative table
# but neither the binary golden corpus nor `neware_excel._STATUS_ALIASES`
# currently produce or accept it.
KNOWN_STATUS_VALUES: tuple[str, ...] = (
    "Rest",
    "CC_Chg",
    "CC_DChg",
    "CV_Chg",
    "CCCV_Chg",
    "CCCV_DChg",
)

# Bounded vocabulary for capability facts a source may expose. Spec 040.1
# reserved these meanings in documentation/constants only. Spec 040.4 built
# the metadata plumbing for the three voltage-role names — see
# `voltage_capabilities()` below, wired into `parsing.read_header_metadata`
# (extending Parent 039's existing `Excel.Capabilities.*` representation in
# `neware_excel.py`, not a new competing schema) and into
# `analysis_engine.compute_time_capacity`'s data-driven `voltage_channels`.
# `cycling_rows`, `absolute_timestamps` and `declared_protocol` remain
# reserved-only; no consumer computes them yet.
CANONICAL_CAPABILITIES: tuple[str, ...] = (
    "cycling_rows",
    "absolute_timestamps",
    "declared_protocol",
    "primary_voltage",
    "working_potential",
    "counter_potential",
)

# Spec 040.4: stable internal quantity IDs used by the Time/Capacity API and
# saved-plot settings, mapped to the canonical raw column each one reads.
# `voltage` is the default/compatibility quantity and stays that way
# everywhere a caller does not explicitly request an electrode potential.
VOLTAGE_QUANTITIES: dict[str, str] = {
    "voltage": "voltage_v",
    "working_potential": "working_potential_v",
    "counter_potential": "counter_potential_v",
}
DEFAULT_VOLTAGE_QUANTITY = "voltage"

# Default, source-neutral role/label vocabulary for `voltage_capabilities()`
# below. Adapters pass non-default role/capability facts only when the source
# layout proves them.
_DEFAULT_VOLTAGE_ROLE_LABELS: dict[str, str] = {
    "cell": "Cell voltage (V)",
    "working_vs_reference": "Working potential vs ref (V)",
    "counter_vs_reference": "Counter potential vs ref (V)",
}


def voltage_capabilities(
    *,
    working_potential_available: bool = False,
    counter_potential_available: bool = False,
    voltage_role: str = "cell",
    reference_electrode: str | None = None,
    voltage_derived: bool = False,
    voltage_origin: str | None = None,
) -> dict[str, Any]:
    """Bounded voltage-role capability representation (Spec 040.4 parent).

    A pure, source-neutral computation — it never reads a file or a cache; a
    caller (an adapter's header-metadata read, or a Time/Capacity data-driven
    availability check) supplies the facts it already knows. Returns exactly
    the conceptual shape documented in
    ``docs/specs/040.4-canonical-multi-voltage-path.md`` and
    ``docs/agent-knowledge/canonical-cycling-data.md``:

    - ``capabilities``: which of the three canonical voltage columns this
      source/selection actually has;
    - ``voltage_roles``: what each present voltage column means. Only
      channels marked available get an entry — this function never invents a
      role for a column that is not there;
    - ``reference_electrode``: explicit source-declared text only, never
      fabricated (``None`` when the source did not say);
    - ``voltage_v_derived``: whether ``voltage_v`` was computed by the
      adapter from the two electrode potentials rather than measured
      directly (Parent 040's ``voltage_v = working_potential_v -
      counter_potential_v`` case).
    """
    roles: dict[str, str] = {"voltage_v": voltage_role}
    if working_potential_available:
        roles["working_potential_v"] = "working_vs_reference"
    if counter_potential_available:
        roles["counter_potential_v"] = "counter_vs_reference"
    result = {
        "capabilities": {
            "primary_voltage": True,
            "working_potential": working_potential_available,
            "counter_potential": counter_potential_available,
        },
        "voltage_roles": roles,
        "reference_electrode": reference_electrode,
        "voltage_v_derived": voltage_derived,
    }
    if voltage_origin is not None:
        result["voltage_v_origin"] = voltage_origin
    return result


def voltage_quantity_label(quantity: str, *, role: str | None = None) -> str:
    """Default truthful label for a stable voltage quantity ID.

    ``role`` lets a caller with real capability metadata (e.g. a future
    adapter's declared ``voltage_roles``) select the matching label instead
    of the default; unrecognized roles fall back to the quantity's own
    default label rather than raising, since a label is presentation, not a
    contract.
    """
    default_role = {
        "voltage": "cell",
        "working_potential": "working_vs_reference",
        "counter_potential": "counter_vs_reference",
    }.get(quantity)
    chosen_role = role or default_role
    if chosen_role and chosen_role in _DEFAULT_VOLTAGE_ROLE_LABELS:
        return _DEFAULT_VOLTAGE_ROLE_LABELS[chosen_role]
    return _DEFAULT_VOLTAGE_ROLE_LABELS.get(default_role or "", quantity)

# "Tiny floating-point tolerance" per the spec's `total_time_s` monotonicity
# rule. Matches the tolerance `neware_excel.py` already uses internally
# (`1e-9`) with a small margin.
_TOTAL_TIME_TOLERANCE_S = 1e-6

# Tolerance for "integer-like" checks on `record_index`/`cycle`.
_INTEGER_TOLERANCE = 1e-6

# Tolerance for "clearly negative" rejections on non-negative-by-meaning
# columns (elapsed time, accumulated capacity/energy counters).
_NEGATIVE_TOLERANCE = 1e-6


class CanonicalCyclingError(ValueError):
    """Raised when a parsed frame does not satisfy the canonical raw contract.

    Every raise site names the specific canonical column/property that broke,
    so a caller sees which part of the contract failed rather than a bare
    assertion.
    """


def _numeric_with_malformed_check(df: pd.DataFrame, column: str) -> pd.Series:
    """Return ``column`` coerced to float64, raising on unparsable values.

    A value already null (NaN/None/empty string) stays null and is not a
    failure by itself; a value that is present but cannot be interpreted as a
    number is the "malformed" case the spec's test 9 describes.
    """
    series = df[column]
    if pd.api.types.is_numeric_dtype(series):
        return series.astype("float64")

    text = series.astype("string")
    originally_present = text.notna() & (text.str.strip() != "")
    numeric = pd.to_numeric(series, errors="coerce")
    malformed = originally_present & numeric.isna()
    if bool(malformed.any()):
        raise CanonicalCyclingError(
            f"canonical column '{column}' contains non-numeric value(s) that "
            "cannot be safely interpreted"
        )
    return numeric.astype("float64")


def _check_numeric_column(
    df: pd.DataFrame,
    column: str,
    *,
    allow_negative: bool = True,
    numeric: pd.Series | None = None,
) -> None:
    """Check finiteness/sign of ``column``.

    ``numeric`` lets a caller that already ran `_numeric_with_malformed_check`
    (e.g. to also run `_check_integer_like`) pass the coerced series down
    instead of coercing the same column twice.
    """
    if column not in df.columns:
        return
    if numeric is None:
        numeric = _numeric_with_malformed_check(df, column)
    present = numeric.notna().to_numpy()
    values = numeric.to_numpy(dtype="float64")

    non_finite = present & ~np.isfinite(np.where(present, values, 0.0))
    if non_finite.any():
        raise CanonicalCyclingError(
            f"canonical column '{column}' contains non-finite value(s) (inf/-inf)"
        )

    if not allow_negative:
        negative = present & (values < -_NEGATIVE_TOLERANCE)
        if negative.any():
            raise CanonicalCyclingError(
                f"canonical column '{column}' contains negative value(s), which "
                "is scientifically impossible for this field"
            )


def _check_integer_like(
    df: pd.DataFrame,
    column: str,
    *,
    numeric: pd.Series | None = None,
) -> None:
    if column not in df.columns:
        return
    if numeric is None:
        numeric = _numeric_with_malformed_check(df, column)
    present = numeric.notna().to_numpy()
    if not present.any():
        return
    values = numeric.to_numpy(dtype="float64")
    rounded = np.round(values)
    mismatched = present & (np.abs(values - rounded) > _INTEGER_TOLERANCE)
    if mismatched.any():
        raise CanonicalCyclingError(
            f"canonical column '{column}' must be integer-like; found "
            "non-integer value(s)"
        )


def _check_record_index(df: pd.DataFrame) -> None:
    column = "record_index"
    if column not in df.columns:
        return
    series = df[column]
    if bool(series.isna().any()):
        raise CanonicalCyclingError(
            "canonical column 'record_index' must not contain missing values"
        )
    numeric = _numeric_with_malformed_check(df, column)
    _check_numeric_column(df, column, numeric=numeric)
    _check_integer_like(df, column, numeric=numeric)
    if bool(series.duplicated().any()):
        raise CanonicalCyclingError(
            "canonical column 'record_index' must be unique within one source"
        )


def _check_cycle(df: pd.DataFrame) -> None:
    column = "cycle"
    if column not in df.columns:
        return
    numeric = _numeric_with_malformed_check(df, column)
    _check_numeric_column(df, column, numeric=numeric)
    _check_integer_like(df, column, numeric=numeric)


def _check_step_index(df: pd.DataFrame) -> None:
    column = "step_index"
    if column not in df.columns:
        return
    numeric = _numeric_with_malformed_check(df, column)
    _check_numeric_column(df, column, numeric=numeric)
    _check_integer_like(df, column, numeric=numeric)


def _check_step(df: pd.DataFrame) -> None:
    column = "step"
    if column not in df.columns:
        return
    numeric = _numeric_with_malformed_check(df, column)
    _check_numeric_column(df, column, numeric=numeric)
    _check_integer_like(df, column, numeric=numeric)


def _check_step_identity_consistency(df: pd.DataFrame) -> None:
    """One executed `step` may not belong to more than one programmed
    `step_index` — the reverse (one `step_index` reused by many `step`
    values, e.g. a looped protocol segment) is the normal, expected case and
    is deliberately not restricted here.

    This does not reconstruct execution boundaries; it only checks a
    structural consistency property of `step`/`step_index` values the
    adapter already produced.
    """
    if "step" not in df.columns or "step_index" not in df.columns:
        return
    sub = df[["step", "step_index"]].dropna()
    if sub.empty:
        return
    distinct_per_step = sub.groupby("step")["step_index"].nunique()
    offending = distinct_per_step[distinct_per_step > 1]
    if not offending.empty:
        sample = ", ".join(str(value) for value in offending.index[:5])
        raise CanonicalCyclingError(
            "canonical column 'step' maps to more than one programmed "
            f"'step_index' for executed step(s) {sample}; one executed step "
            "occurrence must belong to exactly one programmed step"
        )


def _check_total_time_s(df: pd.DataFrame) -> None:
    column = "total_time_s"
    if column not in df.columns:
        return
    numeric_series = _numeric_with_malformed_check(df, column)
    _check_numeric_column(df, column, allow_negative=False, numeric=numeric_series)
    numeric = numeric_series.to_numpy(dtype="float64")
    if len(numeric) < 2:
        return
    diffs = np.diff(numeric)
    # A NaN diff comes from a missing value on either side and is not itself
    # a decrease; only a real, present decrease beyond tolerance is a
    # violation of "non-decreasing in acquisition order".
    decreasing = np.nan_to_num(diffs, nan=0.0) < -_TOTAL_TIME_TOLERANCE_S
    if decreasing.any():
        raise CanonicalCyclingError(
            "canonical column 'total_time_s' must be non-decreasing in "
            "acquisition order"
        )


def _check_timestamp(df: pd.DataFrame) -> None:
    column = "timestamp"
    if column not in df.columns:
        return
    series = df[column]
    if pd.api.types.is_datetime64_any_dtype(series):
        return
    non_null = series.dropna()
    if non_null.empty:
        return
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            pd.to_datetime(non_null, errors="raise")
    except (TypeError, ValueError) as exc:
        raise CanonicalCyclingError(
            "canonical column 'timestamp' contains value(s) that are not "
            "datetime-compatible"
        ) from exc


def validate_raw_timeseries(
    df: pd.DataFrame,
    *,
    require_cycling: bool = True,
) -> None:
    """Fail clearly when canonical raw structure is unsafe for downstream use.

    This is a scientific *safety check*, not a data-cleaning engine: it never
    mutates ``df``, never reorders rows, never fabricates or infers values,
    and performs no file I/O. It only asserts that columns already present
    are structurally consistent with what `calc.py`/`step_blocks.py`/
    `stitch.py` already assume about them (see
    ``docs/agent-knowledge/canonical-cycling-data.md``).

    Args:
        df: a parsed canonical raw DataFrame, as produced by
            ``parsing.parse_timeseries``.
        require_cycling: when True (the default), every column in
            ``REQUIRED_CYCLING_COLUMNS`` must be present. A future non-cycling
            capability source may call this with ``False`` to validate only
            the columns it actually provides; 040.1 itself always calls with
            the default.

    Raises:
        CanonicalCyclingError: naming the specific broken canonical property.
    """
    if not isinstance(df, pd.DataFrame):
        raise CanonicalCyclingError("canonical raw data must be a pandas DataFrame")

    if require_cycling:
        missing = [column for column in REQUIRED_CYCLING_COLUMNS if column not in df.columns]
        if missing:
            raise CanonicalCyclingError(
                "canonical raw data is missing required cycling column(s): "
                + ", ".join(missing)
            )

    if df.empty:
        return

    _check_record_index(df)
    _check_cycle(df)
    _check_step_index(df)
    _check_step(df)
    _check_step_identity_consistency(df)
    _check_numeric_column(df, "time_s", allow_negative=False)
    _check_total_time_s(df)
    _check_numeric_column(df, "voltage_v")
    _check_numeric_column(df, "current_ma")
    _check_numeric_column(df, "charge_capacity_mah", allow_negative=False)
    _check_numeric_column(df, "discharge_capacity_mah", allow_negative=False)
    _check_numeric_column(df, "charge_energy_mwh", allow_negative=False)
    _check_numeric_column(df, "discharge_energy_mwh", allow_negative=False)
    # Reserved multi-voltage columns (Spec 040.4). No adapter populates them
    # yet, but if one is present it must satisfy the same numeric contract as
    # `voltage_v`. Row-count/index alignment is automatic: a pandas
    # DataFrame cannot hold columns of different lengths.
    _check_numeric_column(df, "working_potential_v")
    _check_numeric_column(df, "counter_potential_v")
    _check_timestamp(df)
