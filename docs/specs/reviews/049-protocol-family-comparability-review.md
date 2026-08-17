# Review 049 — Protocol-family comparability and reviewed grouping

Specification: [`../049-protocol-family-comparability.md`](../049-protocol-family-comparability.md)  
Late user-authorized child scope: [`../049.1-protocol-family-grouping.md`](../049.1-protocol-family-grouping.md)  
Branch: `feature/semantic-protocol-signature`  
Merge base: `main` at `9f0f69215182fbba67eb2c7fabce64369009b2b0`  
Final implementation checkpoint: `b57b154257f1aea04be624c33a79ef062353b67b`  
Status: **REVIEW CLEAN — READY TO MERGE**

## Fresh cumulative final review

The final implementation checkpoint is cleanly **21 commits ahead / 0 behind** current `main`; the merge base remains `9f0f69215182fbba67eb2c7fabce64369009b2b0`.

The final review re-checked the complete cumulative branch, including the original Spec 049 comparator, the user-authorized 049.1 grouping extension, all manual-feedback changes, all returned review fixes, the analysis-cache ownership boundary, release/version synchronization, durable documentation, and the final visual-contract cleanup.

No remaining scientific, persistence, cache-identity, grouping, migration, accessibility, or merge-closure defect was found.

## Verification record

Latest implementer handoff (`2026-08-18T00:34:27+02:00`) reports:

- focused frontend comparator/grouping/DCIR tests: PASS (21/21);
- focused analysis-cache tests: PASS (33 tests);
- frontend type-check/build: PASS (`npm.cmd run build`);
- version check: PASS (`0.26.0-beta.6`);
- canonical preflight: PASS (4/4 stages; all 134 backend/frontend test files/modules);
- browser checks: NOT RUN (explicitly delegated to the user by Specs 049/049.1).

Earlier accepted handoffs also recorded the focused backend BioLogic/protocol/rate/identity suite (80 tests), golden analysis regression (30 tests; zero diffs), Neware Excel regression (67 tests), and the live read-only analysis-34 semantic-family check.

Reviewer-independent verification was static through ChatGPT Chat + the GitHub connector. I did **not** independently execute local test/build/browser commands and do not claim that I did. Feature-branch pushes have no required GitHub Actions run under `AGENTS.md`; `main` CI runs after merge.

## Finding resolution

- **R1 — RESOLVED:** persisted current/v3/v1 protocol targets remain usable across Cycles, Steps and DCIR; target-resolution cache generation is separated.
- **R2 — RESOLVED:** frontend semantic C-rate normalization matches the backend contract.
- **R3 — RESOLVED BY USER-AUTHORIZED DESIGN CHANGE / R6:** termination/control conditions are a separate first-class comparison dimension.
- **R4 — RESOLVED:** evidence exposes equality-relevant termination/control fields.
- **R5 — RESOLVED:** Custom mode with zero selected dimensions fails closed.
- **R6 — RESOLVED:** strict semantic identity includes normalized source-declared termination/control conditions with compatibility aliases.
- **R7 — RESOLVED:** creating groups preserves existing definitions/names and duplicate definitions are excluded.
- **R8 — RESOLVED:** BioLogic declared controls are represented without false cross-source differences from redundant Rest/loop storage.
- **R9 — RESOLVED:** grouped DCIR validation and grouped step mapping share the same reviewed empty-step policy.
- **R10 — RESOLVED:** explicit analysis-local `protocol_group_id` provenance prevents ownership transfer by membership inference.
- **R11 — RESOLVED:** current implementation verification is recorded through canonical preflight.
- **R12 — RESOLVED:** editor-only group provenance is excluded from scientific cache identity while true target changes still invalidate results.
- **R13 — RESOLVED at `b57b1542`:** durable DCIR knowledge, parent/child specs, review links, spec index, verification record, and cache-generation comment now describe the beta.6 grouping/provenance behavior accurately.
- **R14 — RESOLVED at `b57b1542`:** grouping-modal instructional/caution copy uses the normal `xs` helper size while dense structural metadata remains at 10 px.

## Final architecture/ownership check

- Per-source semantic protocol signatures remain authoritative identities.
- Reviewed groups are analysis-local metadata; they do not create synthetic protocol signatures or mutate source data.
- Grouped selections expand to exact source-local protocol/DCIR targets before scientific compute.
- Optional `protocol_group_id` is editor/display provenance only and is excluded from the scientific result-cache key.
- Group rename/removal does not rewrite existing scientific targets.
- Legacy protocol signature aliases preserve saved target meaning across the signature-generation change.
- No SQL migration or request-path source-file parsing was introduced.
- Raw protocol families remain selectable alongside reviewed groups.
- The pairwise comparator remains diagnostic; grouping is explicit and opt-in through 049.1.

## Final decision

**READY TO MERGE.**

The cumulative parent review is clean. All findings R1–R14 are resolved, required automated verification is recorded at the final implementation checkpoint, and the intentionally user-delegated in-app browser check is not a workflow blocker under the active specifications.