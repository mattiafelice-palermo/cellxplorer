# 071 — BioLogic repeated executions and truthful import eligibility

Status: Implemented; independent Astra Medium review clean, private-file production
verification, browser acceptance and full canonical preflight passed.
Branch: `codex/biologic-repeated-executions`.
Review document: [071 review](reviews/071-biologic-repeated-executions-and-import-eligibility-review.md).

## User request

Support repeated GCPL executions in the supplied BioLogic MPR files, including
correct execution/cycle identity, capacities and CE. Verify the actual files and
obtain independent GPT-6 Astra Medium review. A confirmed unreadable source must
remain clickable for its error preview, but cannot be included or enable Continue.

Local verification inputs (private; do not commit binaries or raw headers):

- `%USERPROFILE%/Downloads/BB_eNargiZinc_LauraAnodeBareZn_DischCh1h_04_GCPL6_C11.mpr`
- `%USERPROFILE%/Downloads/BB_eNargiZinc_LauraAnodeBareZn_DischCh1h_06_GCPL6_C11.mpr`

## Confirmed evidence and scientific decisions

Both inputs decode as EC-Lab 11.72 GCPL technique 0x77, using the verified
53-byte record layout. Each contains ten active executions and ten rest blocks.
The raw sequence number stays 1 and the raw half-cycle field stays 0. After the
first execution, every Ns-change flag coincides with a rest-to-active return and
a gap in this source's acquisition clock. Current is consistently discharge in
04 and charge in 06. Counters accumulate across executions. Instrument, channel
and acquisition-start identifiers agree; the two sources' execution intervals
interleave in acquisition time.

Lock the new cross-source cycle convention to **charge followed by discharge**.
Never infer full cycles from half-cycle parity, filenames, ordinal alignment or
equal execution counts. The supplied pair has nine complete charge/discharge
cycles, a leading unpaired discharge and a trailing unpaired charge. Single
sources have no complete cycles/CE. Preserve unmatched trajectories and measured
capacities; do not fabricate summaries or efficiency ratios for them. An incomplete
or truncated phase can have reduced measured capacity without being normalized
to the programmed target.

## 1. Bounded source adapter extension

Keep existing strict/delayed flag policies for all other verified layouts.
Recognize the repeated-execution case only from a decoded document/settings
profile and validated acquisition evidence. Require a unique declared active
operation, consistent active direction/control, neutral rest, monotonic time,
matching boundary counter/dQ evidence and unambiguous reentry flags. Reject flags
inside active/rest blocks, missing reentry evidence and unexplained active gaps.
Do not bypass error flags, contradictory direction, unsupported settings or
capacity validation.

Each verified return receives its own positive source-local execution label.
Keep programmed `step_index` unchanged and executed `step` identities distinct;
step time and phase capacity restart at executed-step boundaries. Preserve raw
elapsed time, timestamps, voltages, source counters/provenance and first/last
partial phases. Record a bounded, explicit repeated-execution capability and
pairing identity that survives Parquet/cache round-trips. No private path or
filename is a scientific identity criterion. Bump the BioLogic adapter identity.

## 2. Narrow interleaved-source Cell reconstruction

An ordinary ordered Cell chain keeps existing continuation behavior. A verified
cohort of repeated-execution GCPL sources from the same exact acquisition,
instrument and channel may use acquisition chronology within that cohort.
Validate source provenance, unique executions, non-overlapping execution ranges,
compatible clock origin and alternating active directions before pairing. Do not
pair across unrelated sources, missing files, intervening incompatible sources,
ambiguous overlaps or missing acquisition identity. Reversed input order within
an otherwise proven cohort must either preserve the same chronological science
or explicitly decline pairing; it must never change phase pairing silently.

Use deterministic charge-to-next-discharge pairs, retaining leading/trailing
unmatched rows as display-only/incomplete. Preserve source hash, source-local
execution and original record index for every row. Readdress executed steps
uniquely when calculating cross-source phase totals so matching local step
numbers cannot merge different phases. Per-cycle capacities equal measured phase
counter deltas; CE is discharge/charge * 100 under the existing convention.
Never integrate across absent time intervals or join unrelated phase endpoints.

