# Spec 039 Agent Coordination

This file coordinates the implementing agent and the independent ChatGPT reviewer for the shared
Spec 039 branch. It is a turn-taking state file, not a substitute for the parent/child specs or the
canonical review files.

Repository: `mattiafelice-palermo/cellxplorer`  
Branch: `feature/neware-excel-support`  
Merge base: `main` at `0df1fb3e48dfc8a37ee2e9c2a07667ed09942a5b`

```text
ACTIVE_CHILD: 039.2
TURN: REVIEWER
STATE: UNDER_REVIEW
LAST_IMPLEMENTATION_SHA: 06b33641446e8592748ff56884d50303d02fdee7
LAST_REVIEW_SHA: 3eeeb170324d55e6acc08403b16263225ae1c5d2
NEXT_ACTION: Reviewer has claimed the 039.2 R4-R5 follow-up. Complete the full review and write every finding before returning TURN to IMPLEMENTER or advancing the child.
```

## Protocol

1. The remote branch is authoritative. Before acting, fetch/pull the latest remote branch and reread
   this file, Parent 039, the active child and the active review file if it exists.
2. Only the role named by `TURN` may perform repository changes for its role.
3. `TURN: IMPLEMENTER` permits implementation or review-fix work for `ACTIVE_CHILD` only.
4. `TURN: REVIEWER` means the implementer stops modifying the branch until the reviewer has pushed
   its review handoff.
5. A child advances only after the reviewer explicitly records `STATE: REVIEW_CLEAN`.
6. Every implementation/review-follow-up tranche must be committed and pushed before handoff.
7. The coordination log is append-only. The state block above may be replaced on each handoff.
8. Never force-push, amend, reset, squash away or otherwise rewrite the other agent's checkpoints.
9. Canonical findings and acceptance criteria live in
   `docs/specs/reviews/039.x-*-review.md`; this file summarizes current state/next action.
10. The implementer must not pre-implement the next child while awaiting review.
11. All four children use this one shared branch. Do not merge to `main` between children.
12. The branch must not be merged until 039.4 and the fresh cumulative Parent 039 review are clean.
13. Only the independent reviewer may set `STATE: FEATURE_COMPLETE` after the final cumulative
    review. The user still makes the merge/release decision.

## Parent decisions the coordination loop must not reopen silently

The following are locked in Parent 039 and require an explicit user/parent amendment if they prove
impossible:

- support structured Neware `.xlsx`, not generic Excel;
- `record` is the raw scientific source of truth;
- `cycle`/`step` summaries validate but do not replace raw-derived scientific values;
- `step_index` = programmed step, `step` = executed occurrence;
- Steps analysis remains supported when reliable execution mapping exists;
- downstream analyses remain format-neutral;
- absent protocol conditions are never invented;
- full source header stays once in `SourceFile.header_meta`;
- bounded `import_inspection` architecture is preserved;
- one global parser-bundle version is preserved;
- no database migration is expected;
- no `CALC_VERSION` bump is expected;
- private supplied workbook is not committed without explicit approval.

If implementation appears to require violating one of these, set:

```text
TURN: USER
STATE: BLOCKED
NEXT_ACTION: Describe the locked decision, the concrete repository evidence that prevents it, and the smallest decision required from the user.
```

## Child sequence

```text
039.1 — Neware Excel time-series parser
  ↓ review-clean
039.2 — Metadata, protocol and cache integration
  ↓ review-clean
039.3 — Import and source lifecycle integration
  ↓ review-clean
039.4 — Analysis regression and feature closure
  ↓ child review + fresh cumulative Parent 039 review
FEATURE_COMPLETE
```

## Implementer handoff format

When an implementation/review-fix tranche is complete:

1. update the active child implementation record;
2. run the checks required by the active child/current repository guidance;
3. commit and push;
4. update the state block to:

```text
ACTIVE_CHILD: 039.S
TURN: REVIEWER
STATE: AWAITING_REVIEW
LAST_IMPLEMENTATION_SHA: <pushed implementation SHA>
LAST_REVIEW_SHA: <previous review SHA or NONE>
NEXT_ACTION: Review 039.S against Parent 039 and the active child specification.
```

5. append one concise IMPLEMENTER log entry containing:
   - active child;
   - implementation SHA;
   - files/behavior changed;
   - exact verification results;
   - real-workbook/manual/packaged checks as RUN or NOT RUN;
   - next action;
6. stop implementation work.

## Reviewer handoff format

When `TURN: REVIEWER`:

1. **Immediately claim the review before doing substantive inspection** by updating and pushing the
   state block with `TURN: REVIEWER` and `STATE: UNDER_REVIEW`. Keep the implementer stopped while
   the review is in progress. Do not return `TURN: IMPLEMENTER` until the full review is complete
   and every actionable R finding is already written in the canonical review file.
