# 090 — Scoped scientific cache compatibility

Status: Complete; independent Astra Medium review and canonical preflight passed.
Branch: `codex/scoped-scientific-cache-compatibility`.
Review document: [090 review](reviews/090-scoped-scientific-cache-compatibility-review.md).

## Request and evidence

BioLogic changes must not invalidate unchanged Neware caches. Preserve existing
compatible artifacts and add regression coverage for unnecessary startup work.
The BioLogic repeated-execution change raised global CALC_VERSION from 1.6.4 to
1.6.5. That triggered rebuilding 156 unaffected Neware source tables in the
reported development profile. Read-only comparisons proved all corresponding
NDAX and Excel per-cycle tables identical. The latest UI changes did not bump
cache generations.

## Implementation contract

Keep current CALC_VERSION and parser identities unchanged. BioLogic adapter and
source interpretation changes use their existing per-source parser revision;
only shared scientific changes warrant a global calculation-version bump.

Declare only calculation versions 1.6.4 and 1.6.5 equivalent for explicitly
recognized Neware binary/Excel parser identities. Resolve existing per-cycle and
prepared Time/Capacity artifacts at the requested version first, then that one
proven equivalent version. Preserve artifact names, contents and file identities;
normal LRU access stamps may advance. No migration, copying, rewriting,
regeneration or source parsing is needed
for valid compatible cache hits. Do not alias any BioLogic, unknown format,
other calculation version, parser identity, content hash, raw layout or schema.
Validate prepared sidecars against their actual calculation version and exact
raw identity. Keep fresh writes at current versions and force-rebuild behavior.

Existing analysis response keys and saved provenance remain unchanged. Analysis
consumers obtain compatible source tables through the same cache boundary;
BioLogic-only revision changes must leave Neware-only result fingerprints stable.

## Verification

Use disposable data. Cover existing 1.6.4-only, 1.6.5-only and both-version Neware
caches, both binary and Excel. Exercise startup selection, build, write-behind,
ordinary cycle reads, prepared selective reads, format-isolated parser upgrades
and result fingerprints. Assert no parser/calculation/preparation publication
work on compatible hits and unchanged bytes/file identities. Corrupt, mismatched and
unknown versions must still fail or rebuild through their normal owner.
Run focused scientific regressions and canonical four-worker no-cache preflight,
then commit/push and merge under the sequential repository workflow. Do not
modify live user profiles or release/install an application.


## Completed verification

The cache/startup/prepared-data/parser-identity/analysis-key/stitching suite
passed, as did portable and BioLogic repeated-execution/permissive suites.
Seven focused compatibility tests and the targeted portable legacy-cache round
trip pass. The unchanged private six-source/three-chain corpus passes at 9,
9 and 1,175 complete cycles. Canonical four-worker no-cache preflight passed all
four stages and all 221 backend/frontend test files/modules. Existing application
and calculation versions remain unchanged; no live user profile was modified.
