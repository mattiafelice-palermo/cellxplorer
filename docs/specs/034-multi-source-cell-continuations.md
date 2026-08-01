# 034 — Multi-source cell continuations

**Status:** Implemented — final review fix verified 2026-08-01
**Implementation:** Implement only through the child specifications listed below.  
**Review status:** 034.7, 034.8, and 034.9 review findings are implemented, including the final
zero-row internal-Test invariant fix. Current `main` is integrated into the shared feature branch
and the final no-cache closure matrix passes.
**Scope:** Treat an interrupted/restarted Neware run as one virtual Cell while preserving every
original source, its order, and its provenance.

All UI work inherits
[`../agent-knowledge/visual-style-guide.md`](../agent-knowledge/visual-style-guide.md).

## Why this is a parent specification

This feature crosses importing, source identity, cache semantics, source monitoring, analysis
computation, exports, portable reports, and destructive lifecycle operations. Implementing it as
one large change would make review and rollback unsafe. This document locks the shared scientific
and product decisions. Each `034.x` child is a bounded, independently reviewable implementation
task.

An implementing agent must read this parent before its assigned child. A child may add detail but
must not contradict a locked decision below. If implementation reveals that a locked decision
must change, amend this parent explicitly before continuing.

## User problem

Cycling can stop before the intended protocol finishes. A scientist then starts another Neware
file, often after removing formation or other already-completed steps from the protocol. This may
happen several times because of power loss, cycler interruption, channel moves, network problems,
or a deliberate restart with a shortened or modified protocol.

These files are not separate scientific tests in CellXplorer. They are successive source segments
of the same physical Cell history. The app must simply preserve and virtually chain them in the
scientist-approved order.

The required product object is:

```text
Cell
├── position 0: original source       historical/frozen
├── position 1: first continuation   historical/frozen
└── position 2: current continuation tracked live tail
```

The sources are not physically merged. CellXplorer creates one virtual scientific view over their
ordered caches.

## Locked architecture correction: one Cell-level source chain

The original database schema contains `Test` and `TestFile` tables. That schema detail must **not**
become a user-facing product concept.

The locked model for this feature is:

```text
User-facing model:       Cell -> ordered SourceFiles
Compatibility storage:  Cell -> one internal Test row -> ordered TestFile links
```

The following decisions are mandatory:

- A Cell has one scientific source chain.
- Every Cell has exactly one internal `Test` row.
- Every source belonging to that Cell is linked to that same internal row.
- `Test` exists only as a compatibility container so this feature does not require a schema
  redesign or released-migration rewrite.
- Multiple Tests per Cell were never an implemented or approved workflow. They are not a legacy
  state to support, migrate, flatten, normalize, or preserve.
- Code and tests must enforce the one-Test-row-per-Cell invariant. Any attempt to create a second
  Test for the same Cell is an invariant violation and must fail closed.
- The UI must not expose Test names, Test cards, a Target Test selector, per-Test ordering, or
  per-Test tails.
- Protocol changes between adjacent files do not create a new Test. They are expected restart
  evidence and may produce an informational or acknowledgement finding only.
- Continuation lifecycle APIs and frontend contracts are Cell-level. Existing `/tests/{test_id}`
  routes may remain temporarily as internal wrappers while callers are migrated, but they must not
  enable or imply multiple Tests.
- Do not add a production schema migration merely to rename or remove the existing tables.

This correction supersedes every earlier sentence in Specs 034.1–034.6, their implementation
records, or repository documentation that describes multiple Tests per Cell as supported product
behavior.

## Existing architecture to preserve

- `backend/app/models.py`
  - `SourceFile` owns immutable content identity (`hash`) and a mutable original `path`.
  - `Test`/`TestFile` remain compatibility storage for one ordered Cell source chain.
  - `TestFile.position` stores source order, and `UniqueConstraint("file_id")` prevents one source
    from belonging to multiple chains.
- `backend/app/services/stitch.py::stitch_cycles` and
  `backend/app/services/analysis_engine.py::_stitch_raw` concatenate ordered hashes.
- `backend/app/services/analysis_engine.py::cell_ordered_hashes`,
  `current_cell_hashes`, and `sources_changed_since_compute` make the ordered hash list part of
  analysis provenance.
