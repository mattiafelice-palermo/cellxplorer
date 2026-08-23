# 051 — BioLogic MPR extensible column registry and required-field decoding

**Status:** Plan  
**Branch:** `feature/biologic-mpr-extensible-columns-051`  
**Depends on:** existing BioLogic MPR/GCPL support from Parent 041  
**Review document:** `reviews/051-biologic-mpr-extensible-column-registry-review.md`  
**Registry asset:** [`assets/051-biologic-mpr-column-registry.md`](assets/051-biologic-mpr-column-registry.md)

## Goal

Make the BioLogic MPR reader tolerant of additional data columns without weakening binary safety.

The current low-level reader accepts one exact 16-ID, 53-byte GCPL record layout. That is too brittle: a valid MPR file can contain all quantities CellXplorer needs plus additional recorded quantities, and the extra columns currently make the entire source unsupported.

After Spec 051, MPR acceptance must be driven by two questions:

1. Can CellXplorer determine the binary location of every GCPL-required field without guessing an unregistered base-column storage width?
2. Are all required GCPL quantities present and semantically usable by the existing adapter?

If both are true, additional columns must not prevent import merely because the complete column sequence differs from the original 16-column sample.

This spec changes the low-level binary-layout contract. It does not expand CellXplorer into a generic viewer for every MPR quantity and does not broaden technique support beyond the existing supported GCPL family.

## User decision

The parser must be robust to future files that add optional or newly encoded columns. The complete MPR column sequence is no longer an allowlist.

For every ordinary data-column ID read from the file, CellXplorer must preserve the full encoded ID and derive a storage-definition ID as:

`base_id = encoded_id % 256`

If that base ID exists in the CellXplorer-owned registry, its binary dtype and width are known and the reader can advance through the record safely even when that exact full encoded ID has never been seen before.

Examples include `379 -> 123` and `468 -> 212`. These are examples of the general rule, not one-off aliases.

A genuinely new base ID that is absent from the registry remains unknown-width. CellXplorer must fail rather than infer a width if such a field prevents safe location of required data. A strictly trailing unknown-width suffix may still be treated opaquely under the bounded rule defined below.

## Existing failure mode

`backend/app/services/biologic_mpr.py` currently couples three separate concepts:

- the set of known encoded IDs;
- the exact order of the original sample's IDs;
- the packed NumPy record dtype/itemsize.

The reader rejects any unknown ID and then rejects any sequence that is not exactly the original supported tuple. The resulting 53-byte dtype is therefore treated as the only valid GCPL record stride.

Spec 051 removes that exact-sequence requirement while retaining strict structural validation.

## Project-owned column registry

The authoritative working list for this feature is the checked-in spec asset:

[`assets/051-biologic-mpr-column-registry.md`](assets/051-biologic-mpr-column-registry.md)

The production registry must be authored in CellXplorer's own data structures and naming. It must contain, at minimum:

- the six packed logical flag IDs already supported;
- the 100 ordinary base data-column storage definitions listed in the asset.

The registry must keep **storage facts** separate from **scientific semantics**. A storage entry needs enough information to advance through the binary record safely: base ID, dtype, byte width, and packed-storage behavior. A scientific label/unit is descriptive metadata only and must not automatically make the field part of canonical cycling output.

### General ordinary-column normalization rule

For ordinary data columns, the storage lookup rule is universal:

`base_id = encoded_id % 256`

The full encoded ID remains source evidence and must be retained in diagnostics/provenance. The base ID is used only to resolve the registered binary storage definition and low-level working metadata.

Consequences:

- `379` resolves to base ID `123`, therefore 8-byte `float64` storage;
- `468` resolves to base ID `212`, therefore 4-byte `uint32` storage;
- a future encoded ID such as `635` resolves to base ID `123` and therefore has the same registered 8-byte storage width without any new one-off alias entry;
- a future encoded ID whose modulo-256 base is not in the registry remains genuinely unknown-width.

The high byte may still carry source information that matters diagnostically or semantically. Therefore this normalization establishes **binary storage identity**, not unconditional scientific equivalence.

### Packed flags are separate

The packed logical flag IDs `1`, `2`, `3`, `21`, `31`, and `65` retain their exact-ID shared-byte handling. They are not independent ordinary fields and must not each advance the physical record cursor.

## Required GCPL contract

The existing GCPL adapter's required raw information remains authoritative. Spec 051 must not expand or weaken those semantics merely to accept more binary layouts.

The low-level reader must be able to locate and expose the current required concepts:

- packed acquisition flags;
- sequence/Ns index;
- elapsed time;
- incremental charge;
- control value;
- working-electrode potential;
- charge/discharge quantity;
- half-cycle index.

