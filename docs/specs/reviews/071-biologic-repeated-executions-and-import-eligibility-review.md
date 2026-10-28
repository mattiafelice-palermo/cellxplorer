# 071 review — repeated GCPL executions and import eligibility

Reviewer: independent GPT-6 Astra, Medium reasoning.

## Resolved findings

- Refuse an entire acquisition cohort when a third/missing/overlapping fragment
  makes pairing ambiguous; preserve exact science in reversed source order.
- Preserve acquisition chronology in mixed chains and across raw/cycle/index
  paths, including missing or busy raw-layout sidecars.
- Preserve explicit execution gaps after preview downsampling and through both
  voltage/current trace builders.
- Refresh must invalidate local rejection state even after a same-size/same-mtime
  replacement. Ignore obsolete preview and header-hint callbacks.
- Browser acceptance found that a remembered semantic failure lost its established
  hash before returning from continuation inspection. Preserve that hash so the
  preview can bind the failure to the focused source and remove selection.

## Independent verification

The final code review found no remaining issues. Focused independent checks
covered repeated-execution evidence gates, cohort safety, source readability,
preview rendering and selection policies. A dedicated route regression verifies
hash retention on terminal semantic rejection.

Both private inputs were independently exercised through production parsing,
cache reload, stitching, default combined preview and analysis, in disposable
application data and in both source orders:

- 1,147 + 1,280 = 2,427 raw rows preserved.
- Ten executions per file; zero complete cycles in either file alone.
- Nine complete charge-to-following-discharge cycles; 141 unmatched rows retained.
- All 27 charge/discharge-capacity and CE values exactly match independently
  calculated signed raw source-counter deltas (maximum absolute error zero).
- First CE 99.94225791752707%; final CE 83.57724047594209%.
- Each individual voltage preview retains nine execution breaks.

Local hashes and scalar evidence are in `tmp/071-real-evidence.json`; private
binaries and headers are excluded from the commit.

## Browser acceptance

Verified against a disposable backend/database with the production frontend:

- Both original sources render voltage/current and advance to import review.
- Their combined capacity/CE preview contains nine cycles in both display
  interpretations; neither interpretation changes the verified science.
- A synthetic unsupported reentry selected before validation is removed after
  rejection. Its checkbox and Continue are disabled; click and Enter retain the
  error preview. Select shown includes only the valid peer.
- Returning to the folder retains the known rejection. Replacing that synthetic
  source with valid bytes while preserving size and mtime, then using Refresh,
  restores preview, selection and Continue.

The real database and installed application were not modified. Release/version
declarations remain unchanged. `CALC_VERSION 1.6.5` conservatively invalidates
derived Cell results; golden JSON changes only its version metadata, preserving
all scientific expected values and tolerances.

Canonical preflight passed all four stages with four backend workers in 157.18 s,
including 98 backend modules. Earlier native-watcher timing failures under heavier
concurrent load passed in the final bounded run; no watcher production code or
test timeouts were changed.
