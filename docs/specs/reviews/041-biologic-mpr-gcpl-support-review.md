# Review 041 — BioLogic MPR / GCPL support

**Parent specification:** [`../041-biologic-mpr-gcpl-support.md`](../041-biologic-mpr-gcpl-support.md)  
**Branch:** `feature/biologic-mpr-gcpl-support`  
**Merge base:** `main@aca39740039b4d7146afc9104f5c471bff7c7c46`  
**Prior implementation-review checkpoint:** `08381a5e5a94fdd0fdda9b1e9cc0fa1bc411aa3a`  
**Neutral-preamble implementation checkpoint:** `51deb8e25d54ef5dd42e86cd0d9a6886b55a138a`  
**R6/R7 returned implementation checkpoint:** `a77315b70f55474301ade3d2ce8b9ed6a45a0f68`  
**Returned handoff head reviewed:** `9897e88a935511eab8d8fdbb85b19f625703ca06`  
**Status:** **CHANGES REQUIRED — R7 ONLY; MPR/MPT PARITY DEFERRED**

This is the cumulative Parent 041 review. R1-R6 are resolved. One documentation/specification mismatch remains in R7.

On 2026-08-16 the user explicitly deferred same-experiment `.mpr` / `.mpt` parity to later work. It remains truthfully **NOT RUN**, no general/repeating multi-cycle parity claim is made, and the absent pair is **not** a Parent 041 closure or merge blocker.

The supplied real GCPL discharge file also established one additional bounded case for the single-direction cycle-1 exception: EC-Lab may retain a neutral zero-current setup/control sequence before the active discharge while the recorded rows begin at the discharge sequence. The implementation accepts only a header-proven zero-current setup/control preamble and still requires the decoded execution to satisfy the single-direction proof before canonical promotion.

The reviewer used the live GitHub branch and performed static connector inspection only. The reviewer did **not** execute tests, preflight, builds, packaged-app checks, browser/manual checks, private-file parsing/stitching, or MPR/MPT parity.

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
- The neutral setup/control allowance does not make executed unresolved/non-zero control blocks acceptable; row-level execution remains fail-closed.
- Source-local cycle `1` remains a plotting/stitching label, not an absolute experiment cycle number.

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

The closure record was brought forward through the `gcpl7` candidate/verified boundary and its exact verification checkpoints.

### R6 — RESOLVED: neutral-preamble semantic widening now has a new parser identity and upgrade path

**Reviewed implementation:** `a77315b70f55474301ade3d2ce8b9ed6a45a0f68`.

The adapter advances from `gcpl7` to `gcpl8`, and `bm:gcpl7:r1` joins the explicit legacy/reinspection set. Startup `reinspect_legacy_biologic_sources()` therefore handles the old identity rather than treating it as current.

The focused regression recreates the exact migration hole: an online neutral-preamble source is first registered under current `gcpl8`, then deliberately rewritten into the old persisted metadata-only `bm:gcpl7:r1` state with no reinspection marker. The normal legacy reinspection path re-reads it, promotes it to parsed/canonical `bm:gcpl8:r1`, creates current raw/cycle caches and leaves the historical `gcpl7` cache bytes intact. A separate regression proves an offline `bm:gcpl7:r1` source is downgraded database-only, clears row/cycle/capacity summaries, requires reinspection, retains historical cache bytes and has no fabricated `gcpl8` cache. fileciteturn544file0

The implementation does not bump `CALC_VERSION`; parser identity remains the correct provenance/cache dimension for this semantic change.

**R6 acceptance: satisfied.**

### R7 — MEDIUM — OPEN: Parent 041's single-direction amendment still contradicts the accepted neutral setup/control case

**Affected file**

- `docs/specs/041-biologic-mpr-gcpl-support.md`

**Current**

The parity-deferral portion of R7 is fixed: Parent 041, 041.6, AGENTS, BioLogic-format documentation and the new handoff correctly say MPR/MPT parity is NOT RUN, makes no general/repeating multi-cycle claim, and is not a current Parent 041 merge blocker. 041.6 also correctly records the supplied private MPR's neutral zero-current setup/control preamble and `gcpl8` behavior. fileciteturn549file0

However, the Parent 041 user-amendment bullets still define the single-direction exception as follows:

- all non-active sequences must be Rest; and
- the settings must not declare an unresolved C-rate/control direction.

That directly excludes the now-supported real-file case, whose sequence 1 is a header-proven zero-current **Control** setup/preamble before the active discharge. The same Parent section therefore contradicts both the reviewed implementation and 041.6. fileciteturn546file0

**Target**

Amend the Parent 041 single-direction rules so they describe the actual bounded contract:

