"""Vectorized fast paths for NewareNDA, verified bit-identical.

NewareNDA parses .ndax record-by-record in Python (millions of
struct.unpack calls) and regenerates cycle numbers with a per-row Python
state machine. Both dominate the runtime on large files. This module
provides numpy-vectorized implementations of exactly two leaf functions

  - NewareNDA.NewareNDAx._read_ndc_5_filetype_1   (the data.ndc record loop)
  - NewareNDA.utils._generate_cycle_number        (BTSDA software cycle numbers)

and installs them with install(). All surrounding logic (file orchestration,
aux channels, merges, dtype casts) remains NewareNDA's own code, so output
is identical by construction everywhere except these two functions — and
those are covered by tests/test_fast_neware.py comparing against the
originals. On any input the fast paths don't handle (partial trailing page,
unknown status/range codes), they delegate to the saved originals.

Set CELLXPLORER_FAST_NDAX=0 to disable.
"""
from __future__ import annotations

import logging

import numpy as np
import pandas as pd

import NewareNDA.NewareNDA as _nda_mod
import NewareNDA.NewareNDAx as _ndax_mod
import NewareNDA.utils as _utils_mod
from NewareNDA.dicts import multiplier_dict, state_dict

logger = logging.getLogger(__name__)

_ORIG_READ_5_1 = _ndax_mod._read_ndc_5_filetype_1
_ORIG_GEN_CYCLE = _utils_mod._generate_cycle_number

PAGE = 4096
REC = 87
# per-page payload: bytes[125:-56] of each 4096-byte page = 45 records
PAGE_LO, PAGE_HI = 125, PAGE - 56

# field layout of one 87-byte ndc v5 record (matches _bytes_to_list_ndc)
_REC_DTYPE = np.dtype(
    {
        "names": ["valid", "Index", "Cycle", "Step_Index", "Status", "Time",
                   "Voltage", "Current", "Charge_capacity", "Discharge_capacity",
                   "Charge_energy", "Discharge_energy", "Y", "M", "D", "h", "m",
                   "s", "Range"],
        "offsets": [7, 8, 12, 16, 17, 23, 31, 35, 43, 51, 59, 67, 75, 77, 78,
                     79, 80, 81, 82],
        "formats": ["u1", "<u4", "<u4", "u1", "u1", "<u8", "<i4", "<i4", "<i8",
                     "<i8", "<i8", "<i8", "<u2", "u1", "u1", "u1", "u1", "u1",
                     "<i4"],
        "itemsize": REC,
    }
)

_STATUS_LUT = np.array(
    [state_dict.get(code, "") for code in range(256)], dtype=object
)
_KNOWN_STATUS = np.array([code in state_dict for code in range(256)])


def _fast_read_ndc_5_filetype_1(mm):
    """Vectorized replacement for the per-record struct.unpack loop."""
    size = mm.size() if hasattr(mm, "size") else len(mm)
    n_pages = (size - PAGE) // PAGE
    if n_pages <= 0 or (size - PAGE) % PAGE != 0:
        # partial trailing page — original semantics are subtle, delegate
        return _ORIG_READ_5_1(mm)

    pages = np.frombuffer(mm, dtype=np.uint8, count=n_pages * PAGE, offset=PAGE)
    payload = pages.reshape(n_pages, PAGE)[:, PAGE_LO:PAGE_HI]  # (pages, 45*87)
    recs = np.frombuffer(np.ascontiguousarray(payload).tobytes(), dtype=_REC_DTYPE)
    recs = recs[recs["valid"] == 0x55]

    status_codes = recs["Status"]
    ranges = recs["Range"]
    if not _KNOWN_STATUS[status_codes].all() or not np.isin(
        np.unique(ranges), np.array(list(multiplier_dict))
    ).all():
        return _ORIG_READ_5_1(mm)  # unknown code → original raises its KeyError

    uniq_ranges, inverse = np.unique(ranges, return_inverse=True)
    multiplier = np.array([multiplier_dict[r] for r in uniq_ranges])[inverse]

    # timestamps: numpy datetime arithmetic instead of datetime() per row
    ts = (
        (recs["Y"].astype("int64") - 1970).astype("M8[Y]")
        + (recs["M"].astype("int64") - 1).astype("m8[M]")
        + (recs["D"].astype("int64") - 1).astype("m8[D]")
        + recs["h"].astype("m8[h]")
        + recs["m"].astype("m8[m]")
        + recs["s"].astype("m8[s]")
    ).astype("M8[us]")

    # dtypes chosen to match what pandas infers from the original's Python
    # lists (ints → int64, floats → float64, str objects, datetime64[us])
    df = pd.DataFrame(
        {
            "Index": recs["Index"].astype("int64"),
            "Cycle": recs["Cycle"].astype("int64") + 1,
            "Step_Index": recs["Step_Index"].astype("int64"),
            "Status": pd.Series(_STATUS_LUT[status_codes]),
            "Time": recs["Time"].astype("float64") / 1000,
            "Voltage": recs["Voltage"].astype("float64") / 10000,
            "Current(mA)": recs["Current"].astype("float64") * multiplier,
            "Charge_Capacity(mAh)": recs["Charge_capacity"].astype("float64") * multiplier / 3600,
            "Discharge_Capacity(mAh)": recs["Discharge_capacity"].astype("float64") * multiplier / 3600,
            "Charge_Energy(mWh)": recs["Charge_energy"].astype("float64") * multiplier / 3600,
            "Discharge_Energy(mWh)": recs["Discharge_energy"].astype("float64") * multiplier / 3600,
            "Timestamp": pd.Series(ts),
        }
    )
    df["Step"] = _utils_mod._count_changes(df["Step_Index"])
    return df