Counter-electrode potential remains optional and must still be exposed when present so the existing two-electrode/three-electrode semantics continue to work.

For ordinary required quantities, matching is by resolved base ID, not by exact full encoded ID. A high-byte encoding of a required base quantity can therefore satisfy the low-level storage contract while the original full encoded ID remains preserved.

## Record-stride model

For the supported VMP data version, retain the independently established record-data offset. Determine the actual physical record stride from the record area itself:

- `data_bytes = payload_length - record_data_offset`;
- require `n_datapoints > 0`;
- require `data_bytes` to be exactly divisible by `n_datapoints`;
- `record_stride = data_bytes / n_datapoints`;
- reject zero, impossible, or safety-bound-exceeding strides before constructing arrays.

The reader must no longer assume `record_stride == 53`.

When every ordinary encoded column resolves to a registered base ID, the registry-derived physical width must equal the observed record stride exactly. A mismatch means at least one storage definition or file declaration is inconsistent and must fail before decoding.

When an unknown opaque trailing suffix is accepted, the known prefix width must be less than or equal to the observed stride. The difference is retained only as opaque ignored bytes; it is not split among unknown columns by inference.

## Offset resolution

Walk the encoded column sequence from left to right and maintain a physical byte cursor.

For each entry:

- packed logical flag IDs retain their exact-ID shared-byte handling;
- the physical packed flag byte advances the cursor exactly once;
- every ordinary data-column ID is normalized with `base_id = encoded_id % 256`;
- if the base ID exists in the registry, advance the cursor by that base definition's registered width;
- retain both the full encoded ID and resolved base ID in low-level layout metadata;
- duplicate or structurally impossible packed-field arrangements remain errors;
- required-field byte offsets are recorded when their resolved base IDs are encountered.

Known optional base fields and previously unseen high-byte encodings of known base fields may appear before, between, or after required fields. They are skipped by their registered widths and therefore do not make the layout unsupported.

### Unknown-width field before required data

If an ordinary encoded ID resolves to a base ID absent from the registry while any required field still lies later in the declared sequence, stop with `UnsupportedMprColumn` or the equivalent format-neutral unsupported error.

Do not infer 1/2/4/8 bytes, do not search for plausible floating-point values, and do not use the final stride to guess an individual unknown field's width.

### Unknown-width trailing suffix

If all required fields have already been located and an encoded ID resolves to an unregistered base ID, the remainder of the declared column sequence may be treated as an opaque suffix.

Requirements:

- no required field may appear after the first opaque unknown;
- no field after that point is decoded or assigned an inferred offset;
- the record stride remains the only boundary between rows;
- the known prefix must fit completely inside every record;
- diagnostics retain the full declared IDs and identify which IDs/base IDs were ignored as opaque suffix columns.

This rule allows genuinely new appended base quantities to coexist with the supported GCPL fundamentals even before their storage definitions are added.

## NumPy decode strategy

Do not build a packed dtype whose itemsize is merely the sum of the selected required fields.

Build a NumPy structured dtype or equivalent vectorized view with:

- explicit offsets for the fields CellXplorer needs;
- `itemsize` equal to the actual validated record stride;
- the existing endian definitions;
- one physical packed flag byte;
- optional known fields included only when downstream code actually needs them.

This lets a 53-byte required prefix be decoded correctly from a 93-byte record without copying or stripping the extra 40 bytes first.

Decoding must remain one bulk NumPy operation over the record block, not a Python loop over datapoints.

## Diagnostics and provenance

Extend the low-level data-block result or parser diagnostics with enough information to inspect compatibility decisions without exposing optional columns as canonical data.

At minimum retain:

- complete full encoded column ID sequence from the source;
- resolved modulo-256 base ID for each ordinary column;
- actual record stride;
- base IDs resolved through the CellXplorer registry;
- known optional full encoded IDs ignored by canonical mapping;
- opaque trailing unknown full encoded IDs/base IDs, if any.

Do not silently discard the fact that a file contained a previously unseen high-byte encoding or an unrecognized trailing base quantity.

These diagnostics may remain internal/header metadata if no user-facing surface currently consumes them.

## Initial extended-layout acceptance case

Add regression coverage for the independently inspected GCPL file family that contains the original supported columns plus five appended fields.

The extended encoded sequence is:

1, 2, 3, 21, 31, 65, 131, 4, 7, 13, 5, 6, 9, 39, 211, 468, 379, 124, 125, 126, 182.

Its physical record stride is 93 bytes. The additional fields are all resolvable through the project-owned base registry and are not required for canonical GCPL import.

Relevant storage resolution includes:

