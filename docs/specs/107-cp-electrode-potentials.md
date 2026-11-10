# 107 — CP electrode potentials and scoped cache repair

Status: Implementation complete; clean-Windows preflight required before merge.
Branch: `codex/cp-electrode-mapping`.
Review document: [107 review](reviews/107-cp-electrode-potentials-review.md).

## Request and observed failure

The four supplied CP recordings contain synchronized mean working potential
(base 174) and counter potential (base 185). The current CP mapper publishes
only the former, labels it cell voltage and advertises no auxiliary channels.
The existing selector consequently disappears. Sequential source plotting already
works over 115,216 rows and 1,036.159 minutes in acquisition order.

## Contract

For verified CP rows with a recorded counter potential, preserve Ewe as
`working_potential_v`, Ece as `counter_potential_v`, and publish signed
`voltage_v = Ewe - Ece`. Advertise all three quantities and their truthful
roles/origin in normalized and persisted metadata. Retain acquisition order,
source boundaries, timestamps, current, capacity and cycle-pair behavior.
CP fixtures without Ece retain their existing primary-only behavior; OCV,
GCPL, MB and Neware scientific output remains unchanged.

Keep global CALC_VERSION and the existing MPR family identity unchanged. Add
a bounded CP electrode revision suffix only to affected sources, resolved from
validated file headers at build time and persisted header facts at no-I/O status
checks. Include Safe/Permissive mode in that identity. Startup preparation must
select only affected CP registrations, persist updated capabilities after a
successful build and stop requeuing after success. Preserve old artifacts for
pinned provenance; never relabel old working-only values as corrected cell
voltage. Audit inspection, import, continuation, worker and portable identities.

Use the existing Time/Capacity voltage selector, range controls, renderer and
export path. Verify all three channels sequentially through full/compact and
selected-range reads, cache reload, saved-result provenance and export. No new
frontend surface is required unless actual browser acceptance reveals a gap.

## Verification and privacy

Archive the four originals immutably in a separate ignored private corpus.
Independently decode their observed 49-byte record layout for voltage/time
oracles before establishing a new baseline. Add public synthetic-byte and
pipeline regressions that need no private files. Keep previous private corpus
expectations unchanged. Check unrelated cache bytes and preparation selection.
Run existing corpora, canonical four-worker preflight, and independent Astra
Medium review. Commit/push and merge under the sequential workflow. No release,
installation or direct changes to a real user profile are authorized.

## Outcome

The four sources expose synchronized working potential, counter potential and
signed cell voltage through the existing selector. Acquisition order and source
boundaries are retained across the 115,216-row, 1,036.159015-minute sequence.
The production UI passes three-quantity/Continuous display and manual Y-limit
acceptance against disposable QA data. No frontend change was necessary.

Only CP sources with structural evidence of recorded Ece receive `:cp2`;
Safe/Permissive suffixes remain separate. Successful cache-hit preparation
publishes registration identity and capabilities. Historical working-only caches
are retained and replay with working-potential labels. Offline portable reports
retain their actual artifact identity, and contradictory mode declarations fail
before cache installation/building.

Verification: 259 focused integration tests, six CP regressions including both
portable mode contradictions, the independent four-original byte/time/export
oracle, new immutable four-source frozen baselines, and both prior private
corpora pass. The prior 6/13-source expectations remain unchanged. Astra Medium
approved after lifecycle/mode findings were fixed. Full local four-worker
preflight passes 240/241 modules/files plus version/type/build stages; the sole
failure is the already-established Windows native port-owner detection limit.
No tests or production protections were skipped or weakened. A clean-Windows
branch preflight is the remaining merge gate.
