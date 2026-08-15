# Review 041 — BioLogic MPR / GCPL support

**Parent specification:** [`../041-biologic-mpr-gcpl-support.md`](../041-biologic-mpr-gcpl-support.md)  
**Branch:** `feature/biologic-mpr-gcpl-support`  
**Merge base:** `main@aca39740039b4d7146afc9104f5c471bff7c7c46`  
**Prior implementation-review checkpoint:** `08381a5e5a94fdd0fdda9b1e9cc0fa1bc411aa3a`  
**Neutral-preamble implementation checkpoint:** `51deb8e25d54ef5dd42e86cd0d9a6886b55a138a`  
**R6 implementation checkpoint:** `a77315b70f55474301ade3d2ce8b9ed6a45a0f68`  
**R7 documentation checkpoint:** `de31710823499e0e466bd3436cb5404eb2d54fa5`  
**Final handoff head reviewed:** `ecef6d833a59b4f4f1f1973c61826ca376b56d8e`  
**Status:** **FINAL REVIEW CLEAN — READY TO MERGE**

This is the cumulative Parent 041 review. R1-R7 are resolved. No open implementation or documentation finding remains.

On 2026-08-16 the user explicitly deferred same-experiment `.mpr` / `.mpt` parity to later work. It remains truthfully **NOT RUN**, no general/repeating multi-cycle parity claim is made, and the absent pair is **not** a Parent 041 closure or merge blocker.

The supplied real GCPL discharge file established one bounded extension to the single-direction source-local cycle-1 exception: EC-Lab may retain a neutral zero-current setup/Control sequence before the active discharge while the recorded rows begin at the discharge sequence. The implementation accepts only a header-proven zero-current setup/control preamble and still requires decoded execution to satisfy the single-direction proof before canonical promotion.

The reviewer used the live GitHub branch and performed static connector inspection only. The reviewer did **not** independently execute tests, preflight, builds, packaged-app checks, browser/manual checks, private-file parsing/stitching, or MPR/MPT parity.

## Confirmed cumulative behavior

- Production MPR decoding remains limited to the independently observed 16-ID / 53-byte GCPL record layout; the synthetic-only 15-ID / 49-byte layout remains unsupported.
- `.mpr` is centrally admitted; `.mpt` remains validation-only rather than a user import format.
- Three-electrode Ewe/Ece roles and signed working-minus-counter primary voltage remain explicit.
- Metadata-only continuation acknowledgement remains content-hash bound.
- Cell Database list summaries remain relational and bounded.
- Generic compute, saved-artifact, warmup and portable-export capability guards remain format-neutral and fail closed.
- No relational migration or `CALC_VERSION` bump was introduced.
- No GPL BioLogic parser runtime dependency was introduced.
- Current BioLogic adapter identity is `bm:gcpl8:r1`.
- `bm:gcpl5:r1`, `bm:gcpl6:r1`, and `bm:gcpl7:r1` are reinspection-only identities.
- Online legacy BioLogic sources pass the current source-reading path before receiving `gcpl8`; offline/missing sources are database-only downgraded so parser-derived row/cycle/capacity summaries cannot remain live.
- Historical prior-identity cache bytes may remain but cannot satisfy the current parser identity.
- Constant-zero half-cycle, monotonic `Ns`, one signed active-current direction, declared/executed direction agreement and no repeat loop remain part of the single-direction proof.
- Ordinary non-active settings sequences are Rest; a setup/Control sequence may be ignored for direction classification only when its normalized current is proven zero within tolerance and it contributes no unresolved active direction.
- Non-zero/unresolved Control semantics, mixed direction, loops/repeats, non-monotonic execution and failed decoded-row proof remain fail-closed.
- Source-local cycle `1` remains a plotting/stitching label, not an absolute experiment cycle number.
- General/repeating multi-cycle MPR semantics remain outside the currently proven support boundary.

## Finding status

### R1 — RESOLVED: retired parser saved-artifact/warmup capability leak

Saved artifact, thumbnail and warmup boundaries apply the canonical-cycling capability guard before old cache/artifact bytes can remain live.

### R2 — RESOLVED: generic capability guard N+1/deferred-header load

Live capability checks use bounded persisted scalar state with `include_header=False`; they do not materialize deferred `header_meta` per source.

### R3 — RESOLVED: header-only single-direction eligibility is provisional

Header inspection records a pending candidate rather than claiming canonical rows. Full decoded-row verification promotes the source; failed proof persists fail-closed metadata-only capability.

### R4 — RESOLVED: declared/raw direction and offline legacy-summary safety

Declared per-`Ns` charge/discharge/rest semantics are checked against decoded execution, and offline/missing prior-parser registrations cannot retain live parser-derived capacity summaries.

### R5 — RESOLVED: 041.6 implementation record tracked the live parser boundary

The closure record was brought forward through the candidate/verified parser boundaries and exact verification checkpoints.

### R6 — RESOLVED: neutral-preamble semantic widening has a new parser identity and upgrade path

Checkpoint `a77315b70f55474301ade3d2ce8b9ed6a45a0f68` advances the adapter from `gcpl7` to `gcpl8` and adds `bm:gcpl7:r1` to the explicit legacy/reinspection set.

