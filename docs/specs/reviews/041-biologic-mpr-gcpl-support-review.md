# Review 041 — BioLogic MPR / GCPL support

**Parent specification:** [`../041-biologic-mpr-gcpl-support.md`](../041-biologic-mpr-gcpl-support.md)  
**Branch:** `feature/biologic-mpr-gcpl-support`  
**Merge base:** `main@aca39740039b4d7146afc9104f5c471bff7c7c46`  
**R1 implementation checkpoint:** `33b0efea55ed89e9b7dd18206f57f92d5cda63cc`  
**R2 implementation checkpoint:** `ef4c8d113b0137324e1f4ba4106ad8c59fa5ecb3`  
**Initial user-amendment checkpoint:** `befc0863de5b616d8d08de180afe8d909a9d8252`  
**R3/R4 implementation checkpoint:** `29952b5b7d685897bc04f20ed605523345e95cab`  
**R4/R5 correction checkpoint:** `08381a5e5a94fdd0fdda9b1e9cc0fa1bc411aa3a`  
**Neutral-preamble implementation checkpoint reviewed:** `51deb8e25d54ef5dd42e86cd0d9a6886b55a138a`  
**Returned handoff head reviewed:** `4e10d1b88910322314ad56b19d0e5620d7254dd3`  
**Status:** **CHANGES REQUIRED — R6/R7; MPR/MPT PARITY DEFERRED**

This is the cumulative Parent 041 review. R1-R5 are resolved. The 2026-08-15 user amendment added one narrow cycle-identity exception for a declared, non-repeating charge/rest-only or discharge/rest-only MPR when decoded rows prove constant-zero half-cycle, monotonic `Ns`, one signed active-current direction and at least one active row. The inferred cycle `1` is source-local only.

On 2026-08-16 the user explicitly amended the closure scope again: same-experiment `.mpr` / `.mpt` parity is deferred to later work and must **not** block Parent 041 closure or merge. No MPR/MPT numerical-parity claim is made by this feature.

The user then supplied a real GCPL discharge file that exposed a concrete parser bug: EC-Lab retained a neutral zero-current setup/control sequence before the active discharge even though the recorded data begins at the discharge sequence. The implementer returned `51deb8e25d54ef5dd42e86cd0d9a6886b55a138a`, which permits a header-proven zero-current control/setup preamble while continuing to validate decoded execution before source-local cycle-1 promotion. Static re-review found two follow-up defects, R6 and R7 below.

The reviewer used the live GitHub branch and performed static connector inspection only. The reviewer did **not** execute tests, preflight, builds, packaged-app smoke, browser/manual checks, private MPR parsing, or MPR/MPT parity during this review round.

## Confirmed cumulative behavior

The following parent-level properties remain consistent with the locked design:

- The production MPR reader remains independently authored, bounded and limited to the independently observed 16-ID / 53-byte GCPL record layout; the synthetic-only 15-ID / 49-byte variant remains rejected.
- `.mpr` remains admitted through the central source-format registry and `.mpt` remains excluded as a user import format.
- Three-electrode voltage roles and signed Ewe/Ece handling remain explicit.
- Metadata-only continuation acknowledgement remains content-hash bound.
- Cell Database list summaries remain relational and bounded.
- Generic scientific compute, saved-artifact, warmup and portable-export capability guards remain format-neutral.
- The R1 saved-artifact/warmup fail-closed boundary remains present.
- The R2 live capability guard remains scalar/header-free on cache-hit/artifact/warmup paths.
- Generic Time/Capacity voltage selection and saved/export/portable presentation remain format-neutral; no BioLogic-specific downstream scientific calculation branch was added.
- No relational migration or `CALC_VERSION` bump was introduced.
- Runtime requirements still do not add a GPL BioLogic parser dependency.
- `main` remains at merge base `aca39740039b4d7146afc9104f5c471bff7c7c46`.
- At the reviewed checkpoint the MPR adapter identity is still `bm:gcpl7:r1`; `bm:gcpl5:r1` and `bm:gcpl6:r1` are legacy/reinspection-only identities.
- The constant-zero half-cycle requirement is enforced before the single-direction fallback; non-zero or regressing half-cycle values remain rejected.
- Source-local cycle numbering is compatible with the generic stitcher: each source's local cycle labels are remapped densely to cell/test-global cycles while `source_cycle` preserves the local label.
- Legacy BioLogic reinspection runs from the post-listening scientific warmup thread rather than delaying API reachability.
- The neutral-preamble code does not turn unresolved executed control rows into a guessed electrochemical direction: row-level current/mode/block validation remains fail-closed.

