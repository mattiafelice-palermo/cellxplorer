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

The reader accepts only this exact supported identifier ordering and record layout. It validates the
record-area multiplication and uses one NumPy structured dtype from the memory-mapped payload; it
does not decode records with a Python per-row loop. The 16 logical IDs form the exact accepted GCPL
layout signature. The first six IDs, `1, 2, 3, 21, 31, 65`, are logical flags sharing the one
physical byte at offset 0. The remaining physical fields follow as `131` (sample sequence), `4`
(elapsed time), `7` (incremental charge), `13` (charge relative to origin), `5` (control), `6`
(Ewe-labeled potential), `9` (Ece-labeled potential), `39` (current range), `211`
(charge/discharge quantity), and `468` (half-cycle index). The five flag IDs after the physical
byte are validated as packed-flag aliases; they do not create synthetic duplicate byte ranges.

The names `Ns`, `Ewe`, and `Ece` below are source-label interpretations recorded from the observed
GCPL layout, not an official three-electrode capability claim. The 041.2 adapter uses only the
independently established raw fields and a directly supplied full-cell field; official protocol and
electrode-role semantics are intentionally resolved in 041.3 rather than inferred from these labels.

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

## GCPL canonical mapping (Spec 041.2)

The direct adapter in `backend/app/services/biologic_gcpl.py` accepts this exact record layout as
its low-level input. It returns Parent 040 canonical raw columns only when every required semantic
role is independently resolved; the real supplied GCPL6 file currently fails closed before
canonical publication because its full-cell voltage role is deferred to 041.3. Acquisition order
is preserved; `record_index` is the one-based ordinal `1..n`. The ID-131 value (`raw_sample_index`
in the low-level reader) is the observed BioLogic `Ns` programmed-sequence identity and is copied
without renumbering into `step_index`. The supported contract is one-based (`Ns >= 1`).

The supplied private sample contains only a constant-zero ID-468 half-cycle value. Because no MPT
was available to establish the starting value, direction, progression, or formation behavior of a
non-zero counter, the production adapter accepts only that observed constant-zero contract and
uses one adapter-local source group, `cycle = 1`; this is not asserted to be the vendor's final
full-cycle number. Any non-zero, regressing, or resetting half-cycle sequence, or any set
counter-increment flag, fails closed until a paired MPR/MPT corpus is available. Synthetic tests
cover the rejection; they do not define a production cycle formula.

An executed `step` is a one-based source-local occurrence. A new occurrence starts on an `Ns`
change, a half-cycle change, the decoded `Ns changes` flag, an explicit decoded step-time reset,
or entry/exit from the supported rest mode. A chronological galvanostatic-to-potentiostatic
transition inside one active occurrence stays one step and is classified as `CCCV_Chg` or
`CCCV_DChg`; reversed or re-entering control histories fail closed. Pure current and pure voltage
blocks become `CC_Chg`/`CC_DChg` and `CV_Chg`; standalone CV discharge is rejected because the
current canonical vocabulary has no `CV_DChg` status. Mixed charge/discharge direction in one
occurrence is rejected.

The adapter keeps the accepted BioLogic sign factor explicit as `+1` (`current_ma > 0` is charge
and `current_ma < 0` is discharge), but the required paired MPT semantic parity is still pending.
In galvanostatic rows the ID-5 control value is used only for the supported current-control mode.
A potentiostatic block requires a separately decoded measured-current field; unverified interval
`dq/time` reconstruction is rejected. The required signed ID-211 quantity is converted into a
non-negative phase-specific capacity counter relative to the first row of each executed step, and
its sign must agree with current and incremental ID-7 charge. The adapter also exposes a diagnostic
trapezoidal current integration helper, but never substitutes that diagnostic for the vendor
counter.

The supported GCPL6 layout does not expose a verified vendor energy counter, so the adapter chooses
Policy C: canonical energy columns are absent and downstream energy quantities remain unavailable.
Absolute timestamps are also deferred to 041.3 because the low-level reader has not yet established
a minimal log timestamp decoder. The exact GCPL6 layout exposes Ewe/Ece-labelled fields but no
independently decoded full-cell role in 041.2, so the production adapter does not derive or publish
`voltage_v` from them. A synthetic/direct full-cell field remains testable; the real three-electrode
path is intentionally deferred to 041.3. Rows carrying the decoded error flag are rejected.

The physical dtype contains the packed byte once; the six named arrays are NumPy results owned by the
data block and are cleared with it. These are raw acquisition flags; canonical status/step semantics
are owned by Spec 041.2, while electrode roles, timestamps, and three-electrode capability exposure
remain deferred to Spec 041.3.

## Bounds and ownership

The reader rejects files above 8 GiB, walks at most 32 declared modules, and rejects data headers
above 64 columns before decoding. It validates declared module ends, exact record-area size, and
the `n_datapoints * 53` multiplication before calling `np.frombuffer`. An unknown optional module
is preserved as a descriptor and skipped by its declared length.

`read_mpr()` owns a read-only memory map. `MprDocument`/`MprDataBlock` are context managers. Typed
records are copied into an owning NumPy array before return, so ordinary record consumption remains
valid after the context closes. Module payloads remain zero-copy views and must be released before
closing the document; a retained view causes close to fail explicitly and can be released before a
retry.

## Fail-closed rules

The reader rejects a source when the complete magic header, module marker, declared length, next
boundary, required module count, old/current module versions, column identifiers, record offset, or
record-area size is not verified. It also rejects duplicate VMP data/Set/LOG modules and repeated
column identifiers. It does not silently truncate unknown identifiers, infer record widths, or accept
a partial final record. An unrelated file is classified as unsupported; a file with the full MPR
signature but a truncated/corrupt header is classified as invalid.

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
