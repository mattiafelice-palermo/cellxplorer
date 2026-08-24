# BioLogic MPR format notebook

This is CellXplorer's independent format notebook for the narrow BioLogic EC-Lab MPR layout
supported by Spec 041. It records only facts established from the supplied project-owned sample,
direct byte observations, and project-authored tests. It is not copied from a third-party parser.

## Evidence file

The reference file was used locally from:

```text
BB_eNargiZinc_Discharge-OD19_04_GCPL6_C16.mpr
```

The file is private and is not part of the repository. The observed size is 307,115 bytes. Its first
23 bytes are the ASCII string `BIO-LOGIC MODULAR FILE` followed by byte `0x1a`. The first module
marker is at absolute offset 52.

## Container header and module walk

The supported sample has a 52-byte pre-module header followed by length-delimited modules. The full
52-byte header is the 23-byte signature, 25 ASCII spaces, and four zero bytes. Each observed module
header is 65 bytes:

| Relative offset | Size | Encoding | Meaning |
| ---: | ---: | --- | --- |
| 0 | 6 | ASCII | fixed `MODULE` marker |
| 6 | 10 | ASCII | short module name |
| 16 | 25 | ASCII | long module name |
| 41 | 4 | little-endian uint32 | maximum module size; sample uses `0xffffffff` |
| 45 | 4 | little-endian uint32 | payload length |
| 49 | 4 | little-endian uint32 | old module version; sample uses `0` |
| 53 | 4 | little-endian uint32 | current module version |
| 57 | 8 | ASCII | date text, `MM/DD/YY` in the sample |

The payload starts at `module_offset + 65` and ends at `payload_start + payload_length`. The next
module must begin immediately at that declared end with the six-byte marker `MODULE`; the final
module must end exactly at the file size. CellXplorer walks those boundaries sequentially and never
splits the complete file on the marker string.

The supplied sample has exactly these modules:

| Absolute offset | Short name | Long name | Version | Payload length | End offset |
| ---: | --- | --- | ---: | ---: | ---: |
| 52 | `VMP Set` | `VMP settings` | 10 | 6,953 | 7,070 |
| 7,070 | `VMP data` | `VMP data` | 11 | 291,606 | 298,741 |
| 298,741 | `VMP LOG` | `VMP LOG` | 10 | 8,309 | 307,115 |

Unknown optional modules may be retained as structural descriptors but are not interpreted by the
reader. The supported GCPL layout requires exactly one VMP Set module and one VMP data module. The
VMP LOG module is optional at the low-level boundary and is exposed without guessing its fields.

## VMP data block

For the supported VMP data version 11 layout:

| Payload offset | Size | Encoding | Meaning |
| ---: | ---: | --- | --- |
| 0 | 4 | little-endian uint32 | number of datapoints: 5,483 in the sample |
| 4 | 1 | uint8 | number of columns: 16 in the sample |
| 5 | `2 * n_columns` | big-endian uint16 | encoded column identifiers |
| 37 | 970 | opaque layout prefix | reserved/format-specific bytes for this layout |
| 1,007 | `n_datapoints * actual_stride` | typed records | registry-resolved packed record area |

The sample's encoded column identifiers, in order, are:

```text
1, 2, 3, 21, 31, 65, 131, 4, 7, 13, 5, 6, 9, 39, 211, 468
```

The production reader resolves each full encoded ordinary ID through `encoded_id % 256` against
the project-owned 100-entry storage registry. The full encoded IDs remain in diagnostics; the
modulo operation selects only the storage definition and never rewrites source evidence. The
first six IDs, `1, 2, 3, 21, 31, 65`, are exact logical flag IDs sharing one physical byte at
offset 0. Required GCPL storage bases are `131`, `4`, `7`, `5`, `6`, `211`, and `212` (the
baseline source uses encoded ID `468` for base `212`). Other registry-known columns may appear in
any order and are either decoded into a named raw field or retained as a known-but-ignored
diagnostic column. The reader derives the actual record stride from the payload and requires the
sum of all known widths to equal it. An unknown width before every required field is located fails
closed; unknown IDs are accepted only as an opaque suffix after the required fields, with no
inferred offsets. The reader uses one explicit-offset NumPy structured dtype from the payload; it
does not decode records with a Python per-row loop.

