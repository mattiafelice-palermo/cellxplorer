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

**Branch:** `feature/spec-042-parser-identity-upgrade-preparation`, based on `main` @ `1a23198`
(`0.22.0-beta.7`).

### Where the new work-set logic lives

`backend/app/services/scanner.py`:

- `_needs_identity_bring_forward(sf)` (new) — the distinguishing predicate. Purely relational, no
  file I/O: returns `True` only when `sf.location_status == "online"` and
  `sf.parser_version != parsing.current_parser_identity_for_extension(sf.ext)`. Because
  `cache_maintenance.py` never writes `SourceFile.parser_version` (reverified: no reference to it
  anywhere in that module), the two situations the spec distinguishes fall out of this equality
  alone — no cache-file existence check anywhere in the function:
  - deliberately cleaned cache, still-current identity → `parser_version == expected` → `False`,
    left alone;
  - upgrade changed the expected identity → `parser_version != expected` → `True`, prepared.
- `start_capacity_summary_backfill` — the `sources` work-set gains a third OR-branch,
  `sf.id in identity_bring_forward_ids`, computed from the predicate above and evaluated
  **unconditionally**, independent of `prepare_missing`/the copied-library marker. `main.py:161`'s
  call site (`scanner.start_capacity_summary_backfill()`, no `prepare_missing` argument) is
  **untouched** — the spec's explicit instruction not to flip that default is followed by adding a
  new selection criterion instead of widening the existing `prepare_all_missing`-gated one.
- A source pulled in only via this new criterion keeps its `capacity_summary_status == "ready"`
  rather than being flipped to `"pending"` (unlike the pre-existing incomplete-summary branch).
  Reason, discovered while implementing: flipping it would make `_apply_capacity_source_result`'s
  failure path read `summary_was_ready=False` and downgrade the source to `"error"` on a
  permanently unreachable file — which `cell_capacity_totals` treats as "withhold every total for
  this cell", i.e. it would blank a cell's totals that were correctly showing a moment before the
  upgrade. `location_status="offline"` already carries the truthful unreachable signal for that
  source; `capacity_summary_status` deliberately stays untouched here.
- Job `title`/`description`/`kind` now also read `"Preparing scientific data"` /
  `"scientific_preparation"` (previously `"Capacity totals"` / `"capacity_summary"`) whenever the
  work set includes at least one bring-forward source, so an ordinary post-upgrade startup reports
  truthfully through the same background-job surface used by "Prepare missing" — no new UI surface.

### The `analysis_engine` gate is unchanged

`git diff main -- backend/app/services/analysis_engine.py` is empty — the file was not touched at
all. Confirmed by inspection that the gate's two operands are structurally incapable of seeing this
change: `ref.parser_version` (the pinned identity) resolves from the saved analysis's own stored
`provenance` JSON via `resolve_source_parser_versions`, never from the live `SourceFile.parser_version`
column, and `current_parser_identity(f)` resolves from `f.ext` alone via
`current_parser_identity_for_extension`, also never reading `SourceFile.parser_version`. Bringing a
source's own `parser_version` forward therefore cannot change either side of
`ref.parser_version == current_parser_identity(f)` for any existing saved analysis.

### Proof a pinned analysis survives a preparation pass

`tests/test_analysis_engine.py::test_startup_preparation_rebuild_does_not_disturb_pinned_analysis`
(new) is the spec's test 4-6, run for real rather than argued from reading:

1. Seeds a real historical cache at an old identity (2-cycle synthetic frame) — what a saved
   analysis pins to.
2. Calls the exact production rebuild call
   (`cache.build`, then `sf.parser_version = build_info["parser_version"]`) that
   `scanner._prepare_capacity_source_worker` / `_apply_capacity_source_result` make, using a
   deliberately different 5-cycle synthetic frame as the "upgraded parser's" output.
3. Asserts both `cache.raw_path`/`cache.has_cycles` exist at **both** identities afterward — neither
   deleted nor relabeled (test 5).
