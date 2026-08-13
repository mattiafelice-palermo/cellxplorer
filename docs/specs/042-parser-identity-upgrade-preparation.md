# 042 — Parser-identity upgrade preparation

**Status:** Plan  
**Repository:** `mattiafelice-palermo/cellxplorer`  
**Depends on:** Parent 040 (`Canonical cycler data architecture`) merged, because this uses
`parsing.current_parser_identity_for_extension` introduced by 040.3  
**Ships:** with or immediately after Parent 040, and **before** Parent 041 (BioLogic `.mpr`). Every
parser-identity change from 041 onward reintroduces this problem until it is fixed.

## Why this exists

Parent 040.3 replaced the global parser bundle with per-source parser identities. That is correct,
but it means every previously registered source's stored `SourceFile.parser_version` stops matching
its expected current identity the moment the user upgrades.

The observable result, confirmed against a real library:

- cell previews in the Cell Database go blank across the whole library;
- nothing rebuilds them automatically — not at startup, not on idle, not on opening the cell;
- the user must discover Settings → Cache → **Prepare missing** and click it;
- until they do, the application looks broken rather than busy.

This is not hypothetical. On the reporting user's library, 156 parsed sources were invalidated at
once. It also is not new to 040 — Spec 039's bundle change had the same effect — but 040 makes it
certain, and Parent 041 will do it again.

## Current verified behavior

Reverify all of this before implementing; the anchors below were read at
`feature/spec-040-canonical-cycler-data-architecture` @ `9eb235d`.

### Nothing prepares an identity-mismatched source automatically

```text
main.py:161            start_capacity_summary_backfill()        # prepare_missing defaults to False
cache_management.py    start_capacity_summary_backfill(prepare_missing=True)   # the button
```

`scanner.start_capacity_summary_backfill`'s docstring states the intent:

> A Stable-to-Beta copy carries a durable preparation marker, so its first post-activation pass
> prepares all current-version scientific caches. Normal startups only repair incomplete summaries
> and therefore do not recreate caches that the user deliberately cleaned.

### The existing marker covers exactly one scenario

`scientific_preparation` pending is written in **one** place: `beta_bootstrap.py:704-712`, inside the
Stable→Beta library copy. A beta→beta update keeps the same library, performs no copy, and therefore
never sets the marker. That is the common upgrade path and it is unprotected.

### Both on-demand rebuild paths are gated out

`analysis_engine` does reparse missing caches on demand, but only when the source's pinned identity
already equals its current identity:

```python
if calc_at_current:
    for f, ref in zip(files, refs):
        if (
            ref.parser_version == current_parser_identity(f)
            and not cache.has_cycles(f.hash, ref.parser_version, calc_version)
            and not cache.raw_path(f.hash, ref.parser_version).exists()
            and Path(f.path).exists()
        ):
            scanner.parse_file(db, f)
```

After an identity change that first condition is false, so nothing fires. This gate is **correct and
must be preserved** — it is 040.3's guarantee that a pinned historical cache is never silently
reparsed and relabeled under a different identity.

`library.ensure_cell_caches` would rebuild on cell access, but it has **no production caller**; only
tests reference it. Decide explicitly whether to wire it or delete it (see Open questions).

The frontend `CacheWarmupCoordinator` operates on `(analysis_id, plot_id)` saved-plot artifacts. It
sits above the scientific cache layer and never builds source caches. It is not the right owner.

## The distinguishing fact this spec relies on

Cache cleanup never writes `SourceFile.parser_version` (verified: no reference to it anywhere in
`cache_maintenance.py`). Therefore the two situations the current design conflates are separable
relationally, with no file I/O:

| Situation | `parser_version` vs expected | Cache files | Correct response |
|---|---|---|---|
| User deliberately cleaned the cache | **equal** | absent | Leave alone — preserve today's behavior |
| Application upgrade changed the identity | **different** | may exist at the old identity | Prepare — the user did not choose this |

Everything below follows from that distinction. An implementation that cannot articulate which of
these two states it is in has misunderstood the spec.

## Goal

After an upgrade that changes the expected parser identity, a user's library returns to a working
state without them having to know that a cache subsystem exists — while preserving both the
deliberate-clean behavior and 040.3's pinned-cache guarantee exactly.

