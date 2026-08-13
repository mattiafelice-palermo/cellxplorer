# CellXplorer Development and Review Workflow

Repository: `mattiafelice-palermo/cellxplorer`  
Context last synchronized: 2026-07-26  
Verified against: `main` at `d577d2b2eb959914e84575dd0bf12b05bff42693`

## Working model

CellXplorer is maintained by a solo developer who delegates implementation to AI coding agents.
The workflow therefore optimizes for:

- low probability of silent regressions;
- reproducibility;
- small reviewable branches;
- clear handoff to limited-context coding models;
- minimal process overhead.

Avoid large-team ceremony unless it directly reduces scientific, data-loss or release risk.

## Standard feature sequence

1. **Inspect**
   - confirm exact branch and merge base;
   - read repository guidance and relevant implementation;
   - identify existing patterns and tests.

2. **Specify**
   - create one self-contained spec per coherent unit;
   - split backend, toolbar and complex table behavior when independent;
   - lock scientific definitions and units;
   - identify migrations, cache keys, invalidations and manual UI checks.

3. **Implement**
   - use a dedicated feature branch;
   - follow the spec in order;
   - avoid unrelated refactors;
   - run focused tests during work;
   - record actual verification.

4. **Review**
   - compare code against the spec and correct base;
   - identify branch contamination as well as code defects;
   - create or update a separate review file;
   - do not repeat settled implementation work.

5. **Revise**
   - implement `R1`, `R2`, … in priority order;
   - avoid expanding scope;
   - record what changed and what was run.

6. **Merge**
   - ensure branch scope is clean;
   - ensure required checks passed;
   - update version and changelog for completed user-facing work according to repository policy.

## Branching

Use descriptive branches such as:

```text
feature/cell-library-sort-and-filter
fix/source-cache-invalidation
tooling/faster-preflight
```

Rules:

- determine whether a branch is standalone or intentionally stacked;
- compare against its actual parent/merge base;
- a branch advertised as one feature must not silently include earlier unmerged features;
- rebuild or rebase contaminated branches rather than accepting a misleading PR;
- never modify `main` directly for exploratory work;
- do not reset unrelated user changes.

## Specification format

Path:

```text
docs/specs/NNN-short-kebab-title.md
```

A spec should contain:

- status and dependency;
- goal;
- locked decisions;
- current implementation with exact files and grep-able anchors;
- backend/API/data requirements;
- frontend/UI requirements;
- migration/cache/invalidation consequences;
- tests and manual verification;
- out-of-scope;
- implementation order;
- acceptance checklist.

The spec must be usable by an agent that has not seen the chat. Avoid depending on screenshots or
unstated intent.

### Splitting rule

Split into multiple specs when work can be independently implemented and reviewed, especially when
it combines:

- persistent schema/scientific calculation;
- toolbar or workflow behavior;
- complex sorting/filtering or state logic;
- build tooling;
- unrelated maintenance.

Do not split tiny changes so far that every branch requires coordination without reducing risk.

## Review format

Current project convention:

```text
docs/specs/reviews/NNN-short-kebab-title-review.md
```

Use:

```text
# Review NNN: Title

Branch: `feature/...`
Status: ready to merge | changes required

## Confirmed
...

## Follow-ups

### R1 — High: concise finding
Files: ...

Current:
...

Target:
...

Acceptance:
...
```

Reviews should be concise. Record only findings that require action or verification.

The repository’s verified `docs/specs/README.md` still documents reviews appended to the same spec.
That is an outdated workflow relative to the current user decision. Update it when the repository
workflow documentation is next changed.

## Review principles

- Code reading first.
- Do not accept an implementation record as proof of logic correctness.
- Do not rerun the entire suite by default when the implementer already did so; run a focused check
  only when decisive for a specific doubt.
- Explicitly distinguish:
  - confirmed code behavior;
  - reported test results;
  - independently executed checks;
  - manual checks not performed.
- Check branch scope.
- Look for edge cases tooling misses:
  - non-finite scientific values;
  - N+1 access;
  - stale query caches;
  - hidden selections;
  - accessibility;
  - loading/error/empty states;
  - race conditions and stale background writes;
  - migration immutability;
  - cache-key/schema-version drift.

## Persistent schema changes

1. Add a new forward-only migration.
2. Never edit a released migration.
3. Preserve older user data.
4. Test fresh creation and upgrade from the previous revision.
5. Test backup/compatibility behavior where relevant.
6. Do not use `Base.metadata.create_all()` as a substitute for production migration logic.

## Scientific changes

1. Define formula, units, null behavior and aggregation scope explicitly.
2. Keep the calculation deterministic and backend-owned.
3. Decide whether `CALC_VERSION` or a per-kind analysis schema version must change.
4. Include relevant metadata/overrides in cache keys.
5. Test:
   - representative values;
   - missing metadata;
   - zero and invalid inputs;
   - NaN and infinity;
   - multi-file/multi-cycle boundaries;
   - provenance and export labels.
6. Ensure UI explanations and exported methods match the implemented calculation.

## Frontend/server-state changes

- Use React Query for backend-owned state.
- Invalidate or update every affected list, detail, folder, replicate, analysis, preview and activity
  query.
- Preserve cached content during background refresh.
- Distinguish loading, failure and confirmed empty state.
- Do not let search-filtered data become canonical membership data.
- Prune hidden selections before destructive bulk actions where required.
- Keep hooks above early returns in large components.
- Verify actual browser behavior for hook-order, keyboard and layout-sensitive changes.

## UI standards

Read `docs/agent-knowledge/visual-style-guide.md` before frontend changes.

Check:

- light and dark chrome;
- Plotly’s independent light presentation;
- compact control geometry;
- disabled/loading/error/empty/success states;
- truncation and horizontal overflow;
- keyboard focus and activation;
- accessible names and popup semantics;
- desktop-width browser flow.

A TypeScript build does not prove visual or hook-order correctness.

## Performance changes

1. Measure the real slow boundary.
2. State baseline and test environment.
3. Preserve scientific and export fidelity.
4. Bound parallelism across nested layers.
5. Keep test isolation real, not nominal.
6. Cache skips must be conservative and visibly reported.
7. Include toolchain/configuration inputs in skip identities.
8. Add a regression test for the confirmed cause.
9. Record before/after timings using repeated or paired runs when noise is significant.

## Verification hierarchy

Use the commands documented in the current branch. On the verified `main` commit:

```powershell
python -m unittest discover tests
node --test frontend\tests\*.test.ts
python scripts\preflight.py
python scripts\check_versions.py
```

Typical expectations:

- backend/domain change: focused tests plus full Python suite;
- frontend logic: direct TypeScript policy tests and production build;
- UI interaction/layout: browser verification;
- migration: focused migration/data-preservation tests;
- packaging: follow packaging guides and build only when requested or packaging changed.

Never claim a command passed unless it ran. State environment limitations.

## Release discipline

For a completed committed change:

- patch: compatible fix, reliability or internal change;
- minor: backward-compatible feature/workflow addition;
- major: intentional compatibility break that cannot be safely migrated.

Keep all maintained version declarations synchronized and update `CHANGELOG.md` in user-facing
language. Installer rebuild is not required for ordinary code review unless requested.