- active charge/discharge sequences must still resolve to one direction;
- ordinary non-active sequences may be Rest;
- in addition, a setup/control sequence may be ignored for direction classification only when its decoded/normalized settings prove zero current within the existing tolerance and it contributes no unresolved active direction;
- non-zero or otherwise unresolved control semantics, mixed direction, loops/repeats, non-monotonic execution and failed row proof remain fail-closed;
- the source-local cycle-1 label remains non-absolute.

Do not weaken the row-level verification merely to make the prose match.

**Acceptance criteria**

- Parent 041 no longer states that every non-active sequence must be Rest when the supported neutral zero-current Control preamble is present.
- Parent 041 distinguishes the narrowly permitted zero-current setup/control preamble from an unresolved/non-zero control direction, which remains unsupported.
- Parent 041, 041.6 and durable BioLogic documentation describe one consistent single-direction support boundary.
- MPR/MPT parity remains NOT RUN/deferred and is not reintroduced as a Parent 041 blocker.
- No implementation change is required unless the documentation correction exposes a real code mismatch.

## MPR/MPT parity — DEFERRED BY USER

The original paired `.mpr` / `.mpt` gate has been explicitly amended by the user. Current truth is:

- `MPR/MPT semantic parity: NOT RUN`;
- no general/repeating multi-cycle parity claim;
- absence of a paired `.mpt` does not block Parent 041 closure or merge;
- future general/repeating multi-cycle MPR support must establish its own scientific validation gate.

Parent 041's paired-validation section now reflects this correctly. fileciteturn548file0

## Verification record

### Implementer-reported for neutral-preamble checkpoint `51deb8e25d54ef5dd42e86cd0d9a6886b55a138a`

- Focused parser/import/continuation suite: PASS — 173 tests.
- `python scripts\preflight.py --no-cache`: PASS — 5/5; 68 backend modules, 541 frontend policy tests, TypeScript and Vite production bundle.
- Private `BB_eNargiZinc_Discharge-OD19_04_GCPL6_C16.mpr`: PASS through production header/full parse/cache/temp registration; 5,483 rows, one source-local discharge/rest cycle, canonical promotion.
- Private four-part stitch (`04`, `06`, `08`, `10`): PASS — 15,700 raw rows, four dense global cycles, no missing segments, 1,002.932626 mAh total discharge capacity.
- MPR/MPT semantic parity: NOT RUN.
- Browser/manual feature verification: NOT RUN.

### Implementer-reported for R6/R7 checkpoint `a77315b70f55474301ade3d2ce8b9ed6a45a0f68`

- Focused BioLogic GCPL/closure suite: PASS — 64 tests.
- `python scripts\preflight.py --no-cache`: PASS — 5/5; 68 backend modules, 541 frontend policy tests, TypeScript and Vite production bundle.
- Private four-part MPR stitch evidence remains PASS — 15,700 raw rows, four dense global cycles, no missing segments, 1,002.932626 mAh total discharge capacity.
- MPR/MPT semantic parity: NOT RUN and explicitly deferred.
- Browser/manual feature verification: NOT RUN.

### Reviewer independently inspected this round

- `main` remains `aca39740039b4d7146afc9104f5c471bff7c7c46`.
- Exact R6/R7 implementation checkpoint `a77315b70f55474301ade3d2ce8b9ed6a45a0f68` and handoff head `9897e88a935511eab8d8fdbb85b19f625703ca06`.
- `BIOLOGIC_GCPL_ADAPTER_REVISION = "gcpl8"` and the current parser-identity grammar.
- Explicit addition of `bm:gcpl7:r1` to the legacy/reinspection set.
- Online/offline legacy reinspection path.
- Exact online prior-`gcpl7` metadata-only neutral-preamble migration regression.
- Exact offline prior-`gcpl7` fail-closed/relinkable regression.
- Current Parent 041 paired-validation amendment.
- Current 041.6 private real-file record, `gcpl8` identity and parity-deferral language.
- AGENTS/agent-knowledge/BioLogic-format documentation delta.
- Branch scope since the reviewer handoff: only the intended parser-identity migration, focused tests, workflow/spec/docs updates.

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

**CHANGES REQUIRED — R7 only. Parent 041 is not ready to merge yet.**

R6 is resolved: the neutral-preamble semantic change is now isolated behind `gcpl8`, with a bounded upgrade path for both online and offline `gcpl7` registrations. The remaining correction is documentation-only but authoritative: Parent 041 must update its own single-direction amendment rules to permit the exact header-proven zero-current Control preamble that 041.6 and the implementation now support.

The missing `.mpr/.mpt` pair is not an open finding and is not a Parent 041 blocker. Resume `FINAL_REVIEW` after R7.