- `468 % 256 = 212`, registered `uint32`, 4 bytes;
- `379 % 256 = 123`, registered `float64`, 8 bytes;
- `124`, `125`, `126`, and `182` already equal their own registered base IDs and are 8-byte `float64` fields.

A synthetic fixture using this exact layout must demonstrate that the canonical fields decoded from the first part of each record are byte-for-byte/numerically identical to the equivalent 53-byte fixture.

The real user-provided source may be used locally for acceptance evidence but must not be committed unless separately approved for repository inclusion.

## Parser identity and reinspection

Because this feature changes which `.mpr` sources are accepted, increment the BioLogic reader/parser identity so sources that were previously rejected or stored as metadata-only under the old exact-layout contract are eligible for reinspection through the existing parser-upgrade preparation path.

Expected implementation direction:

- bump `MPR_READER_REVISION`;
- bump the BioLogic GCPL adapter/parser revision from its current value;
- use the existing parser-version upgrade machinery rather than introducing a one-off reparse path.

Do not change the canonical scientific calculation version solely because optional binary columns become ignorable; bump a scientific calculation version only if canonical output meaning changes.

## Registry implementation shape

Refactor `MprColumnDefinition` or introduce a neighboring storage-definition type so registry entries do not embed offsets that are valid only for one exact record layout.

The production model should express facts such as:

- base ID;
- dtype and byte width;
- storage kind (`record_field`, packed physical byte, packed logical alias);
- optional descriptive label/unit.

Record offsets must be computed per file from that file's declared sequence, not stored globally as constants for every possible layout.

Existing raw field names used by `biologic_gcpl.py` should remain stable so this feature does not create unnecessary downstream churn.

## Safety invariants

Spec 051 must preserve fail-closed behavior for genuinely ambiguous binary layouts.

Reject at least these cases:

- record area not divisible by `n_datapoints`;
- known complete column sequence whose registry-derived width differs from observed stride;
- ordinary encoded ID whose modulo-256 base is unregistered before a later required field;
- missing required GCPL base field;
- multiple encoded IDs resolving to the same required base quantity without an explicit deterministic disambiguation rule;
- duplicate physical field that would overlap storage unexpectedly;
- malformed packed-flag arrangement;
- required field offset/width extending beyond the observed record stride;
- unsupported VMP data module version.

A previously unseen full encoded ordinary ID whose modulo-256 base is registered is **not** an error by itself.

No fallback may search the bytes for plausible values or select a dtype combination merely because the total width happens to fit.

## Tests

Add focused tests to `tests/test_biologic_mpr.py` and adapter-level regression where appropriate.

Required cases:

1. Original 16-ID / 53-byte GCPL fixture still decodes identically.
2. Extended 21-ID / 93-byte fixture decodes the same required GCPL fields.
3. IDs 379, 124, 125, 126 and 182 resolve with their registered storage widths.
4. Encoded ID 379 resolves generically through base ID 123 as an 8-byte field.
5. Encoded ID 468 resolves generically through base ID 212 as a 4-byte field.
6. A synthetic previously unseen high-byte ID such as 635 resolves automatically through base ID 123 without any explicit alias entry.
7. A previously unseen high-byte encoding of another registered base ID resolves to the correct dtype/width and preserves the full source encoded ID.
8. Known optional columns inserted between required columns are skipped safely and required offsets remain correct.
9. Known optional columns inserted before required columns are skipped safely and required offsets remain correct.
10. A completely unknown trailing base ID is accepted as opaque when every required field precedes it.
11. Multiple completely unknown trailing base IDs are accepted as one opaque suffix without inferred individual widths.
12. A completely unknown base ID before a later required field fails closed.
13. A missing required base field fails with a useful diagnostic.
14. Multiple full encoded IDs resolving to the same required base field do not silently overwrite each other.
15. All-known registry width that disagrees with observed stride fails before record decode.
16. Record area not divisible by row count fails.
17. Packed flag aliases consume one physical byte total and decode exactly.
18. Diagnostics report full encoded IDs, resolved base IDs, record stride, optional ignored IDs, and opaque trailing IDs truthfully.
19. Bulk decode remains NumPy/vectorized and does not create one Python object per datapoint.
20. Existing GCPL canonical output and three-electrode behavior are regression-identical for the original supported sample.
21. Parser identity bump causes the existing upgrade/reinspection path to recognize the new parser revision.

Also add a registry consistency test that verifies every base entry in the Spec 051 asset represented in production has a supported dtype/width and unique base ID.

## Documentation updates

Update `docs/biologic-mpr-format.md` with the new architectural distinction:

