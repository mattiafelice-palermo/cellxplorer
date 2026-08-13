# Spec 040 Agent Coordination

This file coordinates the implementing agent and independent reviewer for Parent 040. It is a turn-taking ledger, not a substitute for the parent/child specs or canonical review files.

Repository: `mattiafelice-palermo/cellxplorer`  
Branch: `feature/spec-040-canonical-cycler-data-architecture`  
Merge base: `main` at `562c2edff1277fef71789244c95e3b17abc586fa` (`0.22.0-beta.5`)

```text
ACTIVE_CHILD: 040.1
TURN: IMPLEMENTER
STATE: READY
LAST_IMPLEMENTATION_SHA: NONE
LAST_REVIEW_SHA: NONE
NEXT_ACTION: Implement only 040.1 exactly as specified, verify, commit, push, and return the branch to REVIEWER.
```

## Protocol

1. The remote branch is authoritative once created.
2. Parent 039 is complete/review-clean and merged; its historical branch may still exist remotely but is not an active implementation branch.
3. Before every turn, fetch/pull and reread this file, Parent 040, active child and active review file.
4. Only the role named by `TURN` acts.
5. `TURN: IMPLEMENTER` permits only the active child/review-fix scope.
6. `TURN: REVIEWER` stops implementation until review handoff is pushed.
7. A child advances only after explicit `STATE: REVIEW_CLEAN`.
8. Every implementation/review tranche is committed and pushed before handoff.
9. Never force-push/amend/reset/squash away another agent's checkpoint.
10. Canonical findings live in `docs/specs/reviews/040.x-*-review.md` using R1/R2/... with priority, files, Current, Target and Acceptance criteria.
11. All five children share one branch; do not merge between children.
12. Only the final 040.5 reviewer may set `FEATURE_COMPLETE` after both focused 040.5 and fresh cumulative Parent 040 review.
13. User decides merge/release.

## Locked parent decisions not to reopen silently

- canonical model is intentionally Neware-like but CellXplorer-owned;
- `step_index` = programmed step, `step` = executed occurrence;
- `time_s` stays step-relative; `total_time_s` is source-elapsed when available;
- `voltage_v` remains primary/default analysis voltage;
- optional canonical electrode channels are `working_potential_v` and `counter_potential_v`;
- parser/cache provenance becomes source-specific;
- existing Neware numerical science is preserved;
- no expected relational migration;
- no expected `CALC_VERSION` bump;
- bounded list/import architecture is preserved;
- BioLogic `.mpr` is out of scope until Parent 041.

If a locked decision is impossible or scientifically unsafe:

```text
TURN: USER
STATE: BLOCKED
NEXT_ACTION: Describe the exact repository evidence and the smallest parent decision that must change.
```

## Child sequence

```text
040.1 — Canonical cycling data contract and validation
  ↓ review-clean
040.2 — Source-format adapter dispatch
  ↓ review-clean
040.3 — Per-source parser cache, stitching and provenance
  ↓ review-clean
040.4 — Canonical multi-voltage path and Time/Capacity exposure
  ↓ review-clean
040.5 — Existing-format regression and architecture closure
  ↓ focused review + fresh cumulative Parent 040 review
FEATURE_COMPLETE
```

## Standard implementer handoff

After a tranche:

```text
ACTIVE_CHILD: 040.S
TURN: REVIEWER
STATE: AWAITING_REVIEW
LAST_IMPLEMENTATION_SHA: <pushed SHA>
LAST_REVIEW_SHA: <previous review SHA or NONE>
NEXT_ACTION: Review 040.S against Parent 040 and the child spec.
```

Append a concise log entry with files/behavior, exact checks/results, manual/package checks run/not run, and next action. Stop work.

## Standard reviewer handoff

Reviewer first claims:

```text
TURN: REVIEWER
STATE: UNDER_REVIEW
```

Then inspect exact SHA, merge base, cumulative branch scope and code. Push canonical review before returning turn.

If findings:

```text
TURN: IMPLEMENTER
STATE: CHANGES_REQUESTED
NEXT_ACTION: Implement only R findings from the active canonical review, verify, commit, push and return to REVIEWER.
```

If clean and not final:

```text
ACTIVE_CHILD: <next child>
TURN: IMPLEMENTER
STATE: REVIEW_CLEAN
NEXT_ACTION: Previous child is review-clean. Implement the next child exactly as specified.
```

## Final-child rule

040.5 reviewer performs:

1. focused 040.5 review;
2. fresh cumulative Parent 040 review against the locked merge base `562c2edff1277fef71789244c95e3b17abc586fa`.

Only when both are clean:

```text
ACTIVE_CHILD: 040.5
TURN: USER
STATE: FEATURE_COMPLETE
LAST_IMPLEMENTATION_SHA: <final implementation SHA>
LAST_REVIEW_SHA: <final review SHA>
NEXT_ACTION: Parent 040 is implementation/review complete. User decides PR/merge/release and then Parent 041 may be based on the merged main.
```

