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
LAST_IMPLEMENTATION_SHA: b2db0c495787a7b547d8b256fbc7595ed774f2a5
LAST_REVIEW_SHA: c314a1a2e573782c258721d60f8da1d38ab158e2
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

039.4 R1 is resolved at `b2db0c495787a7b547d8b256fbc7595ed774f2a5`. The canonical clean
review at `c314a1a2e573782c258721d60f8da1d38ab158e2` confirms both the focused 039.4
follow-up and fresh cumulative Parent 039 review are clean. Parent 039 is implementation/review
complete. The final 039.4 analysis/browser UI matrix remains truthfully NOT RUN and is an optional
pre-release confidence check. The user decides PR metadata, merge and release.

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

### 2026-08-11 — IMPLEMENTER HANDOFF (039.4 R1)

- Active child: 039.4.
- R1 fix implementation SHA: `b2db0c495787a7b547d8b256fbc7595ed774f2a5`; implementation-record checkpoint: `2ecedf9a22b7ede89ca4ceb8bb60175e6c7aa14d`; coordination handoff: `bfbac9defa5ab22fc52cd705642336531e4b1e55`.
- Change: registered/cache-backed Excel Rate Capability regression now asserts returned charge capacities 10.2, 10.5 and 11.0 mAh at 0.2C, 0.5C and 1.0C with strict tolerance.
- Verification: focused Excel + 8 rate tests PASS; elevated `python scripts\\preflight.py --no-cache` PASS, 5/5 stages including all 59 backend modules, 461 frontend tests, TypeScript and Vite.
- Next action: reviewer verifies R1 and reruns the fresh cumulative Parent 039 review.
- TURN: **REVIEWER**.

### 2026-08-11 — REVIEWER CLAIM (039.4 R1 + Parent 039)

- Reviewer lock: `6e55d93faf5d6d657108b44176a3de10f077bbf2`.
- Reviewed implementation target: `b2db0c495787a7b547d8b256fbc7595ed774f2a5`.
- The implementer remained stopped until both the focused R1 re-review and fresh cumulative Parent 039 review were complete.

### 2026-08-11 — REVIEWER FINAL (039.4 R1 + Parent 039)

- Canonical review commit: `c314a1a2e573782c258721d60f8da1d38ab158e2`.
- R1: **RESOLVED**. The registered/cache-backed Rate Capability result now verifies 0.2C -> 10.2 mAh, 0.5C -> 10.5 mAh and 1.0C -> 11.0 mAh.
- Fresh cumulative Parent 039 review: **REVIEW CLEAN** against merge base `0df1fb3e48dfc8a37ee2e9c2a07667ed09942a5b`.
- Reviewer-independent verification: inspected the R1 implementation/documentation commits, exact computed-result assertions, full cumulative changed-file scope, and confirmed no production code changed after the initial 039.4 implementation. Python/frontend/preflight/packaging/private-workbook/installer/browser commands were not independently rerun; implementer-reported verification remains recorded in the canonical review.
- Final handoff: `TURN: USER / STATE: FEATURE_COMPLETE`. User decides optional manual UI checks, PR metadata, merge and release.

## Recovered audit history after reviewer-log truncation

Reviewer lock commit `6e55d93faf5d6d657108b44176a3de10f077bbf2` correctly claimed the final
R1 review but accidentally removed earlier append-only coordination entries. The exact full
pre-truncation text remains immutable at checkpoint
`bfbac9defa5ab22fc52cd705642336531e4b1e55`. This recovery index restores the removed checkpoint
sequence in the live file; canonical review files remain the authority for the detailed R findings.

### 039.1 — parser implementation and review

- Initial implementation: `7599715c78312ad9ced12c665ade3a5e46c28e95`; parser/fixture verification and real-workbook probe were reported passing.
- Initial review: `a4e5e1b8cb427be36b3408559d5ea0144e7fb556`; R1 requested the missing time-reset-only execution-boundary regression.
- R1 implementation: `949c9caad053faf090fd5cf9645342ef98db9d8d`.
- Review-clean checkpoint: `a931a68a38d4fa20ee7a55925334359fbbde9f05`.

### 039.2 — metadata, protocol and cache integration

