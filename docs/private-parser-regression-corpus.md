# Private parser regression corpus

Real shared sources are archived locally under ignored
`.local-regression/parser-corpus/`. The manifest records stable case IDs, SHA-256,
the original filename and the Cell chain. Source copies are created exclusively,
verified against the original, then made read-only. Registration never rewrites
the original. Private sources, headers, paths, expectations and generated results
must never be staged or uploaded.

The public byte-fixture tests do not require this archive. This private corpus
adds whole-source regressions for the difficult examples shared during development.

## Routine verification

Run from the repository root after parser, cache, stitching, preview or scientific
analysis changes:

```powershell
python scripts/parser_regression_corpus.py verify
```

Verification checks source checksums before and after execution, parses every
source, compares the complete raw frame after Parquet reload, tests selective
cycle reads, and freezes exact raw-frame hashes, cycle tables, replay provenance
and notices. Each chain is exercised in both source orders through production
stitching, three capacity/CE analysis quantities, combined import preview and
Time/Capacity. Sampled preview points are checked against their own cycle x
values. Deterministic Time/Capacity arrays are hashed separately for each source
order because its selected window follows the explicit chain order.

The comparison with frozen expectations is exact. Small tolerances used for
independent route consistency do not relax the baseline comparison. Application
data/cache work happens in a disposable short workspace directory; SQLite state
is in memory. The CLI sets `CELLXPLORER_DATA` before application imports and never
opens a Stable/Beta/Alpha profile.

Missing files, changed checksums, missing expectations, changed case membership
and scientific differences fail verification with a nonzero exit status.
`verify` never generates or updates expectations. If the private archive is not
available on another checkout, report that boundary and run the public tests;
do not claim whole-source parity.

## Adding a shared case

Use a stable, non-sensitive ID and a chain ID identifying the Cell pair/group:

```powershell
python scripts/parser_regression_corpus.py register --case-id case-04 --chain case-pair --source 'C:\path\source04.mpr'
python scripts/parser_regression_corpus.py register --case-id case-06 --chain case-pair --source 'C:\path\source06.mpr'
```

Registration adds immutable copies and manifest entries only. Existing IDs/files
cannot be replaced. Add negative/unsupported examples as public synthetic fixtures;
the private CLI currently requires readable sources.

## Explicit baseline capture

Before first capture, independently verify the newly supported science and
compare previously readable sources with the previous adapter. Then run:

```powershell
python scripts/parser_regression_corpus.py snapshot
python scripts/parser_regression_corpus.py verify
```

An existing snapshot is protected. Adding cases or intentionally changing a
scientific contract requires reviewing the differences and explicitly running
`snapshot --replace-expectations`. Never use that option merely to make a failed
regression pass. Preserve earlier evidence for review.

The initial six-case baseline was checked against the previous GCPL adapter for
all five previously readable sources, with exact raw and per-cycle parity. The
earlier two chains also matched their independently verified prior analysis
results. For the newly recovered source, an independent oracle manually excluded
the two evidenced original ranges and derived cycle identity from raw Ns returns
and capacity/CE from signed active counter endpoint differences. All 1,175 cycles
agreed within 1.14e-13. No golden values or scientific tolerances were changed.