## Review files

```text
docs/specs/reviews/040.1-canonical-cycling-data-contract-and-validation-review.md
docs/specs/reviews/040.2-source-format-adapter-dispatch-review.md
docs/specs/reviews/040.3-per-source-parser-cache-stitching-and-provenance-review.md
docs/specs/reviews/040.4-canonical-multi-voltage-path-review.md
docs/specs/reviews/040.5-existing-format-regression-and-architecture-closure-review.md
```

## Coordination log

### 2026-08-11 — SPEC AUTHOR

- Confirmed Parent 039 coordination state `FEATURE_COMPLETE` and final 039.4 cumulative review clean on current `main`.
- Locked Parent 040 merge base to `1542ff3bed7be31b3b0e1f19282c92598dc0fc06` (`0.22.0-beta.1`).
- Created shared branch `feature/canonical-cycler-data-architecture`.
- Rebased the 040 parent/children onto the landed Spec 039 parser architecture, including `EXCEL_PARSER_REVISION = 3`, global bundle `2026.6.11-cxp3`, `CALC_VERSION = 1.6.1`, and the existing `SourceFile.parser_version String(30)` constraint.
- Initial owner: **IMPLEMENTER**. Active child: **040.1**.
- No implementation or verification is claimed by this authoring checkpoint.

### 2026-08-13 — REBASELINE (no implementation)

The 2026-08-11 entry above is preserved as written; it records the original authoring baseline and is
not restated here as current fact.

- Original shared branch `feature/canonical-cycler-data-architecture` was spec-only (seven documents,
  no implementation). Rather than rebase it, the specs were brought over onto a fresh branch cut from
  current `main`, following the repository's `feature/spec-0NN-*` naming convention.
- New branch: `feature/spec-040-canonical-cycler-data-architecture`.
- New locked merge base: `562c2edff1277fef71789244c95e3b17abc586fa` (`0.22.0-beta.5`), 15 commits
  ahead of the original `1542ff3be…` baseline. The intervening work is the merged Spec 039 Excel
  dialect / import-resilience follow-up plus DCIR and release fixes.
- Anchor drift corrected in the parent and five children: `EXCEL_PARSER_REVISION` `3` → `6`, global
  bundle `2026.6.11-cxp3` → `2026.6.11-cxp6`.
  - **Corrected 2026-08-13 during 040.2 review:** the base version string was wrong in the original
    specs and this rebaseline propagated it. `parsing.NEWARE_NDA_VERSION` is actually `v2026.06.11`
    (leading `v`, zero-padded month), so the real bundle is `v2026.06.11-cxp6`, not `2026.6.11-cxp6`.
    Corrected in the parent, 040.2 and 040.3, and 040.3 now records the measured identity lengths.
- Anchors reverified as unchanged and still accurate as written: `CALC_VERSION = 1.6.1`;
  `analysis_engine.SPEC_VERSION = 9`; `analysis_cache.ANALYSIS_CACHE_VERSION = 4`;
  `SourceFile.parser_version = String(30)`; `stitch_cycles`/`stitch_raw` single-parser-version
  signatures; `cache.py` global-parser-version defaults.
- Noted for 040.1: the dialect follow-up added a unitless "record clock" workbook variant. `time_s`
  remains step-relative in both dialects, so no locked parent decision changes, but
  `docs/neware-excel-variant-findings.md` is now required reading for 040.1.
- Owner remains **IMPLEMENTER**. Active child remains **040.1**.
- No implementation, test run or verification is claimed by this rebaseline checkpoint.

### 2026-08-13 — 040.1 REVIEW-CLEAN + parent amendment

- 040.1 implemented (`39cacc3`), reviewed, two findings raised, fixed (`bbffa2b`), re-reviewed and
  approved. Canonical review: `reviews/040.1-canonical-cycling-data-contract-and-validation-review.md`.
- Reviewer independently reproduced the current-sign measurement, the status vocabulary, the
  `parse_timeseries` caller set and `python scripts\preflight.py` (exit 0, 5/5) rather than accepting
  the implementer's report.
- **Parent amendment, ratified by the user:** `timestamp` moves from the required core columns table
  to the canonical optional-but-standard set. Meaning unchanged; only required/optional status moved.
  Evidence: `parsing.parse_timeseries` normalizes it only `if "timestamp" in df.columns`, and
  `calc.per_cycle` guards its use identically, so requiring it could reject a currently supported
  source.
- Verified absent from the branch, as 040.1 requires: parser dispatch/adapter identities (040.2),
  per-source parser identity and cache/stitch/provenance changes (040.3), populated multi-voltage
  columns (040.4), `CALC_VERSION` bump, relational migration.
- Active child advances to **040.2**.