## Finding status

### R1 — RESOLVED: retired gcpl3 saved artifacts are no longer live after metadata-only downgrade

The generic canonical-cycling guard applies before saved-artifact signature/cache access and across warmup discovery, task admission and late completion. Retired scientific bytes may remain for forensic cleanup but are not live.

### R2 — RESOLVED: live capability guards no longer materialize deferred `header_meta`

The generic capability path uses persisted scalar identity/status/error state with `include_header=False`; header-aware behavior remains limited to reconciliation/presentation paths that genuinely need persisted header evidence.

### R3 — RESOLVED: settings eligibility is provisional until decoded-row verification succeeds

The `gcpl7` implementation separates header eligibility from verified canonical capability. Header-only inspection remains record-decode-free and advertises a bounded pending state rather than claiming canonical rows already exist. Pending candidates proceed through preparation while scientific consumers fail closed until full-parse promotion; failed proof persists metadata-only/noncanonical state.

### R4 — RESOLVED: declared/raw direction and legacy gcpl6 upgrade boundaries fail closed completely

The mapper validates observed execution against declared per-`Ns` single-direction semantics. Declared charge cannot be satisfied by discharge rows, declared discharge cannot be satisfied by charge rows, and active execution on declared Rest is rejected. Offline/missing-path `gcpl5`/`gcpl6` registrations are database-only downgraded so stale row/cycle/capacity summaries cannot remain live; online legacy sources are re-inspected through the current parser.

### R5 — RESOLVED: 041.6 closure record matched the gcpl7 amendment state at the prior checkpoint

The implementation record correctly preserved the historical `gcpl5 → gcpl6 → gcpl7` evolution and the R3/R4 verification boundary before the newly supplied real-file bug was addressed.

### R6 — HIGH — OPEN: neutral-preamble semantic change reuses `gcpl7`, stranding existing failed `gcpl7` registrations

**Affected files**

- `backend/app/services/biologic_gcpl.py`
- `backend/app/services/parsing.py`
- `backend/app/services/scanner.py`
- focused BioLogic upgrade/reinspection regression tests
- 041.6 implementation/provenance record

**Current**

`51deb8e25d54ef5dd42e86cd0d9a6886b55a138a` changes canonical parser semantics: a source shape that the previous `gcpl7` implementation rejected as metadata-only can now become canonical when its zero-current control/setup preamble is header-proven neutral and decoded execution satisfies the single-direction contract. However, `BIOLOGIC_GCPL_ADAPTER_REVISION` remains `gcpl7`.

That is not only a cache-labeling issue. A candidate that failed under the old rule is persisted by `mark_biologic_mpr_cycle_verification_failed()` using the **current parser identity**, i.e. `bm:gcpl7:r1`, with `requires_reinspection=False`. Startup `reinspect_legacy_biologic_sources()` only targets the explicit legacy set (`bm:gcpl5:r1`, `bm:gcpl6:r1`), while the generic identity bring-forward path only triggers when stored identity differs from the current expected identity. Therefore an already-registered real file rejected by the old `gcpl7` rule has no automatic upgrade signal after installing this fix: its row stays current-identity metadata-only even though the new parser would now promote it.

This violates the existing per-source parser-identity contract: the identity must advance when canonical parser output semantics change so persisted registrations/caches can be deterministically brought forward without silently reusing an old semantic boundary.

**Target**

Advance the BioLogic adapter identity for this semantic change (expected next identity: `gcpl8`) and treat `bm:gcpl7:r1` as a prior identity requiring bounded upgrade handling. Online prior-`gcpl7` sources must pass the current header/full-parse path before receiving the new identity. Offline/missing sources must fail closed without leaving parser-derived row/cycle/capacity summaries live. Historical `gcpl7` cache bytes may remain as historical/relinkable artifacts but must not satisfy current-cache/provenance checks.

