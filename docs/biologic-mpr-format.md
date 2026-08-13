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

The supported sample has a 52-byte pre-module header followed by length-delimited modules. Each
observed module header is 65 bytes:

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
record-area multiplication and uses a NumPy structured `V53` view from the memory-mapped payload;
it does not decode records with a Python per-row loop. Field semantics and named canonical mappings
are intentionally deferred to Spec 041.2/041.3.

## Fail-closed rules

The reader rejects a source when the magic, module marker, declared length, next boundary, required
module count, required module version, column identifiers, record offset, or record-area size is not
verified. It also rejects duplicate VMP data/Set/LOG modules and repeated column identifiers. It does
not silently truncate unknown identifiers, infer record widths, or accept a partial final record.

## Provenance and licensing

The implementation is independently authored. No GPL parser package, source, comments, dtype table,
mapping table, or test is imported or copied into the reader. Any external parser used during private
development is only a secondary local comparison oracle and is not part of the repository or runtime.
