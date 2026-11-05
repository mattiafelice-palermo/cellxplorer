# 084 — BioLogic recording variants and permissive reading

Status: Complete; independent Astra Medium review, browser acceptance, both private
corpora and canonical four-worker no-cache preflight passed.
Branch: `codex/biologic-readable-and-permissive`.
Review document: [084 review](reviews/084-biologic-reader-modes-and-recording-variants-review.md).

## Request

Make all thirteen supplied MPR recordings readable, importable and plottable,
add independently verified fixes to the default reader, and implement a
permissive mode alongside it. The user explicitly requested parallel work;
the reader, backend mode plumbing and frontend are parallel tasks on one branch.
MPT exports are unavailable and are not a blanket prerequisite for support.

## Reader boundaries

Safe remains the default. Admit newly understood recording patterns only with
source-byte evidence, independent scientific checks and synthetic positive and
negative tests. Preserve current direction, complete-cycle meaning, measured
capacity ownership and previous whole-source regression results. Never derive
cycles from half-cycle parity or filenames. Instrument error flags and active
replays with unresolved counter semantics must remain visible uncertainties.

Permissive relaxes semantic admission, never structural decoding bounds. Decode
only independently supported fields and layouts. Preserve original physical
record positions, acquisition order and elapsed times. Break exploratory curves
at backward clocks; do not sort, time-shift, silently remove repeated measurements,
interpolate missing intervals or fabricate rest. Unsupported binary widths,
truncation and structurally invalid containers still reject.

Try the verified mapper first. If interpretation remains unsupported, expose
exploratory voltage curves without claiming complete cycles, capacity or CE.
Clearly identify unavailable or unverified quantities. Preserve bounded diagnostic
reasons, instrument error locations and acquisition discontinuities. All thirteen
inputs must be importable/plottable in permissive mode where their verified
structural decoding permits it; this does not promise validated science for all.

## Mode lifecycle and UI

Use per-source `read_mode: safe | permissive`, default safe. Persist the choice
in source metadata, separate parser/cache identities, mode-aware inspection
receipts and eligibility outcomes, and honor it during rebuilds and source
lifecycle operations. No process-global parser bypass or source-path registry.
Concurrent safe/permissive attempts must not contaminate one another.

Provide Safe/Permissive controls reachable even after a semantic rejection in
the import browser. Carry source mode through previews, selection, continued
Cell chains and final registration. Persistent exploratory status must survive
cache reload and remain visible in source details, analyses, saved plots and
exports/portable reports. Use the canonical compact Mantine style guide.

## Verification and privacy

- Keep the thirteen originals immutable in the ignored private incoming archive,
  with SHA-256 checks before/after. Do not stage recordings, private filenames,
  headers, paths, diagnostic snapshots or baselines.
- Retain the previous six-source/three-chain baseline unchanged. Normal private
  verification must not update its expected values.
- Synthetic regressions must cover new scientific admission gates, fallback,
  structural rejection in both modes, mode isolation and import persistence.
- Independently compare accepted new science with signed source counters and
  cycle/execution evidence, and exercise production cache, stitch, selective
  reads, previews and analysis paths. Do not change scientific tolerances to
  accommodate regressions.
- Browser acceptance in disposable data must demonstrate semantic failure ->
  permissive preview -> import -> plotting -> reload, including mixed modes.
- Obtain independent GPT-6 Astra Medium review and resolve material findings.
- Run four-worker canonical no-cache preflight, commit/push the completed feature,
  and merge to main. No real user database, installation, release tag or
  publication or application release-version bump is authorized by this task.

## Acceptance evidence

- The verified `gcpl18` adapter reads nine of the thirteen supplied sources;
  eight are newly accepted. They retain 176,290 records and 2,074 complete
  cycles. The full-loop replay omits exactly seventeen evidenced records.
  The remaining four sources are importable as exploratory recordings,
  preserving all 428,751 physical records without current, capacity or CE claims.
- An independent fixed-offset byte oracle checked every mapped capacity row
  and cycle label in the nine accepted sources; all 6,222 capacity/CE values
  agree within 1.14e-13. A separate incremental-charge check agreed with active
  endpoints within 6.56e-7 mAh. Voltage/native clocks match original bytes
  exactly in all thirteen recordings, including twenty-two mode-specific parses.
- The original six-source/three-chain private expectations pass unchanged
  (9/9/1,175 cycles). A separately reviewed thirteen-source/twelve-chain private
  baseline passes normal verification, including full cache reload, selective
  reads, stitching, capacity/CE, previews and Time/Capacity in both source orders.
  Every original and archived SHA-256 remains unchanged.
- Browser acceptance imported all thirteen sources with mixed Safe/Permissive
  selections into disposable data; all thirteen reached READY. Verified Safe
  rejection -> Permissive preview, visible fault record diagnostics, source
  status persistence after reload, and actual recorded-voltage Overview plots
  for both exploratory and Safe neutral-only recordings with zero complete cycles.
- Independent Astra Medium reviews resolved physical interval admission,
  original-record provenance, structural truncation, primary-voltage roles,
  mode/outcome separation, concurrent-writer ownership, portable interpretation,
  phase encoding/alignment and Overview query invalidation findings. Final
  cumulative review reports no remaining blocking defects.
- Canonical four-worker no-cache preflight passed all four stages and all 219
  backend/frontend test files/modules in 184.04 seconds. Earlier runs
  identified and corrected Safe-call compatibility and test-harness integration;
  the last environmental failure was a cache-candidate path exactly 260
  characters long. The final run uses a shorter disposable TEMP root without
  changing tests, worker limits or deadlines.
