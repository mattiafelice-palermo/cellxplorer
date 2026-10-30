# 074 — Verified BioLogic replay recovery and private regression corpus

Status: Implemented; independent Astra review, browser acceptance and canonical preflight passed.
Branch: `codex/biologic-replay-recovery`.
Review document: [074 review](reviews/074-biologic-replay-recovery-and-private-corpus-review.md).

## Request and evidence

Recover the user's GCPL recording by omitting proven replayed blocks, report a
calm informative notice, verify cycles/capacity/CE and obtain Astra review. Retain
the tricky shared originals as a durable private development regression corpus.

The latest pair's source 06 has 73,779 records and two clock regressions. Original
records 55,097–55,113 and 55,148–55,164 replay the immediately preceding 17-record
Rest→charge→discharge block. Every decoded field matches exactly except the
half-cycle counter, which advances by two, and a constant neutral-rest cumulative
counter difference below 2e-8 mAh. Active counters and every measured field match.
The independent provisional oracle excludes only those ranges: 73,745 retained
records, 1,175 complete cycles. No original file may be rewritten.

## Recovery contract

- Limit admission to the verified 0x77 Rest/charge/discharge settings profile and
  fully compared record layout. Reject unknown/opaque record bytes.
- Only attempt recovery at a backward time transition. Require one unique,
  immediately preceding, complete Rest→charge→discharge block with exact timestamp
  and measured-field equality. Bound block length and recovery count/work.
- Compare all fields. Permit only a constant +2 diagnostic half-cycle offset and
  the independently evidenced, constant, <=2e-8 mAh cumulative-counter difference
  on neutral rows with zero incremental charge and zero resolved current. Raw
  control targets remain exactly equal (the last rest row may hold the next
  charge target under the existing GCPL contract). Active
  capacity and all other values remain exact. No sorting, time shifting,
  interpolation, smoothing or broad duplicate-value removal.
- Require a forward post-block join. Recovery is all-or-nothing; any unmatched,
  partial or changed block or remaining regression leaves the source rejected.
- Preserve original retained record positions and half-cycle evidence, with
  bounded skipped/retained range provenance. Reconstruct cycles from the existing
  declared/observed protocol, never by renumbering raw half-cycles.
- Keep standard direction, instrument-error, control, step and capacity checks.
  Bump only the BioLogic adapter identity; prior readable science stays unchanged.

## Informative notice

Persist a bounded parser diagnostic through Parquet/cache reload and import
inspection. Show a quiet blue information notice explaining the skipped repeated
rows, that calculations use retained measurements, and that the original file is
unchanged. Do not claim general experiment safety or conceal the recovery.
Preserve existing warning severity for unrelated Neware diagnostics. Ensure the
notice is visible for individual sources and combined import review.

## Private corpus

Create checksum-verified immutable copies of the six known shared MPR inputs
under ignored `.local-regression/parser-corpus/`, with private manifest and stable
case IDs. Never commit binaries, raw headers, private paths or generated results.
Provide a reusable registration/snapshot/verification command. Verification must
fail on missing/tampered sources, missing expectations or scientific differences;
normal verification must never regenerate expectations. Check production cache,
stitch and analysis results for the earlier pairs as well as the recovered pair.
Document explicit baseline capture and how future shared cases are added. Keep
the public synthetic suite runnable without private files.

## Verification and completion

- Independent synthetic byte fixtures for valid recovery, zero scientific change
  against a clean reference and negative cases for every admission gate.
- Cache reload, parser diagnostic persistence, provenance, selective analysis and
  preview parity. No golden scientific values or tolerances change.
- Independent counter-based verification of all 1,175 capacities and CE values,
  plus prior readable pairs unchanged and unsupported negatives still rejected.
- Corpus integrity/control tests and full six-file private regression run.
- Browser acceptance of readable preview/import and calm notice; Astra Medium
  review, canonical preflight, durable notes, commit/push and merge main.
- Do not change the real database, install the app, bump the release version or
  create a release/tag.

## Acceptance evidence

- Public recovery/corpus suites: 12 tests plus 25 subtests passed independently
  under Astra; complete native preflight passed all 204 backend/frontend test
  modules/files, type check, production bundle and version consistency.
- Full private verification passed six immutable sources and three chains with
  9, 9 and 1,175 cycles, including frozen Time/Capacity arrays in both orders.
- All five previously readable sources have exact raw/per-cycle parity against
  the prior adapter. Prior BareZn/NiFoam analysis results are exactly unchanged.
- Independent raw-counter oracle verified all 3,525 recovered capacities/CE
  values within 1.14e-13, without using the recovery helper to build expectations.
- Browser verified individual and combined blue notices, exact skipped-range
  details, voltage/capacity/CE previews and a successful disposable continued-Cell
  import showing READY with 1,175 cycles. Real user profiles remain untouched.
- Canonical preflight used a short temporary path and the supported four-worker
  budget after sandbox access denials and a larger-pool watcher timeout. No test
  was skipped or loosened to obtain the passing run.