4. Computes a legacy-pinned analysis (scalar `provenance["parser_version"]` = the old identity) with
   `scanner.parse_file` patched to raise `AssertionError` on any call — proving no reparse — and
   asserts the result is still the 2-cycle data with a `newer_parser` badge (tests 4, 6).
5. Computes the same spec fresh (no pinned provenance) and asserts it now sees the 5-cycle
   brought-forward data — proving the rebuild took effect for new work without disturbing the old.

Also reverified by code reading: `cache.build` computes `raw_path`/`cycles_path` from the source's
own **current** `parser_identity(path)` only and writes only those two files via `_write_atomic`
(temp + `os.replace`); it never opens, iterates, or clears the hash's cache directory, so an
old-identity file already there is structurally untouched by construction, not by convention.

### Unreachable / orphaned sources, no retry churn

`_needs_identity_bring_forward` excludes any source with `location_status != "online"`. A
mismatched, previously-unproven-unreachable source is therefore attempted exactly once: if its file
is missing, `_prepare_capacity_source_worker` raises `FileNotFoundError` and
`_apply_capacity_source_result` sets `location_status="offline"` (this already happened before this
spec, for every failure path) **before** checking `ok`. On every later startup the predicate now
excludes it, so it is never retried again. Proven by
`tests/test_scientific_preparation.py::test_unreachable_identity_mismatched_source_is_skipped_without_retry_churn`,
which runs a real (unmocked) failing attempt, asserts `location_status == "offline"` and
`capacity_summary_status` stays `"ready"` (no phantom "Summary failed"), then asserts a second
`start_capacity_summary_backfill()` call selects zero sources.

Orphaned sources (no `TestFile` row) are not special-cased because nothing in this path was ever
cell/Test-scoped: `start_capacity_summary_backfill` already queries `SourceFile` directly by
`parse_status`, and `_apply_capacity_source_result` only ever touches the `SourceFile` row. The
existing `_source()` test fixture in `test_scientific_preparation.py` never links a `Test`/`TestFile`
either, so every test in that file already exercises an orphaned source without special handling.

### `library.ensure_cell_caches` — deleted

Confirmed it had zero production callers (only its own unit test). Decision: **delete**, not wire up,
because:

1. `source_file_needs_cache`'s own last check
   (`not cache.has_cycles(sf.hash, sf.parser_version, CALC_VERSION)`) returns `True` for a
   **deliberately cleaned, still-current-identity** cache exactly as readily as for a genuine gap —
   it cannot make this spec's central distinction. Wiring `ensure_cell_caches` as-is into any
   request path would silently reintroduce the bug this spec exists to avoid, just on a different
   trigger (cell open instead of startup).
2. The only place it could be wired without inventing new UI is a synchronous request path
   (`GET /cells/{cell_id}` or similar), which would add unbounded parse/cache-build file I/O
   directly on a request — against this codebase's established "list/detail endpoints stay
   relational, no file I/O" invariant (`docs/agent-knowledge/state-and-performance.md`).
   `source_file_needs_cache` itself is kept: it is independently unit-tested
   (`tests/test_import_flow.py::test_source_file_needs_cache_when_unparsed_or_counts_missing`,
   `tests/test_parser_identity.py::test_stale_source_file_needs_cache_is_format_scoped`) and
   documented in `docs/agent-knowledge/architecture.md` as a general current-cache-check predicate
   alongside `scanner._has_current_scientific_cache`; only the untested mutating wrapper is removed.
   `tests/test_import_flow.py::test_ensure_cell_caches_does_not_parse_files_already_parsing` (its
   only test) is removed with it.

### Stable→Beta `scientific_preparation` marker — kept, not redundant