The observed baseline sequence remains 53 bytes and is decoded with the physical fields `131`
(sample sequence), `4` (elapsed time), `7` (incremental charge), `13` (charge relative to origin),
`5` (control), `6` (Ewe-labeled potential), `9` (Ece-labeled potential), `39` (current range),
`211` (charge/discharge quantity), and `468` (half-cycle index). The Spec 051 extended sequence
adds `379 -> 123`, `124`, `125`, `126`, and `182`, producing a 93-byte stride while preserving
the baseline offsets. Encoded IDs such as `262 -> 6`, `635 -> 123`, and `724 -> 212` exercise the
same rule. The five flag IDs after the physical byte are packed aliases; they do not create
synthetic duplicate byte ranges.

The names `Ns`, `Ewe`, and `Ece` are source-label interpretations at the low-level boundary. The
GCPL adapter in 041.3 assigns the canonical roles only after the source configuration is resolved:
Ewe/Ece together are a synchronized three-electrode pair. If the registry-resolved source omits
Ece, the adapter does not fabricate a counter potential; it may still expose a directly measured
primary voltage when that field is independently present.

## Typed registry-resolved record

The observed baseline physical dtype is little-endian where applicable and has `itemsize == 53`.

| Encoded ID(s) | Offset | Size | Dtype | Field | Raw meaning | Unit |
| ---: | ---: | ---: | --- | --- | --- | --- |
| `1, 2, 3, 21, 31, 65` | 0 | 1 | `uint8` | `raw_flags` | six logical flags in one packed byte | — |
| `131` | 1 | 2 | `<u2` | `raw_sample_index` | raw sample sequence number | — |
| `4` | 3 | 8 | `<f8` | `elapsed_time_s` | raw elapsed time; not canonical step time | s |
| `7` | 11 | 8 | `<f8` | `raw_dq_mAh` | raw incremental charge | mA.h |
| `13` | 19 | 8 | `<f8` | `raw_q_minus_q0_mAh` | raw charge relative to origin | mA.h |
| `5` | 27 | 4 | `<f4` | `raw_control_v_or_mA` | technique-dependent raw control value | V or mA |
| `6` | 31 | 4 | `<f4` | `raw_ewe_v` | raw Ewe-labeled potential value | V |
| `9` | 35 | 4 | `<f4` | `raw_ece_v` | raw Ece-labeled potential value | V |
| `39` | 39 | 2 | `<u2` | `raw_current_range_code` | raw current-range code | — |
| `211` | 41 | 8 | `<f8` | `raw_q_charge_discharge_mAh` | raw charge/discharge quantity | mA.h |
| `468` | 49 | 4 | `<u4` | `raw_half_cycle_index` | raw half-cycle index | — |

The full encoded ID `468` is retained in the source column list and resolves to registry base `212`
for storage. The same decoder accepts future high-byte encodings such as `724` for that base,
without treating the full IDs as interchangeable evidence. Registry-known fields without a
canonical raw field name remain in `ignored_known_column_ids`; they do not create guessed output
columns. Complete layout diagnostics include the full encoded IDs, resolved base IDs, actual
record stride, named field offsets, known ignored IDs, and any opaque trailing IDs/base IDs.

The first private-sample record begins at absolute offset `8,142` (`7,070 + 65 + 1,007`). The
privacy-safe direct-byte observation below records the exact raw slices used to establish the
partition:

| Field | Relative offset | Hex bytes | Decoded value |
| --- | ---: | --- | ---: |
| `raw_flags` | 0 | `31` | 49 |
| `raw_sample_index` | 1 | `0100` | 1 |
| `elapsed_time_s` | 3 | `00884cfaf31eae40` | 3855.476519004442 |
| `raw_dq_mAh` | 11 | `0000000000000000` | 0.0 |
| `raw_q_minus_q0_mAh` | 19 | `0000000000000000` | 0.0 |
| `raw_control_v_or_mA` | 27 | `7b14f6c0` | -7.690000057220459 |
| `raw_ewe_v` | 31 | `29eab73f` | 1.4368335008621216 |
| `raw_ece_v` | 35 | `3ab41db9` | -0.00015039826394058764 |
| `raw_current_range_code` | 39 | `0a00` | 10 |
| `raw_q_charge_discharge_mAh` | 41 | `0000000000000000` | 0.0 |
| `raw_half_cycle_index` | 49 | `00000000` | 0 |

