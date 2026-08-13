# 043 — Project-context synchronization and cache reclamation

**Status:** Plan  
**Repository:** `mattiafelice-palermo/cellxplorer`  
**Depends on:** Parent 040 merged (`738167d` on `main`); Spec 042 merged before Part B, because its
identity bring-forward changes which caches are current  
**Shape:** two independent parts, deliberately ordered. Part A is documentation only. Part B deletes
user data from disk.

> **Do Part A and Part B in separate sessions.** They share nothing but this file. Part A is a
> half-hour documentation pass; Part B removes ~1.64 GB of scientific cache and every rule in it
> exists because something is recoverable only from cache. An implementer may complete Part A, commit,
> and stop — that is an expected outcome, not an incomplete one.

---

# Part A — Project-context synchronization

## Why

The four project-context files (`CELLXPLORER_PROJECT_INSTRUCTIONS.md`, `CELLXPLORER_ARCHITECTURE.md`,
`CELLXPLORER_DEVELOPMENT_WORKFLOW.md`, `CELLXPLORER_CONTEXT_MAINTENANCE.md`) are orientation material
uploaded to a ChatGPT Project. Until 2026-08-13 they existed **only** as uploads outside the
repository, so drift was invisible to Git and caught only by hand.

Two consequences.

**A backlog item.** `CELLXPLORER_ARCHITECTURE.md` was corrected on 2026-08-13 for drift accumulated
since its verified commit `d577d2b2` — 405 commits back — but that pass covered **merged main only**,
which then meant Spec 039's Excel support. Parent 040 was deliberately excluded because it was
unmerged and those files' own rules forbid writing unmerged work as current architecture. **040 is
now merged**, so the exclusion has expired.

**A process gap.** `CELLXPLORER_CONTEXT_MAINTENANCE.md` step 9 requires updating the repository copies
"in the same feature change". Parent 040 could not, because the repository copies did not exist yet.
They exist now, and nothing reminds anyone.

## Required reading

- `docs/project-context/CELLXPLORER_CONTEXT_MAINTENANCE.md` — binding. Its authority order, evidence
  threshold, and update steps govern this work.
- `docs/project-context/CELLXPLORER_ARCHITECTURE.md`
- `docs/agent-knowledge/canonical-cycling-data.md`
- `docs/specs/040-canonical-cycler-data-architecture.md` and its five child reviews

## A1 — Fold Parent 040 into the architecture file

Parent 040 hits three of the maintenance file's own Architecture-file triggers: canonical data model
or ownership; source adoption/parsing lifecycle; cache tiers, cache keys or invalidation ownership.

Update `docs/project-context/CELLXPLORER_ARCHITECTURE.md` in that file's compact orientation register
— **not** a copy of the agent-knowledge doc — to describe:

1. **the canonical cycling contract** — CellXplorer owns an explicit canonical raw row model
   (`backend/app/services/canonical_cycling.py`); every source format adapts into it; scientific code
   downstream of parsing is format-neutral;
2. **source-format adapters** — `parsing.py` is a format-neutral facade dispatching through a static
   registry; adapters own their recognition and errors
   (`backend/app/services/source_format_errors.py`);
3. **per-source parser identity** — cache keys and analysis provenance are keyed per source, not by
   one global parser version, so one format's adapter revision no longer invalidates another's
   caches; saved analyses pin their sources' identities and render from pinned historical caches;
4. **the optional multi-voltage path** — `working_potential_v` / `counter_potential_v` are canonical
   optional columns; `voltage_v` remains the default for every existing analysis.

Correct in the same pass:

- the "Scientific calculations and cache versioning" section, which describes cache keys in pre-040
  terms;
- any statement that `timestamp` is required — Parent 040 was amended (user-ratified) to make it a
  canonical *optional* column.

Update `Context last synchronized` and `Verified against` to a commit that actually contains Parent
040. Follow the minimum-edit rule; do not regenerate unrelated sections.

## A2 — Close the process gap

Add a durable reminder so this does not depend on memory. Choose the **smallest** mechanism that
actually fires; do not build tooling. In preference order:

1. a line in `docs/specs/README.md`'s lifecycle/closure rules requiring a parent's final child to
   check the project-context files against the maintenance file's trigger lists;
2. a line in `AGENTS.md` where durable-documentation obligations already live;
3. a checklist item in the maintenance file itself.

It must name the trigger lists rather than say "update the docs" — the point of those lists is that
most changes require no update at all.

## A3 — Keep the mirror honest

The repository copy is canonical; the uploaded Project files mirror it. After editing, verify all four
repository copies and the user's four uploads are byte-identical (or state precisely which differ and
why), and tell the user **exactly** which uploads to replace. Do not report "the docs are updated"
when only the repository copy changed — the maintenance file forbids that explicitly.

## Part A scope limits

No production code. No restructuring of `docs/project-context/` or adding files to it (requires
explicit user approval). Do not rewrite the workflow or instructions files unless a contradiction with
the architecture edits is found — check for contradictions per maintenance step 6, but do not
regenerate. Do not describe Spec 042 or any unmerged branch as current architecture.

## Part A acceptance criteria

- the architecture file describes the post-040 architecture accurately and compactly;
- `Verified against` names a commit containing Parent 040;
- no unmerged work is stated as current fact;
- all four files checked for contradictions;
- repository copies and uploaded mirrors consistent, and the user told which uploads to replace;
- a durable reminder exists so the next parent does not repeat the gap.

---

# Part B — Orphaned and superseded cache reclamation

