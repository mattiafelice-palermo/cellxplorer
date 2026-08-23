# Review: Spec 050 — runtime performance optimization

Status: **Final review — changes required**  
Branch: `feature/runtime-performance-optimization`  
Merge base with `main`: `1dc3525ec42571504ed6d9bdb9a0668d35df309b`  
Parent: [`../050-runtime-performance-optimization.md`](../050-runtime-performance-optimization.md)

## Cumulative review scope

Performed a fresh cumulative review of the complete branch after 050.15 against the verified merge base. GitHub comparison reports the branch **ahead by 152, behind by 0**; the merge base remains `1dc3525ec42571504ed6d9bdb9a0668d35df309b`.

All implemented numeric children are technically review-clean: 050.1–050.7 and 050.9–050.15. Numeric 050.8 remains intentionally withdrawn/reserved. Planning proto-children remain non-implementable and do not themselves block completion.

The previously accepted production architecture remains coherent after 050.15: indexed/selective raw access, dependency-aware Time/Capacity work elimination, bounded persistent whole-Cell Python processes with serial fallback, direct exact-cache-hit bypass, deterministic merge, compact ordinary Time payloads, and full-resolution scientific export remaining separate from display downsampling/refinement.

050.15 adds only the final ordinary-Time presentation/transport layer: compact source-table/index provenance, bounded overview density, ephemeral indexed adaptive zoom refinement, and a bounded 4/6/8 worker retune that retains four workers. Capacity optimization remains deliberately deferred.

## Accepted performance evidence

### 050.14 production route

Real saved `Performance analysis`, complete backend route, three warm repetitions:

| Workload | p50 | Execution |
| --- | ---: | --- |
| 1 Cell, cycles 1–3, Time | 34.6 ms | serial |
| 6 Cells, Time All | 127.3 ms | process / 4 |
| 10 Cells, Time All | 160.8 ms | process / 4 |
| 11 Cells, Time All | 175.5 ms | process / 4 |
| 6 Cells, Capacity All | 231.1 ms | process / 4 |

The representative six-Cell broad Time route therefore improved from roughly 4.42 s early in Spec 050 to roughly 127 ms in the production architecture (~35× faster).

### 050.15 transport/refinement

- Compact provenance reduced broad ordinary Time response bytes by about **72–74%** while staying within the locked route-latency gate.
- Overview density remains at multiplier 12 because browser visual validation was not run.
- 4 workers remain production; 6 did not clear the speed gate and 8 also exceeded the locked RSS gate.
- Focused six-Cell S25 adaptive refinement, three warm repetitions:

| viewport | backend p50 | response bytes | overview-visible → refined-visible points/Cell | resolution gain | mode |
| --- | ---: | ---: | ---: | ---: | --- |
| 25% | 248.65 ms | 824,567 | 601 → 3,852 | 6.41× | process |
| 10% | 227.98 ms | 743,644 | 244 → 3,548 | 14.54× | process |
| 2% | 293.80 ms | 296,361 | 50 → 1,456 | 29.12× | serial |

Adaptive refinement is ephemeral, stale-safe, bounded to indexed candidate cycles, aligned to the overview's canonical consecutive-Time coordinate, and not used for persistent cache identity or full-resolution data export.

## Scientific/cache/migration closure

- No SQLite migration is introduced by Spec 050.
- `CALC_VERSION` remains unchanged because scientific meaning is unchanged.
- Parser identity/canonical scientific semantics remain unchanged.
- Result/cache schema generations changed only where transport/cache shape required deterministic invalidation.
- Raw physical-layout generation is separate from scientific identity; 050.15 raw-layout v2 adds validated cumulative-Time reset facts needed for bounded later-cycle refinement.
- Exact persisted Time/Capacity overview cache hits still bypass raw/index/worker/scientific execution.
- Display density and adaptive refinement remain presentation-only; full/non-compact export remains the exact scientific path.
- Provenance, continuation/global/local cycle identity, voltage-channel semantics and deterministic Cell/source order remain covered by focused/parity tests.
- No production Rust dependency was adopted for ordinary Time/Capacity.

## Verification record

Implementer-reported accepted final 050.15 verification:
- R1–R3 focused backend tests: PASS (29)
- R2–R3 focused frontend tests: PASS (16)
- focused S25 refinement benchmark: PASS (16.49 s; 25% / 10% / 2%, three warm repetitions)
- frontend type check and Vite build: PASS
- canonical preflight: PASS (4/4 stages, 151 files/modules; 84.24 s)
- browser/manual checks: NOT RUN (user requested no browser)

Reviewer verification for this final round was code/document reading through the GitHub connector. I did **not** rerun the implementer's commands and do not claim browser/manual validation.

## Findings

### R1 — Low: parent/proto status documentation still describes the pre-050.12 roadmap

Affected files:
- `docs/specs/050-runtime-performance-optimization.md`
- `docs/specs/050.15-time-overview-transport-and-adaptive-zoom.md`
- `docs/specs/050.P4-interactive-plot-density-and-adaptive-zoom-benchmark.md`

**Current**

The parent header still says `050.9 active; 050.10-050.11 scheduled`, its roadmap stops at 050.11, and its P4 section still describes adaptive zoom as wholly planning-only. In reality 050.12–050.15 are implemented/review-clean and 050.15 explicitly promotes the adaptive-zoom portion of P4. The 050.15 status line also still says `Implementation ready for review` after the child was reviewed clean.

This is not a runtime defect, but leaving it would make the repository's durable agent-facing roadmap materially misleading and could cause a later agent to re-plan/re-implement already completed work.

**Target**

Make the Spec 050 documentation reflect the final branch without rewriting historical evidence:

- mark 050.1–050.7 and 050.9–050.15 review-clean / completed as appropriate;
- add concise outcome entries for 050.12–050.15, including that 050.14 productionized the selected ordinary Time architecture and 050.15 compacted transport + added adaptive viewport refinement while retaining four workers and density multiplier 12;
- keep 050.8 explicitly withdrawn/reserved;
- update the P4 description so it is clear the on-demand adaptive-zoom portion was promoted/implemented by 050.15 while any genuinely unimplemented Plotly/fixed-density/reservoir experiments remain planning-only;
- mark 050.15 itself review-clean.

Do not change implementation code, rerun performance matrices, remove historical benchmark evidence, or broaden scope.

**Acceptance criteria**

- A new agent reading the parent can identify every implemented numeric child through 050.15 and the final production architecture without relying on chat history.
- No text calls 050.9 active or 050.10/050.11 scheduled.
- P4 no longer implies that on-demand adaptive zoom is wholly unimplemented.
- 050.15 status is review-clean.
- Documentation-only validation is sufficient (`git diff --check`); do not rerun preflight for this finding.

## Merge/readiness status

Implementation and verification are technically clean. **Not yet marked COMPLETE solely because R1 documentation closure is open.** Once R1 is resolved, no additional performance implementation or benchmark round is expected before merge readiness.