The focused migration regression recreates the prior hole: an online neutral-preamble source is rewritten into the old persisted metadata-only `bm:gcpl7:r1` state with no reinspection marker, then the normal legacy path re-reads and promotes it to parsed/canonical `bm:gcpl8:r1`, creates current caches and preserves the historical `gcpl7` cache bytes. A separate regression proves an offline `bm:gcpl7:r1` source is downgraded database-only, clears row/cycle/capacity summaries, requires reinspection, preserves historical bytes and does not fabricate a current cache.

No `CALC_VERSION` bump is required for this parser-semantic change; parser identity is the correct cache/provenance dimension.

### R7 — RESOLVED: Parent 041 now matches the supported neutral setup/Control contract and parity deferral

Checkpoint `de31710823499e0e466bd3436cb5404eb2d54fa5` updates the authoritative Parent 041 single-direction amendment so it no longer contradicts the real-file behavior:

- active charge/discharge sequences must resolve to one direction;
- ordinary non-active sequences remain Rest;
- a setup/Control sequence is allowed only when normalized current is proven zero within tolerance and it contributes no unresolved active direction;
- unresolved C-rate direction, non-zero/unresolved Control direction, loops/repeats and the existing decoded-row failure conditions remain unsupported.

The active Parent 041, 041.6, AGENTS, BioLogic-format and agent-knowledge documentation now consistently record that MPR/MPT parity is NOT RUN/deferred and is not a Parent 041 merge blocker.

## MPR/MPT parity — DEFERRED BY USER

Current truth is:

- `MPR/MPT semantic parity: NOT RUN`;
- no general/repeating multi-cycle parity claim;
- absence of a paired `.mpt` does not block Parent 041 closure or merge;
- future general/repeating multi-cycle MPR support must establish its own scientific validation gate.

## Verification record

### Implementer-reported for neutral-preamble checkpoint `51deb8e25d54ef5dd42e86cd0d9a6886b55a138a`

- Focused parser/import/continuation suite: PASS — 173 tests.
- `python scripts\preflight.py --no-cache`: PASS — 5/5; 68 backend modules, 541 frontend policy tests, TypeScript and Vite production bundle.
- Private `BB_eNargiZinc_Discharge-OD19_04_GCPL6_C16.mpr`: PASS through production header/full parse/cache/temp registration; 5,483 rows, one source-local discharge/rest cycle, canonical promotion.
- Private four-part stitch (`04`, `06`, `08`, `10`): PASS — 15,700 raw rows, four dense global cycles, no missing segments, 1,002.932626 mAh total discharge capacity.
- MPR/MPT semantic parity: NOT RUN.
- Browser/manual feature verification: NOT RUN.

### Implementer-reported for R6 checkpoint `a77315b70f55474301ade3d2ce8b9ed6a45a0f68`

- Focused BioLogic GCPL/closure suite: PASS — 64 tests.
- `python scripts\preflight.py --no-cache`: PASS — 5/5; 68 backend modules, 541 frontend policy tests, TypeScript and Vite production bundle.
- Private four-part MPR stitch evidence remains PASS — 15,700 raw rows, four dense global cycles, no missing segments, 1,002.932626 mAh total discharge capacity.
- MPR/MPT semantic parity: NOT RUN and explicitly deferred.
- Browser/manual feature verification: NOT RUN.

### Implementer-reported for R7 checkpoint `de31710823499e0e466bd3436cb5404eb2d54fa5`

- Documentation-only follow-up; no production or test code changed.
- Prior R6 verification remains the latest code-verification evidence.
- MPR/MPT semantic parity: NOT RUN and explicitly deferred.
- Browser/manual feature verification: NOT RUN.

### Reviewer independently inspected

- `main` remains `aca39740039b4d7146afc9104f5c471bff7c7c46` and remains the feature merge base.
- Exact neutral-preamble implementation `51deb8e25d54ef5dd42e86cd0d9a6886b55a138a`.
- Exact R6 implementation `a77315b70f55474301ade3d2ce8b9ed6a45a0f68` and its parser-identity/reinspection regressions.
- Exact R7 documentation change `de31710823499e0e466bd3436cb5404eb2d54fa5`.
- Final implementer handoff head `ecef6d833a59b4f4f1f1973c61826ca376b56d8e`.
- Current `gcpl8` parser identity and explicit legacy set through `gcpl7`.
- Online/offline legacy reinspection behavior.
- Neutral setup/control direction predicate and decoded-row fail-closed boundary.
- Parent 041 and 041.6 support/parity wording.
- AGENTS, canonical-cycling knowledge, state/performance knowledge and BioLogic-format documentation touched by R6/R7.
- Branch delta from the reviewer R6/R7 handoff contained only the intended parser-identity migration, focused regressions, workflow/spec and documentation changes; the final R7 return was documentation/workflow only.

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

**FINAL REVIEW CLEAN — READY TO MERGE.**

R1-R7 are resolved. The current implementation is bounded to the supported GCPL-family MPR contract, the real single-direction neutral-preamble case has a reproducible `gcpl8` parser/provenance boundary, prior parser identities fail closed or re-inspect correctly, and the durable documentation matches the implemented support boundary.

The paired `.mpr/.mpt` validation is deferred future work by explicit user decision and is not part of the Parent 041 merge decision.