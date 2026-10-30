# 074 review — verified replay recovery and private corpus

Reviewer: independent GPT-6 Astra, Medium reasoning. Production recovery, cache
diagnostic persistence and notice review: no blocking findings. Private corpus
integrity/isolation review: no blocking findings.

## Recovery and science

The proof compares every decoded field and rejects ignored/opaque layouts,
ambiguous matches, partial phases, changed active counters/measurements, errors,
nonfinite values, nonzero Rest transfer/current, excessive neutral residual,
changed half-cycle offset and failed forward joins. Recovery is atomic across
all regressions. Retained physical record positions are preserved with gaps;
timestamps and half-cycle evidence remain untouched.

The original replayed source has 73,779 records. Omitting only original one-based
55,097–55,113 and 55,148–55,164 retains 73,745 rows and 1,175 complete cycles.
Astra independently built the oracle by manually masking those ranges, finding
raw Ns returns and computing signed active raw-counter endpoint deltas. All
3,525 charge/discharge-capacity and CE values agreed within 1.14e-13. Cache,
stitch and all returned combined-preview points passed in both input orders.
The companion source remains 2,706 rows with no complete cycles and no notice.

Five previously readable sources were also compared against the previous
`gcpl16` mapper loaded from the parent commit: exact raw and per-cycle parity.
The earlier BareZn and NiFoam pair analyses match their prior independently
verified results exactly. The adapter revision is now `gcpl17`; `CALC_VERSION`
and golden scientific values/tolerances are unchanged.

## Durable private archive

Six originals are retained as exclusive, read-only, checksum-verified copies
under ignored `.local-regression/parser-corpus/`. The manifest and expectations
remain private. The CLI checks integrity before/after execution, fails on missing
expectations/membership mismatch/scientific differences, and never updates a
baseline during normal verification. All database/cache work is disposable.

Astra's corpus review identified one coverage gap: Time/Capacity only checked
that traces existed. The final harness now freezes deterministic scientific
trace hashes separately for both source orders, in addition to exact raw hashes,
cycle tables, capacity/CE analyses, sampled preview arrays, notices and provenance.
All six cases and three chains pass normal verification: 9, 9 and 1,175 cycles.
The public control tests cover tampering, missing sources/expectations, path
escape, immutable registration, membership changes and baseline-write separation.

## Browser acceptance

Disposable data on the local development frontend/backend verified the recovered
voltage preview through cycle 1,175, blue informational notice, exact original
range details, the combined capacity/CE preview and successful continued-Cell
registration. The library shows one READY Cell with 1,175 cycles. The existing
source-order warning remains separate because recorded acquisition times do not
establish a unique source order. No Stable/Beta/Alpha user profile was changed.

Private evidence remains under `tmp/074-*`; screenshots, raw sources, headers and
generated baseline files are excluded from the commit.

## Completion

Final native canonical preflight passed all four stages, including all 204
backend/frontend test modules/files, using the supported four-worker budget.
No tests or scientific baselines were relaxed. The related spec records the
complete acceptance evidence; no release or installer change is included.
