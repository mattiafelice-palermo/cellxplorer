# Review — Spec 051: BioLogic MPR extensible column registry and required-field decoding

Status: **Changes requested**  
Spec: [`../051-biologic-mpr-extensible-column-registry.md`](../051-biologic-mpr-extensible-column-registry.md)  
Branch: `feature/biologic-mpr-extensible-columns-051`  
Main / merge base: `706dc0f14880202a8c5e22b35020502bcf3b4dc9`  
Workflow initialization: `f4ebb10e2b347f62544b700d3781f96be7390704`  
Initial implementation handoff: `09f584f32d095edb70efb18147b8aeb0eeb918eb`

## Review summary

The low-level Spec 051 implementation is substantially aligned with the locked binary-layout design. The exact 16-column allowlist is no longer the decoder boundary; ordinary columns resolve through `encoded_id % 256` against the project-owned storage registry; the observed record stride is derived from the VMP record area; required fields are decoded with explicit offsets and full-stride NumPy dtypes; packed flags retain shared-byte handling; diagnostics preserve full encoded IDs and resolved bases; and the BioLogic parser identity is bumped to `gcpl9`.

The branch is **not ready to merge**, however, because the real 21-ID / 93-byte source family that motivated the feature still does not complete the canonical cycling path. The implementer handoff explicitly reports that both local `Downloads\\EGG*` files reach an existing capacity-boundary validation during full canonical parse and treats that result as outside the binary-layout child. The user independently tested the built application and observed the corresponding user-visible failure: the cell can be loaded, but Analysis refuses a voltage plot because the source is metadata-only and canonical cycling rows are unavailable.

That is a core acceptance failure for this feature. The Spec 051 acceptance criteria say the verified 21/93 extended layout must import without rewriting, and the project architecture requires supported scientific sources to reach canonical cycling rows before analysis/cache-backed computation is enabled. A low-level decode that leaves the motivating real source metadata-only is therefore insufficient.

## Implementer-reported verification

The implementation handoff reports:

- focused MPR/GCPL/metadata/parser/closure tests: **PASS (162)**;
- canonical `python scripts\\preflight.py`: **PASS (4/4; 81 backend modules)**;
- browser checks: **NOT RUN**;
- both local `Downloads\\EGG*` examples: low-level 21-ID / 93-byte decoding succeeds without rewriting, but full canonical parsing reaches the existing capacity-boundary guard.

## Reviewer verification

I independently inspected the cumulative branch diff against `main`/merge base `706dc0f1`, including the production registry/stride resolver, GCPL adapter integration, parser/reinspection changes, diagnostics, documentation, and focused tests. In particular, `tests/test_biologic_gcpl.py` contains synthetic 53/93 canonical parity coverage, while the implementation record and handoff both acknowledge that the real observed files do not pass the same canonical boundary.

I could not independently run the repository test commands in the available reviewer environment: there is no repository checkout and direct GitHub clone/network access from the execution container is unavailable. I therefore do not claim independent automated-test execution. The user's running-build result is recorded as manual acceptance evidence and directly reproduces the unresolved capability failure.

## Findings

### R1 — High: The motivating 21/93 BioLogic source still becomes metadata-only, so Analysis cannot use it

**Affected files:** `backend/app/services/biologic_gcpl.py`, `backend/app/services/parsing.py`, `tests/test_biologic_gcpl.py`, `tests/biologic_mpr_fixture.py` and any narrowly required BioLogic/canonical integration tests or documentation.

**Current**

The new low-level reader successfully identifies and decodes the real 21-ID / 93-byte `EGG*` files, but the full GCPL-to-canonical parse fails at the existing capacity-counter boundary. The implementer explicitly records this in the handoff and Spec 051 implementation record. Consequently the imported source remains metadata-only. The user verified the resulting application behavior: the cell appears in CellXplorer, but attempting to plot voltage in Analysis yields:

> This analysis includes metadata-only sources. Canonical cycling rows are not available for these sources, so cache-backed analysis and recompute are disabled.

The added synthetic `test_extended_registry_layout_preserves_canonical_output` proves that a manufactured 93-byte layout with the old fixture's capacity behavior maps identically to the baseline. It does not reproduce the capacity behavior of the real extended source that actually fails.

**Target**

Complete the evidence-backed canonical path for the real 21/93 GCPL source family that motivated Spec 051. Inspect the failing real rows and determine why the existing capacity boundary rejects them: e.g. whether the required base-211 field has a different but valid observed counter behavior, whether another already decoded source field is the correct semantic input for this file family, or whether the adapter's current boundary is too narrow for independently established GCPL behavior. Implement only the narrow, source-evidenced semantic correction required for this supported family. Preserve fail-closed behavior; do not bypass canonical validation, fabricate capacity, or weaken the guard generically merely to make the file pass.

If the real file establishes a genuinely different GCPL semantic contract, encode that contract explicitly and document the evidence. The real source must not be declared supported while remaining metadata-only.

**Acceptance criteria**

- A fresh import or parser-identity reinspection of the local real `EGG*` 21/93 source completes with canonical cycling capability rather than `metadata_only`.
- `parsing.parse_timeseries(...)` succeeds for the real file and the resulting frame passes the normal canonical raw-timeseries validation.
- Cache preparation/build succeeds for that source, and an Analysis containing it can render at least the ordinary voltage plot without the metadata-only capability error.
- Add a committed synthetic regression that reproduces the actual capacity-counter pattern responsible for the current real-file failure, rather than only the existing idealized 53/93 parity rows.
- The original verified 16-ID / 53-byte source behavior remains regression-identical, and the existing 21/93 low-level registry/stride safety matrix remains intact.
- Record the real-file local acceptance evidence without committing the private/source file, then rerun the focused tests and canonical preflight.

### R2 — Low: The Spec 051 implementation record names a non-existent feature branch

**Affected file:** `docs/specs/051-biologic-mpr-extensible-column-registry.md`.

**Current**

The implementation record says the work was implemented on `feature/biologic-mpr-extensible-column-registry-051`, while the actual workflow/spec branch is `feature/biologic-mpr-extensible-columns-051`.

**Target**

Keep the implementation record consistent with the actual branch so future agents and reviewers do not follow the wrong ref.

**Acceptance criteria**

- Replace the incorrect implementation-record branch name with exactly `feature/biologic-mpr-extensible-columns-051`.

## Review conclusion

**Changes requested.** R1 blocks merge because the real source that motivated the feature is still not analysis-capable. R2 is a documentation correction that should be closed in the same return.