## Packed flags

The single physical `raw_flags` byte is unpacked into six named NumPy arrays with vectorized masks.
The encoded IDs `1, 2, 3, 21, 31, 65` identify those logical flags; the physical byte is stored
once. Canonical status/step semantics built from these acquisition flags belong to 041.2/041.3.

| Encoded ID | Name | Mask | Shift | Result |
| ---: | --- | ---: | ---: | --- |
| `1` | `mode` | `0x03` | 0 | uint8 code |
| `2` | `oxidation_reduction` | `0x04` | 2 | boolean |
| `3` | `error` | `0x08` | 3 | boolean |
| `21` | `control_changed` | `0x10` | 4 | boolean |
| `31` | `ns_changed` | `0x20` | 5 | boolean |
| `65` | `counter_incremented` | `0x80` | 7 | boolean |

## GCPL settings layout (Spec 041.3)

The supplied EC-Lab 11.60 sample independently identifies the supported modern GCPL settings
contract with all of the following discriminators:

| Fact | Observed value |
| --- | ---: |
| VMP Set module version / old version | `10 / 0` |
| technique discriminator | `0x77` (GCPL) |
| parameter header offset | `0x1847` |
| sequence count | `3` in the sample |
| parameter count | `33` |
| parameter item size | `108` bytes |

The parameter block begins at `0x1847 + 4`. The following is the complete bounded field contract
decoded by `backend/app/services/biologic_gcpl.py`; offsets in the second table are relative to the
first sequence in that block. `f32`/`f64` are little-endian IEEE values, integer fields are little-endian,
and Pascal strings are one-byte-length `cp1252` strings.

| Payload offset | Width/encoding | Meaning |
| ---: | --- | --- |
| `0x0000` | `u8` | GCPL technique discriminator (`0x77`) |
| `0x0007` | Pascal | Comments |
| `0x0107` / `0x010F` / `0x0113` / `0x0117` | `f32` | Active mass (g), molecular weight, atomic weight, acquisition-start raw value |
| `0x011B` | `u16` | Electrons transferred |
| `0x011E` / `0x01C0` / `0x0215` | Pascal | Electrode material, electrolyte, reference-electrode text |
| `0x0211` / `0x024C` | `f32` | Electrode area (cm2), characteristic mass (g) |
| `0x025C` / `0x0260` | `f32` / `u8` | Battery capacity and capacity unit |
| `0x1847` / `0x1849` | `u16` / `u16` | Sequence count (`Ns`) and parameter count (`33`) |

| Relative offset | Width/encoding | Meaning |
| ---: | --- | --- |
| `+0` / `+1` / `+5` | `u8` / `f32` / `u8` | Set I/C, `Is`, current unit |
| `+6` / `+10` / `+14` | `u32` / `f32` / `u32` | Current reference selector, `N`, current-sign selector |
| `+18` / `+22` / `+23` | `f32` / `u8` / `u8` | `t1`, current range, bandwidth |
| `+24` / `+28` / `+32` / `+36` | `f32` | `dE1` (mV), `dt1` (s), `EM` (V), `tM` (s) |
| `+40` / `+44` | `f32` / `u8` | `Im` and current-cutoff unit |
| `+50` / `+54` | `f32` | Voltage range lower/upper bounds |
| `+58` / `+62` / `+63` | `f32` / `u8` / `f32` | `dq`, capacity unit, `dtq` |
| `+67` / `+71` | `f32` / `u8` | `dQM` and capacity-limit unit |
| `+80` / `+84` / `+88` / `+92` | `f32` | `tR`, `dER/dt`, `dER`, `dtR` |
| `+96` | `f32` | Final-voltage test `EL` |
| `+100` / `+104` | `u32` / `u32` | `goto Ns` and repeat count `nc` |

