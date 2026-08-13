# Canonical cycling data contract (Spec 040.1)

CellXplorer's raw cycling representation was, until Spec 040, an implicit
Neware-shaped structure owned by whichever parser happened to produce it. This
document is the durable, plain-language half of that contract; the
enforceable half is `backend/app/services/canonical_cycling.py`
(`REQUIRED_CYCLING_COLUMNS`, `STANDARD_OPTIONAL_COLUMNS`,
`validate_raw_timeseries`). Read both together — this file explains *why*,
the module enforces *what*.

Scope note: this child (040.1) only writes the contract, documentation, and a
structural validator. It does not touch parser dispatch (040.2), per-source
cache/provenance identity (040.3), or actual multi-voltage data flow (040.4).

## 1. Why the model is intentionally Neware-like

CellXplorer's existing Neware-derived representation — cycle, programmed
step, executed step, status, step-relative time, signed current, voltage,
capacity/energy counters, timestamp — is already a sound, well-understood
model of battery cycling. Parent 040's locked design principle is that new
source formats *adapt into* this model; CellXplorer does not become a union
of every vendor's native schema. The goal of this child is narrower than a
redesign: give the existing meanings an explicit name and a testable
boundary, without changing what any of them mean or how any existing source
is parsed.

## 2. Programmed `step_index` versus executed `step`

- `step_index` is the **programmed protocol step identity** — which declared
  operation/sequence a row belongs to. A looped protocol (e.g. "repeat steps
  2-4 ten times") reuses the same `step_index` on every pass.
- `step` is the **executed step occurrence identity** — one concrete
  execution block. Each pass through a looped `step_index` gets its own,
  distinct `step` value.

The relationship is one-directional: many `step` values may legitimately
share one `step_index` (normal looping), but one `step` value must never map
to more than one `step_index` — that would mean two different programmed
operations were merged into a single execution block, which is not
representable under the current model. The validator enforces exactly this
one-directional constraint and nothing more; it does not reconstruct
execution boundaries itself. That reconstruction is each adapter's job (see
`neware_excel.py`'s boundary detection in `_frame_from_fast_columns`/
`_parse_records`, keyed on cycle/step_index/status/time_s discontinuities),
because doing it generically in the validator would require the validator to
understand vendor-specific execution semantics it deliberately does not own.

`step_blocks.py` builds on both identities: it groups by `step_index` (or
falls back to `step`) to isolate "every occurrence of this programmed
segment" for its per-block aggregation.

## 3. `time_s` versus `total_time_s`

- `time_s` is **seconds elapsed since the current executed `step` began**. It
  resets to (approximately) zero at every `step` boundary. `calc.per_cycle`
  and `step_blocks.py` both rely on this: they take `max(time_s)` per
  `(cycle, step)` and sum across steps, which only produces a correct
  duration because `time_s` is step-relative, not whole-source elapsed time.
- `total_time_s` is **seconds elapsed since source acquisition began** — an
  auxiliary, standard-optional column. It is monotonically non-decreasing
  (within tiny floating-point tolerance) in normal acquisition order. No
  current scientific calculation reads it; it exists for provenance/display
  and so that a future consumer has a whole-source elapsed axis without
  reconstructing it from per-step `time_s` and step boundaries.

Neither column is redefined by this child. The Excel parser's "record clock"
dialect (see `docs/neware-excel-variant-findings.md` and point 8 below) only
changes *how* `time_s`/`total_time_s` are computed from the source workbook,
never *what they mean*: `time_s` stays step-relative in both dialects.

The binary Neware parser currently never emits `total_time_s` at all — it is
not in `parsing.RAW_COLUMNS`. This is expected: `total_time_s` is
standard-optional, and the validator only checks it when present.

## 4. Current sign convention (verified from current data/tests)

**Positive `current_ma` means charge; negative means discharge.** This was
measured, not assumed, against real production output:

```text
$ python parsing.parse_timeseries(".../cycles_time_steps.ndax") ; groupby(status)["current_ma"]
status                          mean       min          max
CCCV_Chg                  19.248884     2.486   146.210007
CC_Chg                     3.681311     2.496    75.903000
CC_DChg                  -15.918737   -75.903    -2.498000
Rest                        0.000000     0.000     0.000000
```

