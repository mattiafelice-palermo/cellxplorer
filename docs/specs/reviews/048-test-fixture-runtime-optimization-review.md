# Spec 048 implementation review — Test and release runtime optimization

Status: **Changes required — child 048.2**  
Branch: `feature/test-fixture-runtime-optimization`  
Merge base: `02dfcb868bd4d9fe3e1e271f28343b73dbc476c6`  
Reviewed 048.2 handoff: `644b63ecaf19f51004b85ad0938bf79fa438abfe`  
Hosted evidence commit: `7a048b2db67a127c59410c9ebd47efba43666ad1`

## Review scope and result

Children 048 and 048.1 remain review-clean. This round independently reviewed child 048.2: the exhaustive backend/frontend profiler, the A/B/C backend runner benchmark, focused regression tests, child-only branch scope, implementation record, and the raw hosted Windows artifact from workflow run `31980485650`.

The central architecture conclusion is sound: **retain Architecture A, the existing fresh-process-per-module runner.** On the same four-logical-CPU Windows job, all six counterbalanced passes completed the complete 70-module / 1,199-case backend population. Architecture A had a median of 53.153 s, Architecture B 108.201 s, and Architecture C 59.157 s. B and C also passed their reverse-module-order runs. Neither alternative meets the spec's material-improvement threshold, so no persistent-worker production path should be retained.

The child is not review-clean yet because the profiler's body-time concentration calculation is mis-ranked, and the required evidence-driven investigation of the material slow-test contributors is not documented at the level required by section 5 of the child spec.

## Confirmed

- Child 048.2 changes are isolated to diagnostic tooling, tests, `AGENTS.md`, workflow/spec coordination, and implementation evidence; no production scientific/application code changed.
- The temporary rehearsal workflow was removed before handoff.
- `scripts/run_backend_tests.py` remains the canonical runner and is unchanged by 048.2.
- The backend profiler runs each discovered backend module in a fresh child process, records per-case setup/body/teardown/elapsed timing, module wall/CPU/process wall, status and failures, and preserves private module data roots.
- The frontend profiler runs every canonical `frontend/tests/*.test.ts` file with Node's TAP reporter and records file/subtest timing.
- Architecture A calls the existing canonical backend runner; B loads all modules into one interpreter; C uses persistent worker shards with per-module data roots plus environment/module reset and known database/session disposal.
- Focused C-isolation tests cover environment leakage, environment-derived configuration, engine disposal, failure attribution, and continuation after a deliberately failing module.

## Verification record

### Implementer-reported

- hosted workflow run `31980485650`, job `95246290112`: **PASS**;
- exhaustive backend profile: **70 modules / 1,199 cases**;
- exhaustive frontend profile: **60 files / 571 cases**;
- counterbalanced `A,B,C,C,B,A`: **all six passes completed**;
- hosted `python scripts/preflight.py --no-cache`: **PASS**, 70.07 s;
- hosted normal preflight: **PASS**, 56.94 s;
- local focused suite: **PASS**, 40 tests;
- local `check_versions`, `compileall`, golden verification and `git diff --check`: **PASS**;
- local no-cache preflight: **PASS**, 123.95 s;
- local normal preflight: **PASS**, 87.74 s;
- browser/manual UI checks: **not required** for this tooling-only child.

### Reviewer-independent

I independently inspected through the GitHub connector:

- current `main` head and merge base: `02dfcb868bd4d9fe3e1e271f28343b73dbc476c6`;
- the complete 048.2 child diff from `b4c22ec991247ff271f70d81b10106dd8f093841` through handoff `644b63ecaf19f51004b85ad0938bf79fa438abfe`;
- `scripts/profile_test_suite.py`;
- `scripts/benchmark_test_runners.py`;
- `tests/test_profile_test_suite.py`;
- `tests/test_benchmark_test_runners.py`;
- the 048.2 specification and implementation record;
- hosted workflow run `31980485650` and job `95246290112`;
- artifact `9272359471`, including its recorded SHA-256 digest and exact evidence SHA.

I also downloaded and independently inspected the raw artifact `spec-048-2-runtime-evidence`:

- backend profile contains **1,199 recorded cases across 70 modules**, with no profile failures;
- frontend profile contains **571 cases across 60 files**, with no profile failures;
- A pass 1: **52.636 s**, 70 module passes;
- B pass 1: **98.451 s**, 1,199/1,199 tests run;
- C pass 1: **66.345 s**, 70 unique modules and 1,199/1,199 tests run;
- C reverse pass: **51.969 s**, 70 unique modules and 1,199/1,199 tests run;
- B reverse pass: **117.952 s**, 1,199/1,199 tests run;
- A pass 2: **53.669 s**, 70 module passes;
- median A/B/C: **53.153 / 108.201 / 59.157 s**;
- hosted logical CPU count / CPU budget / effective jobs: **4 / 4 / 4**;
- startup probes report median plain Python startup about **0.024 s**, common backend import about **1.044 s**, light module discovery about **0.076 s**, and heavy module discovery about **1.067 s**.

