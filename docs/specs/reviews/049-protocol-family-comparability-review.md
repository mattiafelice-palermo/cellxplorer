# Review 049 — Protocol-family comparability review

Specification: [`../049-protocol-family-comparability.md`](../049-protocol-family-comparability.md)  
Branch: `feature/semantic-protocol-signature`  
Merge base: `main` at `9f0f69215182fbba67eb2c7fabce64369009b2b0`  
Implementation checkpoint: `eec437101d90b52eb354c34420dc2963b7d51712`  
Status: **CHANGES REQUIRED — NOT READY TO MERGE**

## Verification

Implementer-reported: comparator tests 5/5 PASS; protocol/DCIR tests 31/31 PASS; frontend build PASS; canonical preflight PASS (4/4, 131 modules/files); browser NOT RUN by explicit user handoff.

Reviewer-independent: inspected branch/merge base, Spec 049, exact implementation diff, modal integration, comparator/tests, frontend protocol types, backend signature generation, protocol-target resolution, and analysis-cache key. I did not independently run tests, build, preflight, or browser. No GitHub CI run/status is attached to `eec4371`.

## Findings

### R1 — High: Protocol signature upgrade can orphan persisted targets and make warm/cold results disagree

Affected files:
- `backend/app/services/protocol.py`
- `backend/app/services/analysis_engine.py`
- `backend/app/services/analysis_cache.py`
- `frontend/src/features/analyses/editor/protocol/ProtocolSegmentsPanel.tsx`

**Current**

The cumulative dependency `8df9c963` changes the protocol hash payload/version (`PROTOCOL_SIGNATURE_VERSION = 3`), so existing protocols receive new hashes. Persisted protocol/DCIR targets remain exact `(protocol_signature, step_indices)` references. Compute paths reconstruct the current hash and perform literal lookup; the editor presents unmatched stored hashes as unavailable/not in samples. There is no legacy alias/migration layer.

`CALC_VERSION` also remains `1.6.1`, and the analysis cache key does not include the protocol-signature algorithm version. A pre-upgrade cache hit can therefore preserve an old result while a later cold recompute fails to resolve the same persisted target.

**Target**

Preserve persisted target meaning across protocol-signature upgrades and invalidate/separate cache generations whenever target-resolution semantics change. Prefer version-aware legacy-signature resolution; if migration is used, it must deterministically preserve offline/portable analyses.

**Acceptance criteria**

- Regression fixture with pre-upgrade saved protocol + DCIR/Steps targets.
- After upgrade, legacy targets resolve to the same source-local steps and do not become unavailable solely because the signature version changed.
- Cover Cycles filtering, Steps, and DCIR resolution.
- Verify legacy warm-cache and cache-cleared recompute give the same scientific result, or deterministically invalidate the legacy cache.

### R2 — High: Frontend C-rate equality is looser than backend semantic normalization

Affected files:
- `frontend/src/features/analyses/editor/protocol/protocolComparability.ts`
- `frontend/tests/protocolComparability.test.ts`

**Current**

Backend semantic normalization uses 2% relative tolerance. Frontend `numberEqual()` scales by `max(1, |a|, |b|)`, creating an absolute ~0.02 C window below 1C. It can therefore mark materially different low rates as `Same` (for example C/3 vs 0.35C or 0.10C vs 0.119C) even though backend identity keeps them distinct.

**Target**

Compare the same normalized semantic C-rate contract as the backend; do not maintain an independently drifting tolerance rule. Absolute-current-controlled steps remain current-controlled.

**Acceptance criteria**

- Tests on both sides of the backend normalization boundary.
- Backend-equivalent rates are `Same`; backend-distinct rates are `Different` in Workflow/Custom when rates are selected.
- Include a sub-1C regression demonstrating the absolute-window bug is gone.

### R3 — High: Workflow comparison omits behavior-changing condition values and jump destinations

Affected files:
- `frontend/src/features/analyses/editor/protocol/protocolComparability.ts`
- `frontend/tests/protocolComparability.test.ts`

**Current**

Workflow is specified to compare ordered flow/control conditions. `conditionToken()` omits `condition.value` entirely and omits `jump_step` outside Strict mode. A changed threshold or changed jump target can therefore still produce `structure = Same` / `Comparable workflow` despite changing protocol behavior.

**Target**

Include all behavior-relevant condition properties in Workflow. If raw jump step numbers are source-local, normalize destinations structurally instead of discarding them.

**Acceptance criteria**

- Workflow test differing only in condition value => `Different` / not comparable.
- Workflow test differing only in jump destination => `Different` / not comparable.
- Structural normalization avoids requiring identical raw step numbering where inappropriate.

### R4 — Medium: Evidence can say `Different` while showing identical reference/candidate summaries

Affected files:
- `frontend/src/features/analyses/editor/protocol/protocolComparability.ts`
- `frontend/tests/protocolComparability.test.ts`
- `frontend/src/features/analyses/editor/protocol/ProtocolSegmentsPanel.tsx`

**Current**

Equality tokens contain more detail than displayed summaries. Example: changing loop repeat count makes structure `Different`, but both evidence cells can still show only the same executable-step/block counts. Rate/timing summaries similarly collapse ordered schedules into compact unique lists.

**Target**

When a dimension differs, visible evidence must expose the responsible difference while remaining compact (for example first differing block/step with units).

**Acceptance criteria**

- Every focused `Different` regression displays distinguishable reference/candidate evidence.
- Cover changed loop count, rate schedule/order, and timing.
- Preserve units, `Unavailable`, and visible `Ignored` rows.

### R5 — Medium: Custom mode succeeds when zero dimensions are selected

Affected files:
- `frontend/src/features/analyses/editor/protocol/protocolComparability.ts`
- `frontend/src/features/analyses/editor/protocol/ProtocolSegmentsPanel.tsx`
- `frontend/tests/protocolComparability.test.ts`

**Current**

All Custom checkboxes can be cleared. Then every row is `Ignored`, no differing dimension exists, and `comparable` becomes `true` even though nothing was compared.

**Target**

Zero selected dimensions must be indeterminate/fail closed, not successful.

**Acceptance criteria**

- Focused zero-dimension Custom test.
- `comparable` is not true and UI shows neutral guidance rather than success.
- Selecting any dimension restores normal behavior without mutating analysis targets.

## Confirmed boundaries

The modal is read-only; both selector entry points exist; icon actions have tooltip/`aria-label`; active family initializes the reference; one-family/unavailable states fail closed; ignored rows remain visible; Spec 049 adds no API route/migration/source mutation. Browser verification remains intentionally delegated to the user and is not a finding in this round.

## Decision

**CHANGES REQUIRED — NOT READY TO MERGE.** R1 is the cumulative scientific-identity blocker. R2/R3 can yield false positive Workflow matches. R4/R5 are localized comparator defects. Request fixes for **R1–R5**, then re-review each against its Target and Acceptance criteria.
