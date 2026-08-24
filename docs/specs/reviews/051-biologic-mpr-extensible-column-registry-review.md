# Review — Spec 051: BioLogic MPR extensible column registry and required-field decoding

Status: **Complete — cumulative review clean**  
Ready to merge: **Yes**  
Spec: [`../051-biologic-mpr-extensible-column-registry.md`](../051-biologic-mpr-extensible-column-registry.md)  
Child: [`../051.1-biologic-mpr-cycle-reconstruction.md`](../051.1-biologic-mpr-cycle-reconstruction.md)  
Branch: `feature/biologic-mpr-extensible-columns-051`  
Main / merge base: `706dc0f14880202a8c5e22b35020502bcf3b4dc9`  
Previous completion before 051.1: `c17bd2a923182e51e89d83e8e656b6e22e52757a`  
051.1 initial implementation: `43a726c5c620324d50fc4918969e4a06af244b62`  
051.1 returned fixes: `eff841a4ee9aa34c29e8cb6ccf09f62af42e4087`

## Fresh cumulative review

The reopened cumulative Spec 051 review is clean against the correct merge base `706dc0f14880202a8c5e22b35020502bcf3b4dc9`. The branch is ahead-only and the cumulative scope is confined to the BioLogic MPR registry/semantic adapter, parser/cache/lifecycle integration, focused tests, documentation, and workflow/review records. There is no migration, frontend feature, or unrelated architecture change in the branch, and global `CALC_VERSION` remains unchanged.

The original Spec 051 binary-decoding contract remains intact. Ordinary encoded column IDs retain full source identity while resolving storage through the verified base-ID rule; packed logical flags remain exact-ID/shared-byte fields. The 16-ID/53-byte and 21-ID/93-byte GCPL layouts remain regression-covered. Record stride is still derived from the payload record area and datapoint count, then used as the explicit NumPy dtype itemsize. Unknown interleaving, duplicate resolved bases, missing required fields, malformed packed flags, invalid stride/divisibility, unsupported module versions, and other unresolved layouts remain fail-closed.

The reviewed capacity-boundary rule also remains narrow: the EGG-family per-`Ns` counter-origin exception requires a near-zero ID-211 cumulative quantity with matching ID-7 incremental `dQ`; arbitrary non-zero boundary transfer remains rejected. Stable documentation distinguishes ID 211 cumulative/source-dependent charge-discharge quantity from ID 7 incremental `dQ`.

Child 051.1 extends only cycle identity and the associated adapter provenance. `bm:gcpl10:r1` now supports, in order, an explicit full-cycle field, bounded declared or execution-evidenced repeated-loop reconstruction, and deterministic non-repeating source-local cycle 1; unresolved restart/branch/control structures remain metadata-only. The execution-evidenced fallback is no longer an undocumented implementation heuristic: the governing child spec locks its required settings, observed `Ns`, charge/discharge, neutral-control, and fail-closed conditions. Non-zero half-cycle values are retained as diagnostic evidence only and are not converted arithmetically into full cycles.

Cycle provenance is deterministic across lifecycle/cache boundaries. Exact adapter-produced identity (`explicit_full_cycle`, `protocol_loop_reconstruction`, or `non_repeating_cycle_1`) is persisted in cache metadata and recovered on cache hits rather than derived from cycle cardinality. Missing provenance on an older gcpl10 cache causes a safe reparse instead of guessing. Import/scanner promotion receives exact provenance, and mixed-loop sources do not claim single-direction verification.

The real EGG acceptance evidence closes the main scientific uncertainty. The user's Cell 135 contains two ordered BioLogic sources. The first is a 456-row non-repeating discharge source and accounts for the ~58 mAh first Cell-level cycle point. The second is a 49,308-row `bm:gcpl10:r1` source whose observed execution is a repeated Rest/Charge/Discharge sequence with one `3 -> 1` loop edge, producing 1,629 complete source-local charge/discharge iterations. The implementer traced raw ID-211 and ID-7 values through canonical capacities and `calc.per_cycle(...)` at early, middle, and late cycles; those values agree. The dramatic later capacity reduction is present in the raw source rather than being introduced by the BioLogic adapter.

One user-visible issue remains deliberately outside Spec 051: Time/Capacity `display_mode=consecutive` with a capacity X-axis does not concatenate capacity resets across cycle/phase boundaries. The implementer reproduced it on the generic path, including Neware, and reviewer inspection confirmed the same coordinate logic predates Spec 050. It is therefore a separate pre-existing Time/Capacity display-coordinate defect, not a BioLogic parser/cycle/capacity defect and not a reason to extend this branch with unrelated frontend/backend display logic.

## Verification

### Implementer-reported

Original executable Spec 051 checkpoint `f0383220`:

- focused MPR/GCPL/parser/metadata/closure tests: **PASS (163)**;
- `tests.test_analysis_engine`: **PASS (107)**;
- canonical preflight: **PASS (4/4; 81 backend modules and 72 frontend tests)**;
- real single-direction EGG parse/cache/ordinary-voltage analysis: **PASS**.

051.1 initial handoff `43a726c5`:

- focused BioLogic/parser/lifecycle/import-flow tests: **PASS (212)**;
- private repeating EGG parse/cache/ordinary voltage Time/Capacity: **PASS**;
- canonical preflight: **PASS**.

051.1 returned-fix handoff `eff841a4`:

- `tests.test_biologic_gcpl`: **PASS (58)**;
- `tests.test_biologic_closure`: **PASS (22)**;
- existing Time/Capacity capacity-axis diagnostic regression: **PASS (1)**;
- canonical preflight: **PASS** — all 81 backend modules, version consistency, frontend type check, production bundle;
- real user EGG source-level cycle/capacity trace: **PASS**;
- browser checks: **NOT RUN**.

### Reviewer-independent

I inspected the cumulative branch diff from merge base `706dc0f1` through returned-fix commit `eff841a4`, including low-level MPR decoding, GCPL semantic reconstruction, capacity ownership/reset logic, cache provenance, parser/scanner/import lifecycle, focused regression tests, current Spec 051/051.1 contracts, high-priority agent guidance, and BioLogic format documentation. I also inspected the generic Time/Capacity consecutive-coordinate implementation and its pre-Spec-050 history to separate that defect from BioLogic behavior.

I did **not** independently run repository tests, browser checks, the user's database, or the private EGG source. GitHub reports no status checks on `eff841a4`. The real-file measurements above are implementer-reported evidence from a read-only local trace and are not represented as reviewer execution.

## Findings and resolution

Historical Parent 051 findings R1-R3 remain resolved. Child 051.1 findings R1-R4 are resolved in its canonical review file. No new cumulative defect, spec deviation, regression risk, migration issue, cache-versioning error, or missing branch-scoped verification was found in the final cumulative pass.

## Merge readiness

**Ready to merge: Yes.**

The BioLogic MPR branch now supports the verified extensible 21/93 layout and deterministic cycle reconstruction for the reviewed GCPL cases while retaining fail-closed boundaries, source-local provenance, local-first cache architecture, and format-neutral downstream scientific calculations. The separate generic consecutive-capacity display bug should be tracked and fixed independently.