2. identify the exact implementation SHA and handoff checkpoint;
3. confirm the merge base and cumulative branch scope;
4. read actual code first;
5. compare only the active child against Parent 039 + child locks;
6. distinguish implementer-reported verification from reviewer-independent verification;
7. create/update the canonical review file with the complete finding set;
8. push the review checkpoint;
9. if findings exist, update state to:

```text
ACTIVE_CHILD: 039.S
TURN: IMPLEMENTER
STATE: CHANGES_REQUESTED
LAST_IMPLEMENTATION_SHA: <reviewed implementation SHA>
LAST_REVIEW_SHA: <review SHA>
NEXT_ACTION: Implement only R findings from the canonical 039.S review, verify, commit, push, and return to REVIEWER.
```

10. if clean and not final child, advance state to:

```text
ACTIVE_CHILD: 039.NEXT
TURN: IMPLEMENTER
STATE: REVIEW_CLEAN
LAST_IMPLEMENTATION_SHA: <reviewed implementation SHA>
LAST_REVIEW_SHA: <review SHA>
NEXT_ACTION: 039.S is review-clean. Implement 039.NEXT exactly as specified.
```

The implementer then begins only the new active child.

## Review-file format

Use current project convention:

```text
docs/specs/reviews/039.1-neware-excel-timeseries-parser-review.md
docs/specs/reviews/039.2-neware-excel-metadata-protocol-and-cache-review.md
docs/specs/reviews/039.3-neware-excel-import-and-source-lifecycle-review.md
docs/specs/reviews/039.4-neware-excel-analysis-regression-and-closure-review.md
```

Each actionable finding uses `R1`, `R2`, ... and contains:

- priority;
- affected files;
- **Current**;
- **Target**;
- **Acceptance criteria**.

Reviews should report concrete defects/spec deviations/regression risks/missing required
verification only. Do not turn optional enhancements into blocking findings.

## Final-child rule

After the 039.4 implementation is handed to the reviewer, perform **two** checks before completion:

1. focused 039.4 review;
2. fresh cumulative Parent 039 review against merge base
   `0df1fb3e48dfc8a37ee2e9c2a07667ed09942a5b`.

The cumulative review must inspect:

- complete branch scope;
- final parser/import/cache/source architecture;
- no format-specific scientific forks;
- binary `.nda/.ndax` regression state;
- real/synthetic Excel acceptance evidence;
- no migration / no unexpected `CALC_VERSION` change;
- no private source committed without approval;
- final no-cache verification record;
- packaged/manual checks truthfully recorded;
- documentation/project-context/version/changelog closure.

Only when both are clean may the reviewer set:

```text
ACTIVE_CHILD: 039.4
TURN: USER
STATE: FEATURE_COMPLETE
LAST_IMPLEMENTATION_SHA: <final implementation SHA>
LAST_REVIEW_SHA: <final review SHA>
NEXT_ACTION: Parent 039 is implementation/review complete. User decides optional remaining manual/package checks, PR metadata, merge and release.
```

## Current handoff

039.2 review-fix implementation `696e4f967488a1fafd0360a4c8571c53db7ba0cc` and handoff
`2193144907a454c0fe6b7135e10dd495c2914d8a` were independently re-reviewed. Canonical review
commit `3eeeb170324d55e6acc08403b16263225ae1c5d2` confirms R1-R3 resolved and records two further
actionable findings: R4 requires the metadata seam to reject unrelated `.xlsx` workbooks instead of
labelling them Neware Excel, while preserving valid record-only capability degradation; R5 requires
the explicit three-rate Excel-derived Rate Capability protocol regression locked by Child 039.2.
The implementer owns the turn only to address R4-R5. 039.3 is not authorized yet.

## Coordination log

### 2026-08-11 — SPEC AUTHOR

- Created Parent 039 and sequential Children 039.1–039.4 on
  `feature/neware-excel-support` from merge base
  `0df1fb3e48dfc8a37ee2e9c2a07667ed09942a5b`.
- Locked Neware Excel source-of-truth, programmed/executed-step, parser/cache, import-performance,
  source-lifecycle, scientific regression and privacy decisions.
- Initial owner: **IMPLEMENTER**.
- Active child: **039.1**.
- No implementation or verification is claimed by this authoring checkpoint.

### 2026-08-11 — IMPLEMENTER

- Active child: 039.1.
- Implementation SHA: `7599715c78312ad9ced12c665ade3a5e46c28e95`.
- Added the bounded structured Neware Excel raw parser, runtime synthetic workbook tests, the
  `openpyxl` dependency, and the maintained agent/spec records. The parser preserves raw record
  order by `DataPoint`, separates programmed `step_index` from executed `step`, reconstructs
  per-executed-step energy counters, and validates the optional `step` summary.
