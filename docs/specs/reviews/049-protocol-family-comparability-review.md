# Review 049 — Protocol-family comparability and reviewed grouping

Specification: [`../049-protocol-family-comparability.md`](../049-protocol-family-comparability.md)  
Late user-authorized child scope: [`../049.1-protocol-family-grouping.md`](../049.1-protocol-family-grouping.md)  
Branch: `feature/semantic-protocol-signature`  
Merge base: `main` at `9f0f69215182fbba67eb2c7fabce64369009b2b0`  
Implementation checkpoint: `ff38407f877db2d5d84eaf9c0037aea24a665000`  
Final-review workflow checkpoint: `506480219b6a74e35acd7d0a971f44b8adf85615`  
Status: **CHANGES REQUIRED — FINAL REVIEW NOT CLEAN**

## Fresh cumulative final review

The current feature branch is cleanly **19 commits ahead / 0 behind** `main`; the merge base remains `9f0f69215182fbba67eb2c7fabce64369009b2b0`.

This final review re-read the branch cumulatively rather than relying on earlier rounds. Scope includes:

- semantic protocol identity v4 plus v3/v1 compatibility aliases;
- Cycles/Steps/DCIR legacy-target resolution and analysis-cache generation change;
- Strict/Workflow/Custom protocol comparability and evidence;
- user-authorized 049.1 all-family grouping, exact source-local step mapping, group persistence/rename/removal, grouped DCIR suggestions, and explicit segment group provenance;
- BioLogic/Neware comparison normalization and empty Rest/Pause handling;
- editor-only provenance exclusion from scientific cache identity;
- the Plotly Vite interop fix introduced while verifying this branch;
- focused/golden/cache verification and release-version synchronization;
- durable documentation, spec/index status, UI style contract, and merge closure.

The implementation code is scientifically and architecturally clean after R1-R12. No new calculation, target-resolution, grouping, cache, migration, or persistence defect was found in this final pass.

## Verification record

Implementer evidence at beta.6:

- focused frontend comparator/grouping/DCIR tests: PASS (21/21);
- focused backend BioLogic/protocol/rate/identity tests: PASS (80 tests);
- full changed-frontend canonical preflight: PASS (4/4; all 134 backend/frontend files/modules) at the beta.6 implementation checkpoint;
- R12 focused analysis-cache tests: PASS (33 tests);
- R12 incremental canonical preflight: PASS (4/4; 70 backend modules, unchanged frontend stages skipped);
- version check: PASS (`0.26.0-beta.6`);
- earlier golden analysis verification: PASS (30 tests; zero diffs);
- browser checks: NOT RUN, explicitly delegated to the user by Specs 049/049.1.

Reviewer-independent verification was static through ChatGPT Chat + the GitHub connector. I did not execute local test/build/browser commands and do not claim that I did. Feature-branch pushes have no GitHub CI requirement under `AGENTS.md`; `main` CI runs after merge.

## Resolved findings

- **R1 — RESOLVED.** Persisted current/v3/v1 protocol targets remain usable across Cycles, Steps and DCIR; target-resolution cache generation is separated.
- **R2 — RESOLVED.** Frontend semantic C-rate comparison matches backend normalization.
- **R3 — RESOLVED BY USER-AUTHORIZED DESIGN CHANGE / R6.** Termination/control conditions are their own comparison dimension.
- **R4 — RESOLVED.** Termination evidence exposes equality-relevant condition fields.
- **R5 — RESOLVED.** Zero-dimension Custom comparison fails closed.
- **R6 — RESOLVED.** Strict protocol identity includes normalized source-declared conditions with compatibility aliases.
- **R7 — RESOLVED.** Creating groups preserves existing group definitions and names.
- **R8 — RESOLVED.** Declared BioLogic controls are represented without cross-source false differences from redundant Rest/loop storage.
- **R9 — RESOLVED.** Grouped DCIR validation and grouped step mapping share the same authorized empty-step policy.
- **R10 — RESOLVED.** Explicit `protocol_group_id` provenance prevents group ownership transfer by membership inference.
- **R11 — RESOLVED.** Current implementation verification is recorded.
- **R12 — RESOLVED.** `protocol_group_id` is excluded from scientific cache identity while true target changes still invalidate Steps/DCIR results.

## Open final-review findings

### R13 — Medium: Durable documentation and workflow status still describe the pre-grouping implementation

Affected files:
- `docs/agent-knowledge/dcir-analysis.md`
- `docs/specs/049-protocol-family-comparability.md`
- `docs/specs/049.1-protocol-family-grouping.md`
- `docs/specs/README.md`
- `backend/app/services/analysis_cache.py` (generation comment only)

**Current**