Source: `tests/fixtures/golden_analysis/sources/cycles_time_steps.ndax`,
parsed through the real production path
(`backend/app/services/parsing.parse_timeseries` → binary Neware /
`NewareNDA.read`). Every `Chg`-phase status is positive, every `DChg`-phase
status is negative, `Rest` is zero. The same convention was independently
confirmed against a synthetic structured-Excel workbook parsed through
`neware_excel.parse_timeseries` (`CC_Chg` → `+1.0 mA`, `CC_DChg` → `-1.0
mA`), and matches the sign convention already assumed by
`tests/test_calc_and_cache.py`'s existing CV-detection fixtures (e.g.
`test_a_cycle_with_no_cv_at_all_is_zero`, which uses `current_ma: [100.0,
-100.0]` for `["CC_Chg", "CC_DChg"]`).

This convention is now locked for every future adapter: an adapter whose
vendor-native sign convention differs must normalize to CellXplorer's
positive-is-charge convention before its output reaches canonical validation
or scientific code. `validate_raw_timeseries` deliberately does **not**
enforce this sign/phase relationship — checking it would require inferring
charge/discharge from current, which the spec's validation boundary
explicitly forbids the validator from doing. The convention is documented and
tested here, and left to `status`-phase classification (`calc.py`'s
`is_chg`/`is_dchg` masks) rather than being re-derived from `current_ma`.

## 5. Primary voltage and multi-voltage electrode potentials (Spec 040.4)

`voltage_v` is the primary, compatibility voltage used by every existing
CellXplorer analysis (Cycles, Time/Capacity, DCIR, Chargeability, Rate
Capability) unless a future reviewed feature explicitly opts into another
channel. For ordinary two-electrode data, `voltage_v` is simply the measured
cell voltage. This does not change with 040.4: every existing analysis still
reads `voltage_v` and only `voltage_v`, and the default Time/Capacity voltage
quantity is still `voltage_v`.

`working_potential_v` and `counter_potential_v` are the canonical names for a
source's synchronized electrode potentials versus a reference. As of 040.4
they flow end to end — canonical raw frame → Parquet cache → selective raw
load → `stitch_raw` → Time/Capacity API/UI/export/saved-plot/portable path —
but **no adapter shipped in Parent 040 populates them**: there is still no
BioLogic (or other three-electrode) parser. Every real source today therefore
reports `working_potential`/`counter_potential` capability as `False` and
every Time/Capacity trace for those channels is empty. The path was built and
proven with a synthetic canonical frame (`tests/test_analysis_engine.py`'s
`synth_three_electrode_raw`, `tests/test_canonical_cycling.py`'s
`_three_electrode_frame`) precisely so a future adapter (Parent 041) does not
have to build or review this plumbing under time pressure.

`validate_raw_timeseries` applies the same numeric-column contract to them as
`voltage_v` (finite, non-malformed) if a source happens to populate them —
this was already true before 040.4 and is unchanged.

### Voltage-role capability vocabulary

`canonical_cycling.voltage_capabilities(...)` (Spec 040.4) is the one bounded,
pure representation of what a source says about its voltage channels:

```python
{
  "capabilities": {"primary_voltage": True, "working_potential": bool, "counter_potential": bool},
  "voltage_roles": {"voltage_v": "cell", ...only-present channels...},
  "reference_electrode": str | None,   # never fabricated
  "voltage_v_derived": bool,           # True only if an adapter computed voltage_v = working - counter
}
```

`parsing.read_header_metadata` calls it with no arguments for both current
formats (binary and Excel), so every recognized source's metadata carries the
default two-electrode shape today — this is a static, format-level fact (no
header inspection can tell you a column that adapter never produces), not a
per-file probe. `canonical_cycling.VOLTAGE_QUANTITIES` (`"voltage"`,
`"working_potential"`, `"counter_potential"` → `voltage_v`,
`working_potential_v`, `counter_potential_v`) is the stable internal quantity
ID vocabulary the Time/Capacity API and saved-plot settings use;
`DEFAULT_VOLTAGE_QUANTITY` is `"voltage"`.

### Time/Capacity availability rule (locked by 040.4)

`analysis_engine.compute_time_capacity` reports **per-selection, data-driven**
availability (`result["voltage_channels"][quantity]["available"]`) — computed
from whether the requested column actually has any finite value anywhere in
the current selection's stitched raw frame, never from a static per-format
declaration. The mixed-sample rule this child chose and locked with tests
(`tests/test_analysis_engine.py::MultiVoltageTimeCapacityTests
::test_mixed_selection_omits_per_cell_rather_than_disabling_whole_quantity`):
when some selected cells have the requested channel and others do not, the
cells without it get an **omitted (all-`None`) trace** — exactly how this
architecture already treats any other cell whose raw frame is missing a
requested column — rather than the whole quantity being marked unavailable
for the entire selection. A cell requesting a channel it does not have never
receives a fabricated value or a silent substitution of `voltage_v`.

