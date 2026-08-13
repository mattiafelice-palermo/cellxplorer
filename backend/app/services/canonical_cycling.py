"""CellXplorer canonical cycling data contract and validation (Spec 040.1).

This module is the single, narrow owner of the canonical raw cycling-data
*contract*: the column names/meanings every source adapter must produce, and a
small structural validator that asserts a parsed frame is safe for downstream
scientific code to consume.

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
# to. `working_potential_v` / `counter_potential_v` are reserved names only:
# no adapter or downstream code populates them yet (Spec 040.4).
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

# Bounded vocabulary for capability facts a future adapter may expose about a
# source. Spec 040.1 only reserves these meanings in documentation/constants;
# it does not build the metadata plumbing that would compute or expose them
# (that is Spec 040.4, extending Parent 039's existing
# `Excel.Capabilities.*` representation in `neware_excel.py` /
# `parsing.read_header_metadata`, not a new competing schema).
CANONICAL_CAPABILITIES: tuple[str, ...] = (
    "cycling_rows",
    "absolute_timestamps",
    "declared_protocol",
    "primary_voltage",
    "working_potential",
    "counter_potential",
)

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
