# Review 042 — Parser-identity upgrade preparation

Specification: [`../042-parser-identity-upgrade-preparation.md`](../042-parser-identity-upgrade-preparation.md)  
Repository: `mattiafelice-palermo/cellxplorer`  
Branch: `feature/spec-042-parser-identity-upgrade-preparation`  
Base: `main` at `1a23198` (`0.22.0-beta.7`, Parent 040 merged)  
Implementation: `4dc7e9e` (+ `d06db32` SHA record)  
Status: **Review clean — approved on first round**

## Origin

This spec exists because a user upgraded to a build containing Parent 040 and found the Cell Database
blank library-wide, with no automatic recovery. Diagnosis against their real library: 156 parsed
sources, every one invalidated at once by 040.3's per-source parser identity, and no code path
rebuilding them — not at startup, not on idle, not on cell access. The only route was
Settings → Cache → Prepare missing.

## The primary risk, and why it did not materialise

The tempting fix is to relax `analysis_engine`'s reparse gate:

```python
ref.parser_version == current_parser_identity(f)
```

It looks like an over-restrictive guard blocking a sensible rebuild. It is not — it is Spec 040.3's
guarantee that a cache pinned by a saved analysis is never silently reparsed and relabeled under a
newer identity. Relaxing it would make the visible symptom disappear while reintroducing a silent
scientific-correctness bug that no existing test catches.

Reviewer verification:

```text
git diff origin/main HEAD -- backend/app/services/analysis_engine.py
(empty)
```

Byte-identical. The implementer additionally supplied a structural argument, which holds on
inspection: the gate compares `ref.parser_version` (from the analysis's saved provenance JSON)
against `current_parser_identity(f)` (derived from `f.ext`), and neither reads the live
`SourceFile.parser_version` that this change writes. The two mechanisms are independent by
construction, not merely by current behavior.

`tests/test_analysis_engine.py::test_startup_preparation_rebuild_does_not_disturb_pinned_analysis`
proves the property end to end rather than by argument: it seeds a real old-identity cache, runs the
actual production `cache.build` at the current identity with deliberately different synthetic data,
asserts both caches coexist on disk, then computes the pinned analysis with `scanner.parse_file`
patched to `side_effect=AssertionError`. It asserts the pinned result still returns the old data
(`x == [1, 2]`), that provenance still reports the old identity, and that the `newer_parser` badge
remains. A coupling between the two mechanisms fails this test loudly.

## The distinguishing predicate

`scanner._needs_identity_bring_forward(sf)` — purely relational, no file I/O, no cache-existence
check:

```python
if sf.location_status != "online":       return False
if sf.parser_version is None:            return False
# True when parser_version != current_parser_identity_for_extension(sf.ext)
```

This is the spec's core claim implemented directly: because `cache_maintenance.py` never writes
`parser_version` (reverified), equality means "deliberately cleaned, still current" and mismatch
means "upgrade". The deliberate-clean case is left alone, preserving
`start_capacity_summary_backfill`'s documented refusal to recreate caches the user removed.

Correctly, `main.py:161`'s call site is untouched and the new branch is evaluated independently of
`prepare_missing`, rather than the naive fix of flipping that flag — which would have swept the
deliberate-clean case back in.

### Reviewer check on a possible silent exclusion

`location_status != "online"` would permanently exclude sources from bring-forward if that column
could be `NULL`. It cannot: `models.py:67` declares it non-nullable with `default="online"`, and the
reporting user's real database contains only `online` (144) and `offline` (12), no NULLs. The
exclusion is safe, and correctly also skips `changed` sources, whose bytes differ and which belong
to the source-update flow rather than a cache rebuild.

## Unreachable and orphaned sources

Excluded by the same `location_status` check. A first attempt on a now-missing file sets
`location_status="offline"` through the pre-existing `_apply_capacity_source_result` path, so such a
source is attempted once and skipped on every later startup — no retry churn. Locked by
`test_unreachable_identity_mismatched_source_is_skipped_without_retry_churn`.

This covers the reporting user's 12 stale sources, which are both offline and orphaned (referenced by
zero `test_files` rows, hence attached to no cell). They surface in the candidate set because the
backfill queries by `parse_status`, and are correctly filtered out.

`capacity_summary_status` is deliberately not flipped to `"pending"` for bring-forward-only sources,
to avoid a `"ready"` → `"error"` regression on permanently unreachable files that would blank a
cell's totals through `cell_capacity_totals`. Reasoned, and covered by
`test_scientific_preparation.py`.

## `ensure_cell_caches` deleted

Flagged in the spec as an open question requiring an explicit decision; the implementer deleted it,
with `library.py` −8 lines and `test_import_flow.py` −27 lines.

Accepted. It had zero production callers, and its `source_file_needs_cache` check cannot distinguish
a deliberate clean from an identity mismatch — so wiring it as-is would have reintroduced this exact
defect on a different trigger, while wiring it into a request path would violate the no-file-I/O
invariant for list and detail endpoints. `source_file_needs_cache` itself is retained, being
independently used and tested.

Recorded explicitly here because it is a deletion of previously-tested code and should not pass
unremarked in a diffstat.

## Version bump

Bumped to `0.22.0-beta.8` with a CHANGELOG entry. The reviewer initially questioned this against
Parent 040.5's decision *not* to bump on the branch, then checked: `AGENTS.md:448` requires updating
the version and CHANGELOG "when committing completed user-facing work... without waiting for a
separate user request." 042 is a single self-contained spec with user-facing effect, so the bump is
correct. Parent 040's situation differed — a five-child parent bumping once at release, per Parent
038's precedent.

## Stable→Beta marker retained

Correctly not removed. The implementer's evidence: the Stable→Beta copy excludes `cache/` entirely,
which is a broader gap than identity mismatch alone covers, so the marker is not made redundant by
this change.

## Scope audit

- `analysis_engine.py` — untouched.
- `CALC_VERSION` unchanged; no relational migration; `models.py` untouched.
- No scientific formula, cache key, or provenance change.

## Verification

Reviewer-run, not taken from the implementer's report:

- full-precision `calc.per_cycle` baseline for all four golden `.ndax` sources, captured from `main`
  at `1a23198` before implementation — **ALL IDENTICAL** afterwards;
- `git diff` on `analysis_engine.py` — empty;
- `models.py` nullability and the real-library `location_status` distribution;
- `AGENTS.md` versioning policy;
- `python scripts\preflight.py --no-cache` — exit 0, `PREFLIGHT PASSED`, 5/5, **zero SKIP lines**.

No golden expectation moved; the implementer reported the corpus check as "SAME" on all 8 baselines
and the reviewer's independent baseline agrees.

Not run by the reviewer: manual browser check. The implementer reports no observable UI change beyond
an existing job-label string, which is consistent with the diff — no frontend file is touched.

## Verdict

042 is review clean. An upgrade that changes parser identity now restores the library without user
intervention; a deliberate cache clean is still respected; pinned historical analyses are provably
unaffected; unreachable sources are attempted once and then skipped. No `CALC_VERSION` bump, no
migration, no scientific change.

Remaining, and deliberately out of scope: orphaned `SourceFile` rows and their orphaned cache files
(~890 in the reporting library) survive cell deletion. That is a separate data-hygiene defect with a
different root cause and deserves its own spec.
