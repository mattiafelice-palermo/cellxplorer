# Spec 038 Agent Coordination

This file coordinates the implementing agent and the independent ChatGPT reviewer for the shared
Spec 038 branch. It is a turn-taking state file, not a substitute for the parent/child specs or the
canonical review files.

Repository: `mattiafelice-palermo/cellxplorer`  
Branch: `feature/analyses-feature-modularization`

```text
ACTIVE_CHILD: 038.6
TURN: REVIEWER
STATE: AWAITING_REVIEW
LAST_IMPLEMENTATION_SHA: c17be850c7cd8a647f05026b0b0f226f96a28b74
LAST_REVIEW_SHA: 6b5945c159396e58b5af1b9faa8356de05767c4a
NEXT_ACTION: Review 038.6 against the parent/child spec and update its canonical review file.
```

## Protocol

1. The remote branch is authoritative. Before acting, fetch/pull the latest remote branch and reread
   this file, the parent, the active child, and the active review file.
2. Only the agent named by `TURN` may perform its role's repository changes.
3. `TURN: IMPLEMENTER` permits implementation/review-fix work only for `ACTIVE_CHILD`.
4. `TURN: REVIEWER` means the implementer must stop modifying the branch until the reviewer has
   pushed its review handoff.
5. A child advances only after the reviewer explicitly records `STATE: REVIEW_CLEAN`.
6. Every completed implementation/review-follow-up tranche must be committed and pushed before
   handing over the turn.
7. The coordination log is append-only. The state block above may be replaced on each handoff.
8. Never force-push, amend, reset, squash away, or otherwise rewrite the other agent's checkpoints.
9. Canonical findings and acceptance criteria live in `docs/specs/reviews/038.x-*-review.md`; this
   file summarizes the next action rather than duplicating full reviews.
10. The branch must not be merged to `main` until 038.8 and the parent integration review are clean.

## Current handoff

038.1 through 038.5 are independently review-clean.

Implement only:

`docs/specs/038.6-saved-plot-artifacts-extraction.md`

Follow the parent and child exactly. When 038.6 is complete:

1. run every verification required by 038.6 and current repository guidance;
2. run `python scripts\preflight.py` before the completed pushed checkpoint unless current branch
   guidance explicitly supersedes it;
3. record exact results and any manual checks not run;
4. commit and push the implementation;
5. update the state block to `ACTIVE_CHILD: 038.6`, `TURN: REVIEWER`,
   `STATE: AWAITING_REVIEW`, record the pushed implementation SHA, and set `NEXT_ACTION` to the
   independent 038.6 review;
6. append an IMPLEMENTER entry to this log;
7. make no 038.7 implementation changes until the reviewer returns the turn.

## Coordination log

### 2026-08-09 20:26 CEST — REVIEWER

Reviewed the live branch after the implementer pushed the remaining 038.1 corrections and the
first 038.2 implementation.

038.1:

- R1/R2 had already been resolved in the earlier rounds;
- R3 is resolved: the extra `plotCsv.ts` production module is removed and CSV formatting/BOM
  ownership is back in locked `plotExport.ts`;
- the regression test imports the production formatter directly and preserves the U+FEFF check;
- R4 is resolved by the implementer-reported final `459/459` frontend suite, TypeScript check,
  Vite build, and `python scripts\preflight.py` passing `5/5` stages;
- manual browser matrix remains accurately recorded as not run;
- final review commit: `f0b7e38b0a11dd6185a809f00e725c5d980f6e60`;
- decision: **038.1 REVIEW_CLEAN**.

038.2:

- implementation commit: `bbd94ac5691bd100bcf0477f6b2c9ed63870e29a`;
- integrated implementation checkpoint: `a1c7868b1cdb4d55f4ceb31bcfd88b9e055329fc`;
- final documentation checkpoint before review: `0b64153e4173b6c3daa8fbd2386d33e4ddb3170c`;
- confirmed locked database/workspace ownership, thin route adapter, direct new-owner imports,
  preserved workspace/query-cache behavior, and no backend/scientific/persistent-data changes;
- implementer-reported verification: frontend `459/459`, workspace `4/4`, app-channel `17/17`,
  TypeScript passed, Vite build passed, preflight `5/5`; manual browser matrix not run;
- no actionable defect/spec deviation found;
- review commit: `cbabde5b954e18e77a9e20fed7cc09a78ba55bd4`;
- decision: **038.2 REVIEW_CLEAN — 038.3 may begin**.

### 2026-08-09 — IMPLEMENTER

Implemented **038.3** in `a57851fa9e19a2f323da6bc3fc0190a5c046fe7e` and pushed the shared branch.