### Derivatives stay primary-voltage only

`_derivative_curve` (dQ/dV, dV/dQ) reads `frame["voltage_v"]` directly and
unconditionally — it was never routed through the selected Y channel, so
040.4 made no change to it. The Time/Capacity `voltage_channel` setting only
affects the voltage/current plot; derivative views always compute from
primary voltage regardless of the selected channel
(`tests/test_analysis_engine.py::MultiVoltageTimeCapacityTests
::test_derivative_view_stays_restricted_to_primary_voltage` proves this by
showing the derivative trace is identical between the default channel and an
electrode-potential selection). The frontend only exposes the voltage-channel
selector inside the voltage/current plot mode for the same reason.

## 6. Capacity/energy reset semantics

`charge_capacity_mah`, `discharge_capacity_mah`, `charge_energy_mwh`, and
`discharge_energy_mwh` are accumulated counters that **may legitimately reset
to zero at every executed `step` boundary** (this is how Neware's own
counters behave, and `neware_excel.py`'s reconstructed energy counters follow
the same convention deliberately). `calc.per_cycle` and `step_blocks.py`
already handle this correctly by summing each step's own `(max - min)` delta
rather than taking a per-cycle maximum — see the `phase_total`/
`_sum_step_capacity` docstrings in `calc.py`/`step_blocks.py` for the
regression this fixed (Spec 003).

Because of this, `validate_raw_timeseries` intentionally does **not** require
these columns to be monotonic across a whole cycle — that would reject
perfectly valid data. It only checks that present values are numeric, finite,
and non-negative (a capacity/energy counter can never sensibly go below
zero). It never sums, integrates, or reconstructs these values itself.

## 7. Adapter versus downstream scientific ownership

The boundary is deliberately narrow:

- **Adapters** (`neware_excel.py`, binary dispatch in `parsing.py`, and any
  future format adapter) own: recognizing the source format, reconstructing
  `step`/`cycle`/`status` from vendor-native fields, normalizing vendor
  status strings into CellXplorer's status vocabulary (point 3 below still
  applies — no arbitrary vendor string reaches downstream code), and
  normalizing sign conventions to point 4 above.
- **`canonical_cycling.validate_raw_timeseries`** owns: asserting that
  whatever the adapter produced is structurally safe — required columns
  present, identifiers unique/numeric/finite, no scientifically impossible
  values (negative elapsed time, negative capacity counter, a `step` that
  spans two `step_index` values). It never mutates the frame, never
  reorders it, never fills in missing values, and performs no file I/O.
- **`calc.py`/`step_blocks.py`/`stitch.py`** own: the actual scientific
  aggregation (per-cycle/per-block totals, dense cycle-label stitching
  across sources). They consume validated canonical data; they do not
  re-validate it.

If a check would require inferring, reconstructing, or computing a value
(charge/discharge from current sign, executed-step boundaries, integrated
capacity, a fabricated timestamp), it belongs to the adapter or to scientific
code — never to the validator.

## 8. How a future source format should map into the contract

A new adapter (e.g. a future BioLogic `.mpr` adapter, Parent 041) must:

1. produce a `pandas.DataFrame` with every column in
   `canonical_cycling.REQUIRED_CYCLING_COLUMNS` (`record_index`, `cycle`,
   `step_index`, `step`, `status`, `time_s`, `voltage_v`, `current_ma`,
   `charge_capacity_mah`, `discharge_capacity_mah`) if it claims normal
   cycling capability;
2. translate vendor-native operation modes into CellXplorer's existing
   status vocabulary (point 3) rather than passing vendor strings through —
   an unrecognized operation should become a clearly non-recognized status or
   fail a format-specific capability check, not silently teach downstream
   code a new vendor string;
3. normalize its native current sign convention to point 4 above
   (positive = charge);
4. populate `STANDARD_OPTIONAL_COLUMNS` (`total_time_s`,
   `charge_energy_mwh`, `discharge_energy_mwh`, `timestamp`,
   `working_potential_v`, `counter_potential_v`) only where the source
   actually supports them — absence is a capability fact, never a reason to
   fabricate a value (in particular: never derive a timestamp from file
   modified time, never invent a missing cycle label);