Full raw stitch, cycle stitch, continuation preview, indexed/selective analysis
and reusable-array paths must agree. Add a compact bounded cache/index summary
for this capability; special cohorts may use a deliberate exact full-stitch
fallback until an indexed implementation is correct. Ordinary Neware, existing
GCPL and CP/OCV hot paths, worker pools and navigation caches must remain intact.
Change `CALC_VERSION` if derived Cell cycle meaning/cache identities change.

## 3. Import selection follows confirmed readability

Header hints remain cheap and asynchronous; do not fully parse every file in a
directory or regress cold NDAX/XLSX preview performance. Header compatibility is
provisional and does not override a confirmed semantic parse rejection.

Propagate terminal source-validation outcomes into one shared, source-versioned
eligibility policy for filesystem and indexed results, checkbox/Space/Ctrl-click/
double-click/range/Select all and final Continue. Remove a newly rejected source
from the selected set. Clicking or Enter still focuses the row and displays the
reason. Known unsupported/unreadable rows stay visually unavailable and cannot
be included; error text must be understandable. Continue must not be enabled
by an unreadable file, including one selected before validation completed.

Distinguish confirmed source rejection from a cancelled request, HTTP/transport
failure or a supported source having no complete cycles. Only source failures
block eligibility. Invalidate rejection when the file identity changes, and
ignore stale results from an older focused source/version. Reuse known terminal
rejections server-side where appropriate so refreshing/navigation and a stale
client cannot silently re-admit the same rejected identity at the next stage.
Folder selections still resolve to individual candidates before proceeding;
they must not bypass this rule. No warnings-only converter diagnostic becomes
a fatal error unless canonical readability actually fails.

## Verification and completion

- Synthetic adapter positive/negative cases for every evidence gate and separate
  execution identity; exact unchanged ordinary GCPL/CP/OCV behavior.
- Cross-source chronology, source order, provenance, leading/trailing unmatched
  phases, same-polarity/missing/overlapping/unrelated sources and mixed chains.
- Cache reload and full/selective/cycle/preview/analysis parity. Scientific
  capacity totals checked against independent source-counter delta calculations;
  no golden expected-output or tolerance changes to conceal regressions.
- Run both private local files through production parsing, cache, combined
  preview and analysis in disposable application data. Verify nine complete
  pairs and every capacity/CE numerically; record hashes and scalar evidence
  locally without committing binaries or private headers.
- Frontend policy regressions for all selection methods, stale outcomes, file
  replacement, indexed results, no-cycle support and transient failures.
- Browser acceptance for both readable files and a deliberately unsupported
  synthetic source: row preview/error, selection pruning and Continue behavior.
- Independent Astra Medium review, iterate to clean; focused tests and canonical
  preflight; update durable architecture notes; commit/push branch and merge main.
  Do not modify the real database, install the app, bump the release version or
  create a release/tag.

## Completion evidence

The final implementation uses `bm:gcpl15cpocv1:r1` and `CALC_VERSION 1.6.5`.
The calculation-version bump conservatively invalidates derived Cell results for
the new acquisition-backed pairing semantics. Golden outputs change only version
metadata; scientific expected values and tolerances are unchanged.

Independent raw-counter calculations exactly match all nine charge capacities,
discharge capacities and CE values through cache, stitching, combined preview and
analysis, including reversed source order. The 2,427 raw rows include 141 unmatched
rows, which remain incomplete. First CE is 99.942258%; final CE is 83.577240%.
Hashes and scalar-only evidence remain local in `tmp/071-real-evidence.json`.

Browser acceptance covered both real files, nine-cycle combined previews, semantic
rejection pruning and disabled Continue, retained click/Enter error access, and
Refresh after a same-size/same-mtime repaired replacement. The route-level hash
retention regression found by that acceptance is covered by a focused test.

Canonical `python scripts/preflight.py` passed all four stages with four backend
workers (157.18 s); the final run included 98 backend modules. Earlier watcher
timing failures under heavier parallel load were resolved by that bounded rerun.
See the linked review for findings and verification details.
