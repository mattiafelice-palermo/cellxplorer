# Review — Spec 051: BioLogic MPR extensible column registry and required-field decoding

Status: **Cumulative review clean after R5 browser acceptance**  
Ready to merge: **Yes within Spec 051 scope; workflow COMPLETE transition still pending**  
Spec: [`../051-biologic-mpr-extensible-column-registry.md`](../051-biologic-mpr-extensible-column-registry.md)  
Child: [`../051.1-biologic-mpr-cycle-reconstruction.md`](../051.1-biologic-mpr-cycle-reconstruction.md)  
Branch: `feature/biologic-mpr-extensible-columns-051`  
Main / merge base: `706dc0f14880202a8c5e22b35020502bcf3b4dc9`  
Previous completion before 051.1: `c17bd2a923182e51e89d83e8e656b6e22e52757a`  
051.1 returned fixes: `eff841a4ee9aa34c29e8cb6ccf09f62af42e4087`

## Fresh cumulative review result

The cumulative Spec 051 branch is clean against merge base `706dc0f14880202a8c5e22b35020502bcf3b4dc9` after the R5 browser-acceptance round.

The branch remains confined to the BioLogic MPR binary registry, GCPL semantic adapter, parser/cache/lifecycle integration, focused tests, documentation, and workflow/review records. No migration, frontend feature, or global `CALC_VERSION` change is introduced. The original Spec 051 binary-decoding guarantees remain intact: verified ordinary-column storage resolution, exact packed-flag treatment, explicit record stride, required-field location, bounded opaque trailing suffix handling, and fail-closed behavior for ambiguous/unsupported layouts.

Child 051.1 adds deterministic source-local logical-cycle reconstruction without moving scientific logic downstream. The final adapter priority remains explicit full-cycle identity first, bounded declared/execution-evidenced loop reconstruction second, deterministic non-repeating cycle 1 third, otherwise metadata-only. Half-cycle remains diagnostic evidence rather than an arithmetic source of full-cycle labels. Exact cycle provenance survives cache and lifecycle boundaries.

The real EGG scientific trace remains consistent: the first ordered source contributes the initial ~58 mAh discharge point; the second 49,308-row source contains 1,629 Rest/Charge/Discharge iterations, and representative raw ID-211 / ID-7 values agree with canonical phase capacities and `calc.per_cycle(...)` at early, middle, and late cycles.

R5 supplied the missing browser acceptance. With explicit user approval, the implementer reproduced the malformed Voltage vs Capacity + Consecutive view in the actual Cell 135 browser page and traced the plotted/API values. The compact backend response already contains hundreds of backward/resetting `display_x` transitions, so the frontend is rendering the coordinates it receives. The same defect reproduces on a Neware control analysis, while Time + Consecutive remains monotonic. Reviewer inspection confirms the owning backend function `_time_capacity_display_x(...)` uses a single-origin subtraction for Consecutive capacity and that the same implementation is present at the branch merge base.

Therefore the still-visible Capacity + Consecutive defect is **generic, pre-existing Time/Capacity behavior**, not a BioLogic/Spec 051 regression. R5 explicitly allowed this outcome provided browser ownership was established and the unrelated generic fix was not silently added to the BioLogic branch. That acceptance criterion is now satisfied.

## Verification

### Implementer-reported

At the final R5 handoff:

- focused BioLogic regressions: **PASS (81 tests)**;
- canonical preflight: **PASS (81 backend modules; frontend checks unchanged)**;
- browser verification: **RUN with explicit user approval**;
- Cell 135 EGG: Capacity + Consecutive visibly malformed; Time + Consecutive monotonic; backend API already contains 752 backward `display_x` transitions over 3,977 points;
- Neware control (`BQV_2370`-`BQV_2374`): Capacity + Consecutive reproduces with seven backward `display_x` resets per cell over cycles 1-3; Time + Consecutive has zero backward resets;
- screenshots captured; private database/source bytes were not committed.

Previous Spec 051 / 051.1 focused and preflight evidence remains recorded in the child and historical parent reviews.

### Reviewer-independent

I inspected the final R5 handoff, current branch state, canonical child review, cumulative branch scope, and the generic `analysis_engine.py::_time_capacity_display_x(...)` implementation. Static inspection confirms that Consecutive mode performs one origin subtraction and therefore does not concatenate capacity resets, and that this code exists at merge base `706dc0f1`. I did not independently operate the user's browser or private database; the browser measurements above are implementer-reported evidence required by R5.

The final implementer R5 handoff changed only workflow files; no production or test code was changed in that round. Thus there is no new executable delta requiring an additional defect finding.

## Findings and resolution

- Historical Parent 051 findings R1-R3: **resolved**.
- Child 051.1 findings R1-R4: **resolved**.
- Child 051.1 R5 browser acceptance: **resolved at the required diagnosis/ownership gate**.
- No new cumulative defect, spec deviation, regression risk, migration issue, parser/cache versioning error, or branch-scoped verification gap was found.

## Remaining separate issue

Time/Capacity `display_mode=consecutive` with a capacity X-axis remains user-visible and incorrect. The smallest correct follow-up is a **generic Time/Capacity consecutive-capacity concatenation fix** owned by the backend display-coordinate path, with focused Neware + BioLogic regression coverage and real browser acceptance. This should not be represented as fixed by Spec 051.

## Merge readiness

**Ready to merge: Yes within Spec 051 scope.**

The final repository workflow state should only be moved from `REVIEWER + FINAL_REVIEW` to `REVIEWER + COMPLETE` using `docs/specs/workflow/spec_workflow.py complete`; the reviewer must not bypass that state-machine transition with direct JSON editing.