5. get validated by `canonical_cycling.validate_raw_timeseries(df)` before the
   frame reaches scientific code. Today that happens in `cache.build` /
   `cache.build_write_behind` (see "Where validation runs" below) — being
   dispatched from `parsing.parse_timeseries` does **not** get an adapter
   validation for free, because `parse_timeseries` itself deliberately does
   not call the validator. A new adapter added under `parsing.parse_timeseries`
   inherits validation automatically only because every production caller of
   `parse_timeseries` is `cache.build`/`cache.build_write_behind`; an adapter
   that is invoked some other way must call `validate_raw_timeseries` itself
   at its own full-parse boundary;
6. raise the right error type. Since the Spec 040.2 follow-up,
   `backend/app/services/source_format_errors.py` defines the one
   format-neutral base every adapter's source-rejection errors should
   ultimately derive from:

   ```text
   SourceFormatError(ValueError)              # neutral base
   ├── UnsupportedSourceFormatError           # not a recognized source of this format
   └── InvalidSourceFormatError               # recognized, but structurally broken
   ```

   `neware_excel.py` is the reference example: it keeps its own
   `NewareExcelError(ValueError)` base (so `except NewareExcelError` still
   gets Excel-specific detail) and multiply-inherits each subclass from the
   matching neutral type — `UnsupportedNewareExcelError(NewareExcelError,
   UnsupportedSourceFormatError)`, `InvalidNewareExcelError(NewareExcelError,
   InvalidSourceFormatError)`. A future `.mpr` adapter should follow the same
   pattern: keep (or add) an adapter-specific error base for its own
   diagnostic detail, and additionally inherit its "this isn't a `.mpr` file
   at all" error from `UnsupportedSourceFormatError` and its "this is a
   `.mpr` file but structurally broken" error from `InvalidSourceFormatError`
   — both from `source_format_errors`, imported directly, never via `parsing`
   or `neware_excel` (that module must not import either, to avoid a
   circular import with `parsing`, which imports every adapter). Doing this
   means both `except <YourAdapterError>` and `except SourceFormatError`
   correctly catch your adapter's rejections, and `except ValueError` still
   catches everything, without inventing a fourth unrelated exception tree
   that would force every multi-format caller down to `except Exception`.

   Do **not** derive from `canonical_cycling.CanonicalCyclingError` and do
   not make your adapter's errors a base of it either — that error means an
   adapter was recognized and ran, and still produced a structurally invalid
   canonical frame. That is an adapter bug, not a bad source file, and must
   not be catchable by a caller's `except SourceFormatError`.

A worked example of an adapter doing this today, imperfectly parallel to a
future format, is `neware_excel.py`: it reconstructs `step` from
`(cycle, step_index, status, time_s)` discontinuities (`_frame_from_records`
et al.), normalizes vendor step-type strings through `_STATUS_ALIASES`, and
handles two workbook dialects (`docs/neware-excel-variant-findings.md`) while
keeping `time_s` step-relative in both — i.e. the workbook dialect is an
*adapter-internal* detail that never leaks into the canonical meaning of a
column.

Since Spec 040.2, a new adapter also needs a stable format identifier: add a
`SourceFormatDescriptor` (`format_id`, `extensions`, `adapter_revision`) and
an extension entry in `parsing._EXTENSION_FORMAT_ID` alongside
`FORMAT_NEWARE_BINARY`/`FORMAT_NEWARE_EXCEL`, and extend
`parsing.recognize_source`/`parsing.parse_timeseries`/
`parsing.read_header_metadata` dispatch — this is a small static registry
addition, not a plugin system. Add its identity prefix to
`parsing._FORMAT_IDENTITY_PREFIX` (Spec 040.3) so `parsing.parser_identity()`
covers it too; the identity is `<prefix>:<adapter_revision>:r<canonical_raw_version>`
and must stay within `SourceFile.parser_version`'s 30-character bound
(`parsing._MAX_PARSER_IDENTITY_LENGTH` asserts this at construction time
rather than trusting it by eye). A new format's `adapter_revision` changes
only that format's own cache/provenance identity — `cache.build`,
`scanner._has_current_scientific_cache`, and `analysis_engine`'s per-source
resolver all key on `parsing.current_parser_identity_for_extension()` /
`parsing.parser_identity()` per source, never on one shared bundle, so a new
adapter cannot silently invalidate or relabel an existing Neware source's
cache. `parsing.PARSER_VERSION` remains only as a legacy fallback for a
source that predates 040.3 and has no stored `parser_version`.

## Status vocabulary actually verified in current code