Do **not** bump `CALC_VERSION` solely for this parser-semantic change; parser identity is the correct cache/provenance dimension unless the meaning of downstream calculated output changes independently.

**Acceptance criteria**

- `BIOLOGIC_GCPL_ADAPTER_REVISION` advances from `gcpl7` to a new revision and current identity changes accordingly.
- `bm:gcpl7:r1` is explicitly covered by the prior-identity reconciliation/reinspection policy.
- A regression creates an online persisted metadata-only `bm:gcpl7:r1` registration representing the neutral-preamble file rejected by the old rule, runs the normal upgrade path, and proves it is re-read under the new parser, promoted to canonical capability, and receives the new parser identity.
- Offline/missing-path `bm:gcpl7:r1` registrations are fail-closed and cannot expose stale row/cycle/capacity summaries; they remain relinkable without destructive cache/source deletion.
- Any previously canonical `gcpl7` registration is likewise considered stale/current-parser-mismatched and is rebuilt/revalidated before publishing under the new identity.
- Old `gcpl7` caches are not treated as current `gcpl8` scientific caches or provenance.
- Focused upgrade tests and canonical preflight pass and are recorded against the exact implementation checkpoint.

### R7 — MEDIUM — OPEN: active closure records resurrect the user-deferred MPR/MPT gate

**Affected files**

- `docs/specs/041-biologic-mpr-gcpl-support.md`
- `docs/specs/041.6-scientific-regression-real-file-parity-and-closure.md`
- durable BioLogic support documentation where it still states the old closure boundary (including `AGENTS.md` / `docs/biologic-mpr-format.md` as applicable)
- new workflow handoffs/implementation record

**Current**

The user explicitly deferred same-experiment `.mpr`/`.mpt` parity on 2026-08-16 and the cumulative Parent 041 review already records that it is no longer a closure blocker. Nevertheless, the returned 041.6 record still says Parent 041 “remains blocked from final closure” until a paired `.mpt` is available, and the latest implementer handoff repeats the same obsolete blocker. The parent spec itself already permits this requirement to be removed by explicit user amendment.

This creates two conflicting authoritative instructions for the next coding/review agent and can incorrectly prevent Parent 041 completion after R6 is fixed.

**Target**

Persist the 2026-08-16 user amendment in the active Parent 041/041.6 specification and durable support record. Keep `MPR/MPT semantic parity: NOT RUN` truthful and preserve the limitation that Parent 041 makes no general multi-cycle parity claim, but remove the pair as a closure/merge gate for this parent. General/repeating multi-cycle MPR expansion belongs to later work with its own validation requirement.

Historical append-only coordination entries may remain unchanged as historical statements; new/current decision text must not present the old gate as active.

**Acceptance criteria**

- No current authoritative Parent 041/041.6 decision or ground-truth section says Parent 041 is blocked solely by the absent `.mpt` pair.
- Current docs explicitly state: parity was not run; no general multi-cycle parity claim is made; the user deferred that validation to later work; the missing pair is not a Parent 041 merge blocker.
- Durable support wording acknowledges the narrow verified single-direction/source-local-cycle-1 exception rather than globally describing all current MPR as metadata-only.
- Future general/repeating multi-cycle support is clearly left for later work rather than implicitly certified by this amendment.
- The next implementer → reviewer handoff uses the amended closure rule.

## MPR/MPT parity — DEFERRED BY USER, no longer a Parent 041 closure gate

The original Parent 041 acceptance criteria required a privacy-approved same-experiment `.mpr` / `.mpt` pair for general multi-cycle semantic parity. That validation was never run because no matching `.mpt` was available.

On 2026-08-16 the user explicitly deferred that work to a later implementation. Therefore:

- MPR/MPT semantic parity remains truthfully **NOT RUN**;
- no parity claim is made for general multi-cycle GCPL semantics;
- the currently implemented narrow charge-only/discharge-only source-local cycle-1 support remains bounded by decoded-row proof and regressions;
- absence of a paired `.mpt` is **not** a blocker for closing or merging Parent 041;
- future expansion to general/repeating multi-cycle MPR support must establish its own scientific validation requirements.