- Verification: `python -m unittest tests.test_neware_excel -v` — 21 passed; `python -m unittest
  tests.test_calc_and_cache -v` — 36 passed; real supplied workbook probe — 13,982 rows, cycles
  1–40, 201 executed steps, 40 `calc.per_cycle` rows, finite required fields; final elevated
  `python scripts\preflight.py` — `PREFLIGHT PASSED`, 5/5 stages.
- Real-workbook/manual/packaged checks: real read-only probe RUN; browser/manual UI check NOT
  APPLICABLE to 039.1; packaging check NOT RUN because packaging belongs to 039.3.
- Next action: stop implementation and await independent reviewer review of 039.1.

### 2026-08-11 — IMPLEMENTER FOLLOW-UP (R1)

- Active child: 039.1; review addressed: R1.
- Follow-up implementation SHA: `949c9caad053faf090fd5cf9645342ef98db9d8d`.
- Added a focused synthetic regression where consecutive records share cycle, programmed
  `step_index`, and canonical status while only `Time(min)` resets; the test asserts distinct
  globally increasing executed `step` IDs and monotonic `Total Time(min)`.
- Verification: `python -m unittest tests.test_neware_excel -v` — 22 passed; `python -m unittest
  tests.test_calc_and_cache -v` — 36 passed; `python -m py_compile backend\app\services\neware_excel.py
  tests\test_neware_excel.py` — passed; `git diff --check` — passed; elevated
  `python scripts\preflight.py` — `PREFLIGHT PASSED`, 5/5 stages.
- Real-workbook/manual/packaged checks unchanged from the implementation checkpoint: real probe
  RUN; browser/manual UI NOT APPLICABLE; packaging NOT RUN.
- Next action: stop implementation and await reviewer re-review of R1.

### 2026-08-11 — REVIEWER

- Reviewed implementation: `7599715c78312ad9ced12c665ade3a5e46c28e95`.
- Result: **CHANGES REQUIRED**.
- Finding: R1 — Medium; the production boundary correctly handles a `time_s` reset, but the
  committed synthetic suite does not isolate that rule because the repeated programmed step is
  already separated by a different Rest step. Add the required time-reset-only regression.
- Canonical review commit: `a4e5e1b8cb427be36b3408559d5ea0144e7fb556`.
- Reviewer-independent verification: inspected the merge base, cumulative branch scope, full parser
  implementation, full 039.1 test suite, dependency change and handoff records through the GitHub
  connector. No Python/preflight/private-workbook commands were independently executed.
- Next action: IMPLEMENTER addresses only R1, verifies, commits/pushes, and returns 039.1 to REVIEWER.
- TURN: **IMPLEMENTER**.

### 2026-08-11 — REVIEWER FOLLOW-UP (R1)

- Reviewed follow-up implementation: `949c9caad053faf090fd5cf9645342ef98db9d8d`.
- Result: **REVIEW CLEAN**.
- R1 is resolved: the new test isolates the `time_s` reset as the only execution-boundary signal and asserts distinct globally increasing executed `step` IDs.
- Canonical review commit: `a931a68a38d4fa20ee7a55925334359fbbde9f05`.
- Reviewer-independent verification: inspected the exact follow-up patch, live branch scope, original parser boundary algorithm, updated test, implementation record and canonical review through the GitHub connector. Python/preflight/private-workbook commands were not independently executed.
- Next action: 039.2 may begin exactly as specified.
- TURN: **IMPLEMENTER**.

### 2026-08-11 — IMPLEMENTER

- Active child: 039.2.
- Implementation checkpoint: `024525e` (`feat: integrate Neware Excel metadata and cache validation`); documentation checkpoint: `4063999131e850b42cda00911dcf05c4367fdf27`.
- Added bounded Neware Excel metadata and programmed-plan reconstruction, explicit capability
  metadata and protocol warning behavior, shared `.xlsx` parser dispatch and bundle provenance,
  cycle-summary validation, cache build validation hooks, and focused protocol/cache/regression
  coverage. No API, UI, scanner, migration, or `CALC_VERSION` changes were made.
- Verification: focused suite `96 passed`; final canonical `python scripts\preflight.py` — `PREFLIGHT PASSED`, 5/5 stages completed successfully; structural ownership checks passed; real supplied workbook probe RUN with 13,982 raw rows, 40 cycles, 201 executed steps, 26 plan rows, 20 executable rows, 19.21 mg active mass, 3.3 mAh nominal capacity, and start `2026-07-17 11:21:32`.
- Real-workbook/manual/packaged checks: read-only metadata/protocol/parse/validation/cache probe RUN; browser/manual UI NOT APPLICABLE to this backend child; packaged runtime NOT RUN because it remains out of scope until 039.3.
- Next action: stop implementation and await independent reviewer review of 039.2.

### 2026-08-11 — REVIEWER

