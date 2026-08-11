# Spec 039 Agent Coordination

This file coordinates the implementing agent and the independent ChatGPT reviewer for the shared
Spec 039 branch. It is a turn-taking state file, not a substitute for the parent/child specs or the
canonical review files.

Repository: `mattiafelice-palermo/cellxplorer`  
Branch: `feature/neware-excel-support`  
Merge base: `main` at `0df1fb3e48dfc8a37ee2e9c2a07667ed09942a5b`

```text
ACTIVE_CHILD: 039.4
TURN: USER
STATE: FEATURE_COMPLETE
LAST_IMPLEMENTATION_SHA: 805f318b60dc3815459792503073c1b1953d2ed1
LAST_REVIEW_SHA: 8c55e4592d6d7b4bf93c93f882e54796b51468ba
NEXT_ACTION: Parent 039 is implementation/review complete. User decides optional remaining manual/package checks, PR metadata, merge and release.
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

039.4 and the fresh cumulative Parent 039 review are clean at canonical review commit
`8c55e4592d6d7b4bf93c93f882e54796b51468ba`. Parent 039 is implementation/review complete and
control is returned to the user for optional remaining manual/package checks, PR metadata, merge
and release decisions. The final 039.4 analysis/browser UI matrix remains truthfully NOT RUN and is
an optional pre-release confidence check, not a blocking review finding.

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
- R4 now validates the bounded Neware `record` header before metadata labels an
  `.xlsx` source as Neware Excel; R1’s valid record-only/no-`test` degradation remains intact.
  R5 adds a three-rate Excel-derived protocol regression through the existing Rate Capability
  pairing seam, asserting programmed step numbers, directions, rates and voltage cutoffs.
- Verification: combined focused run `python -m unittest tests.test_neware_excel tests.test_protocol tests.test_calc_and_cache tests.test_parsing tests.test_rate_capability -v` — 110 passed; final elevated `python scripts\preflight.py` — `PREFLIGHT PASSED`, 5/5 stages; real supplied workbook probe RUN and passed; `py_compile` and `git diff --check` passed.
- Real-workbook/manual/packaged checks: metadata/protocol/parse/validation/cache probe RUN; browser/manual UI NOT APPLICABLE; packaged runtime NOT RUN because it remains out of scope until 039.3.
- Next action: stop implementation and await reviewer re-review of 039.2.

### 2026-08-11 — REVIEWER FOLLOW-UP (R4–R5)

- Reviewed follow-up implementation: `06b33641446e8592748ff56884d50303d02fdee7`.
- Result: **CHANGES REQUIRED**.
- R4-R5: **resolved** after independent code/test inspection; R1-R3 remain resolved.
- New findings: R6 — High, advance Excel parser revision/provenance so pre-fix `cxp1` caches are not treated as current; R7 — Medium, bind metadata labels to their verified value groups rather than scanning into neighboring groups; R8 — Low, record the required real-workbook metadata-vs-full-parse timing and current follow-up checkpoint.
- Canonical review commit: `3b0a7668dd169f3078ce8823c8998bb3e1edd062`.
- Reviewer-independent verification: inspected the exact R4-R5 patch, cumulative branch/merge base, current parser/cache/provenance behavior, metadata grouping logic, Rate Capability seam, tests and 039.2 performance/version requirements through the GitHub connector. Python/preflight/private-workbook commands were not independently executed.
- Next action: IMPLEMENTER addresses only R6-R8, verifies, commits/pushes, and returns 039.2 to REVIEWER. 039.3 must not begin.
- TURN: **IMPLEMENTER**.

### 2026-08-11 — IMPLEMENTER FOLLOW-UP (R6–R8)

- Active child: 039.2; review findings addressed: R6, R7 and R8.
- Follow-up implementation SHA: `0abff4102cb534f0652ffb6bc52648eec69c6c9b`.
- R6 advances the Excel parser revision to `2`, producing `v2026.06.11-cxp2` while leaving
  `CALC_VERSION` at `1.6.1`; golden changes are provenance-only. R7 bounds optional metadata
  values to their recognized label groups, including optional unit-sheet times. R8 records the
  real-workbook metadata-only versus full-parse timing comparison.
- Verification: combined focused run — `112 passed`; `python -m py_compile` — passed;
  `git diff --check` — passed; final elevated `python scripts\preflight.py` — `PREFLIGHT PASSED`,
  5/5 stages; real supplied workbook metadata/protocol/parse/validation/cache probe passed.
- Real-workbook timing: metadata read `0.262049 s`; full `parse_timeseries` `2.859019 s`; metadata
  was approximately 9.2% of full parse time for 13,982 raw rows.
- Real-workbook/manual/packaged checks: metadata/protocol/parse/validation/cache probe PASS;
  browser/manual UI NOT APPLICABLE; packaging NOT RUN.
- Next action: stop implementation and await independent reviewer re-review of 039.2 R6–R8.

### 2026-08-11 — REVIEWER FOLLOW-UP (R6–R8)

- Reviewed follow-up implementation: `0abff4102cb534f0652ffb6bc52648eec69c6c9b`; handoff checkpoint: `d260f9e54bbfba1fc8b58a8b66ea2eb4a107eda5`.
- Result: **REVIEW CLEAN**.
- R6 resolved: Excel parser revision advanced to `2`, producing `v2026.06.11-cxp2`; old `cxp1` cache/provenance identity is no longer current and `CALC_VERSION` remains `1.6.1`.
- R7 resolved: optional metadata value lookup is bounded by recognized label-group boundaries, with focused regressions for both the `test` information block and optional `unit` timestamps.
- R8 resolved: the implementation record includes the current follow-up SHA and real-workbook metadata/full-parse timing (`0.262049 s` vs `2.859019 s`, ~9.2%).
- Canonical review commit: `08b5eaae375a8cdc02659fd794ac9d5ce4bf17ad`.
- Reviewer-independent verification: inspected the exact R6-R8 implementation delta, bundle-version formula, focused metadata grouping tests, provenance-only golden changes, implementation record and handoff through the GitHub connector. Python/preflight/private-workbook commands were not independently executed.
- Next action: 039.2 is review-clean; 039.3 may begin exactly as specified.
- TURN: **IMPLEMENTER**.

### 2026-08-11 — REVIEWER RECONCILIATION (premature 039.2 clean handoff)

- The prior R6-R8 reviewer handoff marked 039.2 clean before a second reviewer pass under the active
  `UNDER_REVIEW` lock completed.
- Before any 039.3 implementation code landed, branch comparison confirmed that only coordination
  metadata had advanced beyond the premature clean commit; no 039.3 implementation files changed.
- A concrete remaining R7 defect was identified in the committed verified-layout fixture: a blank
  `Voltage range` value can still consume the neighboring unsupported `Curr. lower` label because
  the grouping boundary recognizes only normalized labels.
- 039.2 was therefore safely reclaimed as `TURN: REVIEWER / STATE: UNDER_REVIEW` for correction.
- 039.3 remains unauthorized until the corrected canonical review is pushed and the remaining
  findings are resolved.

### 2026-08-11 — REVIEWER RECONCILIATION COMPLETE

- Corrected canonical review commit: `22e63305ba0cdf275573a637166d7cec9f20d939`.
- Result: **CHANGES REQUIRED**; the premature 039.2 clean decision is superseded.
- R1-R5 remain resolved. Remaining work: final positional R7 fix, consequent new parser revision
  under R6, and R8 implementation-record checkpoint correction. The existing timing evidence is
  accepted.
- Reviewer-independent verification: inspected the committed verified metadata fixture, production
  grouping logic, parser/provenance/cache semantics, branch delta after the premature clean handoff,
  and confirmed no 039.3 implementation code had landed before reclaiming 039.2. Python/preflight/
  private-workbook commands were not independently executed.
- Next action: IMPLEMENTER addresses only the remaining R6-R8 findings and returns 039.2 to REVIEWER.
- TURN: **IMPLEMENTER**.

### 2026-08-11 — IMPLEMENTER FOLLOW-UP (final R6-R8 correction)

- Active child: 039.2.
- Final implementation SHA: `871834c06703592a0d1774383ca37498581bf2ac`; implementation-record checkpoint: `d436c6c`.
- R6 advances the Excel parser revision to `3`, producing `v2026.06.11-cxp3`; R7 binds metadata values to fixed verified label/value slots and adds the blank `Voltage range`/`Curr. lower` regression; R8 records both exact follow-up checkpoints and final timing evidence.
- Verification: combined focused run — **113 passed**; `python -m py_compile` — passed; `git diff --check` — passed; final elevated `python scripts\preflight.py` — **PREFLIGHT PASSED**, 5/5 stages; final real supplied-workbook metadata/protocol/parse/validation/cache probe — PASS (13,982 rows, 40 cycles, 201 executed steps).
- Real-workbook/manual/packaged checks: final read-only backend probe RUN; browser/manual UI NOT APPLICABLE to this backend child; packaged runtime NOT RUN because it remains out of scope until 039.3.
- Next action: stop implementation and await independent reviewer re-review of 039.2 R6-R8.

### 2026-08-11 — REVIEWER FOLLOW-UP (final R6-R8 correction)

- Reviewed final implementation: `871834c06703592a0d1774383ca37498581bf2ac` under reviewer lock `4f38bb1ad77c215770862962558d4d983b3945f3`.
- Result: **REVIEW CLEAN**.
- R6-R8: **resolved**. Parser revision is `3`/`v2026.06.11-cxp3`; positional metadata lookup no longer scans across neighboring groups; the blank `Voltage range`/`Curr. lower` regression is present; the child record names both the first and final R6-R8 checkpoints and retains truthful timing evidence.
- Canonical review commit: `938c634b363d88360b7df839432f9ca7aa5a5a06`.
- Reviewer-independent verification: inspected the exact final implementation delta, current parser-bundle formula, `CALC_VERSION`, positional metadata implementation and tests, provenance-only golden changes, child implementation record, stale-cxp2 search and branch scope through the GitHub connector. Python/preflight/private-workbook checks were not independently executed.
- Next action: 039.3 may begin exactly as specified.
- TURN: **IMPLEMENTER**.

### 2026-08-11 — IMPLEMENTER HANDOFF (039.3)

- Active child: 039.3.
- Implementation SHA: `dca7a83440c79b1bd959f847d9b2c2c88b47a3c1`; verification-record checkpoint: `d2f52e2`.
- Changes: centralized `.nda`/`.ndax`/structured `.xlsx` source policy; integrated bounded inspection, import selection, registration, preview/raw-data, scanner, source replacement, continuation, warmup, and Neware-specific UI wording; preserved full source headers and curated Cell metadata.
- Verification: focused backend import/source suite — **152 passed**; frontend policy tests — **461 passed**; TypeScript check — passed; Vite build — passed; final elevated `python scripts\preflight.py` — **PREFLIGHT PASSED**, 5/5 stages; `git diff --check` — passed.
- Real-workbook/manual/packaged checks: disposable browser/import matrix RUN (structured `.xlsx` listed, metadata/capacity preview, registration/background cache, raw-data endpoint, online/parsed source, unrelated-workbook rejection); native picker and HTML file-input checks NOT RUN; packaged `.xlsx` smoke NOT RUN.
- Next action: stop implementation and await independent 039.3 review.

### 2026-08-11 — REVIEWER (039.3)

- Review lock: `fdfc6537e005ad5ad0ef447170ad0edc40af2e9a` kept `TURN: REVIEWER / STATE: UNDER_REVIEW` while the full review was performed.
- Reviewed implementation: `dca7a83440c79b1bd959f847d9b2c2c88b47a3c1`; verification record: `d2f52e2f9820312f50b6a7558646490e725fe33d`; implementer handoff: `91050914d906518a8af7dc567a9cbeda6eec1627`.
- Result: **CHANGES REQUIRED**.
- Findings: R1 — High, recursive scanner ingestion can leave an existing same-path source falsely `online` when replacement `.xlsx` bytes are invalid; R2 — Medium, the required mixed binary/Excel continuation compatibility/order/one-Test proof is absent; R3 — Medium, required Excel-specific stable-update/source-monitor lifecycle verification is incomplete.
- Canonical review commit: `7c30e14442f3c3d635c8376f2bfa19fe9cfe82de`.
- Reviewer-independent verification: inspected the exact implementation delta, merge base, import inspection/registration, shared extension policy, scanner/source replacement ordering, continuation contracts, source-monitor ownership, frontend wording and focused tests through the GitHub connector. Python/frontend/browser/private-workbook/packaged commands were not independently executed.
- Next action: IMPLEMENTER addresses only R1-R3, verifies, commits/pushes, and returns 039.3 to REVIEWER. 039.4 must not begin.
- TURN: **IMPLEMENTER**.

### 2026-08-11 — REVIEWER RECONCILIATION (039.3 premature release)

- Review commit `7c30e14442f3c3d635c8376f2bfa19fe9cfe82de` returned control to the implementer before a second reviewer pass under the active `UNDER_REVIEW` lock had completed.
- Branch comparison confirmed no implementation code landed after the premature release; only review/coordination documentation changed.
- The reviewer reclaimed `TURN: REVIEWER / STATE: UNDER_REVIEW` at `c45b040ab77a063f6261928e508a6febb43bc880` to finish the full 039.3 finding set before any implementation follow-up starts.
- R1-R3 remained active while an additional exact-hash scanner relink inconsistency was checked.

### 2026-08-11 — REVIEWER RECONCILIATION COMPLETE (039.3)

- Corrected canonical review commit: `2bfedb9b0746db5100dfbfe0e6924b1926398869`.
- Result: **CHANGES REQUIRED**; the earlier R1-R3-only release is superseded.
- Complete findings: R1 — same-path invalid Excel replacement can remain falsely online; R2 — mixed-format continuation/order/one-Test proof missing; R3 — Excel stable-update/source-monitor lifecycle proof incomplete; R4 — exact-hash scanner relink can bypass the Excel format contract and leave `ext` inconsistent with the relinked path.
- Reviewer-independent verification: inspected the exact implementation delta, scanner hash/relink/update ordering, continuation/source-monitor seams, added tests, frontend/source-selection changes, warmup/dependency handling and branch state through the GitHub connector. Python/frontend/browser/private-workbook/native-picker/packaged commands were not independently executed.
- Next action: IMPLEMENTER addresses only R1-R4, verifies, commits/pushes, and returns 039.3 to REVIEWER. 039.4 must not begin.
- TURN: **IMPLEMENTER**.

### 2026-08-11 — IMPLEMENTER FOLLOW-UP (039.3 R1-R4)

- Follow-up implementation commits: `52164278480dc66b977eaf622fd128a6631508f9` (R1-R3) and `d956f05008f091ee3c387d219782e1c06d73deae` (R4); verification-record checkpoint: `2ccebf1`.
- R1 marks an existing same-path source `changed` before invalid replacement metadata validation and preserves the prior identity, counts and cache. R2 proves mixed binary/Excel continuation ordering, one internal Test and unchanged blocking rules. R3 adds generated Excel monitor coverage for unchanged, offline, stable adoption and growing/deferred states. R4 guards exact-hash relinking by parser family and updates `SourceFile.ext` on accepted same-family relinks.
- Verification: focused backend follow-up — **233 passed**; frontend policy tests — **461 passed**; TypeScript — passed; Vite build — passed with existing warnings; final elevated preflight — **PREFLIGHT PASSED**, 5/5 stages, all 59 backend modules passed.
- Manual/browser follow-up: NOT RERUN; no frontend code changed. Prior disposable import matrix remains recorded in the child implementation record. Packaged `.xlsx` smoke: NOT RUN.
- Next action: stop implementation and await independent reviewer re-review of corrected 039.3 R1-R4.
- TURN: **REVIEWER**.

### 2026-08-11 — REVIEWER FOLLOW-UP (039.3 R1-R4)

- Reviewer lock: `2e37488219cf8dd92909c7a41c1cb2ebbcf17118` held `TURN: REVIEWER / STATE: UNDER_REVIEW` through the complete follow-up review.
- Reviewed actual remote implementations: `eb59fb02b9ebe16c7a1a2dfffb702beee1316c87` (R1-R3) and `d956f05008f091ee3c387d219782e1c06d73deae` (R4); verification record `2ccebf15ff02703e2b9aa8e90d52fad0a8d6e7df`.
- Result: **CHANGES REQUIRED — R1-R4 RESOLVED; R5 ONLY**.
- R1-R4 resolved after independent inspection of scanner ordering, parser-family relink guard, mixed-format continuation persistence/blocking tests, Excel source-monitor/stable-update tests and old-cache cleanup behavior.
- R5 — Low: the implementation/audit record names non-resolvable SHA `52164278480dc66b977eaf622fd128a6631508f9`; the actual remote R1-R3 commit is `eb59fb02b9ebe16c7a1a2dfffb702beee1316c87`.
- Canonical review commit: `38e6769cd1fe15ae0b7d9ebe91798aafb5cad845`.
- Reviewer-independent verification: GitHub connector inspection only; Python/frontend/browser/private-workbook/native-picker/packaged commands were not independently executed.
- Next action: IMPLEMENTER corrects R5 audit records only, commits/pushes, and returns 039.3 to REVIEWER. 039.4 remains unauthorized.
- TURN: **IMPLEMENTER**.

### 2026-08-11 — IMPLEMENTER AUDIT CORRECTION (039.3 R5)

- The prior 039.3 follow-up entry recorded `52164278480dc66b977eaf622fd128a6631508f9` for the R1–R3 implementation, but that identifier is not a resolvable remote commit.
- Canonical remote R1–R3 implementation commit: `eb59fb02b9ebe16c7a1a2dfffb702beee1316c87` (`fix: close 039.3 lifecycle review findings`). The R4 implementation remains `d956f05008f091ee3c387d219782e1c06d73deae`.
- This correction changes audit documentation only; no implementation code or verification claim changed.

### 2026-08-11 — REVIEWER FOLLOW-UP (039.3 R5)

- Reviewer lock: `b84063054b95201b06424dbf4aa4c5af39bdafbd` held `TURN: REVIEWER / STATE: UNDER_REVIEW` while the audit-only correction was inspected.
- Reviewed correction: `d8bc05716d92f80f0f87376a56504e49d073dc8f`.
- Result: **REVIEW CLEAN**. R1-R5 are resolved.
- R5 resolved: the child implementation record now names canonical remote R1-R3 commit `eb59fb02b9ebe16c7a1a2dfffb702beee1316c87`; the coordination log preserves the earlier mistaken identifier and appends the explicit correction.
- Canonical review commit: `60d1a53773d821c9134835bc9c48e87c81ef25b7`.
- Reviewer-independent verification: inspected the exact two-file documentation patch and remote commit history through the GitHub connector. No implementation/test command was independently rerun because R5 changed audit documentation only.
- Next action: 039.3 is review-clean; implement 039.4 exactly as specified, then hand control to REVIEWER for focused 039.4 plus fresh cumulative Parent 039 review.
- TURN: **IMPLEMENTER**.

### 2026-08-11 â€” IMPLEMENTER HANDOFF (039.4)

- Active child: 039.4.
- Implementation SHA: `805f318b60dc3815459792503073c1b1953d2ed1`; verification-record checkpoint:
  `5284d97`.
- Changes: added registered/cache-backed Excel analysis regressions for Cycles, Time/Capacity,
  repeated Steps, DCIR, Rate Capability and truthful missing-condition Chargeability; added
  portable original-`.xlsx` provenance coverage; completed format-neutral scientific audit,
  real-workbook acceptance record, documentation/project-context closure, synchronized `0.22.0`
  minor version and user-facing changelog.
- Verification: parent backend matrix including golden modules â€” **375 passed**; frontend policy
  tests â€” **461 passed**; `python scripts\check_versions.py --expected-version 0.22.0` â€” PASS;
  final elevated `python scripts\preflight.py --no-cache` â€” **PREFLIGHT PASSED**, 5/5 stages,
  all 59 backend modules passed; build-only stable packaging â€” PASS, NSIS artifact produced.
- Real workbook: disposable read-only registered/cache-backed acceptance RUN (13,982 raw rows,
  40 cycles, 201 executed steps, 26 programmed rows, 19.21 mg, 3.3 mAh, locked deviations within
  tolerance); DCIR/rate/Chargeability recorded not applicable for the supplied protocol.
- Packaged runtime: RUN with a generated privacy-safe workbook; sidecar health, metadata/full parse,
  preview, raw data, normal registration, Cycles, Steps, exact restart and cache-hit checks passed.
  Final 039.4 analysis/browser UI matrix: NOT RUN; earlier 039.3 import browser matrix remains
  recorded separately. Private workbook was not committed.
- Next action: stop implementation and await the focused 039.4 review plus fresh cumulative Parent
  039 review.
- TURN: **REVIEWER**.

### 2026-08-11 — REVIEWER FINAL (039.4 + Parent 039)

- Review lock: `d7192d99a22885f28184f50708d098c1a380a387` held `TURN: REVIEWER / STATE: UNDER_REVIEW` until the final coordination handoff.
- Reviewed implementation: `805f318b60dc3815459792503073c1b1953d2ed1`.
- Canonical review commit: `8c55e4592d6d7b4bf93c93f882e54796b51468ba`.
- Result: **REVIEW CLEAN** — focused 039.4 and fresh cumulative Parent 039 review both clean; no actionable findings.
- Verification ownership remains exactly as recorded in the canonical review: reviewer independently inspected the repository through the GitHub connector and did not independently rerun Python/frontend/preflight/packaging/private-workbook/installer/browser commands.
- Final handoff: `TURN: USER / STATE: FEATURE_COMPLETE`; the user decides optional remaining manual/package checks, PR metadata, merge and release.