- the original 16/53 layout remains independently verified evidence, not the global allowlist;
- the 21/93 layout is an additional project-observed case;
- full ordinary encoded IDs are preserved while binary storage resolves through modulo-256 base IDs;
- record stride is validated per source;
- known-base optional columns and previously unseen high-byte encodings may be skipped safely;
- genuinely unknown trailing base IDs may be ignored only after required fields are safely located;
- genuinely unknown interleaved base widths remain unsupported.

Do not turn the format notebook into a chronological log. Record stable format facts and decoder invariants.

Update the relevant agent knowledge document if the exact-layout assumption is currently described as a durable architecture constraint.

## Explicitly out of scope

- importing EIS or other new BioLogic technique families;
- exposing all 100 registry quantities in the UI or canonical cycling frame;
- automatic semantic interpretation of every registered column;
- guessing storage widths for unregistered base IDs;
- converting unknown trailing bytes into anonymous numeric columns;
- changing protocol reconstruction or cycle semantics merely because more binary layouts can be read;
- adding a runtime dependency for MPR parsing.

## Implementation order

1. Add/validate the project-owned base storage registry from the Spec 051 asset.
2. Refactor column definitions so byte offsets are per-layout rather than global constants.
3. Compute and validate the actual record stride from payload size and row count.
4. Implement full-encoded-ID preservation plus modulo-256 base-ID resolution for every ordinary data column.
5. Implement left-to-right offset resolution using registered base widths and exact packed-flag handling.
6. Implement the fail-closed unknown-base interleaved rule and opaque-trailing-suffix rule.
7. Build the explicit-offset, full-stride NumPy dtype/view for required fields.
8. Add the 21/93 extended-layout fixture, generic high-byte-ID cases, and unknown-base safety matrix.
9. Add diagnostics/provenance for encoded IDs, resolved base IDs, ignored known columns, and opaque unknowns.
10. Bump BioLogic parser identity and verify reinspection behavior.
11. Update the MPR format notebook and any stale architecture knowledge.
12. Run focused tests and `python scripts\preflight.py`.
13. Record implementation evidence, commit, push, and create the review document for final review.

## Acceptance criteria

Spec 051 is complete only when:

- the full column sequence is no longer required to equal the original 16-ID tuple;
- every ordinary data-column storage definition is resolved by `encoded_id % 256` against the CellXplorer-owned base registry;
- full encoded IDs remain preserved in diagnostics/provenance;
- previously unseen high-byte encodings of registered base IDs do not require one-off aliases or parser updates;
- the original 53-byte layout still decodes identically;
- the verified 21-ID / 93-byte extended layout imports without file rewriting;
- known-base optional fields can appear anywhere without breaking required-field decoding;
- genuinely unknown trailing base IDs are tolerated without assigning guessed widths;
- genuinely unknown interleaved base IDs still fail whenever a required later field cannot be located safely;
- record stride and all required offsets are independently validated before NumPy decode;
- packed logical flags retain their exact-ID shared-byte semantics;
- canonical GCPL scientific output does not change for previously supported sources;
- parser identity is bumped so previously rejected compatible MPR sources can be reconsidered;
- the registry asset and stable format documentation are updated together with implementation;
- focused tests include generic future high-byte encoded IDs rather than only 379 and 468;
- focused tests and full preflight pass;
- the feature branch is pushed and the final review is clean.

## Implementation record

Implemented on `feature/biologic-mpr-extensible-column-registry-051` (preflight passed; external
review pending). The low-level reader now owns the 100-entry storage registry, exact packed-flag
handling, full encoded-ID preservation, modulo-256 ordinary-base resolution, per-source stride
calculation, explicit-offset NumPy dtypes, and fail-closed unknown/interleaved versus opaque
trailing-column rules. GCPL metadata persists resolved IDs, stride, named offsets, ignored known
IDs, and opaque suffix diagnostics; the adapter identity is `gcpl9` and legacy reinspection uses
the registry resolver.

The independent fixture matrix covers the baseline 53-byte layout, the 21-ID/93-byte extended
layout, optional-column interleaving/omission, high-byte IDs including generic `635 -> 123`,
unknown suffixes, duplicate bases, stride mismatch, packed flags, canonical parity, metadata
diagnostics, and parser migration. The two local `Downloads\EGG*` examples were read without
rewriting: both declare the 21-ID layout, decode with stride 93, and expose the expected ignored
known IDs. Their existing canonical mapper reaches a separate capacity-boundary validation on full
parse; that semantic result is outside this binary-layout child.

Focused MPR/GCPL/metadata/parser/closure checks passed (162 tests), and
`python scripts\preflight.py` passed all 4 stages, including all 81 backend test modules.
