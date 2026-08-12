# Neware Excel Export Variant Findings

Date: 2026-08-12

Status: **open** — diagnosed, not fixed. No code change has been made for this.

## Symptom

Importing a Neware `.xlsx` export fails in the import wizard with:

> Neware Excel export is missing required record column: Cycle Index.

Observed on `NG_20251127_LFP_LP_MoL_376_FM_CY_FC_Continue.xlsx` (19.3 MB, 145,152 record
rows, test span 2025-12-18 → 2026-02-28).

The file is not corrupt. It is a **second variant** of the structured Neware Excel export,
with a different header dialect from the one Spec 039 was implemented against.

## Where the error comes from

`_require_columns` in `backend/app/services/neware_excel.py` checks the record sheet against
`REQUIRED_RECORD_HEADERS` and raises `UnsupportedNewareExcelError` naming **only the first**
missing column. `Cycle Index` is simply the first mismatch encountered, not the only one —
aliasing that single header would surface `Step Index` next, then the two time columns.

## What actually differs

The workbook has the expected sheet set: `unit`, `test`, `cycle`, `step`, `record`, `log`,
`idle`, `curve`.

### `record` sheet (28 columns)

| Parser expects (`REQUIRED_RECORD_HEADERS`) | This workbook has |
| --- | --- |
| `Cycle Index` | `Cycle ID` |
| `Step Index` | `Step ID` |
| `Time(min)` | `Time` |
| `Total Time(min)` | `Total Time` |

The other required record headers match exactly: `DataPoint`, `Step Type`, `Current(mA)`,
`Voltage(V)`, `Chg. Cap.(mAh)`, `DChg. Cap.(mAh)`, `Date`, `Power(W)`.

Full observed header row:

```
DataPoint, Cycle ID, Step ID, Step Type, Time, Total Time, Current(mA), Voltage(V),
Capacity(mAh), Spec. Cap.(mAh/g), Chg. Cap.(mAh), Chg. Spec. Cap.(mAh/g), DChg. Cap.(mAh),
DChg. Spec. Cap.(mAh/g), Energy(Wh), Spec. Energy(mWh/g), Chg. Energy(Wh),
Chg. Spec. Energy(mWh/g), DChg. Energy(Wh), DChg. Spec. Energy(mWh/g), Date, Power(W),
dQ/dV(mAh/V), dQm/dV(mAh/V.g), Contact resistance(mΩ), Module start-stop switch,
SOC/DOD(%), LgD
```

### `step` sheet

Has `Step Time`; parser's `STEP_HEADERS` requires `Step Time(min)`. All other required step
headers match, and this sheet does use `Cycle Index` / `Step Index`.

### `cycle` sheet

Has `Chg. Time` / `DChg. Time`; parser's `_CYCLE_HEADERS` requires `Chg. Time(min)` /
`DChg. Time(min)`.

More significantly, **`Chg.-DChg. Eff(%)` is absent entirely** from this variant, and
`_CYCLE_HEADERS` currently requires it.

Observed header row:

```
Cycle Index, Chg. Cap.(mAh), DChg. Cap.(mAh), Chg. Energy(Wh), DChg. Energy(Wh),
Constant Curr. Chg. Ratio(%), Constant Curr. Chg. Cap.(mAh), Plat. Cap.(mAh),
Plat. Cap.2(mAh), Plat. Cap.3(mAh), Plat. Time, Plat. Time2, Plat. Time3,
Chg. Time, DChg. Time
```

Note the naming is **inconsistent within a single workbook**: `cycle` and `step` say
`Cycle Index`, while `record` says `Cycle ID`. Any fix therefore needs per-sheet alias
handling, not one global rename.

## The durations are not numeric minutes

This is the part that makes the fix more than a rename. In this variant the duration columns
hold **`HH:MM:SS` strings**, where hours accumulate without rolling into days:

| Record row | `Time` | `Total Time` |
| --- | --- | --- |
| 1 | `00:00:00` | `00:00:00` |
| 500 | `02:34:10` | `06:07:28` |
| 5,000 | `01:09:10` | `60:32:41` |
| 50,000 | `02:19:10` | `585:58:57` |
| 145,152 (last) | `00:02:10` | `1697:53:24` |

`1697:53:24` is ≈70.7 days, consistent with the 2025-12-18 → 2026-02-28 test span. The hours
field is unbounded, so parsing is a plain `split(":")` with an unbounded first component —
but these values are **not interchangeable** with the numeric `(min)` columns the parser
reads today.

The current code reads the numeric minutes and multiplies by `60.0` to reach seconds
(`neware_excel.py` around lines 838-846 for records, 1034 for step summaries), and the plan
builder converts minutes with `step_time_min * 60.0 * 1000.0` near line 635. All of those
sites assume a number.

The same `HH:MM:SS` formatting appears in the `cycle` sheet (`Chg. Time`, `DChg. Time`,
`Plat. Time*`) and the `step` sheet (`Step Time`).

## No header aliasing exists today

The only alias map in `neware_excel.py` is `_step_type_id`'s step *type* table
(`cc chg` → `cc charge`, etc., around line 404) plus `_STATUS_ALIASES` at line 145. There is
no mechanism for header-name variance.

## What a fix needs

1. **Per-sheet header aliases** — `Cycle ID`↔`Cycle Index`, `Step ID`↔`Step Index`,
   `Time`↔`Time(min)`, `Total Time`↔`Total Time(min)`, `Step Time`↔`Step Time(min)`,
   `Chg. Time`↔`Chg. Time(min)`, `DChg. Time`↔`DChg. Time(min)`.
2. **An `H+:MM:SS` → seconds duration parser**, applied when the unit-less variant is in use,
   covering unbounded hours. Every existing `* 60.0` conversion site must go through one
   shared helper so the two dialects cannot diverge.
3. **`Chg.-DChg. Eff(%)` becomes optional** in `_CYCLE_HEADERS`, derived as
   `DChg. Cap. / Chg. Cap. * 100` when absent (guarding division by zero).

### Open design question

Whether to treat this as a **detected variant** (probe which dialect the workbook uses, then
commit to that interpretation for the whole file) or as **loose per-column fallback** (accept
either name anywhere).

Recommendation: detected variant. It keeps the parser failing loudly on genuinely malformed
or half-written exports, instead of silently half-matching a corrupt file — which is the
property the current strict `_require_columns` was giving us for free.

### Scope note

This widens the accepted input contract, so it belongs as a Spec 039 follow-up child rather
than a patch, and it needs a committed fixture workbook of the new dialect. The existing
Excel fixtures cover only the `(min)` dialect, so a regression test for the numeric variant
must be kept alongside the new one — the two dialects need parallel coverage, and the
existing golden-analysis expectations must stay unchanged.

## Reproduction

```
C:\Users\matti\Downloads\MoLs\LP_MoL_376\NG_20251127_LFP_LP_MoL_376_FM_CY_FC_Continue.xlsx
```

Import via the cell-loading wizard; the failure appears at the inspection step in the third
modal, per-file.

## Relevant code

- `backend/app/services/neware_excel.py`
  - `REQUIRED_RECORD_HEADERS` — line ~95
  - `STEP_HEADERS` — line ~117
  - `_CYCLE_HEADERS` — line ~72
  - `_header_map` / `_require_columns` — lines ~703 and ~734 (error text at ~744)
  - record time conversion — lines ~838-846
  - step summary time conversion — line ~1034
  - plan step time conversion — line ~635
- Spec: `docs/specs/039-neware-excel-export-support.md` and its `039.1` timeseries-parser child
