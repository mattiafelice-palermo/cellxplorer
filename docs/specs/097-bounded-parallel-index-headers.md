# 097 — Bounded parallel index header readers

Status: Implemented and verified; independent review clean. Branch:
`feature/parallel-index-headers`, from main `48a80e90`.

## Contract

Overlap independent header reads with at most four persistent, spawned processes.
Discovery still publishes all filenames first. The backend coordinator remains the
only catalog writer; each lane has one outstanding fact and its own unchanged
45-second deadline. A blocked/crashed lane marks only its identified fact unavailable
and is replaced for later work. Other lane completions never extend its deadline.
Cancellation, global pause and generation changes stop all owned readers and reject
late results. Retain source size/mtime validation and unchanged-header caching.
Incremental watcher processing retains its existing serial recovery semantics.

Compare the established serial implementation with two and four readers on the same
user-authorized folder using separate disposable catalogs. Alternate run order,
report filesystem cache limitations, compare exact metadata/classifications and
identities, record monotonic fixed-total progress, and verify unchanged rescans only
retry unavailable headers. Do not modify original files or active application data.
Use focused crash, stall, cancellation and generation regressions, then full preflight.
Have GPT-6 Astra at medium review the final work and iterate until clean.

No release or tag is requested. Integration follows the repository branch workflow
after verification and clean review.

## Real-folder comparison

Original authorized folder, 300 candidates, separate fresh catalogs, order
serial / two / four / four / two / serial. Filesystem and NAS caches were not
flushed; these are repeated observed network timings, not cold-storage guarantees.

| Readers | Initial scan repeats (s) | Median (s) | Unchanged rescan repeats (s) |
|---|---|---|---|
| Legacy serial | 171.58, 169.38 | 170.48 | 10.13, 11.00 |
| Two | 92.91, 88.45 | 90.68 | 9.13, 8.44 |
| Four | 53.61, 48.75 | 51.18 | 7.36, 7.50 |

Four-reader median is 3.33× faster (70.0% less wall time). Exact metadata,
recognition, source size/mtime and creation/modified timestamps matched across all
300 entries in every pass: 119 metadata ready, 170 unsupported, 11 unavailable,
zero pending. Every unchanged rescan checked exactly the same 11 unavailable
headers, with no metadata drift. Sampled header progress was monotonic against one
fixed total per generation, and completed exactly at that total.

An additional actual NAS watcher check completed startup reconciliation and an
explicit manual rescan (11 checks each), remained connected for 60.06 seconds with
no extra scan/revision, and retained exact metadata/source identities. Separate
synthetic/native watcher tests cover changes, rename, outage and restart without
modifying original network files. Four readers used about 353 MiB working memory
combined in one snapshot (not a measured peak); they are torn down after the pass.
Private paths, logs, catalogs and manifests remain ignored under `data/`.

## Review and verification

GPT-6 Astra medium identified delayed Windows-exit cleanup ownership and suppressed
Python 3.14 directory-enumeration errors. Fixes retain delayed readers and their
capacity slots until reaped, continue sibling cleanup, and propagate/retry spool
enumeration access errors under existing deadlines. Follow-up review corrected
pending-work starvation during delayed cleanup and preserved producer enumeration
retries within the five-second publish budget. Deterministic regressions cover all
four findings; 27 reader/transport tests passed after those fixes. The independent
final review is **clean**; see the [review record](reviews/097-bounded-parallel-index-headers-review.md).

Canonical `python scripts/preflight.py --no-cache` on Python 3.14, four workers,
passed all **225 backend/frontend test modules** and **4/4 stages** (version checks,
tests, frontend type check and production bundle), 247.47 seconds wall time.
No assertions, scientific expectations, deadlines or verification stages were relaxed.

A fresh pass on the exact reviewed code (same Python 3.12 runtime as the comparison)
took **52.84 s**, with a **7.25 s** unchanged rescan. Its complete 300-entry digest
matches the original serial baseline exactly, with fixed-total monotonic progress
and exactly 11 rescan checks. Final-code Python 3.14 live monitoring also passed:
startup and manual rescan each checked 11 headers; 60.07 seconds continuously
connected, no unrequested scans/revisions, exact metadata/source-identity parity.
