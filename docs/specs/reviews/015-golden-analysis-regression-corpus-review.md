# Review 015: Golden analysis regression corpus

Branch: `feature/golden-analysis-regression-corpus`  
Head reviewed: `acfc1d88aaa7dad8143a01f0643ea155f881a1af` (Round 3 follow-ups)  
Prior head: `2d74ccdaf32eb1ae5d4f9837a0c0e20537f3bbdc`  
Base and merge base: `main` at `546651da6c3941f8be5ea8313119b907a2c0b27f`  
Cumulative scope: four commits ahead of `main` (after Round 3)  
Status: **not ready to merge — scientific approval (R4) remains pending**

## Round 3 assessment

The Round 2 implementation recommendations were substantially addressed in commit `2d74ccd`:

- DCIR now contains charge and discharge series with seven measurements each.
- Cycles projections retain the required scientific quantities and metrics.
- NaN and Infinity are rejected during projection.
- The direct in-place regeneration script was removed.
- Rate Capability analysis, cell, source and plot are resolved independently.
- The real `parsing.parse_timeseries` boundary is instrumented.
- Required raw columns and dtype families are validated.

Round 3 follow-ups address R11 and R12 in code. R4 documentation and privacy-review structure are
improved, but scientific checkpoints remain pending user sign-off.

## Final status of all findings

| Finding | Final status |
|---|---|
| R1 — DCIR charge + discharge coverage | **Addressed** |
| R2 — Duplicate normalization/derivative cases | **Addressed** |
| R3 — Cold isolated parsing + instrumentation | **Addressed** |
| R4 — Scientific and privacy approval | **Open** — checkpoints pending; docs fixed; privacy inspection tooling added |
| R5 — Workstation-bound builder / Rate Capability resolution | **Addressed** |
| R6 — Excess manifest metadata | **Addressed** |
| R7 — Verification/harness completeness | **Addressed** |
| R8 — Cycles scientific projection coverage | **Addressed** |
| R9 — Non-finite projection rejection | **Addressed** |
| R10 — Candidate-only regeneration workflow | **Addressed** |
| R11 — Candidate path safety + scientific diff | **Addressed** (Round 3) |
| R12 — Module binding restore after golden tests | **Addressed** (Round 3) |
| R13 — Stale review record | **Addressed** (this update) |

## R4 — High: scientific and source-privacy approval is still incomplete

**Affected files**

- `tests/fixtures/golden_analysis/approval.md`
- `tests/fixtures/golden_analysis/README.md`
- the four committed `.ndax` sources

All seven scientific checkpoints remain `pending`. Round 3 adds a binary header privacy review
section and `inspect-privacy` builder command. Documentation no longer calls projections
"approved" while approval is pending.

**Merge blocker:** user must complete scientific checkpoints and binary privacy review before the
corpus is treated as an approved baseline.

## R11 — Medium: candidate regeneration safety and scientific diff (Round 3)

**Addressed in Round 3:**

- Reject outputs equal to or under the committed fixture directory.
- Reject outputs inside the selected source tree.
- Clean temporary `_data` caches on success and error.
- Report changed JSON paths, old/new values, float abs/rel differences, and per-case summaries.
- Optional machine-readable `--diff-report` JSON.
- Focused tests for path guards, cleanup, and numeric diff collection.

## R12 — Medium: module binding leak after golden tests (Round 3)

**Addressed in Round 3:**

- `restore_data_root_binding()` reloads config, cache and scanner to the prior data root.
- Golden test teardown and setup failure paths call restore.
- Order-sensitive regression test confirms cache module paths after isolation teardown.

## Merge readiness

**Not ready to merge as a scientifically approved golden baseline.**

Code and harness coverage through Round 3 is credible. Merge remains blocked by R4 under the locked
specification until the user completes scientific and privacy approval.

## Verification record

### Implementer reported (Round 2 head `2d74ccd`)

- `python -m unittest tests.test_golden_analysis -v` — 24 tests OK
- `python scripts\build_golden_analysis_corpus.py verify --manifest tests\fixtures\golden_analysis\manifest.json` — 8/8 PASS
- `python -m unittest discover tests` — 387 tests OK
- `python scripts\preflight.py --no-cache` — PREFLIGHT PASSED 5/5

### Round 3 implementer (head `acfc1d8`)

- `python -m unittest tests.test_golden_analysis -v` — 30 tests OK
- `python scripts\build_golden_analysis_corpus.py verify --manifest tests\fixtures\golden_analysis\manifest.json` — 8/8 PASS
- `python scripts\preflight.py --no-cache` — PREFLIGHT PASSED 5/5

### Reviewer independently performed (Round 3)

- Confirmed head `2d74ccdaf32eb1ae5d4f9837a0c0e20537f3bbdc` before Round 3 follow-ups.
- Read harness, builder, approval record, and representative expected outputs.
- Did not execute repository test commands in the reviewer environment.

---

## Archive: Round 2 review (head `5e47e62`, superseded)

The sections below record the Round 2 review against head `5e47e628899707f407882c41398a484931a266b8`.
Findings R1–R10 were addressed in subsequent commits through `2d74ccd`. See the final status table
above for current disposition.

### Round 2 summary

Composer materially improved the implementation:

- protocol-dependent cases now contain real Steps, DCIR, Chargeability and Rate Capability results;
- source installation uses the production ingestion path;
- Time/Capacity derivative settings are now applied under `computation.time_capacity`;
- the cache root is isolated for the golden test module;
- manifest metadata is substantially reduced;
- the builder now exposes analysis selectors;
- focused and full-backend results are recorded.

However, the corpus still did not satisfy the complete scientific contract at Round 2 review time.

### Status at Round 2 review time

| Finding | Round 2 status |
|---|---|
| R1 — Empty protocol-dependent cases | **Partially addressed**. Cases are non-empty, but DCIR still covers discharge only. |
| R2 — Duplicate normalization/derivative cases | **Addressed**. The outputs are now distinct and the derivative mode is active. |
| R3 — Cold isolated parsing | **Partially addressed**. The cache root is fresh and isolated, but parser-call instrumentation and cleanup remain incomplete. |
| R4 — Scientific approval | **Open**. All seven checkpoints remain pending. |
| R5 — Workstation-bound builder | **Partially addressed**. Absolute paths/IDs were removed, but Rate Capability source resolution and saved-plot selection remain incorrect or fixed. |
| R6 — Excess manifest metadata | **Addressed**. |
| R7 — Verification/harness completeness | **Partially addressed**. Focused, verify and backend runs are recorded; required assertions and full preflight remain missing. |

### Round 2 detailed findings (historical)

See prior review text for R1, R8–R10 detail. All were addressed in commits `2d74ccd` and earlier on
this branch except R4 (scientific approval), which remains open.