- Moved the four existing family cards, diagnostic-cycle policy, protocol UI/helpers, recognition
  UI/progress modules, and draft/plot/multi-source policies into their locked editor folders.
- Updated direct owner imports, workspace policy typing, focused test imports, app-channel path
  assertions, the maintained tree, and durable analysis path references; removed the protocol UI
  helper re-export. No behavior, API, query-key, scientific, cache, or artifact-version changes.
- Verification: focused 038.3 suite **71/71**; `tests.test_app_channels` **17/17**; TypeScript
  passed; Vite build passed with **7512** modules transformed; all three stale-path searches had
  no matches; `python scripts\preflight.py` **PREFLIGHT PASSED**, **5/5** stages, **459** frontend
  tests and **58** backend test modules passed.
- Manual checks: **NOT RUN**; browser automation was not authorized.
- Next action: independent reviewer reviews 038.3.

### 2026-08-09 — REVIEWER

Reviewed 038.3 implementation `a57851fa9e19a2f323da6bc3fc0190a5c046fe7e` after valid handoff checkpoint
`2cdabaa21b4d6f60513bff5b04f6e90cf9c1285c`.

- Confirmed all 15 locked modules at their final family/protocol/recognition/policy paths.
- Compared representative pre/post family cards; changes are ownership/import-path only and preserve
  APIs, queries, builders, settings, visibility, exports, and one-way dependency direction.
- Confirmed protocol pure-helper direct ownership and removal of the UI re-export.
- Confirmed recognition shared-token/polling behavior remains in the moved module.
- Confirmed `SAVED_PLOT_THUMBNAIL_RENDER_VERSION` remains `6` and policy logic is unchanged.
- Confirmed no backend/API/migration/scientific/query-key/cache/artifact-version change.
- Implementer-reported verification: focused `71/71`, app-channel `17/17`, TypeScript passed, Vite
  passed (`7512` modules), stale-path searches clean, preflight `5/5` with `459` frontend tests and
  `58` backend modules; manual browser matrix NOT RUN.
- No actionable finding.
- Canonical review commit: `0ed279ebdaf970807f09690ffe8e43bc62b3c20f`.
- Decision: **038.3 REVIEW_CLEAN — 038.4 may begin**.

### 2026-08-09 — IMPLEMENTER

Implemented **038.4** in `de1b31e1987bd532e2bd30c070f6e6a14f03fd21` and pushed the shared branch.

- Extracted the Cycles query/quantity adapter, diagnostic display filtering, canonical trace and
  layout builders, settings, live card, style preview, and ordinary export ownership into the
  locked `families/cycles/CyclePlotCard.tsx` module. Saved preview, warmup, portable, naming, and
  editor normalization consumers now use the family exports; no scientific, backend, schema,
  cache, calculation-version, or artifact-version behavior changed.
- Verification: focused frontend suite **90/90**; TypeScript passed; Vite build passed with
  **7513** modules transformed; structural Cycles-owner/query searches passed; canonical elevated
  `python scripts\\preflight.py` **PREFLIGHT PASSED**, **5/5** stages, **459** frontend tests and
  **58** backend test modules passed. Existing Vite dynamic-import and large-chunk warnings
  remain; the initial sandboxed preflight bundle was denied access by Windows and was rerun
  successfully with elevation.
- Manual checks: **NOT RUN**; browser settings, diagnostics, export, saved-preview, warmup,
  portable, light/dark, and keyboard checks remain for independent review.
- Next action: independent reviewer reviews 038.4 and updates its canonical review file.

### 2026-08-09 — REVIEWER

Reviewed 038.4 implementation `de1b31e1987bd532e2bd30c070f6e6a14f03fd21` after valid handoff checkpoint
`555c0fe7b2d914acb811f29f88dffe96f2e4dddb`.

- Confirmed `families/cycles/CyclePlotCard.tsx` owns the Cycles quantity/query/diagnostic/builder/
  settings/live-card/style/export boundary required by the child.
- Confirmed the exact live compute key, endpoint/payload/token, stale time, tab enablement, job
  polling, and page last-valid-result behavior are preserved without a duplicate live query.
- Compared the extracted trace/layout boundary with the prior page-owned builders; no scientific or
  presentation contract change found.
- Confirmed saved preview and portable snapshot orchestration use the canonical family builders and
  the page no longer owns duplicate Cycles settings/card/builders.
