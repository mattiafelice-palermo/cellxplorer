# Spec 067 independent review

Reviewer: GPT-6 Astra Medium. Date: 2026-10-03.
Checkpoint: working-tree implementation on `codex/alpha-analysis-improvements`
after Spec 066 checkpoint `fe697cd0`.
Verdict: **PASS — implementation review clean**. Final preflight and remaining
browser checks are separate acceptance gates.

Final integration evidence supplied by the parent implementer: canonical preflight
passed 4/4 stages, including all 191 test modules, TypeScript and the production
bundle. Disposable browser help was checked in light/dark; completed recognition
and incomplete-step evidence were checked live. Completed no-match remains covered
by focused policy/backend tests. These are implementer acceptance results, separate
from the independent review above.

## Re-review

R1 is resolved: the plot card now checks `!result.data` before evaluating
no-match guidance and distinguishes waiting from recognition not started.
R2 is resolved: the bounded raw fixture provides `step_index`.
Independently reran `python -m pytest tests/test_rate_capability.py -q
-p no:cacheprovider`: **18/18 passed**, including scientific-output invariance.
No actionable implementation findings remain.

The implementer additionally reports browser verification of expanded help
showing the actual minimum of three rates, 0.03 V cutoff tolerance, and 3%
rate tolerance. Before starting a draft it shows Not started; after New it
shows Detecting / Checking protocol, without falsely showing No match.
Completed no-match feedback, light/dark coverage, and preflight are pending.

## Final evidence follow-up

Audited the final sorted-rate evidence change: ascending positive rates make
the greedy separated-rate set an upper bound rather than allowing protocol
order to undercount overlapping tolerance neighborhoods. The detector itself
is unchanged. The new `0.50, 0.49, 0.51` regression covers the non-transitive
case. Independent combined backend/corpus run passed **21 tests and 13
subtests**. Implementation PASS is retained.

The implementer reports completed browser recognition of two blocks with
incomplete-execution notices and exclusion counts matching backend evidence,
and verified dark chrome tokens. These supplement the help/loading checks
above; they are implementer-supplied evidence, not reviewer-run browser checks.
Final canonical preflight is still running.

## Golden-projection follow-up

Reviewed the narrow golden projection adjustment after the additive response
field caused an exact-key mismatch. It removes only
`cells[*].recognition_evidence` for `type == "rate_capability"`, from a deep
copy. Family statuses, scientific numeric values, other result types, and
similarly named keys elsewhere remain compared. No expected outputs or
numerical tolerances were changed. The regression explicitly preserves input
immutability and verifies that capacity/status mutations still fail comparison.
Independent focused projection regression: **1 passed**. The implementer
reports **35 golden/approval tests passed** and the original rate baseline
digest retained. PASS is retained; the final full preflight rerun is pending.

## Resolved R1 — P2: Empty plot could report no match before recognition starts

`frontend/src/features/analyses/editor/families/rate-capability/RateCapabilityPlotCard.tsx:1694`
falls through to `rateCapabilityNoMatchGuidance` when no data exists and
recognition is disabled. A disabled React Query with no cache is neither
loading nor fetching. The settings summary has an explicit not-started state,
but the plot card does not. Add a no-result/not-started branch before the
scientific no-match message so absence of computation is not presented as a
recognition result.

## Resolved R2 — P2: New compute-evidence regression failed before its assertion

`tests/test_rate_capability.py:339` supplies an empty DataFrame while leaving
`_ExecutionIndex` real. Independent execution of the module produced **17
passed, 1 failed**: the new scientific-output preservation test raises
`KeyError: 'step_index'`. Supply the required raw columns or a suitable bounded
fixture/mock, then rerun the regression and complete preflight.

## Evidence and acceptance limits

Independent `node --test frontend/tests/rateCapabilityGuidance.test.ts`:
**7/7 passed**. Inspected the evidence additions and detector: they append
per-Cell diagnostics without changing pairing, rate matching, sweep selection,
capacity, or common-reference calculations. Schema version 5 invalidates the
old rate-capability result shape. Evidence counts use the same tolerance rule
as recognition; prose describes them without claiming compatibility or the
cause of interrupted execution. Missing nominal capacity is not treated as a
universal prerequisite when declared C-rates exist.

The implementer reports browser verification of the help dialog and configured
minimum of three rates. This reviewer has not performed browser, light/dark,
or native acceptance. Final focused/preflight results are pending.