- Initial implementation: `024525e01b184583d443d672d4b93b91bedfbfc6`; implementation-record checkpoint `4063999131e850b42cda00911dcf05c4367fdf27`.
- Initial review: `f4d748c528162a8005b99058abcfff78152d43c4`; R1-R3 covered missing declared-protocol degradation, step-summary timing and numeric timestamp rejection.
- R1-R3 implementation: `696e4f967488a1fafd0360a4c8571c53db7ba0cc`; follow-up review `3eeeb170324d55e6acc08403b16263225ae1c5d2` resolved them and raised R4-R5.
- R4-R5 implementation: `06b33641446e8592748ff56884d50303d02fdee7`; follow-up review `3b0a7668dd169f3078ce8823c8998bb3e1edd062` resolved them and raised R6-R8.
- First R6-R8 implementation: `0abff4102cb534f0652ffb6bc52648eec69c6c9b`; premature clean review `08b5eaae375a8cdc02659fd794ac9d5ce4bf17ad` was subsequently superseded after a remaining metadata-slot defect was identified before any 039.3 implementation landed.
- Corrected review checkpoint: `22e63305ba0cdf275573a637166d7cec9f20d939`.
- Final R6-R8 implementation: `871834c06703592a0d1774383ca37498581bf2ac`; final review-clean checkpoint: `938c634b363d88360b7df839432f9ca7aa5a5a06`.
- Final accepted parser identity: Excel revision 3 / global parser bundle `...-cxp3`; `CALC_VERSION` remained `1.6.1`.

### 039.3 — import and source lifecycle integration

- Initial implementation: `dca7a83440c79b1bd959f847d9b2c2c88b47a3c1`; verification checkpoint `d2f52e2f9820312f50b6a7558646490e725fe33d`; implementer handoff `91050914d906518a8af7dc567a9cbeda6eec1627`.
- First reviewer lock: `fdfc6537e005ad5ad0ef447170ad0edc40af2e9a`; initial review `7c30e14442f3c3d635c8376f2bfa19fe9cfe82de` raised R1-R3.
- A concurrent premature release was reclaimed at `c45b040ab77a063f6261928e508a6febb43bc880`; corrected complete review `2bfedb9b0746db5100dfbfe0e6924b1926398869` added R4 before returning the implementer.
- Actual remote R1-R3 implementation: `eb59fb02b9ebe16c7a1a2dfffb702beee1316c87`; R4 implementation: `d956f05008f091ee3c387d219782e1c06d73deae`; verification checkpoint `2ccebf15ff02703e2b9aa8e90d52fad0a8d6e7df`.
- Follow-up reviewer lock: `2e37488219cf8dd92909c7a41c1cb2ebbcf17118`; review `38e6769cd1fe15ae0b7d9ebe91798aafb5cad845` resolved R1-R4 and raised audit-only R5 because the earlier log named non-resolvable SHA `52164278480dc66b977eaf622fd128a6631508f9` instead of the actual R1-R3 commit.
- Audit correction: `d8bc05716d92f80f0f87376a56504e49d073dc8f`; reviewer lock `b84063054b95201b06424dbf4aa4c5af39bdafbd`; final 039.3 review-clean checkpoint `60d1a53773d821c9134835bc9c48e87c81ef25b7`.
- Coordination advance to 039.4: `417aa141d15cc7c067ca741e2bab1b3489c045d2`.

### 039.4 — original closure review and R1 reconciliation

- Initial 039.4 implementation: `805f318b60dc3815459792503073c1b1953d2ed1`; verification-record checkpoint `5284d97`; handoff `ae8ac6b8190eaf4f70ef7daf0a80ff40850b9672`.
- Reviewer lock: `d7192d99a22885f28184f50708d098c1a380a387`.
- Concurrent premature clean review `8c55e4592d6d7b4bf93c93f882e54796b51468ba` and coordination `e615bb2504fe6baf260dc3ee500ea7f849f80c2b` were superseded because the active locked review was not complete; no implementation code had landed in the race.
- Reviewer reclaim: `e57e57799059563b32438eaf537237605fc6a2f7`.
- Corrected review `fa3f2587c0f5f669e5fbe3ab2bb80489b519ee3e` raised one Medium R1: the registered/cache-backed Excel Rate Capability regression recognized the three-rate sweep but did not assert its known capacities.
- Coordination returned R1 to the implementer at `3c80f26872159e2cf95cd683e97cb042263071ee`.
- R1 implementation `b2db0c495787a7b547d8b256fbc7595ed774f2a5`, documentation checkpoint `2ecedf9a22b7ede89ca4ceb8bb60175e6c7aa14d`, and handoff `bfbac9defa5ab22fc52cd705642336531e4b1e55` closed the missing numeric regression.
- Final reviewer lock `6e55d93faf5d6d657108b44176a3de10f077bbf2`; canonical final clean review `c314a1a2e573782c258721d60f8da1d38ab158e2`; FEATURE_COMPLETE coordination `6c5a08f39752d36fa7e5b2416b6538d40ff7ad17`.

### 2026-08-11 — REVIEWER AUDIT RECOVERY

- Restored the live coordination audit sequence after the accidental history truncation in reviewer lock `6e55d93faf5d6d657108b44176a3de10f077bbf2`.
- Exact pre-truncation coordination text remains preserved at immutable checkpoint `bfbac9defa5ab22fc52cd705642336531e4b1e55`; the recovery index above preserves all removed implementation/review checkpoints and supersession events in the live coordination file.
- No implementation code, scientific behavior, review decision, test claim or `FEATURE_COMPLETE` state changed during this audit repair.
