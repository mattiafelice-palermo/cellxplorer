# 072 review — interrupted GCPL execution and readable errors

Reviewer: independent GPT-6 Astra, Medium reasoning. Final code review clean.

## Scientific boundary

The NiFoam 04 source has a two-record leading discharge followed by a marked
active-to-active return, with no intervening rest row. Restart/control-change
flags, unchanged control, a 3,990.274506-second gap, zero boundary dQ and unchanged
cumulative capacity jointly establish the return. Execution identity now also
splits executed steps before capacity/time validation. Missing intervals remain
unmeasured; no rest or interpolated capacity is invented.

Negative fixtures cover missing restart/control flags/gap, capacity jump/reset,
nonzero incremental transfer, changed control/direction/step, unsupported mode,
time regression and instrument errors. Existing repeated-execution safety gates
remain in force.

## Error presentation and retry behavior

Specific readable explanations replace generic corruption wording for incomplete
blocks, inconsistent record counts, unsupported technique/columns/layout,
ambiguous restart/capacity ownership, instrument errors and backwards time.
Raw exception diagnostics remain separate in metadata `error` and remembered
rejection `diagnostic`.

Review identified that a base MPR open failure could be classified as a permanent
invalid-source rejection. Only concrete invalid/unsupported subclasses now
establish that rejection; base access errors retain `error_kind=None` and remain
retryable. Tests exercise stat succeeding while opening fails, including metadata,
header hints, canonical parsing and eligibility classification. Unexpected adapter
errors still surface normally.

## Independent verification

- 30 focused tests and 44 subtests passed independently.
- Actual NiFoam sources: 850 + 1,280 = 2,130 rows, ten executions each, nine
  complete pairs and 130 unmatched rows retained.
- All 27 charge/discharge-capacity and CE values match signed raw source-counter
  deltas exactly through production cache reload, stitching, combined preview and
  analysis, in both input orders (maximum absolute error zero).
- First CE 99.91615744031952%; final CE 53.71106131328832%.
- BareZn production results are exactly unchanged under `gcpl16` in both orders,
  including capacities, CE and analysis arrays.
- Local scalar evidence: `tmp/072-real-evidence.json` and
  `tmp/072-bare-regression-evidence.json`; private headers and binaries are excluded.

## Browser and completion

Disposable application data verified both real voltage previews, selection,
Continue/import review and a settled nine-cycle combined capacity/CE plot. A
synthetic incomplete recording displays the complete-header explanation and
retry suggestion; checkbox and Continue stay disabled, while click retains the
reason. Evidence screenshot: `tmp/072-readable-error-browser.png`.

Canonical preflight passed all four stages with four backend workers in 194.73 s.
The adapter identity is `bm:gcpl16cpocv1:r1`; calculation formulas, golden scientific
values and tolerances are unchanged. No real database, installation, release
version, tag or release was modified.