## Verification record

### Implementer-reported for R3/R4 checkpoint `29952b5b7d685897bc04f20ed605523345e95cab`

- Focused R3/R4 suites: reported PASS — 172 tests.
- `python scripts\preflight.py --no-cache`: reported PASS — 5/5; all 68 backend modules, 541 frontend tests, TypeScript type check and Vite production bundle passed.
- MPR/MPT semantic parity: **NOT RUN**.
- Browser/manual feature verification: NOT RUN.

### Implementer-reported for R4/R5 correction checkpoint `08381a5e5a94fdd0fdda9b1e9cc0fa1bc411aa3a`

- Focused R4/R5 suites: reported PASS — 172 tests.
- `python scripts\preflight.py --no-cache`: reported PASS — 5/5; all 68 backend modules, 541 frontend tests, TypeScript type check and Vite production bundle passed.
- MPR/MPT semantic parity: **NOT RUN**.
- Browser/manual feature verification: NOT RUN.

### Implementer-reported for neutral-preamble checkpoint `51deb8e25d54ef5dd42e86cd0d9a6886b55a138a`

- Focused parser/import/continuation suite: reported PASS — **173 tests**.
- `python scripts\preflight.py --no-cache`: reported PASS — **5/5** after the elevated Windows Vite build; 68 backend modules, 541 frontend policy tests, TypeScript and production bundle passed.
- Private `BB_eNargiZinc_Discharge-OD19_04_GCPL6_C16.mpr`: reported PASS through production header/full canonical parse, isolated cache build and temporary registration; 5,483 rows, one source-local discharge/rest cycle, canonical capability promoted.
- Private four-part stitch (`04`, `06`, `08`, `10`): reported PASS — 15,700 raw rows, four dense global cycles, no missing segments, 1,002.932626 mAh total discharge capacity.
- MPR/MPT semantic parity: **NOT RUN**.
- Browser/manual feature verification: NOT RUN.

Historical earlier checkpoint verification remains historical evidence and is not restated as proof of the current implementation.

### Reviewer independently inspected in this round

- Current `main` head and merge base.
- Exact implementation delta `51deb8e25d54ef5dd42e86cd0d9a6886b55a138a` and returned handoff head `4e10d1b88910322314ad56b19d0e5620d7254dd3`.
- `_single_direction_protocol_direction()` neutral-control predicate.
- Full-map per-`Ns` declared execution validation and downstream current/mode/block fail-closed behavior.
- New synthetic neutral-preamble regression.
- Current `BIOLOGIC_GCPL_ADAPTER_REVISION = "gcpl7"`.
- Candidate failure persistence under the current parser identity.
- Explicit legacy identity sets and `reinspect_legacy_biologic_sources()` query boundary.
- Generic current-identity bring-forward condition.
- Spec 040.3 parser-identity/cache/provenance invariant requiring an identity change when canonical parser semantics change.
- Active Parent 041, 041.6, AGENTS and BioLogic format documentation around parity/metadata-only support boundaries.
- Cumulative branch scope from the prior clean checkpoint to the returned handoff; no unrelated implementation subsystem was added by the bug fix.

### Reviewer did NOT independently execute

- Python/backend tests.
- Frontend policy tests.
- `scripts/preflight.py`.
- TypeScript/Vite build.
- Packaged Windows smoke.
- Browser/manual matrix.
- Private real-file parse/stitch.
- MPR/MPT semantic parity.

## Decision

**CHANGES REQUIRED — R6 and R7. Parent 041 is not ready to merge yet.**

The neutral-preamble mapping itself is a bounded correction for the supplied real discharge file, and the implementer reports successful production parse/cache/stitch verification. The blocking implementation defect is upgrade safety: the semantic widening currently reuses `gcpl7`, so existing `gcpl7` registrations that failed under the old rule can remain stranded metadata-only after upgrade. R6 must advance and reconcile the parser identity. R7 must make the current spec/documentation reflect the user's explicit parity deferral.

The missing `.mpr/.mpt` pair is **not** an open finding and is **not** a Parent 041 closure blocker. After R6/R7 return, resume `FINAL_REVIEW` from the new delta.