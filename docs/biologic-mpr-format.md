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
| 0 | 1 | `uint8` | `flags` | packed record flags | — |
| 1 | 2 | `<u2` | `ns` | sample sequence number | — |
| 3 | 8 | `<f8` | `time_s` | elapsed time | s |
| 11 | 8 | `<f8` | `dq_mAh` | incremental charge | mA.h |
| 19 | 8 | `<f8` | `q_minus_q0_mAh` | charge relative to origin | mA.h |
| 27 | 4 | `<f4` | `control_v_or_mA` | technique-dependent control value | V or mA |
| 31 | 4 | `<f4` | `working_potential_v` | working-electrode potential | V |
| 35 | 4 | `<f4` | `counter_potential_v` | counter-electrode potential | V |
| 39 | 2 | `<u2` | `current_range` | current-range code | — |
| 41 | 8 | `<f8` | `q_charge_discharge_mAh` | charge/discharge quantity | mA.h |
| 49 | 4 | `<u4` | `half_cycle` | half-cycle index | — |

The full encoded ID `468` is required for the final field. It is not normalized with `% 256` and is
not silently replaced with the low-byte value `212`.

## Packed flags

The single physical `flags` byte is unpacked into NumPy arrays with vectorized masks. The masks
below are the only flags exposed by this reader revision; bit `0x40` remains unclaimed.

| Name | Mask | Shift | Result |
| --- | ---: | ---: | --- |
| `mode` | `0x03` | 0 | uint8 code |
| `oxidation_reduction` | `0x04` | 2 | boolean |
| `error` | `0x08` | 3 | boolean |
| `control_changed` | `0x10` | 4 | boolean |
| `ns_changed` | `0x20` | 5 | boolean |
| `counter_incremented` | `0x80` | 7 | boolean |

The physical dtype contains the packed byte once; the derived arrays are views/temporary NumPy
results owned by the open data block and are cleared with it. Canonical status/step semantics are
intentionally deferred to Spec 041.2.

## Bounds and ownership

The reader rejects files above 8 GiB, walks at most 32 declared modules, and rejects data headers
above 64 columns before decoding. It validates declared module ends, exact record-area size, and
the `n_datapoints * 53` multiplication before calling `np.frombuffer`. An unknown optional module
is preserved as a descriptor and skipped by its declared length.

`read_mpr()` owns a read-only memory map. `MprDocument`/`MprDataBlock` are context managers and the
typed record array must not be retained after the context closes unless the caller makes an owning
copy.

## Fail-closed rules

The reader rejects a source when the complete magic header, module marker, declared length, next
boundary, required module count, old/current module versions, column identifiers, record offset, or
record-area size is not verified. It also rejects duplicate VMP data/Set/LOG modules and repeated
column identifiers. It does not silently truncate unknown identifiers, infer record widths, or accept
a partial final record. An unrelated file is classified as unsupported; a file with the full MPR
signature but a truncated/corrupt header is classified as invalid.

## Provenance and licensing

The implementation is independently authored. No GPL parser package, source, comments, dtype table,
mapping table, or test is imported or copied into the reader. A separate external runtime was used
only as a private comparison oracle for the supplied file's dtype names, byte offsets, and flag
masks; it remains outside the repository and runtime. No MPT file was available, so no MPT-derived
claim is made here.
