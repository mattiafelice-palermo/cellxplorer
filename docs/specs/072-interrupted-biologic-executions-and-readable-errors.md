# 072 — Interrupted BioLogic executions and readable source errors

Status: Implemented; Astra Medium review clean, independent real-file production
parity, browser acceptance and canonical preflight passed.
Branch: `codex/biologic-interrupted-executions`.
Review document: [072 review](reviews/072-interrupted-biologic-executions-and-readable-errors-review.md).

## Request and verified evidence

Investigate the supplied NiFoam GCPL pair and give understandable technical
source-error explanations instead of an unsupported claim of corruption.
Private inputs remain in Downloads; never commit their bytes or headers:

- `BB_eNargiZinc_LauraAnodeNiFoam_DischCh1h_04_GCPL6_C11.mpr`
- `BB_eNargiZinc_LauraAnodeNiFoam_DischCh1h_06_GCPL6_C11.mpr`

06 already reads as ten executions. 04 has 850 records and ten marked
executions, including an initial two-record discharge lasting 1.182 seconds.
Record 3 returns directly to discharge after a 3,990.274506-second gap, without
a rest row. Its new-sequence and control-change flags are set, incremental
capacity is zero and cumulative capacity is unchanged. Ordinary later returns
follow rest. Both sources have monotonic clocks and no instrument error flag.

## Bounded adapter extension

Extend only the verified single-operation repeated GCPL profile. Admit a direct
active-to-active return only with an explicit restart and control-change marker,
a gap above the declared acquisition cadence, the same declared operation and
direction/control, zero boundary dQ and continuous source capacity counters.
Keep all existing settings, direction, error-flag and capacity checks. Split
executed steps at every admitted execution boundary before capacity/time
validation. Preserve all recorded rows, the short initial phase and missing
intervals; never synthesize rest or integrate through a gap. Bump the GCPL
adapter identity; existing calculation formulas and complete-cycle meaning stay
unchanged from 071.

The acquisition-backed charge-to-following-discharge rule remains mandatory.
Expect nine complete cycles, an unmatched initial discharge and unmatched final
charge. Independently verify every capacity/CE from signed raw counters in
disposable production parser/cache/preview/analysis paths and both source orders.

## Error communication

Keep detailed diagnostics separate from the user-facing explanation. Explain the
specific reason in ordinary scientific terms: incomplete header/data block,
inconsistent record counts, unsupported technique/record layout, ambiguous restart
or counter ownership, or temporary inability to open the file. Do not equate an
unsupported recording pattern with a damaged file. Keep enough detail to explain
why import stopped and what can be retried, without raw field IDs/byte-offset
jargon in the main message. Preserve existing exception types and raw diagnostics.

Only concrete unsupported/invalid source failures may establish a remembered
semantic rejection. File-open/read-access failures remain retryable and must not
permanently disable selection. Unexpected adapter bugs must still surface.

## Completion checks

- Positive interrupted-first-execution fixture and exact step/time/capacity checks.
- Negative missing marker/control flag/gap, nonzero boundary dQ/counter jump,
  changed direction/control, rest flags, time regression and instrument errors.
- Existing 071, ordinary GCPL and CP/OCV regressions remain unchanged.
- Presentation tests for structural/unsupported/semantic/access failures and raw
  diagnostic retention, including stat-success/open-failure retry behavior.
- Both actual files through disposable production and browser verification.
- Astra Medium independent review, canonical preflight, durable architecture
  notes, focused commit/push and merge to main. No real database modification,
  application installation, release version bump, tag or release.

## Completion evidence

`bm:gcpl16cpocv1:r1` reads both NiFoam inputs as ten executions each. The nine
complete pairs retain 2,130 rows, including 130 unmatched rows. Every phase
capacity and CE matches independently calculated signed source-counter deltas
exactly through caches, stitching, combined preview and analysis in both source
orders. The earlier BareZn results remain exactly unchanged. Independent focused
review checks passed 30 tests and 44 subtests; the implementation focused run
passed 158 tests. Canonical preflight passed all four stages in 194.73 seconds.

Browser acceptance confirmed readable real-file previews and nine combined
cycles, plus a specific incomplete-header explanation with selection disabled
for a synthetic incomplete file. See the linked review and local scalar evidence
in `tmp/072-real-evidence.json` for verification details.
