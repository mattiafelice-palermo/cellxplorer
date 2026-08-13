# CellXplorer — ChatGPT Project Instructions

Repository: `mattiafelice-palermo/cellxplorer`  
Default branch: `main`  
Context files last synchronized: 2026-07-26  
Verified against: `main` at `d577d2b2eb959914e84575dd0bf12b05bff42693`

Use these instructions for every repository-specific task in this project.

## Source-of-truth order

1. The current GitHub branch being discussed.
2. Tests and executable configuration on that branch.
3. `AGENTS.md`.
4. `docs/agent-knowledge/` and specialist documentation under `docs/`.
5. The active feature specification and its review file.
6. These project context files.
7. Previous project chats and memory.

Never treat project memory or these uploaded files as proof of the current implementation when the
repository can be inspected directly.

## Before repository-specific work

1. Confirm the exact repository and branch.
2. Identify the correct merge base. Do not assume every feature branch is based directly on `main`.
3. Read:
   - `AGENTS.md`;
   - `docs/agent-knowledge/README.md`;
   - the topic-specific knowledge document;
   - `docs/specs/README.md`;
   - the relevant specification and review file.
4. Inspect the actual implementation and tests.
5. Distinguish:
   - verified repository facts;
   - branch-specific facts;
   - recommendations;
   - assumptions or unresolved questions.

## Engineering priorities

- Preserve scientific correctness, provenance, determinism and reproducibility.
- Keep scientific calculations in backend services unless the repository explicitly establishes a
  shared frontend/report implementation.
- Preserve the local-first SQLite and Parquet architecture.
- Keep list endpoints relational and bounded: no per-row Parquet reads, source-file reads,
  scientific-stack imports or N+1 API/database access.
- Keep parsing, checksum work, cache rebuilding and expensive analysis work off request/UI critical
  paths.
- Never edit a released migration. Persistent schema changes require a new forward-only revision
  and focused migration/data-preservation tests.
- Bump `CALC_VERSION` only when the meaning of cached scientific output changes.
- Reuse existing components, services and patterns before adding abstractions or dependencies.
- Prefer small, reversible changes. This repository is maintained by a solo developer using AI
  coding agents; avoid process and architecture intended only for a large team.
- Do not broadly refactor `AnalysisPage.tsx` unless the task requires it. Extract one coherent
  responsibility at a time and protect saved-plot, autosave and draft behavior.
- Preserve light/dark behavior, keyboard access, loading/error/empty states and compact Mantine
  geometry for UI work.
- Never modify, reset or discard unrelated work.

## Specifications

Specs must be self-contained for a coding agent that did not see the originating conversation.

Include:

- goal and locked decisions;
- current files/functions/endpoints with grep-able anchors;
- exact target behavior and data shapes;
- cache, migration and invalidation consequences;
- explicit out-of-scope items;
- implementation order;
- tests, manual checks and acceptance criteria.

Split a request when it spans independent backend, UI or workflow concerns and combining them would
increase partial-implementation risk.

### Review-file convention

Current project convention, decided 2026-07-26:

- specification: `docs/specs/NNN-short-title.md`;
- implementation review: `docs/specs/reviews/NNN-short-title-review.md`;
- review findings use `R1`, `R2`, … with priority, Current, Target and Acceptance criteria;
- subsequent review rounds update the same review file.

`docs/specs/README.md` on the verified `main` commit still describes the older convention of
appending reviews to the specification. Treat the separate-review-file convention above as the
current user decision, and update the repository documentation when that workflow is next changed.

## Code-review behavior

- State whether the branch is ready to merge.
- Compare against the correct base and identify cumulative or unrelated branch scope.
- Read code first; do not merely restate the spec.
- Report only concrete defects, spec deviations, regression risks or missing verification.
- Order findings by severity.
- For each finding provide:
  - affected files;
  - Current;
  - Target;
  - Acceptance criteria.
- Record what the implementer reported as tested and what the reviewer independently ran.
- Never claim manual browser checks or test commands passed unless they were actually performed.
- Do not modify repository files unless explicitly requested.

## Verification

Use the repository’s current canonical commands, not remembered commands. On the verified `main`
commit, the full local check is:

```powershell
python scripts\preflight.py
```

Backend, frontend and packaging checks should follow `AGENTS.md`,
`docs/agent-knowledge/change-playbooks.md`, and the active spec. If a command cannot run in the
available environment, state that directly.

## Project-context maintenance

Read `CELLXPLORER_CONTEXT_MAINTENANCE.md`. When a durable repository change makes these files
misleading, produce updated replacement files rather than silently continuing with stale context.
