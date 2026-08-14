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
| 1,007 | `n_datapoints * 53` | opaque records | 53-byte packed record area |

The sample's encoded column identifiers, in order, are:

```text
1, 2, 3, 21, 31, 65, 131, 4, 7, 13, 5, 6, 9, 39, 211, 468
```

The reader accepts exactly this identifier ordering and record layout, or exactly the same ordering
with only the Ece channel (`9`) omitted, yielding a compact 49-byte two-electrode record. Unknown
IDs, reordered fields, duplicate physical fields, and any other omission fail closed. The reader
validates the record-area multiplication and uses one NumPy structured dtype from the memory-mapped
payload; it does not decode records with a Python per-row loop. The first six IDs, `1, 2, 3, 21, 31,
65`, are logical flags sharing the one physical byte at offset 0. The remaining physical fields
follow as `131` (sample sequence), `4` (elapsed time), `7` (incremental charge), `13` (charge
relative to origin), `5` (control), `6` (Ewe-labeled potential), optional `9` (Ece-labeled
potential), `39` (current range), `211` (charge/discharge quantity), and `468` (half-cycle index).
The five flag IDs after the physical byte are validated as packed-flag aliases; they do not create
synthetic duplicate byte ranges.

The names `Ns`, `Ewe`, and `Ece` are source-label interpretations at the low-level boundary. The
GCPL adapter in 041.3 assigns the canonical roles only after the source configuration is resolved:
Ewe/Ece together are a synchronized three-electrode pair; Ewe without Ece is the measured primary
two-electrode voltage.

## Typed 53-byte record

The physical record dtype is little-endian where applicable and has `itemsize == 53`:

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

The full encoded ID `468` is required for the final field. It is not normalized with `% 256` and is
not silently replaced with the low-byte value `212`.

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

The direct adapter in `backend/app/services/biologic_gcpl.py` maps the verified records into the
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
Energy follows Policy C for this layout: no verified vendor energy counter is present, so canonical
energy columns remain unavailable rather than being fabricated.

The supplied sample's ID-468 half-cycle is constant zero, so it does not by itself establish a
multi-cycle identity. The current direct parser therefore remains intentionally fail-closed for
that real-file canonical mapping until an independent cycle ground truth is available; this is not
a claim of MPR/MPT parity. Synthetic mapper tests exercise explicit cycle fields and do not silently
promote that evidence to the private file.

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

For the bounded two-electrode layout, Ece is absent and the Ewe-labelled channel is used once as the
measured primary `voltage_v`; auxiliary working/counter columns and capabilities are not fabricated.

### Timestamps and execution time

When the verified VMP LOG OLE timestamp is present, canonical `timestamp` is
`acquisition_start + total_time_s`. The timestamp is a naive local wall-clock value because the log
does not contain a verified timezone offset. If the log is absent or unreliable, the column is
present with `NaT` values and `absolute_timestamps` is false. File modification time is never used.

An executed `step` is a one-based source-local occurrence. Occurrence boundaries are established by
validated zero-based Ns/cycle/half-cycle changes, explicit step-time resets, and entry/exit from Rest. A
galvanostatic-to-potentiostatic transition within one occurrence stays one step and is classified as
CCCV when the canonical vocabulary supports it. Current, voltage, capacity, rest, loop, and timestamp
settings are retained in the normalized protocol metadata; unsupported Neware condition expressions
are reported through `semantic_conditions_available = false`.

## Bounds and ownership

The reader rejects files above 8 GiB, walks at most 32 declared modules, and rejects data headers
above 64 columns before decoding. It validates declared module ends, exact record-area size, and the
`n_datapoints * verified_record_itemsize` multiplication before calling `np.frombuffer`. An unknown
optional module is preserved as a descriptor and skipped by its declared length.

`read_mpr()` owns a read-only memory map. `MprDocument`/`MprDataBlock` are context managers. Typed
records are copied into an owning NumPy array before return, so ordinary record consumption remains
valid after the context closes. Module payloads remain zero-copy views and must be released before
closing the document; a retained view causes close to fail explicitly and can be released before a
retry. `read_mpr_header()` walks and validates the same container/data-column bounds but leaves
`records=None`, so normalized metadata does not construct a record-sized NumPy array.

## Fail-closed rules

The reader rejects a source when the complete magic header, module marker, declared length, next
boundary, required module count, old/current module versions, column identifiers, required GCPL
fields, source order, record offset, or record-area size is not verified. It also rejects duplicate
VMP data/Set/LOG modules and repeated column identifiers. It does not silently truncate unknown
identifiers, infer unknown record widths, or accept a partial final record. An unrelated file is
classified as unsupported; a file with the full MPR signature but a truncated/corrupt header is
classified as invalid.

## Header-only performance evidence

On the private 307,115-byte sample, `read_mpr_header()` validated the three modules and 5,483-row
data header without constructing records; `read_mpr()` returned the owning `(5483,)` structured array.
The measured single-run wall times on the development machine were `0.000488 s` and `0.000924 s`,
respectively. The absolute values are machine-specific; the relevant invariant is that the header
path does not call the record `np.frombuffer` operation. The focused test patches that operation to
fail if the header path attempts a full decode.

## Provenance and licensing

The implementation is independently authored. The physical offsets and dtypes were rederived from
project-owned bytes: the observed record-area boundary is offset 1,007, the exact module remainder
is `5,483 * 53`, and a direct-byte probe records the 53-byte partition, little-endian encodings, and
the first-record values listed below. The first six encoded IDs are recorded as logical flags sharing
the packed byte; the remaining IDs are recorded in their physical field order. No duplicate byte
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