- `frontend/src/pages/InboxPage.tsx::ImportModal` owns import selection and metadata editing.
- `frontend/src/components/CellDetailTabs.tsx::FilesPanel` owns Cell source-chain presentation.
- `backend/app/routers/library.py` and `backend/app/services/source_monitor.py` own source checks.
- `backend/app/services/portable_analysis.py` owns portable source hierarchy and provenance.

## Locked scientific and product decisions

### 1. Virtual merge only

- Never rewrite, concatenate, or generate a combined `.nda`/`.ndax`.
- Keep one `SourceFile` per original file and store only ordered links.
- The ordered source hashes remain part of analysis provenance.
- No production schema migration is expected for the core feature.

### 2. User order is authoritative

- CellXplorer suggests chronological order from source metadata/raw timestamp ranges.
- The scientist can reorder sources manually after reviewing warnings.
- The final source in the Cell chain is the only tracked live tail.
- No independent persisted `tracked` flag is added because it could drift from order.
- Adding a continuation appends to the Cell chain by default and makes the new final source the
  tracked tail.
- There is no Target Test selection and no cross-Test concept.

### 3. Append cycles; do not splice a boundary cycle

- Every observed source-local cycle is one distinct global cycle.
- Map observed local cycle labels densely and in observed order. Do not infer absent cycles from
  `max - min + 1`.
- Example: source A local cycles `1…73` map to global `1…73`; source B local cycles `1…5` map to
  global `74…78`.
- Do not automatically merge the last cycle of A with the first cycle of B.
- Preserve incomplete cycles and expose source/local/global provenance.

### 4. Compatibility findings inform; identity violations block

- Exact duplicate content in the same proposed Cell, a source already linked to another Cell,
  a missing file, an unstable file, or an unsupported extension blocks submission.
- Reversed chronology, timestamp overlap, time gaps, changed channel/device, metadata mismatch,
  and protocol mismatch are visible findings.
- Different numeric step IDs and different protocol signatures are expected for valid restarts.
  They are not automatic rejection criteria and never imply a new Test.
- Static Cell metadata and scientific overrides come from the Cell/import form. Adding a
  continuation never silently replaces Cell metadata with the new file header.

### 5. Time meaning

- The default time/capacity x-axis remains cycling elapsed time: active recorded durations are
  continuous across source boundaries and shutdown downtime is excluded.
- Wall-clock elapsed time including interruption is outside the initial scope.

### 6. Supported analysis families

- Initial fully supported families:
  - Cycles
  - Time / capacity
- Initially guarded families:
  - Steps
  - DCIR
  - Chargeability
  - Rate capability
- Numeric step IDs are source-local. Their durable identity is at least
  `(source protocol signature, local step index)`.
- Guarded families must fail closed until explicit cross-source semantic mapping exists.

### 7. Source monitoring

- Scheduled low-impact monitoring checks only the final source of each active Cell chain.
- Historical sources are frozen during scheduled monitoring.
- Manual Check sources, manual update, and portable-export preflight may inspect every ordered
  source because the user explicitly requested a full integrity operation.
- Reordering immediately changes which source is the tracked tail.

### 8. Lifecycle mutations are Cell-level, atomic, and consequential

- Initial multi-source import, attach, reorder, and detach validate the complete proposed Cell
  chain before changing membership/order.
- Reorder requires an exact permutation of all current Cell source IDs.
- A Cell cannot be left with zero sources.
- Attach/reorder/detach invalidate dependent analysis results, artifacts, and thumbnails, make
  provenance visibly stale, and create a privacy-safe activity entry.
- No frontend sequence may leave a partially attached chain if a later request fails.
- The response returns the complete updated Cell source chain and tracked source ID.

### 9. Portable reports and exports preserve provenance

- Portable export/import preserves Cell -> ordered source hierarchy exactly.
- The internal Test row is an implementation detail and must not create multiple user-visible
  groups in portable reports.
- Embedded source downloads retain one folder per Cell and distinct original files.
- CSV/Excel data for supported stitched plots identify source order, source hash/filename, local
  cycle, and global cycle wherever those concepts apply.

### 10. Real supplied files are evidence, not fixtures