**This part deletes user data from disk.** Every rule below exists because something is recoverable
only from cache.

## Why

Measured on a real user library:

```text
cache directories on disk                     923
source hashes known to the database           156
orphan directories (no SourceFile row at all)  779   =  1.64 GB
stale-identity raw files under KNOWN sources   143
```

About 85% of cache directories belong to hashes the database no longer knows, and are never
reclaimed. Separately, every parser-identity change leaves a superseded generation of identity-keyed
caches behind — Parent 040 created one, Parent 041 will create another. Nothing prunes them, so this
grows monotonically.

## What is NOT broken — read before proposing a fix

Two things look like bugs and are not. An implementation that "fixes" either is wrong.

### Cell deletion already has a deliberate retention policy

`library.delete_cells_from_library` documents it:

> Online `SourceFile` rows become unregistered data once their Cell is deleted, so they and their
> regenerable caches are removed after the transaction commits. Offline or changed sources are
> retained together with their cache: **the cache may be the only locally readable copy of that
> data.**

Correct, and must be preserved. Retaining an offline source's cache after its cell is deleted is
deliberate data preservation, not a leak.

### Superseded identity-keyed caches under known sources are load-bearing

The 143 stale-identity files sit under sources the database still knows. Spec 040.3 requires that a
saved analysis pinned to an older parser identity renders **from its own cache at that identity**,
never by reparsing under a newer one. Those files are what makes that work. Deleting one a saved
analysis still pins turns a working analysis into a `cache_missing` result.

## Investigation required before writing deletion code

Establish and record these facts first:

1. **Why doesn't existing cleanup reclaim the 779?** `cache_maintenance.py` has `cleanup_category`,
   `cleanup_eligible_scientific` and `cleanup_offender`. Determine whether this is a gap in
   eligibility, a budget threshold that never triggers, or a path that only walks hashes reachable
   from the database. The answer decides whether to extend existing machinery or add a pass — extend
   if at all possible.
2. **What still references an orphaned hash?** At minimum saved `Analysis.provenance` JSON (which
   pins `sources[].files[].hash` since 040.3), saved plot artifacts, and portable-report records. A
   hash with no `SourceFile` row may still be pinned by a saved analysis, and that analysis must keep
   rendering.
3. **Are any of the 779 recoverable in principle?** If an orphan hash corresponds to a source file
   still reachable on disk, deleting its cache is cheap to undo; if not, deletion is permanent. Policy
   may reasonably differ.
4. **What is the superseded-generation rule?** For a known source now at identity B with a cache at
   identity A, determine exactly when A is safe to drop. The obvious rule — "no saved analysis pins A"
   — must be verified against how provenance is actually queried, including legacy single-parser
   provenance normalized per 040.3.

## Required behavior

### Never delete

- a cache at an identity pinned by any saved analysis, saved plot artifact or portable report;
- a cache belonging to an offline or changed `SourceFile`, per the retention policy above;
- a cache for a source whose original file is unreachable, unless the user explicitly asks — that
  cache may be the only copy.

### Safe to reclaim

- cache directories whose hash appears in **no** `SourceFile` row **and** is pinned by nothing;
- superseded identity generations under a known source, once nothing pins them.

### User-facing

Reclamation must be **visible and consented**, not silent. Report what would be freed before freeing
it, in the existing cache-management surface, and make a dry run possible. A silent background delete
of 1.64 GB of scientific cache is unacceptable even when provably safe, because "provably safe"
depends on this spec's own reasoning being correct.

Whether any part becomes automatic is a decision to record explicitly with justification — do not make
it automatic by default.

### The 12 retained-but-cacheless rows

The reporting library has 12 `SourceFile` rows that are offline, orphaned (referenced by zero
`test_files` rows) **and have no cache at all**. The retention rationale — "the cache may be the only
locally readable copy" — does not apply when there is no cache and no reachable file. Decide
explicitly whether such rows are reclaimable, and if so only with consent. They are harmless clutter,
so doing nothing is acceptable if justified.

## Part B scope limits

No `CALC_VERSION` change, no scientific formula or cached numeric meaning change. Do not weaken Spec
040.3's pinned-cache guarantee. Do not change the cell-deletion retention policy. No relational
migration. No redesign of the cache budget or warmup queue.

## Part B tests

1. an orphaned hash pinned by a saved analysis is **not** reclaimed;
2. an orphaned hash pinned by nothing **is** reported as reclaimable;
3. a superseded identity generation pinned by a saved analysis is **not** reclaimed;
4. a superseded generation pinned by nothing is reported as reclaimable;
5. an offline source's cache is never reclaimed by the automatic path;
6. legacy single-parser provenance is normalized before the pinned check, so an old saved analysis
   still protects its caches;
7. dry run reports the same set the real run deletes;
8. a saved analysis still renders after a full pass — the regression this spec most needs to disprove;
9. the pass is bounded and does not block startup or list endpoints;
10. no scientific numeric output changes.

## Part B acceptance criteria

- reclaimable space reported accurately before anything is deleted;
- nothing pinned by a saved analysis, artifact or portable report is ever deleted;
- the offline retention policy and 040.3's pinned-cache guarantee both survive intact;
- superseded generations reclaimable under a stated, tested rule;
- existing cleanup machinery extended rather than duplicated, or the reason recorded;
- `python scripts\preflight.py --no-cache` passes with no SKIP lines.

---

## Implementation record

_To be filled by the implementing agent. Record Part A and Part B separately, including which parts
were done and which were deliberately left._