## Target behavior

### Startup preparation includes identity-mismatched sources

Extend the startup backfill so its work set includes parsed sources where the stored
`parser_version` differs from `parsing.current_parser_identity_for_extension(sf.ext)`, **in addition
to** today's incomplete-summary repair.

Do **not** simply flip `prepare_missing=True` at the `main.py` call site. That would also recreate
caches the user deliberately cleaned, which the docstring explicitly refuses to do and which this
spec preserves. The new work set is narrower and differently motivated.

Required exclusions:

- sources whose file is not reachable on disk — they cannot be reparsed, and must not be retried on
  every startup (the reporting user has 12 such sources, permanently unreparseable);
- sources already at the expected identity, regardless of whether their cache files exist;
- anything a saved analysis has pinned to an older identity — see below.

### 040.3's pinned-cache guarantee is untouched

Bringing a `SourceFile`'s own registration forward is not the same as reparsing a source under an
identity an analysis pinned. This spec changes only the former.

A saved analysis pinned to an older identity must continue to render from its own cache at that
identity, must not be recomputed, and must keep showing its existing "newer parser available"
badge. The `analysis_engine` gate quoted above must remain exactly as it is.

This is the highest-risk property in the spec. It needs an explicit test that a pinned analysis is
unaffected by a preparation pass that rebuilds the same underlying source at the new identity — both
caches coexisting is the correct end state.

### Bounded, visible, resumable

A first launch after upgrade may need to reparse an entire library. It must therefore:

- run in the background at the existing adaptive worker/priority settings, never blocking startup or
  the UI;
- report progress through the existing background-job surface so the user sees work happening rather
  than a blank library;
- be resumable rather than restarting from zero if the app closes mid-pass;
- respect the existing cache budget and cleanup policy;
- not delete old-identity caches — cleanup owns that, and pinned analyses may still need them.

### Truthful UI while preparing

A cell whose scientific cache is being rebuilt should read as *preparing*, not as empty or broken.
Reuse the existing pending/preparation presentation rather than inventing a new state.

## Explicitly out of scope

- changing `CALC_VERSION`, any scientific formula, or any cached numeric meaning;
- relaxing the `analysis_engine` reparse gate;
- deleting or migrating old-identity caches;
- a relational migration — the needed facts are already in `SourceFile`;
- redesigning the cache budget, cleanup or warmup queue;
- BioLogic `.mpr` support.

## Tests

1. a source at an older identity with a reachable file is prepared at startup;
2. a source already at the expected identity with a deliberately deleted cache is **not** rebuilt;
3. a source at an older identity whose file is missing is skipped, and skipped again on the next
   startup without retry churn;
4. an analysis pinned to an older identity still renders from its pinned cache after a preparation
   pass rebuilds that source at the current identity;
5. both caches coexist; neither is deleted or relabeled;
6. the pinned analysis's "newer parser available" badge remains truthful;
7. preparation is reported through the background-job surface;
8. startup is not blocked; list endpoints stay relational and perform no file I/O while preparation
   runs;
9. an interrupted pass resumes rather than restarting;
10. no scientific numeric output changes — the reviewer's golden baseline must stay identical.

## Open questions for the implementer

- **`library.ensure_cell_caches` is dead code.** Wire it as an on-demand complement to startup
  preparation, or delete it? Recommend deciding explicitly rather than leaving an untested,
  uncalled rebuild path in the tree.
- **Should the Stable→Beta marker be retired?** If identity-mismatch detection covers upgrades
  generally, the copy marker may become redundant. Do not remove it in this spec without evidence;
  record the finding.
- **Orphaned caches.** The reporting library holds ~890 cache files for hashes no longer in the
  database. Unrelated to this spec, but worth a separate cleanup issue.

## Acceptance criteria

- an upgrade that changes parser identity restores the library without user intervention;
- a deliberate cache clean is still respected;
- pinned historical analyses are provably unaffected;
- no `CALC_VERSION` bump, no migration, no scientific change;
- unreparseable sources are skipped without repeated retries;
- preparation is bounded, visible and resumable;
- `python scripts\preflight.py --no-cache` passes with no SKIP lines.

## Implementation record

_To be filled by the implementing agent._
