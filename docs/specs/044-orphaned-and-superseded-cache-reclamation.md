# 044 — Orphaned and superseded cache reclamation

**Status:** Plan  
**Repository:** `mattiafelice-palermo/cellxplorer`  
**Depends on:** Parent 040 merged; Spec 042 merged (its identity bring-forward changes which caches
are current, which this spec must not fight)  
**Risk:** this spec **deletes user data from disk**. Every rule below exists because something is
recoverable only from cache.

## Why this exists

Measured on a real user library:

```text
cache directories on disk                     923
source hashes known to the database           156
orphan directories (no SourceFile row at all)  779   =  1.64 GB
stale-identity raw files under KNOWN sources   143
```

Roughly 85% of the cache directories belong to hashes the database no longer knows about, and they
are never reclaimed. Separately, every parser-identity change leaves a superseded generation of
identity-keyed caches behind — Parent 040 created one such generation, and Parent 041 (BioLogic) will
create another. Nothing prunes them today, so this grows monotonically.

## What is NOT broken — read before proposing a fix

Two things look like bugs and are not. An implementation that "fixes" either is wrong.

### Cell deletion already has a deliberate retention policy

`library.delete_cells_from_library` documents it:

> Online `SourceFile` rows become unregistered data once their Cell is deleted, so they and their
> regenerable caches are removed after the transaction commits. Offline or changed sources are
> retained together with their cache: **the cache may be the only locally readable copy of that
> data.**

That is correct and must be preserved. Retaining an offline source's cache after its cell is deleted
is a deliberate data-preservation choice, not a leak.

### Superseded identity-keyed caches under known sources are load-bearing

The 143 stale-identity files above sit under sources the database still knows. Spec 040.3 requires
that a saved analysis pinned to an older parser identity renders **from its own cache at that
identity**, never by reparsing under a newer one. Those files are what makes that work. Deleting a
superseded cache that a saved analysis still pins would turn a working analysis into a
`cache_missing` result.

## Goal

Reclaim cache that is genuinely unreachable, without ever deleting data that is someone's only copy
or that a saved analysis still depends on.

## Investigation the implementer must do first

Do not start writing deletion code. Establish these facts and record them:

1. **Why doesn't existing cleanup already reclaim the 779?** `cache_maintenance.py` has
   `cleanup_category`, `cleanup_eligible_scientific` and `cleanup_offender`. Determine whether this is
   a gap in what they consider eligible, a budget threshold that never triggers, or a path that only
   ever walks hashes reachable from the database. The answer decides whether this spec extends
   existing machinery or adds a new pass — extend if at all possible.
2. **What still references an orphaned hash?** At minimum check saved `Analysis.provenance` JSON
   (which pins `sources[].files[].hash` since 040.3), saved plot artifacts, and portable-report
   records. A hash with no `SourceFile` row may still be pinned by a saved analysis; that analysis
   must keep rendering.
3. **Are any of the 779 recoverable in principle?** If an orphan hash corresponds to a source file
   still present on disk somewhere the app knows about, deleting its cache is cheap to undo. If not,
   deletion is permanent. The policy may reasonably differ between those cases.
4. **What is the superseded-generation rule?** For a known source now at identity B with a cache
   still present at identity A, determine exactly when A becomes safe to drop. The obvious rule — "no
   saved analysis pins A" — must be verified against how provenance is actually queried, including
   legacy single-parser provenance normalized per 040.3.

## Required behavior

### Never delete

- a cache at an identity pinned by any saved analysis, saved plot artifact or portable report;
- a cache belonging to an offline or changed `SourceFile`, per the retention policy above;
- a cache for a source whose original file is not reachable, unless the user explicitly asks —
  that cache may be the only copy of the data.

### Safe to reclaim

- cache directories whose hash appears in **no** `SourceFile` row **and** is pinned by nothing;
- superseded identity generations under a known source, once nothing pins them.

### User-facing

Reclamation must be **visible and consented**, not silent. Report what would be freed before freeing
it, in the existing cache-management surface. A silent background delete of 1.64 GB of scientific
cache is not acceptable even when provably safe, because "provably safe" depends on this spec's own
reasoning being right.

Prefer: report the reclaimable total, let the user trigger it, and make a dry-run possible. Whether
any part becomes automatic is a decision to record explicitly with its justification — do not make it
automatic by default.

### The 12 retained-but-cacheless rows

The reporting library has 12 `SourceFile` rows that are offline, orphaned (referenced by zero
`test_files` rows) **and have no cache at all**. The retention policy's rationale — "the cache may be
the only locally readable copy" — does not apply when there is no cache and no reachable file. Decide
explicitly whether such rows should be reclaimable, and if so only with the user's consent. They are
harmless apart from clutter, so doing nothing is an acceptable outcome if justified.

## Explicitly out of scope

- changing `CALC_VERSION`, any scientific formula, or any cached numeric meaning;
- weakening Spec 040.3's pinned-cache guarantee in any way;
- changing the cell-deletion retention policy;
- a relational migration;
- redesigning the cache budget or the warmup queue.

## Tests

1. an orphaned hash pinned by a saved analysis is **not** reclaimed;
2. an orphaned hash pinned by nothing **is** reported as reclaimable;
3. a superseded identity generation pinned by a saved analysis is **not** reclaimed;
4. a superseded generation pinned by nothing is reported as reclaimable;
5. an offline source's cache is never reclaimed by the automatic path;
6. legacy single-parser provenance is normalized before the pinned check, so an old saved analysis
   still protects its caches;
7. dry-run reports the same set the real run deletes;
8. a saved analysis that depended on a reclaimed-but-pinned cache still renders after a full pass —
   the regression this spec most needs to disprove;
9. the reclamation pass is bounded and does not block startup or list endpoints;
10. no scientific numeric output changes.

## Acceptance criteria

- reclaimable space is reported accurately before anything is deleted;
- nothing pinned by a saved analysis, artifact or portable report is ever deleted;
- the offline retention policy and 040.3's pinned-cache guarantee both survive intact;
- superseded generations are reclaimable under a stated, tested rule;
- the existing cleanup machinery is extended rather than duplicated, or the reason it could not be is
  recorded;
- `python scripts\preflight.py --no-cache` passes with no SKIP lines.

## Implementation record

_To be filled by the implementing agent._
