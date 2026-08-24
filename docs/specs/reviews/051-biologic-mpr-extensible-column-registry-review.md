# Review — Spec 051: BioLogic MPR extensible column registry and required-field decoding

Status: **Reopened — browser acceptance pending**  
Ready to merge: **No**  
Spec: [`../051-biologic-mpr-extensible-column-registry.md`](../051-biologic-mpr-extensible-column-registry.md)  
Child: [`../051.1-biologic-mpr-cycle-reconstruction.md`](../051.1-biologic-mpr-cycle-reconstruction.md)  
Branch: `feature/biologic-mpr-extensible-columns-051`  
Main / merge base: `706dc0f14880202a8c5e22b35020502bcf3b4dc9`  
Previous completion before 051.1: `c17bd2a923182e51e89d83e8e656b6e22e52757a`  
051.1 returned fixes: `eff841a4ee9aa34c29e8cb6ccf09f62af42e4087`

## Current cumulative status

The cumulative code/source-level review through `eff841a4` found the BioLogic MPR registry, cycle reconstruction, capacity mapping, cache provenance, and lifecycle integration internally consistent and fail-closed where required. Historical Parent findings R1-R3 and Child 051.1 findings R1-R4 remain resolved at that level.

Merge readiness is nevertheless withdrawn after a new user browser acceptance pass. The real application still renders the Voltage vs Capacity view incorrectly in `Consecutive` mode. The user has explicitly authorized browser verification for this issue, and Child finding R5 now requires the implementer to reproduce the actual UI behavior on the real EGG Cell and on a Neware control before cumulative review can close again.

The source-level evidence remains unchanged: Cell 135 contains a 456-row one-cycle BioLogic source followed by a 49,308-row repeating source with 1,629 source-local Rest/Charge/Discharge iterations, and representative raw ID-211/ID-7 values agree with canonical and `calc.per_cycle(...)` capacities. The outstanding question is therefore user-facing display ownership, not an already-proven source-capacity conversion error.

## Verification status

Implementer-reported focused BioLogic tests and canonical preflight at `eff841a4` passed, and the real source/canonical/calc trace passed. Browser checks were **NOT RUN** at that handoff. The new user acceptance failure makes browser verification mandatory before merge readiness can be restored.

## Active blocker

See `reviews/051.1-biologic-mpr-cycle-reconstruction-review.md` **R5 — High: Real browser voltage-vs-capacity acceptance still fails**.

R5 requires browser comparison of Time/Capacity and Capacity/Consecutive behavior on the actual user EGG Cell and a Neware control, plus request/response or plotted-series inspection to establish whether the problem is generic Time/Capacity display-coordinate logic, BioLogic/stitching output, frontend rendering, or another layer.

## Merge readiness

**Ready to merge: No.** A fresh cumulative final review is required after R5 is returned and reviewed.