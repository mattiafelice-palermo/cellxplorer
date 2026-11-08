# 097 — Bounded parallel index header readers: independent review

Reviewer: GPT-6 Astra, medium reasoning. User explicitly requested review and
iteration until clean. Base main: `48a80e90`; branch: `feature/parallel-index-headers`.

## Findings and resolution

1. **P1 — Delayed Windows termination could abandon sibling cleanup.** Closing a
   still-running process after two short joins raised and stopped the cleanup loop.
   Retain delayed processes/spools in a reaper until confirmed exit, reserve their
   global reader capacity, and clean every sibling independently. Regression proves
   delayed ownership, sibling closure and exactly-once eventual capacity release.
2. **P2 — Glob could suppress an enumeration access error.** Python 3.14 glob can
   turn an access denial into an apparently empty spool, losing the final result.
   Enumerate through `Path.iterdir`, preserve access errors, and retry within the
   caller's deadline. Regression denies actual directory enumeration, not merely
   a mocked spool get.
3. **P2 — Delayed cleanup could strand pending work.** Healthy readers previously
   skipped the pending fact while no capacity was available for a replacement.
   Give healthy reusable lanes pending work first; start new deadlines at dispatch
   and preserve original deadlines only for actual retries. A retained-slot test
   completes 180 later facts through the healthy reader with one unavailable result.
4. **P2 — Producer enumeration also needs its existing retry budget.** Retry
   enumeration within the same publication deadline as rename; coordinator sends
   retain zero-wait retries so cancellation and siblings stay responsive. Regression
   verifies transient producer enumeration denial followed by successful publication.

Optional interrupted-benchmark resume behavior is documented: move an incomplete
run directory aside; the benchmark will not overwrite its diagnostic artifacts.

## Final review

After two fix/review iterations, the reviewer reported: **"Review clean. All four
findings are resolved."** No further actionable findings. The reviewer inspected
the completed six-run benchmark summary and confirmed exact parity across all 300
entries, 11 retries per rescan, and serial/two/four-reader medians of
170.48 / 90.68 / 51.18 seconds. All 27 focused reader/transport tests passed.

Full preflight and exact final-code real-folder acceptance are recorded in Spec 097.