The verified private sample provides representative independent values: three sequences, an active
mass of about `0.001 g`, a sequence-2 current of about `-7.69 mA`, a `0.2 V` sequence-2 `EM`, a
`900 s` post-discharge `tR`, and a final zero-current `tM` of `3,600 s`. Current and capacity units
are normalized to mA and mA.h using validated source unit codes. Explicit C-rate settings are
retained only when the sequence selects C/C×N control; a C-rate is never inferred from active mass.
The current-reference selector is independently verified only for code `2` in this revision; other
selectors fail closed rather than receiving the same current meaning by assumption.

The normalized protocol uses the existing CellXplorer step schema. A voltage limit with no hold
duration is CC until an operational cutoff. A verified voltage target plus hold duration is represented
by the shared CCCV step type; no adapter-only `substeps` field is emitted. A zero-current sequence
with `tM` but no `EM` target is the verified open-circuit/rest representation used by the supplied
sample. An unresolved C-rate direction remains an explicit Control step and does not receive a guessed
charge/discharge or CV meaning. Raw `goto Ns` targets are zero-based and are converted with the same
`+1` adjustment as data rows; raw target zero is retained when `nc cycles` is nonzero, so a loop can
legitimately target the first sequence. `goto Ns` and `nc cycles` are retained as inclusive loop
structure when they are valid; malformed forward or zero repeats are preserved in raw settings and
excluded from structural groups. Instrument protection limits are not fabricated from the GCPL
operating range.

The declared protocol exposes explicit capability facts for protocol availability, explicit rates,
operational cutoffs/limits, loop structure, and semantic condition grammar. BioLogic does not carry
the Neware formula grammar used by the current Chargeability matcher, so
`semantic_conditions_available` is false and the limitation is included in protocol warnings.

## VMP LOG layout (Spec 041.3)

Only the verified identity/timing fields are decoded from the optional VMP LOG version `10` module:

| Payload offset | Meaning |
| ---: | --- |
| `0x0009` | zero-based raw channel index; normalized metadata exposes the one-based display number |
| `0x00AB` | channel serial (`uint16`) |
| `0x0249` | acquisition start as an OLE date (`float64`) |
| `0x0251` | original filename |
| `0x0351` | host |
| `0x0384` | instrument address |
| `0x03B7` / `0x03BE` / `0x03C5` | EC-Lab / server / interpreter versions |
| `0x03CF` | device serial |

The OLE date is exposed as a naive local wall-clock timestamp because the log carries no verified
timezone offset. Canonical timestamps are `acquisition_start + total_time_s`. A missing, truncated,
non-finite, or out-of-range OLE date leaves `absolute_timestamps` false and every canonical timestamp
as `NaT`; file modification time is never used.

## GCPL canonical mapping (Specs 041.2/041.3)

The direct adapter in `backend/app/services/biologic_gcpl.py` (current adapter revision `gcpl10`)
maps the verified records into the
Parent 040 canonical frame. Acquisition order is preserved; `record_index` is the one-based ordinal
`1..n`. The ID-131 value (`raw_sample_index`) is the BioLogic `Ns` programmed-sequence identity and
is zero-based in the verified file. The canonical adapter applies the documented base adjustment
`step_index = raw Ns + 1` (`raw Ns >= 0`); for example, the private sample's raw `Ns=1` belongs to
settings sequence 2 and is published as canonical `step_index=2`.

The adapter keeps the accepted BioLogic sign factor explicit as `+1`: positive canonical current is
charge and negative canonical current is discharge. ID-211 is converted into non-negative,
phase-specific capacity counters relative to each executed step, and its sign must agree with ID-7
and the current direction. Capacity counters must remain monotonic; ambiguous boundary ownership,
error flags, unvalidated counter-increment flags, and unsupported control histories fail closed.
The supplied EGG GCPL6 source also establishes one narrow reset form at an executed `Ns` boundary:
the first active row of the new `Ns` has an ID-211 cumulative charge/discharge quantity near zero
and an ID-7 incremental `dQ` equal to that same short origin interval (about `1.75e-6 mA.h` in the
observed source). The adapter accepts only that active-row counter-origin shape and continues to
reject arbitrary non-zero
boundary transfer; per-step capacity output remains relative to each block's first counter value.
Energy follows Policy C for this layout: no verified vendor energy counter is present, so canonical
energy columns remain unavailable rather than being fabricated.