### 2026-08-13 — 040.2 REVIEW-CLEAN

- 040.2 implemented (`0d9531d`, plus `a75e44e` correcting a self-referential SHA note in its own
  implementation record), reviewed, approved with no findings. Canonical review:
  `reviews/040.2-source-format-adapter-dispatch-review.md`.
- Reviewer proved output parity independently rather than accepting the pinned hashes: a worktree at
  the pre-refactor commit `4b78b00` reproduced the golden `.ndax` content hash
  `0ca93bae…5fb5010a` exactly, confirming the constants were captured before the refactor.
  `python scripts\preflight.py` re-run by the reviewer: exit 0, 5/5.
- Production change is confined to `parsing.py`. `neware_excel.py`, `cache.py`, `stitch.py`,
  `analysis_*.py` and `models.py` are untouched, so no 040.3 work was pre-implemented.
- `parsing.PARSER_VERSION` preserved as the transitional bundle; `source_parser_family` preserved
  suffix-only as the exact-hash relinking guard; `source_parser_descriptor()` exposed for 040.3 with
  no production consumer yet.
- Spec correction during review: the real NewareNDA version is `v2026.06.11`, not `2026.6.11` (see
  the rebaseline entry above). Corrected in the parent, 040.2 and 040.3.
- Active child advances to **040.3**.

### 2026-08-13 — 040.2 error-taxonomy follow-up

- Reopened after approval: the initial review accepted the implementer's "unused, so skipped"
  argument for `InvalidSourceFormatError`, which is valid with one adapter family and wrong with
  three. This was a reviewer error, not an implementation failure. Surfaced by a user question about
  where a non-conforming `.xlsx` error is thrown.
- Implemented in `8262f01`: new `backend/app/services/source_format_errors.py` defines
  `SourceFormatError(ValueError)` with `UnsupportedSourceFormatError` / `InvalidSourceFormatError`.
  `neware_excel` keeps `NewareExcelError` as its adapter base and multiply-inherits each subclass
  from the matching neutral type. `parsing` re-exports rather than redefines.
- Confirmed already correct and unchanged: the structural check runs before canonical mapping, and
  rejection errors originate in the adapter with adapter-specific messages.
- Reviewer measured the MRO and the full catchability matrix directly, confirmed
  `except (OSError, ValueError)` at `scanner.py:843` still catches every type, confirmed
  `CanonicalCyclingError` stays outside the hierarchy, and confirmed the generic `.xlsx` failure is
  byte-identical in type name and message. `python scripts\preflight.py`: exit 0, 5/5.
- Active child remains **040.3**.

### 2026-08-13 — 040.3 REVIEW-CLEAN

- 040.3 implemented (`1c93d2f`, plus `4a86773` recording the SHA), reviewed, approved on the first
  round. Canonical review: `reviews/040.3-per-source-parser-cache-stitching-and-provenance-review.md`.
- **Scientific output proven unchanged**, which was the user's explicit constraint for this child.
  The reviewer captured full-precision `calc.per_cycle` projections for all four golden `.ndax`
  sources from a worktree at the pre-040.3 commit `c0a8e8e` and compared them against the current
  tree: ALL IDENTICAL. This was deliberately independent of the repository's golden fixtures, which
  were refreshed during this child.
- Golden fixture refresh verified line by line: eight files, eight changed lines, all
  `"parser_version": "v2026.06.11-cxp6"` → `"nb:v2026.06.11:r1"`. No numerical value changed.
- Process note: the implementer was told to stop and report if a golden moved, and instead refreshed
  and reported. Outcome correct and parent-permitted, but later children should treat "stop before
  refreshing a golden" as a hard rule — a refresh and a regression are indistinguishable in a passing
  test run without an out-of-band baseline.
- Parser identity `nb:v2026.06.11:r1` (17) / `nx:6:r1` (7), inside the `String(30)` bound, asserted
  at construction. Built on 040.2's `source_parser_descriptor()`.
- Silent-recompute defect covered: pinned-old-identity analyses render from their own cache with
  `scanner.parse_file` patched to raise. Reviewer confirmed no bypass — `analysis_engine` reaches
  parsing only via `scanner.parse_file`, and `stitch` only calls read-only `cache.load_*`.
- `CALC_VERSION` unchanged, `models.py` untouched, no migration, `SPEC_VERSION` still 9.
- Recorded for 040.5: `ANALYSIS_CACHE_VERSION` 4→5 invalidates cached analysis results (one-time
  recompute, worth naming in release notes); the new `display_parser_version` `"mixed"` sentinel
  needs a sensible UI treatment.
- Reviewer verification: `python scripts\preflight.py` exit 0, 5/5; `npx tsc -b --force` exit 0, run
  explicitly because preflight self-skipped its frontend stages while `frontend/src/api.ts` changed.
- Active child advances to **040.4**.