Do not trust an illustrative list from a spec without reverifying it — the
Spec 040 parent's own illustrative table includes `CV_DChg`, which does
**not** currently exist anywhere in production code. The verified vocabulary,
checked against `neware_excel._STATUS_ALIASES` and the normalized `status`
values actually observed across all four golden-corpus binary sources
(`chargeability_source.ndax`, `cycles_time_steps.ndax`, `dcir_source.ndax`,
`rate_capability_source.ndax`), is exactly:

```text
Rest
CC_Chg
CC_DChg
CV_Chg
CCCV_Chg
CCCV_DChg
```

`CV_DChg` is absent from both `neware_excel._STATUS_ALIASES` and every
observed binary status set. If a future source genuinely needs it, add it to
`neware_excel._STATUS_ALIASES` (or the binary equivalent) and this list
together, with a fixture proving it is real — do not add it speculatively.

This list (`canonical_cycling.KNOWN_STATUS_VALUES`) is documentation only.
`validate_raw_timeseries` never rejects an unrecognized status string; that
would conflict with the parent's rule that unknown vendor operations may be
preserved as a "clearly non-recognized canonical status" rather than
validated away.

## Reserved capability vocabulary

`canonical_cycling.CANONICAL_CAPABILITIES` names the following meanings,
extending Parent 039's existing `Excel.Capabilities.*` fields in
`neware_excel.py` / `parsing.read_header_metadata` rather than creating a
competing schema:

```text
cycling_rows          — the source can produce normal per-record cycling data
absolute_timestamps   — real calendar timestamps are reconstructable
declared_protocol     — a programmed test plan/protocol is available
primary_voltage       — voltage_v is populated
working_potential     — working_potential_v is populated
counter_potential      — counter_potential_v is populated
```

As of Spec 040.4, `primary_voltage`/`working_potential`/`counter_potential`
are computed and exposed two ways (see "Voltage-role capability vocabulary"
and "Time/Capacity availability rule" above): a static, source-format-level
declaration in `parsing.read_header_metadata`'s `voltage_capabilities` block
(always the two-electrode default today, no adapter varies it), and a
data-driven per-selection availability in
`compute_time_capacity`'s `voltage_channels` response field, which is what
actually drives the frontend selector. `cycling_rows`,
`absolute_timestamps` and `declared_protocol` remain documentation-only
reserved names; no consumer computes them yet.

## Where validation runs

`canonical_cycling.validate_raw_timeseries` is called in `cache.py`, in both
`build()` and `build_write_behind()`, immediately after each calls
`parsing.parse_timeseries(source_path)` and before the result reaches
`calc.per_cycle`. `build()` only validates when it actually parsed from
source (`parsed_from_source`); a raw frame reloaded from an existing Parquet
cache was already validated when it was first written, so it is not
re-coerced/re-checked on every read. `cache.build`/`cache.build_write_behind`
are the only production callers of `parsing.parse_timeseries`, so this is
still a single, non-duplicated boundary — it is just one level below the
dispatch point rather than inside it.

Validation is deliberately **not** inside `parsing.parse_timeseries` itself
(`backend/app/services/parsing.py`), even though that is the single dispatch
point both binary Neware and structured Excel parsing funnel through.
`tests/test_neware_excel.py`'s
`test_parser_dispatch_preserves_binary_and_excel_boundaries` calls
`parsing.parse_timeseries` directly with deliberately minimal/mocked frames
to test dispatch mechanics in isolation, not the canonical contract;
validating inside `parse_timeseries` would reject those frames and break that
test. `parse_timeseries`'s own docstring records this explicitly.

**Practical consequence for a future adapter**: being dispatched from
`parsing.parse_timeseries` does not, by itself, get an adapter validated.
Today's binary/Excel adapters only end up validated because their one
production path to a cache is `cache.build`/`cache.build_write_behind`. A
future adapter invoked through any other path (a new cache entry point, a
standalone import tool, etc.) must call `validate_raw_timeseries` itself.

It deliberately does **not** run on:

- `parsing.read_header_metadata` — a bounded metadata-only read that never
  calls `parse_timeseries`;
- `import_inspection.py` — calls `parsing.read_header_metadata` only;
- `scanner.py`'s non-cache-build paths that also read metadata only.

Any direct call to `parsing.parse_timeseries` or `neware_excel.parse_timeseries`
that bypasses `cache.build`/`cache.build_write_behind` — including the
dispatch-mechanics test above and direct Excel-parser unit tests — does not
trigger canonical validation. Excel-parser unit tests exercise the adapter's
own (narrower, stricter) contract in isolation instead.