The verified record layout does not expose a separate full-cycle field. Header inspection remains
record-decode-free and marks a bounded candidate when settings establish either a non-repeating
cycling episode or a simple mixed-direction loop. Full parsing validates the declared per-`Ns`
direction, executed block progression, capacity ownership, and loop wraps before promotion. A
declared loop must contain both charge and discharge sequences; a single-direction repeated loop
is not treated as a sequence of full cycles. When no explicit loop fields are present, the adapter
may accept one stable observed backward `Ns` edge only when the complete forward body and resolved
charge/discharge semantics corroborate that one effective loop. Active preconditioning, branching,
contradictory direction, unresolved controls, and other restarts remain metadata-only with a precise
reason. A valid loop wrap increments the source-local cycle exactly once; an interrupted final
prefix is retained without fabricating its missing phase.

The ID-468 half-cycle remains decoded diagnostic evidence only. It must be finite, integer, and
non-negative, but its starting value, parity, progression, and resets are not converted with an
arithmetic formula and are not a sole step/cycle boundary. Explicit `raw_cycle_index` remains the
strongest identity, followed by protocol/execution loop reconstruction and the bounded
non-repeating cycle-1 convention. The inferred cycle labels are source-local and do not claim an
absolute experiment cycle number or MPR/MPT semantic parity.

### Electrode roles and primary voltage

For the verified three-electrode data header, ID 6 is Ewe (working versus reference) and ID 9 is Ece
(counter versus reference). The canonical adapter publishes both auxiliary columns and computes the
signed primary cell voltage as:

```text
voltage_v = working_potential_v - counter_potential_v
```

The subtraction order is tested with positive and negative counter potentials and is never replaced
with an absolute difference. Metadata records `voltage_v` as the `cell` role,
`voltage_v_origin = derived_working_minus_counter`, and the auxiliary roles as
`working_vs_reference` and `counter_vs_reference`. An explicit source reference-electrode string is
preserved; no battery chemistry is used to invent one.

If a future independently verified two-electrode layout provides Ewe without Ece, the Ewe-labelled
channel is used once as the measured primary `voltage_v`; auxiliary working/counter columns and
capabilities are not fabricated. That semantic rule is not evidence that the current MPR reader
accepts a 49-byte binary record.

### Timestamps and execution time

When the verified VMP LOG OLE timestamp is present, canonical `timestamp` is
`acquisition_start + total_time_s`. The timestamp is a naive local wall-clock value because the log
does not contain a verified timezone offset. If the log is absent or unreliable, the column is
present with `NaT` values and `absolute_timestamps` is false. File modification time is never used.

An executed `step` is a one-based source-local occurrence. Occurrence boundaries are established by
validated zero-based Ns changes, explicit cycle changes when supplied, explicit step-time resets,
and entry/exit from Rest. Half-cycle changes are retained as diagnostic evidence and are not a sole
boundary signal. A
galvanostatic-to-potentiostatic transition within one occurrence stays one step and is classified as
CCCV when the canonical vocabulary supports it. Current, voltage, capacity, rest, loop, and timestamp
settings are retained in the normalized protocol metadata; unsupported Neware condition expressions
are reported through `semantic_conditions_available = false`.

The exact production MPR record layout currently verified here has no separate measured-current
field for potentiostatic rows. A standalone or combined CCCV block therefore fails closed rather
than inferring current from `dq/time`; the direct mapper's dedicated-current path is reserved for a
future byte layout that establishes that field independently.

## Bounds and ownership

The reader rejects files above 8 GiB, walks at most 32 declared modules, and rejects data headers
above 64 columns before decoding. It validates declared module ends, exact record-area size, and the
`n_datapoints * actual_record_stride` multiplication before calling `np.frombuffer`. The stride is
bounded independently, and every named field must fit inside it. An unknown optional module is
preserved as a descriptor and skipped by its declared length.

