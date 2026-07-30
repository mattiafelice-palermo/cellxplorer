# 034 — Multi-source cell continuations

**Status:** Plan — parent specification
**Implementation:** Implement only through the child specifications listed below.
**Scope:** Treat an interrupted/restarted Neware test as one virtual Cell while preserving every
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

Cycling can stop before the intended protocol finishes. A scientist then starts a second Neware
file, often after removing formation or other already-completed steps from the protocol. The
second file is a continuation of the same physical cell, but its local cycle numbers and numeric
step IDs usually restart. Today CellXplorer imports each source as a different Cell or can attach
files only through incomplete low-level APIs. That prevents a scientifically honest continuous
cycle/time view and makes source update behavior ambiguous.

The desired object is one Cell containing one ordered continuation chain:

```text
Cell
└── Test
    ├── position 0: original source       historical/frozen
    ├── position 1: first continuation   historical/frozen
    └── position 2: current continuation tracked live tail
```

The sources are not physically merged. CellXplorer creates a virtual scientific view over their
ordered caches.

## Existing architecture to preserve

- `backend/app/models.py`
  - `SourceFile` owns immutable content identity (`hash`) and a mutable original `path`.
  - `Test` already describes an ordered set of files stitched into one continuous record.
  - `TestFile.position` already stores order, and `UniqueConstraint("file_id")` permits one source
    to belong to only one Test.
- `backend/app/services/stitch.py::stitch_cycles` and
  `backend/app/services/analysis_engine.py::_stitch_raw` already concatenate ordered hashes, but
  duplicate offset logic and infer length from `max(cycle) - min(cycle) + 1`.
- `backend/app/services/analysis_engine.py::cell_ordered_hashes`,
  `current_cell_hashes`, and `sources_changed_since_compute` already make the ordered hash list
  part of analysis provenance. Reorder, attach, and detach can therefore make analyses stale
  without adding a new database flag.
- `backend/app/routers/files.py`
  - `/api/imports/cells` creates one Cell/Test/TestFile for each selected file.
  - `/api/register`, `/api/tests/{test_id}/detach/{file_id}`, and
    `/api/tests/{test_id}/reorder` expose incomplete lifecycle operations. Reorder accepts partial
    lists, and these routes do not consistently validate, invalidate, or log their effects.
- `frontend/src/pages/InboxPage.tsx::ImportModal` explicitly says one file becomes one cell and
  currently states that concatenation is not supported.
- `frontend/src/components/CellDetailTabs.tsx::FilesPanel` shows attached sources but cannot add,
  reorder, or detach continuations.
- `backend/app/routers/library.py::_cell_source_files` gives scheduled and manual source checks
  every source of every selected active Cell.
- `backend/app/services/portable_analysis.py::_cell_document` serializes `TestFile.position`
  order, but `_analysis_sources` sorts sources by database ID rather than scientific order.

## Locked scientific and product decisions

### 1. Virtual merge only

- Never rewrite, concatenate, or generate a combined `.nda`/`.ndax`.
- Keep one `SourceFile` per original file and store only ordered `TestFile` links.
- The ordered source hashes remain part of analysis provenance.
- No production schema migration is expected for the core feature. If a child discovers a genuine
  persistence need, it must amend this parent and add a forward-only migration.

### 2. User order is authoritative

- CellXplorer suggests chronological order from source metadata/raw timestamp ranges.
- The scientist can reorder sources manually after reviewing warnings.
- The final source in scientific Cell order is the tracked live tail. No independent persisted
  `tracked` flag is added because it could drift from `TestFile.position`.
- For the existing multi-Test model, scientific Cell order is Tests by `Test.id`, then files by
  `TestFile.position`. The tracked source is the final file in the final non-empty Test.
- Adding a continuation defaults to the final Test and makes the new final file the tracked tail.
  A user may choose another Test, but the UI must explain whether that changes the Cell-wide tail.

### 3. Append cycles; do not splice a boundary cycle

- Every observed source-local cycle is one distinct global cycle.
- Map observed local cycle labels densely and in observed order. Do not infer absent cycles from
  `max - min + 1`.
- Example: source A local cycles `1…73` map to global `1…73`; source B local cycles `1…5` map to
  global `74…78`.
- Do not automatically merge the last cycle of A with the first cycle of B, even if either is
  incomplete. A restart may resume a physical action, restart the whole cycle, or use a changed
  protocol; the files alone do not prove which interpretation is correct.
- Preserve incomplete cycles and expose the source/local/global provenance needed for a scientist
  to interpret them.

### 4. Compatibility findings inform; identity violations block

- Exact duplicate content in the same proposed Cell, a source already linked to another Test, a
  missing file, an unstable file, or an unsupported extension blocks submission.
- Reversed chronology, timestamp overlap, time gaps, changed channel/device, metadata mismatch,
  and protocol mismatch are visible findings. Potentially dangerous findings require explicit
  acknowledgement but do not silently reorder or discard data.
- Different numeric step IDs and different protocol signatures are expected for many valid
  continuations; they are not automatic rejection criteria.
- Static Cell metadata and scientific overrides come from the Cell/import form. Adding a
  continuation never silently replaces Cell metadata with the new file header.

### 5. Time meaning

- The default time/capacity x-axis remains cycling elapsed time: active recorded durations are
  continuous across source boundaries and shutdown downtime is excluded.
- Wall-clock elapsed time including the interruption is useful but is outside the initial scope.
  Preserve source timestamps/provenance so it can be added later without re-importing.

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
  `(source protocol signature, local step index)`, not the displayed integer alone.
