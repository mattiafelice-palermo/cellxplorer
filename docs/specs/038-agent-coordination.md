# Spec 038 Agent Coordination

This file coordinates the implementing agent and the independent ChatGPT reviewer for the shared
Spec 038 branch. It is a turn-taking state file, not a substitute for the parent/child specs or the
canonical review files.

Repository: `mattiafelice-palermo/cellxplorer`  
Branch: `feature/analyses-feature-modularization`

```text
ACTIVE_CHILD: 038.3
TURN: REVIEWER
STATE: AWAITING_REVIEW
LAST_IMPLEMENTATION_SHA: a57851fa9e19a2f323da6bc3fc0190a5c046fe7e
LAST_REVIEW_SHA: cbabde5b954e18e77a9e20fed7cc09a78ba55bd4
NEXT_ACTION: Review 038.3 against the parent/child spec and update the canonical 038.3 review file.
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

038.1 and 038.2 have now been independently reviewed through the GitHub connector and are clean.

The repository status text in the parent/child/index files may still describe the pre-review state
because the reviewer intentionally did not rewrite implementation-owned status metadata during the
review commits. Before beginning 038.3, update those status lines/implementation records only as
needed so they accurately say:

- 038.1: implemented and review-clean;
- 038.2: implemented and review-clean;
- 038 parent: in progress, 038.1 and 038.2 complete, 038.3 next;
- `docs/specs/README.md`: same sequential state.

Do not rewrite the review findings themselves.

Then implement only:

`docs/specs/038.3-existing-editor-module-organization.md`

Follow the parent and child exactly. When 038.3 is complete:

1. run every verification required by 038.3 and current repository guidance;
2. run `python scripts\preflight.py` before the completed pushed checkpoint unless current branch
   guidance explicitly supersedes it;
3. record exact results and any manual checks not run;
4. commit and push the implementation;
5. update this state block to:

```text
ACTIVE_CHILD: 038.3
TURN: REVIEWER
STATE: AWAITING_REVIEW
LAST_IMPLEMENTATION_SHA: <pushed 038.3 checkpoint>
LAST_REVIEW_SHA: cbabde5b954e18e77a9e20fed7cc09a78ba55bd4
NEXT_ACTION: Review 038.3 against the parent/child spec and update the canonical 038.3 review file.
```

6. append an IMPLEMENTER entry to the log;
7. make no 038.4 implementation changes until the reviewer returns the turn.

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

Next owner: **IMPLEMENTER**.

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
- Manual checks: **NOT RUN**; browser automation was not authorized. The child’s requested family,
  recognition, policy, multi-source, chrome, and keyboard matrix remains unverified manually.
- Next action: independent reviewer reviews 038.3 against the parent/child specs and updates the
  canonical 038.3 review file.