`read_mpr()` owns a read-only memory map. `MprDocument`/`MprDataBlock` are context managers. Typed
records are copied into an owning NumPy array before return, so ordinary record consumption remains
valid after the context closes. Module payloads remain zero-copy views and must be released before
closing the document; a retained view causes close to fail explicitly and can be released before a
retry. `read_mpr_header()` walks and validates the same container/data-column bounds but leaves
`records=None`, so normalized metadata does not construct a record-sized NumPy array.

## Fail-closed rules

The reader rejects a source when the complete magic header, module marker, declared length, next
boundary, required module count, old/current module versions, column identifiers, required GCPL
fields, record offset, or record-area size is not verified. It also rejects duplicate VMP
data/Set/LOG modules, repeated encoded IDs, duplicate resolved known bases, packed aliases before
physical flag ID 1, and required fields after an opaque suffix. It does not silently infer unknown
widths or offsets, or accept a partial final record. An unknown suffix is retained only as opaque
diagnostic evidence after all required fields are located. An unrelated file is classified as
unsupported; a file with the full MPR signature but a truncated/corrupt header is classified as
invalid.

## Header-only performance evidence

The supplied private sample and its four discharge parts were re-read on
2026-08-16 through the production header reader, canonical parser, isolated
cache builder and stitching path. The exact acceptance and stitch evidence is
recorded in `docs/specs/041.6-scientific-regression-real-file-parity-and-closure.md`.
No paired `.mpt` was available, so `MPR/MPT semantic parity: NOT RUN`; this
does not block the current Parent 041 scope under the user's amendment. The
committed closure test additionally generates 50 bounded MPR files, reads all
50 through `read_gcpl_header_metadata()`, then full-parses the two-cycle
fixture through the normal cache/parser path. The absolute batch timing is
descriptive and machine-specific; the relevant invariants are that header
inspection does not construct a record-sized array, full `np.frombuffer`
decoding occurs only on the full-parse path, and the reader does not create an
inner process pool. The focused reader tests patch the decode operation to
fail if the header path attempts a full decode.

## Provenance and licensing

The implementation is independently authored. The physical offsets and dtypes were rederived from
project-owned bytes: the observed record-area boundary is offset 1,007, the baseline module
remainder is `5,483 * 53`, and a direct-byte probe records the baseline partition, little-endian
encodings, and the first-record values listed below. Spec 051 adds the project-owned storage
registry, modulo-256 ID resolution, explicit per-source stride validation, and independent
extended-layout fixtures. The first six encoded IDs are recorded as logical flags sharing the
packed byte; the remaining IDs are recorded in their declared physical order. No duplicate byte
ranges are invented. Raw field names are descriptive labels
authored for this reader, not canonical CellXplorer semantics. Literal `struct.pack_into` fixture
bytes independently test every field offset and endian choice.

The direct-byte probe used for the notebook reads only the private sample's data-module header and
record area, computes `record_start = data_module_offset + 65 + 1007`, slices each documented field,
and decodes it with the documented `struct` format. It also emits the packed-flag masks as
`(flags & mask) >> shift`; no source or mapping table is read. A separate external GPL runtime was
run only after that direct-byte definition as an output-only comparison oracle. It was not used as
implementation input, and no package, source, comments, dtype table, mapping table, or private
sample entered the repository or runtime. Static tests audit the reader, requirements, and
production entry-point files for prohibited parser dependencies. No MPT file was available, so no
MPT-derived claim is made here.

The low-level reader now accepts any registry-resolved GCPL layout that supplies the required bases,
has a stride matching the declared known widths, or ends with a bounded opaque suffix. The baseline
16-ID/53-byte three-electrode sequence and the Spec 051 21-ID/93-byte extended sequence are covered
by independent byte fixtures. An Ece-omitted layout is safe only when its own declared sequence and
observed stride satisfy that same registry contract; the adapter then reports the missing counter
potential rather than fabricating one.