- Confirmed no backend/API/migration/scientific/query-key/cache/artifact-version change.
- Implementer-reported verification: focused `90/90`, TypeScript passed, Vite passed (`7513`
  modules), structural searches clean, `git diff --check` passed, preflight `5/5` with `459`
  frontend tests and `58` backend modules; manual browser matrix NOT RUN.
- No actionable finding.
- Canonical review commit: `07dbe7fad21c6ba9d22006eee0d2f49b97385168`.
- Decision: **038.4 REVIEW_CLEAN — 038.5 may begin**.

Next owner: **IMPLEMENTER**.

### 2026-08-09 — IMPLEMENTER

Implemented **038.6** in `c17be850c7cd8a647f05026b0b0f226f96a28b74` and pushed the focused
implementation checkpoint.

- Moved `DraftPlotCard`, `CacheWarmupCoordinator`, and `warmupCompletion` into
  `editor/artifacts`; extracted `SavedPlotPreviews`, `AnalysisCacheWarmupRenderer`, and
  `SavedPlotsPanel`; removed the saved-preview, artifact, warmup-renderer, and saved-panel
  implementations from `AnalysisPage.tsx`.
- Reconnected App, Settings, the analysis page, the warmup test, and durable path documentation to
  the new owners. No scientific, backend, schema, cache, renderer-version, endpoint-payload, or
  artifact-signature redesign was made.
- Verification: warmup terminal test **10/10**; analysis policy/visibility tests **19/19**;
  `tests.test_app_channels` **17/17**; TypeScript passed; Vite build passed with **7517** modules
  transformed; `git diff --check` passed; canonical `python scripts\\preflight.py` **PREFLIGHT
  PASSED**, **5/5** stages, with **459** frontend tests and **58** backend test modules passed.
  Preflight's type-check and production-bundle stages reused the verified successful build.
- Manual checks: **NOT RUN**; browser/manual interaction matrix was not run in this checkpoint.
- Next action: independent reviewer reviews 038.6 and updates its canonical review file.

Next owner: **REVIEWER**.

### 2026-08-09 — IMPLEMENTER

Implemented **038.5** in `dbeb78fb0360e9eca6ebb64b9d5a80abc5138689` and pushed the shared branch.

- Extracted the complete Time/Capacity configuration, normalization, coordinate/segment/current
  helpers, canonical trace/layout builders, settings, live query/progress/render/export card, and
  style preview into the locked `families/time-capacity/TimeCapacityPlotCard.tsx` module. Saved
  preview and portable snapshot consumers use the canonical family builders; no scientific,
  backend, schema, cache, calculation-version, or artifact-version behavior changed.
- Verification: focused suite **81/81**; TypeScript passed; Vite build passed with **7514** modules
  transformed; page implementation search clean; one live `time-capacity` query owner plus the
  intentional saved/portable requests; canonical elevated `python scripts\preflight.py`
  **PREFLIGHT PASSED**, **5/5** stages, including **58** backend test modules, frontend policy
  tests, type check, and production bundle. Existing Vite dynamic-import and large-chunk warnings
  remain.
- Manual checks: **NOT RUN**; browser/manual matrix was not run in this checkpoint.
- Next action: independent reviewer reviews 038.5 and updates its canonical review file.

### 2026-08-09 — REVIEWER

Reviewed 038.5 implementation `dbeb78fb0360e9eca6ebb64b9d5a80abc5138689` against the live parent/child specs, repository guidance, changed-file boundary, extracted family code, and current page consumers.

- Confirmed `families/time-capacity/TimeCapacityPlotCard.tsx` owns the complete Time/Capacity configuration/query/builder/settings/live-card/style/export boundary required by 038.5.
- Confirmed the locked query key, compact request payload, fixed 1200 viewport identity, data-signature inputs, 30-minute cache windows, placeholder behavior, job polling, delayed token clearing, and readiness semantics are preserved.
- Confirmed saved preview and portable snapshot generation reuse the canonical family trace/layout builders and `AnalysisPage.tsx` no longer owns duplicate Time/Capacity settings/query/trace/layout/card logic.
- Confirmed no backend/API/migration/persistent-spec/scientific/cache/artifact-version/configuration change in the implementation diff.
- Implementer-reported verification: focused `81/81`, TypeScript passed, Vite passed (`7514` modules), structural searches clean, `git diff --check` passed, preflight `5/5`; manual browser matrix NOT RUN.
- Reviewer-independent execution: none; review used ChatGPT + GitHub connector only, not Work.
- No actionable finding.
- Canonical review commit: `6b5945c159396e58b5af1b9faa8356de05767c4a`.
- Decision: **038.5 REVIEW_CLEAN — 038.6 may begin**.

Next owner: **IMPLEMENTER**.
