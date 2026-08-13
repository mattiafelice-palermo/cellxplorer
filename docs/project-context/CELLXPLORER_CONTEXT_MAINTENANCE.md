# CellXplorer Project Context Maintenance

These files are uploaded orientation material for ChatGPT Project chats:

- `CELLXPLORER_PROJECT_INSTRUCTIONS.md`
- `CELLXPLORER_ARCHITECTURE.md`
- `CELLXPLORER_DEVELOPMENT_WORKFLOW.md`
- this file

They are mirrors, not the source of truth.

## Authority

Use this order:

1. current repository branch and tests;
2. `AGENTS.md` and repository documentation;
3. active specs/reviews;
4. project context files.

A mismatch must never be resolved by forcing the repository to agree with an uploaded summary.

## Required drift check

Before relying heavily on these files for a repository-wide task:

1. read the `Verified against` commit in each file;
2. inspect the current default-branch head;
3. when the head differs, check whether changes affect the topic being discussed;
4. for branch-specific work, inspect the branch directly regardless of the stored commit.

A different commit alone does not require rewriting these files. Update only when a durable,
cross-cutting fact changed.

## Changes that require an update

Update the relevant project file when verified repository changes alter any of these:

### Architecture file

- runtime stack or process boundaries;
- canonical data model or ownership;
- persistent-data locations;
- startup/migration sequence;
- source adoption/parsing lifecycle;
- cache tiers, cache keys or invalidation ownership;
- analysis-family boundaries;
- portable-report security/format ownership;
- packaging or desktop endpoint architecture;
- major performance invariants.

### Workflow file

- canonical branch/spec/review convention;
- migration policy;
- testing/preflight/CI commands;
- versioning/release policy;
- branch stacking or PR expectations;
- UI verification requirements;
- coding-agent handoff format;
- repository-maintained file locations.

### Project instructions

- source-of-truth order;
- explicit user decisions;
- non-negotiable engineering constraints;
- review output format;
- canonical verification entry point.

## Changes that do not require an update

Do not rewrite these files for:

- one narrow component implementation;
- temporary branch state;
- transient bugs;
- speculative future architecture;
- line-number changes;
- a new endpoint that does not change ownership or workflow;
- chronological progress notes;
- unmerged experiments unless the user explicitly designates them as the new baseline.

## Evidence threshold

A project-context change must be supported by at least one of:

- merged/current default-branch code plus tests;
- an explicit invariant in `AGENTS.md` or `docs/agent-knowledge/`;
- an explicit current user decision about workflow;
- an accepted spec that the user identifies as the intended new baseline.

Do not update from inference alone. When documentation and code disagree, inspect tests and runtime
behavior, then report the discrepancy.

## How an agent should update the files

When a durable mismatch is confirmed:

1. Identify the smallest affected file and section.
2. Verify the new fact against code, tests and repository docs.
3. Preserve terminology used by the repository.
4. Edit the minimum necessary text; do not regenerate unrelated sections.
5. Update:
   - `Context last synchronized`;
   - `Verified against`;
   - any affected paths or commands.
6. Check all four files for contradictions.
7. Produce replacement Markdown files with the same filenames.
8. Tell the user exactly which Project files should be replaced.
9. When canonical copies exist in the repository, update those in the same feature change.

Do not silently state that Project files were updated when only a chat response was produced.

## Canonical storage

Established 2026-08-13 with explicit user approval. The canonical copies live under:

```text
docs/project-context/
├── CELLXPLORER_PROJECT_INSTRUCTIONS.md
├── CELLXPLORER_ARCHITECTURE.md
├── CELLXPLORER_DEVELOPMENT_WORKFLOW.md
└── CELLXPLORER_CONTEXT_MAINTENANCE.md
```

The files uploaded to the ChatGPT Project mirror these repository copies. This makes drift reviewable
in Git and lets an agent regenerate the uploaded versions without reconstructing them from chat
history.

The repository copy is canonical. When these files change, update the repository copy in the same
change and tell the user which uploaded Project files to replace — never only one of the two.

Do not restructure this directory, add files to it, or repoint the mirror without explicit user
approval.

## Agent response when drift is found

Use a concise notice:

```text
Project context drift detected.

Repository fact:
...

Outdated project file:
...

Required update:
...

Evidence:
- file/test ...
```

Then either:

- create updated replacement files when artifact-writing access is available; or
- provide an exact patch when it is not.

Continue the requested repository task using the live code as source of truth; do not block all work
merely because the uploaded context is stale.

## Known discrepancy at initial creation — resolved

At synchronization commit `d577d2b2...`, `docs/specs/README.md` described reviews appended to the
same spec file. The user subsequently chose separate review files.

Current project convention:

```text
docs/specs/reviews/NNN-short-title-review.md
```

Resolved as of `main` at `562c2edf...`: `docs/specs/README.md` now documents this convention
directly and maintains a reviews index, and `CELLXPLORER_DEVELOPMENT_WORKFLOW.md` already states the
same path. No further reconciliation is outstanding.
