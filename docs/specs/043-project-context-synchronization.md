# 043 — Project-context synchronization

**Status:** Plan  
**Repository:** `mattiafelice-palermo/cellxplorer`  
**Depends on:** Parent 040 merged (done, `738167d` on `main`); branch
`docs/project-context-canonical` merged or folded in  
**Size:** small — documentation only, no production code

## Why this exists

The four project-context files (`CELLXPLORER_PROJECT_INSTRUCTIONS.md`, `CELLXPLORER_ARCHITECTURE.md`,
`CELLXPLORER_DEVELOPMENT_WORKFLOW.md`, `CELLXPLORER_CONTEXT_MAINTENANCE.md`) are orientation material
uploaded to a ChatGPT Project. Until 2026-08-13 they existed **only** as uploads outside the
repository, so drift in them was invisible to Git and was caught only by hand.

Two things follow.

**1. A backlog item.** `CELLXPLORER_ARCHITECTURE.md` was corrected on 2026-08-13 for drift accumulated
since its verified commit `d577d2b2` — 405 commits back — but that correction covered **merged main
only**, which at the time meant Spec 039's Excel support. Parent 040 was deliberately excluded
because it was unmerged and the files' own rules forbid writing unmerged work as current
architecture. **040 is now merged**, so that exclusion has expired.

**2. A process gap.** `CELLXPLORER_CONTEXT_MAINTENANCE.md` step 9 says to update the repository
copies "in the same feature change". Parent 040 did not do this, because the repository copies did
not exist yet. They exist now, so future parents have no excuse — but nothing currently reminds
anyone.

## Required reading

- `docs/project-context/CELLXPLORER_CONTEXT_MAINTENANCE.md` — it governs this work. Its authority
  order, evidence threshold, and "how an agent should update the files" steps are binding.
- `docs/project-context/CELLXPLORER_ARCHITECTURE.md`
- `docs/agent-knowledge/canonical-cycling-data.md` — the durable 040 architecture description
- `docs/specs/040-canonical-cycler-data-architecture.md` and its five child reviews

## Task 1 — Fold Parent 040 into the architecture file

Parent 040 hits three of the maintenance file's own Architecture-file update triggers:

- canonical data model or ownership;
- source adoption/parsing lifecycle;
- cache tiers, cache keys or invalidation ownership.

Update `docs/project-context/CELLXPLORER_ARCHITECTURE.md` to describe, in that file's compact
orientation register — **not** a copy of the agent-knowledge doc:

1. **the canonical cycling contract** — that CellXplorer owns an explicit canonical raw row model
   (`backend/app/services/canonical_cycling.py`), that every source format adapts into it, and that
   scientific code downstream of parsing is format-neutral;
2. **source-format adapters** — `parsing.py` is a format-neutral facade dispatching through a static
   registry; adapters own their own recognition and errors
   (`backend/app/services/source_format_errors.py`);
3. **per-source parser identity** — cache keys and analysis provenance are keyed per source, not by
   one global parser version, so one format's adapter revision no longer invalidates another's
   caches; saved analyses pin their sources' identities and render from pinned historical caches;
4. **the optional multi-voltage path** — `working_potential_v` / `counter_potential_v` are canonical
   optional columns; `voltage_v` remains the default for every existing analysis.

Also correct, in the same pass:

- the "Scientific calculations and cache versioning" section, which describes cache keys in
  pre-040 terms;
- the `timestamp` requirement if that file states one — Parent 040 was amended (user-ratified) to
  make `timestamp` a canonical *optional* column, not a required one.

Update `Context last synchronized` and `Verified against` to the merge commit or later. Follow the
maintenance file's minimum-edit rule: do not regenerate unrelated sections.

## Task 2 — Close the process gap

Add a short, durable reminder so this does not depend on someone remembering. Choose the **smallest**
mechanism that actually fires; do not build tooling. Options, in preference order:

1. a line in `docs/specs/README.md`'s spec lifecycle/closure rules requiring a parent's final child
   to check the project-context files against the maintenance file's trigger lists;
2. a line in `AGENTS.md` where durable-documentation obligations already live;
3. a checklist item in the maintenance file itself.

Whichever is chosen, it must name the trigger lists rather than say "update the docs" — the whole
point of those lists is that most changes require no update at all.

## Task 3 — Keep the mirror honest

The repository copy is canonical; the uploaded Project files mirror it. After editing:

- verify all four repository copies and the four files the user uploads are byte-identical, or state
  precisely which differ and why;
- tell the user **exactly** which uploaded Project files to replace. Do not say "the docs are
  updated" when only the repository copy changed — the maintenance file explicitly forbids that.

## Explicitly out of scope

- production code of any kind;
- restructuring `docs/project-context/` or adding files to it (the maintenance file requires explicit
  user approval);
- rewriting `CELLXPLORER_DEVELOPMENT_WORKFLOW.md` or `CELLXPLORER_PROJECT_INSTRUCTIONS.md` unless a
  contradiction with the architecture edits is found — check for contradictions, per maintenance
  step 6, but do not regenerate;
- describing Spec 042 or any unmerged branch as current architecture.

## Acceptance criteria

- the architecture file describes the post-040 architecture accurately and compactly;
- `Verified against` names a commit that actually contains Parent 040;
- no unmerged work is stated as current fact;
- all four files are checked for contradictions;
- repository copies and uploaded mirrors are consistent, and the user is told which uploads to
  replace;
- a durable reminder exists so the next parent does not repeat this gap.

## Implementation record

_To be filled by the implementing agent._