def _fast_generate_cycle_number(df, cycle_mode="chg"):
    """Vectorized replacement for the per-row cycle-count state machine.

    Original semantics: walking rows in order, the cycle number increments
    at the START of an incremental (charge, by default) step, but only if a
    'flag' was raised since the previous increment; the flag is raised by
    any opposite-direction (discharge) row or any SIM row. We reproduce
    this exactly by extracting the event rows vectorized and walking only
    the events (hundreds) instead of the rows (millions).
    """
    if cycle_mode.lower() == "auto":
        cycle_mode = _utils_mod._id_first_state(df)

    if cycle_mode.lower() == "chg":
        inkey, offkey = "Chg", "DChg"
    elif cycle_mode.lower() == "dchg":
        inkey, offkey = "DChg", "Chg"
    else:
        logger.error(
            f"Cycle_Mode '{cycle_mode}' not recognized. Supported options are 'chg', 'dchg', and 'auto'."
        )
        raise KeyError(
            f"Cycle_Mode '{cycle_mode}' not recognized. Supported options are 'chg', 'dchg', and 'auto'."
        )

    status = df["Status"]
    n = len(status)
    if n == 0:
        return np.array([], dtype="int64")

    # rising edges of incremental steps ((inc - inc.shift()).clip(0), [0]=1)
    inc_bool = status.isin([f"CCCV_{inkey}", f"CC_{inkey}", f"CP_{inkey}"]).to_numpy()
    rising = inc_bool.copy()
    rising[1:] = inc_bool[1:] & ~inc_bool[:-1]
    rising[0] = True

    # flag-raising rows: split-state == offkey, or SIM
    uniq = pd.unique(status)
    off_statuses = [
        u for u in uniq if isinstance(u, str) and "_" in u and u.split("_", 1)[1] == offkey
    ]
    flag_bool = status.isin(off_statuses).to_numpy() | (status == "SIM").to_numpy()

    inc_idx = np.flatnonzero(rising)
    flag_idx = np.flatnonzero(flag_bool)

    # walk events only: increment at a rising edge iff a flag was raised
    # since the last increment (flag events never share a row with a rising
    # edge — those rows carry the inkey status)
    bumps = []
    fptr = 0
    has_flag = False
    n_flags = len(flag_idx)
    for i in inc_idx:
        while fptr < n_flags and flag_idx[fptr] < i:
            has_flag = True
            fptr += 1
        if has_flag:
            bumps.append(i)
            has_flag = False

    cyc = np.zeros(n, dtype="int64")
    cyc[np.asarray(bumps, dtype="int64")] = 1
    return np.cumsum(cyc) + 1


def install() -> None:
    """Install the fast paths into NewareNDA (idempotent)."""
    if _ndax_mod._read_ndc_5_filetype_1 is _fast_read_ndc_5_filetype_1:
        return
    _ndax_mod._read_ndc_5_filetype_1 = _fast_read_ndc_5_filetype_1
    # _generate_cycle_number was imported by value into both entry modules
    _utils_mod._generate_cycle_number = _fast_generate_cycle_number
    _ndax_mod._generate_cycle_number = _fast_generate_cycle_number
    _nda_mod._generate_cycle_number = _fast_generate_cycle_number
    logger.info("NewareNDA fast paths installed")


def uninstall() -> None:
    _ndax_mod._read_ndc_5_filetype_1 = _ORIG_READ_5_1
    _utils_mod._generate_cycle_number = _ORIG_GEN_CYCLE
    _ndax_mod._generate_cycle_number = _ORIG_GEN_CYCLE
    _nda_mod._generate_cycle_number = _ORIG_GEN_CYCLE