- Until a later spec implements an explicit cross-source semantic mapping, guarded families must
  fail closed with a clear explanation. They must never compute only some selected Cells/files,
  silently reuse the first protocol, or display stale cached output.

### 7. Source monitoring

- Scheduled low-impact monitoring checks only the tracked tail of each active Cell.
- Historical sources are treated as frozen during scheduled monitoring.
- Manual “check sources”, manual update, and portable-export preflight may inspect every ordered
  source because the user explicitly requested a full integrity operation.
- Reordering immediately changes which source is the tracked tail.

### 8. Lifecycle mutations are atomic and consequential

- Initial multi-source import, attach, reorder, and detach validate the complete proposed chain
  before changing membership/order.
- A reorder request must be an exact permutation of the Test’s current source IDs.
- A Test cannot be left with zero sources through the detach operation.
- Attach/reorder/detach invalidate dependent analysis results, artifacts, and thumbnails, make
  provenance visibly stale, and create a privacy-safe activity entry.
- No frontend sequence may leave a partially attached chain if a later request fails.

### 9. Portable reports and exports preserve provenance

- Portable export/import preserves Cell → Test → ordered source hierarchy exactly.
- Embedded source downloads retain one folder per Cell and distinct original files.
- CSV/Excel data for supported stitched plots identify source order, source hash/filename, local
  cycle, and global cycle wherever those concepts apply.
- Image exports and thumbnails use the same final Plotly figure, including any source-boundary
  presentation.

### 10. Real supplied files are evidence, not fixtures

The user supplied `marge1.ndax` and `marge2.ndax` as a private example. Read-only inspection found
the behaviors this spec must cover: local cycle numbers restart, protocol step numbers differ, the
channels differ, and there is a multi-day gap. The files must not be committed or copied into the
repository without separate explicit privacy approval. Tests must use synthetic data/cache frames
that reproduce these properties.

## Child specifications and dependency graph

| Child | Purpose | Depends on |
|---|---|---|
| [034.1](034.1-scientific-stitching-and-boundaries.md) | Canonical dense cycle/raw stitching and provenance | Parent |
| [034.2](034.2-continuation-compatibility-and-ordering.md) | Inspection, findings, suggested order | 034.1 contracts |
| [034.3](034.3-atomic-multi-source-lifecycle-apis.md) | Atomic import/attach/reorder/detach APIs and invalidation | 034.1, 034.2 |
| [034.4](034.4-initial-multi-source-import.md) | Import-modal workflow for creating one multi-source Cell | 034.2, 034.3 |
| [034.5](034.5-existing-cell-continuation-management.md) | Add/reorder/detach continuations in Cell details | 034.3, 034.4 shared UI |
| [034.6](034.6-tracked-tail-source-monitoring.md) | Scheduled tail-only monitoring, manual all-source integrity | 034.3 |
| [034.7](034.7-cycles-time-capacity-and-exports.md) | Supported analysis families, boundaries, data exports | 034.1, 034.3 |
| [034.8](034.8-protocol-derived-analysis-safety.md) | Fail-closed protection for protocol-derived families | 034.3 |
| [034.9](034.9-portable-roundtrip-and-regression.md) | Portable round-trip, synthetic regression corpus, final matrix | 034.1–034.8 |

Implement these sequentially in numeric order unless a child explicitly says that a later child
can be skipped. The documentation commit and all children use the existing shared
`feature/spec-034-multi-source-continuations` branch. Each child gets one focused implementation
commit, a pushed review checkpoint, and its own review file before the next child starts. Review
follow-ups may add focused commits for that child. Do not merge the shared branch to `main` until
034.9 and the parent-level acceptance matrix are complete, and do not squash away the child commit
boundaries unless the user explicitly requests it.

## Parent-level acceptance

- One Cell can be created from two or more ordered Neware files and can receive later
  continuations without duplicating scientific data.
- Reordering is user-controlled and changes both global cycle mapping and the tracked tail.
- Exact duplicates and invalid membership are rejected before mutation; chronology/protocol
  concerns are explained and acknowledged.
- Global cycles are dense across observed local cycles, source boundary provenance is retained,
  incomplete cycles remain present, and downtime is excluded from default cycling elapsed time.
- Cycles and time/capacity work through interactive plots, saved plots, thumbnails, image export,
  and CSV/Excel export.
- Steps, DCIR, chargeability, and rate capability never display scientifically misleading partial
  data for a multi-source selection.
- Scheduled checks inspect only each Cell’s final source; explicit integrity operations inspect all.
- Attach/reorder/detach invalidate every dependent artifact and leave an activity record.
- Portable export/import retains exact source order and separate originals.
- Synthetic tests cover normal, reversed, overlapping, gapped, missing-cycle, incomplete-cycle,
  duplicate, protocol-changed, and source-update cases.
- No private supplied source is committed.

## Parent verification and closure

This parent is complete only when every child has:

1. an implementation record and linked review document;
2. no open blocking review findings;
3. its focused commands recorded exactly;
4. its focused commits pushed on the shared parent feature branch;
5. no undocumented deviation from the locked decisions above.

After all children satisfy these conditions, run the final parent verification and merge the
shared branch to `main` once.

Child 034.9 owns the final full command and disposable-data matrix. Browser interaction must not be
run automatically unless the user explicitly asks; record the manual checklist as not run when
that permission is absent.
