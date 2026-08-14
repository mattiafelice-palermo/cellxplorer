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
| 0 | 10 | ASCII | fixed short name, including the `MODULE` marker |
| 10 | 31 | ASCII | long module name |
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
| 52 | `MODULEVMP` | `Set   VMP settings` | 10 | 6,953 | 7,070 |
| 7,070 | `MODULEVMP` | `data  VMP data` | 11 | 291,606 | 298,741 |
| 298,741 | `MODULEVMP` | `LOG   VMP LOG` | 10 | 8,309 | 307,115 |

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
layout signature. IDs `5`, `6`, `9`, `39`, and `211` are retained as validated auxiliary IDs: the
observed 53-byte physical record has no separate byte range for them, so the reader does not invent
numeric fields for them. Their protocol meaning is deferred to Spec 041.2/041.3.

## Typed 53-byte record

The physical record dtype is little-endian where applicable and has `itemsize == 53`:

| Offset | Size | Dtype | Field | Raw meaning | Unit |
| ---: | ---: | --- | --- | --- | --- |
| 0 | 1 | `uint8` | `raw_flags` | packed raw record flags | — |
| 1 | 2 | `<u2` | `raw_sample_index` | raw sample sequence number | — |
| 3 | 8 | `<f8` | `elapsed_time_s` | raw elapsed time; not canonical step time | s |
| 11 | 8 | `<f8` | `raw_dq_mAh` | raw incremental charge | mA.h |
| 19 | 8 | `<f8` | `raw_q_minus_q0_mAh` | raw charge relative to origin | mA.h |
| 27 | 4 | `<f4` | `raw_control_v_or_mA` | technique-dependent raw control value | V or mA |
| 31 | 4 | `<f4` | `raw_ewe_v` | raw Ewe-labeled potential value | V |
| 35 | 4 | `<f4` | `raw_ece_v` | raw Ece-labeled potential value | V |
| 39 | 2 | `<u2` | `raw_current_range_code` | raw current-range code | — |
| 41 | 8 | `<f8` | `raw_q_charge_discharge_mAh` | raw charge/discharge quantity | mA.h |
| 49 | 4 | `<u4` | `raw_half_cycle_index` | raw half-cycle index | — |

The full encoded ID `468` is required for the final field. It is not normalized with `% 256` and is
not silently replaced with the low-byte value `212`.

## Packed flags

The single physical `raw_flags` byte is unpacked into eight neutral raw-bit NumPy arrays with
vectorized masks. This child deliberately does not assign protocol meanings such as step mode,
control change, or counter change; those mappings belong to 041.2/041.3.

| Name | Mask | Shift | Result |
| --- | ---: | ---: | --- |
| `raw_bit_0` | `0x01` | 0 | boolean |
| `raw_bit_1` | `0x02` | 0 | boolean |
| `raw_bit_2` | `0x04` | 0 | boolean |
| `raw_bit_3` | `0x08` | 0 | boolean |
| `raw_bit_4` | `0x10` | 0 | boolean |
| `raw_bit_5` | `0x20` | 0 | boolean |
| `raw_bit_6` | `0x40` | 0 | boolean |
| `raw_bit_7` | `0x80` | 0 | boolean |

The physical dtype contains the packed byte once; the derived arrays are NumPy results owned by the
data block and are cleared with it. Canonical status/step semantics are intentionally deferred to
Spec 041.2.

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
is `5,483 * 53`, and the field partition is recorded in the table above. Raw names are descriptive
labels authored for this reader, not copied vendor names; flag exposure is neutral bit decomposition.
Literal `struct.pack_into` fixture bytes independently test every field offset and endian choice.

A separate external GPL runtime was run only after that direct-byte definition as an output-only
comparison oracle. It was not used as implementation input, and no package, source, comments, dtype
table, mapping table, or private sample entered the repository or runtime. Static tests audit the
reader, requirements, and production entry-point files for prohibited parser dependencies. No MPT
file was available, so no MPT-derived claim is made here.