- Reviewed 039.2 implementation commit `024525e01b184583d443d672d4b93b91bedfbfc6`, implementation-record checkpoint `4063999131e850b42cda00911dcf05c4367fdf27`, and handoff checkpoint `df5bc8f1b01db7d0895938f5428316f6ee9cbe7c`.
- Result: **CHANGES REQUIRED**.
- Findings: R1 — High, missing `test`/declared-protocol metadata must degrade through explicit capabilities rather than collapse metadata inspection; R2 — Medium, step-summary timing must use the declared record interval or the 2-second fallback, not median observed gaps; R3 — Medium, required Excel timestamps must reject arbitrary numeric cells instead of accepting pandas nanosecond timestamps.
- Canonical review commit: `f4d748c528162a8005b99058abcfff78152d43c4`.
- Reviewer-independent verification: inspected the correct merge base, cumulative 039.2 scope, parser/metadata/protocol/cache implementation, focused tests, golden provenance-only changes, and underlying 039.1 parser behavior through the GitHub connector. Python/preflight/private-workbook checks were not independently executed.
- Next action: IMPLEMENTER addresses only R1–R3, verifies, commits/pushes, and returns 039.2 to REVIEWER. 039.3 must not begin.
- TURN: **IMPLEMENTER**.

### 2026-08-11 — IMPLEMENTER FOLLOW-UP (R1–R3)

- Active child: 039.2; review findings addressed: R1, R2 and R3.
- Follow-up implementation SHA: `696e4f967488a1fafd0360a4c8571c53db7ba0cc`.
- R1 now keeps valid record-only workbooks parseable while explicitly setting
  `DeclaredProtocol=false`; R2 uses the declared record interval or the exact two-second floor
  for step-summary timing; R3 rejects bare numeric record, metadata and step-summary timestamps.
- Verification: combined focused run `python -m unittest tests.test_neware_excel tests.test_protocol tests.test_calc_and_cache tests.test_parsing -v` — 100 passed; final elevated `python scripts\preflight.py` — `PREFLIGHT PASSED`, 5/5 stages; real supplied workbook probe RUN and passed; `py_compile` and `git diff --check` passed.
- Real-workbook/manual/packaged checks: metadata/protocol/parse/validation/cache probe RUN; browser/manual UI NOT APPLICABLE; packaged runtime NOT RUN because it remains out of scope until 039.3.
- Next action: stop implementation and await reviewer re-review of 039.2.

### 2026-08-11 — REVIEWER FOLLOW-UP (R1–R3)

- Reviewed follow-up implementation: `696e4f967488a1fafd0360a4c8571c53db7ba0cc`; implementer handoff: `2193144907a454c0fe6b7135e10dd495c2914d8a`.
- Result: **CHANGES REQUIRED**.
- R1-R3: **resolved** after independent code/test inspection.
- New findings: R4 — High, `read_metadata()` does not establish the required `record` contract before labelling an arbitrary `.xlsx` as Neware Excel; R5 — Medium, the child-required three-rate Excel-derived Rate Capability compatibility regression is absent.
- Canonical review commit: `3eeeb170324d55e6acc08403b16263225ae1c5d2`.
- Reviewer-independent verification: inspected the exact review-fix delta, cumulative branch/merge base, public metadata seam, recognition helper, 039.2 rate-compatibility requirement and focused tests through the GitHub connector. Python/preflight/private-workbook commands were not independently executed.
- Next action: IMPLEMENTER addresses only R4-R5, verifies, commits/pushes, and returns 039.2 to REVIEWER. 039.3 must not begin.
- TURN: **IMPLEMENTER**.

### 2026-08-11 — IMPLEMENTER FOLLOW-UP (R4–R5)

- Active child: 039.2; review findings addressed: R4 and R5.
- Follow-up implementation SHA: `06b33641446e8592748ff56884d50303d02fdee7`.
- R4 now validates the bounded required `record` header contract before metadata labels an
  `.xlsx` source as Neware Excel; R1’s valid record-only/no-`test` degradation remains intact.
  R5 adds a three-rate Excel-derived protocol regression through the existing Rate Capability
  pairing seam, asserting programmed step numbers, directions, rates and voltage cutoffs.
- Verification: combined focused run `python -m unittest tests.test_neware_excel tests.test_protocol tests.test_calc_and_cache tests.test_parsing tests.test_rate_capability -v` — 110 passed; final elevated `python scripts\preflight.py` — `PREFLIGHT PASSED`, 5/5 stages; real supplied workbook probe RUN and passed; `py_compile` and `git diff --check` passed.
- Real-workbook/manual/packaged checks: metadata/protocol/parse/validation/cache probe RUN; browser/manual UI NOT APPLICABLE; packaged runtime NOT RUN because it remains out of scope until 039.3.
- Next action: stop implementation and await reviewer re-review of 039.2.