The implementation now supports explicitly reviewed protocol-family groups, maps reference selections into exact source-local targets, persists `protocol_groups`, and stores optional editor-only `protocol_group_id` provenance on protocol/DCIR segments. The scientific engine ignores grouping metadata and the cache strips provenance.

The durable documentation has not caught up:

- `docs/agent-knowledge/dcir-analysis.md` still says the comparison modal is diagnostic only and “never ... creates a step mapping”, which is false after 049.1; it also does not document group provenance/cache exclusion.
- Parent 049 still reports `Implementation ready for remote review`, its implementation record says the modal “remains read-only”, and its verification record stops at `0.25.0-beta.3`. Those statements are historically true for 049 alone but misleading as the current feature record unless the later 049.1 extension is made explicit.
- 049.1 still reports `Implementation complete - review pending` and its state contract omits the final optional `protocol_group_id` provenance added by the accepted R10 design.
- `docs/specs/README.md` still labels parent 049 as ready for review and 049.1 as review pending.
- `ANALYSIS_CACHE_VERSION = 6` still comments only on current/version-1 aliases although the compatibility contract is current + version-3 + version-1 / legacy aliases.

This is a final-review merge blocker because `AGENTS.md` requires durable architectural facts and spec status to be reconciled with the implementation, and the reviewer prompt explicitly requires documentation/status closure before `COMPLETE`.

**Target**

Bring the durable feature record to the final beta.6 behavior without rewriting historical decisions:

- update DCIR knowledge to distinguish the original diagnostic comparator from the explicit reviewed 049.1 grouping workflow; document exact source-local target expansion, analysis-local group/provenance ownership, removal behavior, and cache exclusion of `protocol_group_id`;
- update 049/049.1 status and implementation records so the parent clearly points to the later user-authorized grouping extension and the child records the final provenance/data shape;
- add `Review document:` links for the parent and 049.1 review files following `AGENTS.md`;
- synchronize the 049 entries in `docs/specs/README.md` with the final-review state;
- make the cache-generation comment describe generic legacy/current signature compatibility accurately.

Do not change runtime behavior while closing this documentation finding.

**Acceptance criteria**

- No durable documentation says the **current** comparison surface is read-only/no-mapping without immediately distinguishing the 049.1 reviewed-group extension.
- 049.1 documents `protocol_group_id?: string | null` as editor-only segment provenance; exact source-local targets remain authoritative and provenance is excluded from scientific cache identity.
- Parent/child spec status and the spec index no longer say remote review/review pending once the returned documentation handoff is ready for final review.
- Both specs cross-link their canonical review documents.
- `dcir-analysis.md` accurately describes grouped DCIR target expansion and private segment/cache ownership.
- The cache-version comment no longer incorrectly implies only version-1 legacy aliases exist.
- Documentation-only changes pass the relevant repository checks/preflight.

### R14 — Low: New grouping-modal instructions use the 10 px metadata size reserved by the visual contract

Affected file:
- `frontend/src/features/analyses/editor/protocol/ProtocolSegmentsPanel.tsx`

**Current**

The visual style guide explicitly reserves 10–11 px for dense structural metadata and says **10 px is never for instructions or error messages**. The 049.1 modal uses `size="10px"` for several instructional/caution lines, including:

- `Scroll horizontally to inspect all families`;
- `Rename or remove groups without changing source data.`;
- `This grouping already exists as ... Rename it in Applied protocol groups.`;
- `No source data changes until you create named groups.`

Other 10 px uses in the matrix/cards are legitimate compact metadata and need not be changed.

**Target**

Use the normal helper/instruction treatment (`size="xs"`, with existing dimmed/semantic color as appropriate) for instructional and caution copy while retaining 10 px only for dense protocol/group metadata. Preserve the compact modal geometry and theme-safe styling.

**Acceptance criteria**

- The four instructional/caution lines above are no longer rendered at 10 px.
- Dense metadata such as protocol evidence, cell/source counts and compact group labels may remain 10 px.
- No new hard-coded color/background system is introduced.
- Frontend build and canonical preflight pass.

## Reviewer-owned 049.1 bookkeeping

049.1 was added after `049-agent-state.json` was initialized and therefore never appeared in the frozen child list. The final reviewer is creating/updating the correctly named `docs/specs/reviews/049.1-protocol-family-grouping-review.md` so the late user-authorized child has the review artifact required by repository convention. This bookkeeping does not require the implementer to reimplement the child.

## Decision

**CHANGES REQUIRED — NOT READY TO MERGE.**

Return only **R13** and **R14**. All implementation/scientific findings R1-R12 remain resolved. After this narrow documentation/style handoff, resume the cumulative `FINAL_REVIEW`; browser verification remains user-delegated rather than an external blocker.