The raw backend profile also confirms 72.978 s of cumulative test-body time, 79.749 s cumulative case elapsed time, 6.307 s setup, 0.362 s teardown, and 39.479 s of module wall not attributed to case elapsed. These categories overlap with process/import measurements and should not be added together.

I did **not** independently execute repository test commands in this Chat + GitHub reviewer session.

## Findings

### R1 — RESOLVED: timing-history scheduler reverted

Clean hosted evidence showed longest-first scheduling was slower; the experiment was removed in child 048.

### R2 — RESOLVED: partition experiment reverted

The original Neware Excel and portable-analysis module topology was restored in child 048.

### R3 — RESOLVED: Vite 8 / Rolldown migration

The compatible migration remains accepted based on the child-048 verification and direct-build improvement.

### R4 — RESOLVED: backend-only sidecar no longer races frontend stamp

Resolved in child 048.1.

### R5 — RESOLVED: exact-SHA decision is based on canonical job, not helper completion

Resolved in child 048.1.

### R6 — RESOLVED: main dependency installs use native parallel steps

Resolved in child 048.1.

### R7 — RESOLVED: hosted release/cache evidence obtained

Resolved in child 048.1.

### R8 — Medium: body-time concentration is ranked by elapsed duration

Affected files:
- `scripts/profile_test_suite.py`
- `tests/test_profile_test_suite.py`
- `docs/specs/048.2-full-test-suite-profiling-and-runner-architecture.md`

**Current**

`_summarize_backend()` creates one `top` list sorted by `duration_seconds`, then reuses that elapsed-ranked list when calculating `top_case_concentration` from `body_seconds`. The implementation record labels the resulting values as "Top 10/25/50 by true case-body time".

The raw artifact makes the error observable. The committed report gives 31.60% / 52.09% / 63.14%. Ranking by `body_seconds` before summing body time gives approximately **31.60% / 52.34% / 65.03%**. The 10-case set happens to agree; the 25- and 50-case sets do not.

**Target**

Keep separate rankings for elapsed-duration reporting and true body-time concentration. `top_50_cases` may remain elapsed-ranked, but `top_case_concentration` must select its top N by `body_seconds`. Update the implementation record with the corrected hosted-artifact values.

**Acceptance criteria**

- add a regression case where elapsed ranking and body ranking intentionally differ;
- `top_case_concentration` uses the body-ranked population;
- `top_50_cases` remains explicitly elapsed-ranked unless the schema/documentation is deliberately changed;
- update the recorded 25/50 body-time concentrations from the existing raw hosted artifact; a new full A/B/C rehearsal is not required solely for this arithmetic/reporting correction;
- focused profiler tests pass.

### R9 — Medium: material slow-test investigation is asserted rather than demonstrated

Affected files:
- `docs/specs/048.2-full-test-suite-profiling-and-runner-architecture.md`
- any test/fixture files only if the required investigation identifies a safe optimization

**Current**

The exhaustive profile successfully identifies the dominant modules and cases, but the implementation record jumps from aggregate timing/classification to the blanket conclusion that no individual fixture/test optimization was justified. It does not show the section-5 investigation required by the spec for the material contributors: identify the expensive operation, decide whether that work is behavior under test or redundant setup, consider a concrete lower-cost equivalent, and accept/reject it with evidence.

This matters because the remaining backend cost is concentrated in concrete modules such as `test_import_flow`, `test_database_migrations`, golden-analysis/checkpoint tests, `test_neware_excel`, `test_portable_analysis`, `test_analysis_engine`, `test_biologic_closure`, and the setup-dominated `test_mixed_parser_integration`. The user asked not only for an inventory but whether the 1000+ tests themselves can be sped up.

**Target**

Complete the evidence-driven slow-contributor investigation before declaring 048.2 finished. Define a reasonable material-contributor boundary and, for each included module/test group, record:

- dominant expensive operation;
- whether that operation is part of the behavior being verified or redundant setup;
- the concrete optimization considered (for example immutable DB template/copy, compact fixture, class/module immutable setup, avoiding unrelated app startup, compact serialization fixture), where applicable;
- accept/reject rationale.

If the inspection finds a clearly redundant, correctness-preserving setup cost, implement the smallest safe optimization and measure it with paired/focused evidence. If none is found, document why for the material contributors rather than forcing speculative changes.

**Acceptance criteria**

- the implementation record defines the material-contributor selection rule;
- every selected contributor has an auditable cost classification and accept/reject rationale;
- any accepted optimization preserves the same assertions, tolerances, fixture semantics and private mutable isolation, with focused regression coverage and before/after timing;
- no optimization is required merely to produce a speedup if the evidence shows the expensive work is necessary behavior under test.

## Decision

**CHANGES REQUIRED — keep active child at 048.2.**

The exhaustive profiling and A/B/C architecture result are otherwise credible, and retaining Architecture A is correct based on the clean hosted evidence. Resolve R8 and R9, then hand the same child back for final review. Parent Spec 048 is **not merge-ready** until 048.2 and the cumulative parent review are clean.