The user supplied `marge1.ndax` and `marge2.ndax` as a private example. Read-only inspection found
local cycle restarts, changed step numbers, changed channel, and a multi-day gap. These are normal
continuation characteristics, not evidence of separate Tests. The files must not be committed or
copied into the repository without explicit privacy approval.

## Child specifications and dependency graph

| Child | Purpose | Depends on |
|---|---|---|
| [034.1](034.1-scientific-stitching-and-boundaries.md) | Canonical dense cycle/raw stitching and provenance | Parent |
| [034.2](034.2-continuation-compatibility-and-ordering.md) | Inspection, findings, suggested order | 034.1 contracts |
| [034.3](034.3-atomic-multi-source-lifecycle-apis.md) | Atomic Cell-level import/attach/reorder/detach APIs | 034.1, 034.2 |
| [034.4](034.4-initial-multi-source-import.md) | Import-modal workflow for creating one multi-source Cell | 034.2, 034.3 |
| [034.5](034.5-existing-cell-continuation-management.md) | Add/reorder/detach sources in one Cell chain | 034.3, 034.4 shared UI |
| [034.6](034.6-tracked-tail-source-monitoring.md) | Scheduled tail-only monitoring, manual all-source integrity | 034.3 |
| [034.7](034.7-cycles-time-capacity-and-exports.md) | Supported analysis families, boundaries, data exports | 034.1, 034.3 |
| [034.8](034.8-protocol-derived-analysis-safety.md) | Fail-closed protection for protocol-derived families | 034.3 |
| [034.9](034.9-portable-roundtrip-and-regression.md) | Portable round-trip, synthetic regression corpus, final matrix | 034.1–034.8 |

Implement sequentially in numeric order. Do not continue to 034.7 until the revised 034.4–034.6
reviews have no blocking findings.

## Parent-level acceptance

- One Cell can be created from two or more ordered Neware files and can receive later
  continuations without duplicating scientific data.
- The application exposes one Cell-level source chain, never multiple Tests.
- Every Cell has exactly one internal compatibility Test row and all sources link to it.
- No code path can create a second Test for a Cell.
- No Test name, Target Test selector, per-Test card, per-Test tail, or per-Test lifecycle action is
  visible to the user.
- Reordering is user-controlled and changes both global cycle mapping and the one tracked tail.
- Protocol changes remain non-blocking continuation findings and never create a separate Test.
- Exact duplicates and invalid membership are rejected before mutation.
- Global cycles are dense across observed local cycles and source-boundary provenance is retained.
- Scheduled checks inspect only each Cell’s final source; explicit integrity operations inspect all.
- Attach/reorder/detach invalidate every dependent artifact and leave an activity record.
- Portable export/import retains exact source order and separate originals.
- Synthetic tests cover normal, reversed, overlapping, gapped, missing-cycle, incomplete-cycle,
  duplicate, protocol-changed, source-update, and second-Test-rejection cases.

## Parent verification and closure

This parent is complete only when every child has:

1. an implementation record and linked review document;
2. no open blocking review findings;
3. its focused commands recorded exactly;
4. its focused commits pushed on the shared parent feature branch;
5. no undocumented deviation from the locked decisions above.

Child 034.9 owns the final full command and disposable-data matrix. Browser interaction must not be
run automatically unless the user explicitly asks; record the manual checklist as not run when
permission is absent.

**Review follow-up status:** The historical closure record below is superseded by Review 034.9.
Strict portable-chain validation, executable case mapping, current-main integration, the final
no-cache closure matrix, and the 034.7 zero-row invariant fix are complete. The browser/disposable-
data manual matrix remains not run without explicit browser-testing authorization.

## Final closure record — 2026-08-01

The shared feature branch contains the sequentially pushed 034.1–034.9 checkpoints and merge
commit `3abfb2f`, which integrates `origin/main` at `4bc4feee35444615714e424e963d8531fdcebc21`
from merge base `f767ccdb4ff137f21bc420cfc23e7a9e5d973387`. The integrated closure passed
`python -m unittest discover tests` (699 tests), `node --test frontend\\tests\\*.test.ts`
(271 tests), `npx.cmd tsc --noEmit`, `npx.cmd vite build`, `python scripts\\check_versions.py`,
and `python scripts\\preflight.py --no-cache` (5/5 stages). The browser/disposable-data manual
matrix was not run because browser testing was not authorized. No merge to `main` was made.
