# Agent startup guide

Use this file as the starting point for a new Codex chat working in CellXplorer. It is a routing
guide, not a replacement for `AGENTS.md`, the active specification, or the current code and tests.
Those sources remain authoritative when this guide is incomplete or stale.

## Read first

1. Read [`AGENTS.md`](../AGENTS.md) completely.
2. Read [`README.md`](../README.md) for the application overview.
3. Read [`docs/specs/README.md`](specs/README.md) for specification lifecycle, branch, review,
   verification, and handoff rules.
4. Identify the requested spec and read its parent and the assigned child completely. For a
   standalone spec, read that spec completely.
5. Read only the relevant files linked by the spec and the corresponding agent-knowledge or
   change-playbook documents. For frontend work, always read
   [`docs/agent-knowledge/visual-style-guide.md`](agent-knowledge/visual-style-guide.md).

Do not start by reading every file in the repository. Use the spec's anchors, `AGENTS.md`, and
the knowledge-base index to narrow the investigation, then verify those anchors against the
current code before editing.

## Repository orientation

CellXplorer is a local-first Windows application with a React/Mantine frontend, FastAPI/SQLAlchemy
backend, and Tauri desktop shell. The canonical user-facing scientific hierarchy is:

```text
Cell
└── ordered SourceFiles
```

A Cell is the primary object users select and analyze, and interruptions or restarts remain
successive sources in that single Cell chain. `Test` and `TestFile` are internal compatibility
storage only: every Cell uses exactly one internal Test row whose `TestFile.position` values store
the source order. See the core data rules in `AGENTS.md`.

Source files remain at their original paths. The database stores provenance, checksums, and
relationships; parsed and derived scientific data lives in regenerable caches. Analyses and
replicate groups refer to Cells rather than copying scientific data. Never clear, replace, seed,
or migrate a real user data root unless the user explicitly requests it.

Important starting locations include:

- `backend/app/models.py`, `backend/app/routers/`, and `backend/app/services/` for domain and API
  behavior;
- `frontend/src/api.ts`, `frontend/src/pages/`, and `frontend/src/components/` for typed client,
  page, and reusable-surface behavior;
- `tests/` and `frontend/tests/` for backend and frontend policy coverage;
- `docs/agent-knowledge/` for durable architecture, performance, scientific, visual, and
  packaging invariants.

## Before editing

Run read-only repository checks and record what they show:

```powershell
git status --short --branch
git branch --show-current
git log -1 --oneline --decorate
```

Preserve unrelated tracked changes and all untracked user work. Do not use reset, checkout, clean,
or broad deletion to make the tree convenient. Treat temporary files, test data, and database
directories as user-owned unless their scope is proven safe.

For a parent specification, continue on its existing shared feature branch. Do not create a
child-specific branch or begin a later child early. If another feature branch is already open,
follow the repository's sequential branch workflow rather than creating a competing branch.

Before implementation, verify the spec's current-code anchors and inspect the neighboring tests.
Current code and tests take precedence over stale prose only when the locked product or scientific
decision is not contradicted; if a locked decision is impossible or scientifically unsafe, stop
and request a spec amendment.

## Implementation loop

Work only on the requested spec or review follow-up. Keep mutations, validation, cache behavior,
activity logging, query invalidation, and exports consistent with the existing ownership rules.
Backend scientific calculations must remain deterministic and server-owned. Add focused tests for
the behavior changed; do not weaken existing tests or use private source files as committed
fixtures.

For frontend work, follow the visual guide and cover relevant loading, empty, error, disabled,
dark-mode, truncation, keyboard, and accessible-label states. Do not run browser interaction
tests unless the user explicitly authorizes them; record the manual checklist as not run when the
spec requires it.

Run the exact focused verification named by the active spec. Use the repository's canonical
commands where applicable:

```powershell
python -m unittest discover tests
node --test frontend\tests\*.test.ts
cd frontend
npx.cmd tsc --noEmit
npx.cmd vite build
cd ..
python scripts\preflight.py
```

Do not claim a command passed unless it was actually run. `vite build` is required for frontend
source, entrypoint, public-asset, Vite, TypeScript-config, package, or lockfile changes; it is not
required for backend-only, documentation-only, or frontend-test-only changes unless the active
spec says otherwise.

When a durable architectural constraint, failure mode, or verification technique is discovered,
update the relevant knowledge document in the same change. Do not turn knowledge documents into a
chat transcript or chronological work log.

## Checkpoint and handoff

Before declaring an implementation checkpoint complete:

1. Update the active spec or review file with the implementation record: changed files and
   behavior, decisions, exact commands/results, anything not run, branch, commit, and review link.
2. Confirm unrelated changes and private data are not included.
3. Commit the focused checkpoint on the shared feature branch.
4. Push it to `origin` so reviewers and other agents can read it.
5. Leave review findings in the separate review document; do not append them to the spec.

Do not merge a parent feature branch between children. Merge only after every child has a clean
review and the parent-level regression and integration verification has passed. Do not version-tag
or release as part of ordinary spec implementation unless the user explicitly asks for a release
or the active workflow requires it.

## Useful handoff prompt

For a child implementation, start the new chat with:

```text
Implement docs/specs/NNN.S-child-name.md.

First read docs/agent-startup.md, AGENTS.md, docs/specs/README.md, the parent specification in
full, and the named child specification in full. Continue on the parent's shared feature branch.
Inspect every current-code anchor before editing, preserve unrelated work, implement only this
child, run its exact verification, record anything not run, commit the focused checkpoint, and
push the branch for review. Do not run browser tests unless explicitly authorized.
```