Evidence, not assumption: a Stable→Beta database snapshot **excludes `cache/` entirely**
(`docs/agent-knowledge/state-and-performance.md`, "Cache tiers, budgets, and background
preparation"). Immediately after copy, essentially every parsed source has **zero** cache files even
though its `parser_version` is usually still exactly current (Stable and Beta are normally built
from the same commit at copy time). `_needs_identity_bring_forward` only fires on a `parser_version`
**mismatch**, so it does not and cannot cover "cache absent, identity already current" — that is
precisely what the marker's broader `prepare_all_missing` (cache-existence-based) sweep exists for.
The two mechanisms solve different problems and both remain necessary; the marker is not removed.

### Bounded, visible, resumable

- Bounded/low-priority: bring-forward sources reach the pass through the same `sources` list as
  every other candidate, so they run through the existing serial, below-normal-priority path for an
  ordinary startup (`_run_capacity_summary_backfill` with `adaptive_foreground=False` whenever the
  copied-library marker is not pending) — untouched by this change. Only the Stable→Beta copy path
  remains adaptive/foreground, exactly as before.
- Visible: reported through the same `background_jobs` surface (`kind`, `title`, `description`,
  per-item progress) every other backfill job uses; no new frontend surface.
- Resumable: selection is fully relational and re-derived from `SourceFile` state on every call —
  once a source's own `parser_version` is brought forward, it stops matching the predicate, so an
  interrupted pass naturally resumes with only the remaining sources on the next startup. Proven by
  `tests/test_scientific_preparation.py::test_identity_mismatch_selection_is_resumable_across_a_restart`.

### Verification

```text
python -m unittest tests.test_scientific_preparation -v          → Ran 13 tests — OK
python -m unittest tests.test_parser_identity -v                 → Ran 18 tests — OK
python -m unittest tests.test_analysis_engine -v                 → Ran 58 tests — OK
python -m unittest tests.test_import_flow -v                     → Ran 59 tests — OK
python -m unittest tests.test_calc_and_cache tests.test_cache_maintenance
    tests.test_stitch tests.test_analysis_cache
    tests.test_mixed_parser_integration tests.test_source_and_replicates
    tests.test_source_monitor -v                                 → Ran 120 tests — OK
python -m unittest tests.test_golden_analysis
    tests.test_golden_approval_checkpoints -v                    → Ran 33 tests — OK; golden-corpus
                                                                     refresh check: all 8 baselines
                                                                     "SAME" (no numeric drift)
python scripts\preflight.py --no-cache                           → PREFLIGHT PASSED, 5/5 stages;
                                                                     64/64 backend test modules pass;
                                                                     zero SKIP lines in the full log
python scripts\check_versions.py --expected-version 0.22.0-beta.8 → PASS
```

Not run: manual/browser verification (no observable UI change beyond a job title/kind string already
covered by existing background-job UI; no new frontend surface). No packaged-backend smoke test (no
PyInstaller collection-list change, no new dependency).

### Ambiguities / decisions

- **Job `kind`/`title` for a bring-forward-only startup pass.** The spec does not specify exact
  wording; chosen to reuse `"scientific_preparation"` / `"Preparing scientific data"` (the same
  strings the "Prepare missing" button already produces) rather than inventing a fourth job-kind
  string, since both describe the same underlying operation (rebuilding scientific caches) and the
  existing `BetaBootstrapCoordinator` only matches this kind when its own durable marker is pending,
  so this does not interact with that gate.
- **Whether to flip `capacity_summary_status` to `"pending"` for a bring-forward-only source.**
  The spec's "Truthful UI while preparing" section asks for the existing pending presentation to be
  reused. Implemented as **not** flipping it (see rationale in "Where the new work-set logic lives"
  above) because the alternative introduces a `"ready"` → `"error"` regression for a permanently
  unreachable source that did not exist before this spec. The already-truthful `location_status`
  badge covers the unreachable case; the totals themselves were never wrong.
- **`ensure_cell_caches`** — deleted rather than wired; see dedicated section above.
- **Stable→Beta marker** — kept; see dedicated section above.

**Implementation SHA:** `4dc7e9e1133a5164e668e42fa1371290dd95272a`.
**Review:** pending.
