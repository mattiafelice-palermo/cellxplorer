# 108 — CP loop display boundaries review

Reviewer: independent GPT-6 Astra, Medium reasoning.
Status: Approved; no unresolved findings.

The review checked the observed source-loop envelope, identity scope, CP2 pinned
voltage roles, normal/sparse sampling, permissive fallback, boundary retention
through decimation and the shared derivative/export paths.

The decoder accepts one observed v10/old-v0, 280-byte `VMP loop` annotation,
bounded count, strictly increasing zero-based indexes, a final row-count sentinel
and zero padding. Unknown or malformed annotations supply no inferred boundaries
and do not withdraw otherwise verified voltage measurements. The new behavior
uses the same recorded-Ece CP scope as its `:cp3` identity. Explicit loop blocks
do not establish why recording intervals vary.

Resolved finding: the permissive fallback initially reused combined loop/clock
display segments as storage cycles. Storage cycle labels now remain based only
on the prior clock-regression rule. A focused regression checks exact parity of
every previous fallback column except the acquisition marker, with independent
expected cycle/segment labels. Astra approved this correction on re-review.

Public tests check normal-cadence loop boundaries, long in-loop intervals that
remain connected, absent/ambiguous/malformed tables, both ordinary worker and
baseline paths, forced decimation with both boundary points retained, selected
cycles, reusable-array bypass, historical CP2 roles, independent derivative
chunks, all-row native numeric export and all three graphical trace channels.

All four original files retain exact previous raw columns and cycle results
when the new segment annotation is excluded. The independent source-layout
oracle verifies 115,216 records, 12 interior loop boundaries, three source joins,
full/compact adjacent-point retention and selected-range numeric export. The
prior 6/13-source private expectations and the separate CP2 baseline remain
unchanged; new CP3 expectations are isolated in a separate ignored corpus.

Production UI and native PNG export were independently inspected with disposable
QA data. Both preserve the source-defined line breaks and measured post-boundary
transients. The local canonical preflight passes 240/241 modules/files and all
version/type/build stages; its only failure remains the established native
Windows port-owner reporting limitation. A clean-Windows branch gate is required
before merge.
