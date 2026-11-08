# 099 — BioLogic MB cycling review

Reviewer: independent GPT-6 Astra, Medium reasoning.
Status: Re-review passed; no unresolved findings.

The review covered both source layouts, scientific accounting and exclusion,
existing-reader/cache compatibility, source discovery, previews, warmed/selective
navigation, derivative calculation/rendering and mixed-source Cells.

Resolved findings:

- Carry acquisition boundaries and MB native time through indexed source previews.
- Restrict frequency-less data to the independently verified non-EIS RDO layout.
- Reject neutral or zero-duration interior intervals with charge transfer.
- Bypass reusable arrays that cannot represent EIS gaps; preserve native MB
  consecutive time when selecting later cycles.
- Split derivative smoothing/calculation and interactive/exported rendering at
  acquisition boundaries. Use finite-aware boundaries so ordinary rows in a
  mixed Cell retain their original derivatives.
- Retain positive excluded-record counts as informational cache diagnostics.
- Retry old unsupported MPR catalog facts once without invalidating recognized
  metadata or scientific caches.
- Scope the named frequency field to MB, preserving existing GCPL dtypes,
  ignored-column metadata and replay-recovery gates.
- Scan half-cycle slices linearly rather than rescanning the entire file per label.

Astra independently ran the ten focused MB tests and checked mixed-source
derivative equality. Its independent original-array accounting matched the
production adapter: ISL retains 31,469 of 32,669 records, with 24 EIS gaps and
50 pairs; RDO retains all 1,538 records and 11 pairs. Retained-operation capacity
sums (mAh) are 121.4918417598 / 120.0195042639 charge/discharge for ISL and
8.4867070001 / 8.4403306749 for RDO. These totals deliberately omit EIS and
unassignable operation-boundary intervals.

The review did not constitute native Windows installer or browser acceptance.

The final integration review also checked the pre-existing header-deadline
fixture correction. Both refactored virtual-reader tests pass; an in-memory
mutation renewing a stalled deadline after each sibling completion fails with
5.68 seconds against the unchanged 2.02-second assertion. Independent baseline
reproduction established that the old fixture could expire before observing any
child-start message. Native lifecycle tests and production deadlines remain.
