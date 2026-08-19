# 047 — Continued-cell import workspace — Cumulative parent review

**Spec:** `docs/specs/047-continued-cell-import-workspace.md`
**Children:** `047.1`, `047.2`, `047.3` (all individually review-clean)
**Branch:** `feature/continued-cell-import-workspace`
**Merge base:** `5e50736` (current `main` tip — the branch fast-forwards, no divergence)
**Reviewed range:** `main..HEAD` = `05c268e..0b00351`, 21 commits
**Round:** 2
**Result:** Changes required — R3 (Low) still open; R1, R2, R4 resolved

This is a fresh cumulative review of the whole branch against the real merge base, not a re-read of
the three child reviews. Child findings (047.1 R1–R4, 047.2 R1–R4, 047.3 R1–R2) are all closed and
are not revisited; everything below was found by reading the **end state** of the branch.

---

## Verification actually performed for this review

Run by the reviewer on the exact final tree (`aec506e`):

```text
python scripts\preflight.py     PASS (4/4 stages)
npx.cmd tsc --noEmit            PASS
npx.cmd vite build              PASS (built in 5.57s)
```

Preflight reported `SKIP: frontend build (unchanged since last successful run)` for both the type
check and the bundle, so those two were re-run explicitly rather than accepted from cache — the same
precaution the DCIR merge needed earlier. Both pass on their own.

Implementer-reported results across the three children (focused suites, full frontend policy suite,
canonical preflight over 137–138 modules) are consistent with what I re-ran and are taken as given.

### Browser / manual verification — NOT RUN

This is the single largest gap in the parent's evidence, and it is **not** an implementer failing:
neither agent was authorized to drive a browser in this workflow. The cumulative matrix in 047.3
(items 1–40) and the per-child matrices (047.1 items 1–19, 047.2 items 1–15) are all **NOT RUN**.

Parent acceptance criteria that no automated check in this repository can satisfy therefore remain
unverified:

- "No whole-Step-3 horizontal overflow is introduced" and the three panes fitting at supported
  desktop geometry;
- source color parity between the left numbered circles and the plot segments *as rendered*;
- drag-and-drop actually reordering, and colors following a source across the drag;
- "Light and dark mode remain legible" and behavior at higher UI zoom;
- keyboard access to reorder, remove, Inspect, review checkboxes, Raw data and the footer action —
  including the 047.1 R2 fix, whose whole point was restoring nested-control keyboard activation;
- long-filename truncation.

The code-level reasoning behind each is sound and is recorded in the child reviews, but reasoning is
not a browser run. This must be resolved before merge — see *Merge readiness* below.

---

## Findings

### R1 — Medium: completed user-facing work is being merged with no version bump and no CHANGELOG entry

Affected files:
- `CHANGELOG.md`
- version declarations (`package.json` ×2 + lockfiles, `src-tauri/tauri.conf.json`, `Cargo.toml`/lock)

**Current**

`AGENTS.md` states the obligation without qualification:

> When committing completed user-facing work, update the application version and `CHANGELOG.md`
> without waiting for a separate user request.

Parent 047 is completed user-facing work by any reading — a redesigned Step-3 continued-cell
workspace, a new bounded combined-preview endpoint and plot, and a new Continuity review modal. The
parent spec inherits `AGENTS.md` explicitly ("All UI work inherits `AGENTS.md` …").

The branch changes no version declaration and adds no CHANGELOG entry. `scripts/check_versions.py`
and preflight's version-consistency stage both pass only because every declaration is *consistently*
still on `0.26.0-beta.6` — the same version as the merge base. A user updating to the next build
would receive this feature with no release note describing it.

Note what the parent spec does and does not say. Decision 14 rules out a **SQLite migration**, a
**released migration edit**, and a **`CALC_VERSION`** bump — all correctly honored. It says nothing
about the *application* version, which is a different declaration governed by the versioning policy.

**Target**

The branch carries a version bump appropriate to a backward-compatible workflow addition, with a
matching `CHANGELOG.md` entry describing the user-visible change, applied through the repository's
own helper so every declaration stays synchronized:

```powershell
python scripts\bump_version.py <version> --notes "…"
```

If the user deliberately elects not to bump (as they did for the DCIR style-wiring merge earlier
today), that decision should be recorded in the coordination log instead, so the omission is a
choice rather than an oversight.

**Acceptance criteria**

- Either every maintained version declaration is bumped together with a `CHANGELOG.md` entry naming
  the continued-cell import workspace, or the coordination log records an explicit user decision to
  skip it for this feature.
- `python scripts\check_versions.py` passes with all declarations on the new version.
- No `CALC_VERSION`, migration, or portable-report format change is introduced by the bump.

---

### R2 — Low: the spec index still describes 047.3 as in progress

Affected files:
- `docs/specs/README.md`

**Current**

047.3 section I requires the index to carry the package's "current status / shared branch". The
status line reads:

```text
**047.1 and 047.2 implemented and review-clean; 047.3 implementation in progress.**
```

That was accurate when written, mid-047.3. All three children are now implemented and review-clean
and the parent is in its cumulative review, so the line understates the package's state at exactly
the moment a reader would consult it to decide whether the branch is mergeable.

**Target**

The status line reflects the state at merge: all three children implemented and review-clean, with
the parent review recorded.

**Acceptance criteria**

- `docs/specs/README.md` describes 047.1, 047.2 and 047.3 as implemented and review-clean.
- It links the parent review file alongside the three child review links it already carries.
- Any remaining gate (for example outstanding browser verification) is stated rather than implied.

---

### R3 — Low: two new pure policy modules are missing from the AGENTS.md file tree

Affected files:
- `AGENTS.md`

**Current**

`AGENTS.md` requires the tree to be updated "when a change creates … a tracked source, test,
documentation, packaging, or configuration file/folder … when the map would otherwise become
misleading", and its `frontend/src/` listing enumerates precisely this category of pure policy
module with its owning spec:

```text
│   │   ├── importBrowserSelection.ts Pure folder/file row and range-selection policy (Spec 035.1)
│   │   ├── importPathBreadcrumbs.ts  Windows path parsing and edit-mode policy (Spec 035.2)
│   │   ├── importProgress.ts         Truthful staged import progress policy (Spec 035.6)
│   │   ├── librarySelectionScope.ts  Page-versus-result selection policy (Spec 035.12)
```

This branch adds two modules of exactly that kind and lists neither:

- `frontend/src/continuedImportWorkspacePolicy.ts` (Spec 047.1)
- `frontend/src/continuedImportPreviewPolicy.ts` (Spec 047.2)

The obligation was clearly understood — `ContinuationReviewModal.tsx` *was* added to the components
listing in the same commit — so this reads as an oversight rather than a judgment that the map stays
accurate without them.

(For context, the pre-existing `continuationPolicy.ts` is also absent from the tree. That is not this
branch's doing and is out of scope, but it means the convention is already imperfectly applied.)

**Target**

Both new policy modules appear in the `frontend/src/` tree listing in the established one-line form
with their owning spec number.

**Acceptance criteria**

- `AGENTS.md` lists `continuedImportWorkspacePolicy.ts` and `continuedImportPreviewPolicy.ts` with a
  concise purpose and spec reference.
- No unrelated tree entries are rewritten.

---

### R4 — Low: dead residue left by the final 047.3 fix

Affected files:
- `frontend/src/continuedImportWorkspacePolicy.ts`
- `frontend/src/pages/InboxPage.tsx`
- `frontend/tests/continuedImportWorkspacePolicy.test.ts`

**Current**

Two leftovers survived the 047.3 R1 fix, both invisible to the toolchain because `tsconfig.json` sets
`noUnusedLocals: false`.

1. **`inspectionRequired` is dead in production.** The R1 fix replaced the footer's
   `inspectionRequired` branch with `inspectionStatus === "error" | "preparing" | "not_started"`
   checks. The field is still declared on `ContinuedImportSubmissionState`, still computed
   (`inspectionStatus !== "ready"`), and still initialized in two places in `InboxPage.tsx` — but a
   repository grep finds **no production reader**. Only four test assertions keep it alive, which
   makes a dead field look load-bearing to the next reader.

2. **`acknowledgementFindingIds` is imported but unused.** It was the only dependency of
   `confirmationFindingIds`, which 047.3 deleted; the import was not removed with it.

Neither affects behavior. Both are the kind of residue that a later reader has to re-derive, in a
contract (`ContinuedImportSubmissionState`) that is deliberately the narrow projection between the
editor and the footer.

**Target**

The submission-state contract carries only fields something reads, and the module imports only what
it uses.

**Acceptance criteria**

- `inspectionRequired` is either removed from `ContinuedImportSubmissionState` (with its two
  `InboxPage` initializers and its test assertions updated to `inspectionStatus`), or given a real
  production consumer.
- The unused `acknowledgementFindingIds` import is removed.
- `continuedInspectionStatus` coverage still distinguishes `not_started` / `preparing` / `ready` /
  `error`, as 047.3 R1 required.
- Focused frontend suites stay green.

---

## Round 2 — R1, R2 and R4 resolved; R3 partially applied (`b6997e4`)

**R1 — RESOLVED.** All nine maintained declarations plus `backend/app/config.py`'s `APP_VERSION`
moved together to `0.27.0-beta.1`, and `python scripts\check_versions.py` confirms it:
`PASS: all version declarations match 0.27.0-beta.1`. A minor bump is the right call for a
backward-compatible workflow addition under the versioning policy. `CHANGELOG.md` gained a
`### New features` entry naming the continued-cell import workspace with ordered source review and
combined previews — one line, matching the house style of every neighbouring entry. I confirmed the
bump introduced no `CALC_VERSION`, migration, model or portable-report change: the diff is version
declarations, the changelog, and the R2–R4 edits only.

**R2 — RESOLVED.** The spec index now reads "All three children implemented and review-clean;
cumulative parent review in progress."

**R4 — RESOLVED.** `inspectionRequired` is gone from `ContinuedImportSubmissionState`, from both
`InboxPage` initializers and from the four test assertions that were pinning it; the unused
`acknowledgementFindingIds` import is removed. `continuedInspectionStatus` coverage still
distinguishes all four states, and the focused continuation suites pass 33/33.

**R3 — STILL OPEN.** Half the acceptance criterion was met. `AGENTS.md` now lists

```text
│   │   ├── continuedImportWorkspacePolicy.ts  Continued-import workspace projection and source identity policy (Spec 047)
```

and, beyond what was asked, also backfilled the pre-existing `continuationPolicy.ts` — a welcome
extra. But `frontend/src/continuedImportPreviewPolicy.ts` is still absent: `grep -c` over `AGENTS.md`
returns `0`, while `git ls-files` confirms the module is tracked. The finding named both files
explicitly, and the tree now lists every other pure policy module in that directory, so the omission
of this one is more conspicuous than before the fix.

Remaining work is a single line in the same listing, in the same form, referencing Spec 047.2.

**Verification re-run by the reviewer on the fixed tree:**

```text
python scripts\preflight.py     PASS (4/4)
npx.cmd tsc --noEmit            PASS
npx.cmd vite build              PASS
focused continuation suites     33/33 PASS
```

Preflight again skipped the type check and bundle from cache, so both were re-run explicitly.

## Cumulative verification against the parent acceptance criteria

### Workspace

- Continued mode uses the existing Step-3 shell and the unchanged `SegmentedControl`; no new modal
  size, wizard step, page or window was introduced. `IMPORT_MODAL_WIDTH` and
  `ImportModalShell.module.css` are untouched by this branch.
- Source chain / Preview / Cell draft are three bordered `Paper` panes with independent internal
  scrolling, inside a `Group` carrying `flex: 1, minHeight: 0, minWidth: 0`, under a `flex: none`
  command row. Fixed panes are 310 px and 380 px, within the parent's 300–330 / 360–400 ranges; the
  preview pane is `flex: 1, minWidth: 0` rather than a hard 480–520 px floor, which 047.2's review
  accepted as the safer reading of decision 2's "do not introduce a horizontal scrollbar".
- **Horizontal overflow itself is unverified** — see the browser gap above.
- Exactly one primary Import action exists. `Import one continued cell` appears once in the whole
  repository, in `ImportModalShell.actions`; the editor's internal button and its `onImport` prop are
  gone.

### Source chain

- Compact rows are `Paper withBorder p="xs"` with `gap={4}`/`gap={6}`, `size="sm"` filename and
  `size="xs"` dimmed metadata; no path, hash, protocol signature, raw-data control or finding rows.
- Drag, up/down and remove are all live from entry to continued mode (047.1 R1), the row's Enter/Space
  handler no longer swallows nested-control activation (047.1 R2), and every icon control has an
  `aria-label` plus a Mantine `Tooltip`.
- Removal uses `staged_name`, never an index. `sourceRoleLabel` still marks only the final visible
  source as Tracked tail.
- Reorder and removal cannot mutate the Cell draft: `continuedCellDraft` is re-initialized only from
  the `[opened, targetFolderId]` effect.
- `assignContinuationSourceColors` keys off source identity, reuses only unused palette slots, drops
  removed keys and repeats the palette on overflow. Colors come from `PALETTE` in `plotStyle.ts`,
  which is the same array as `PLOT_PALETTES.app` — the app plot palette the visual style guide names,
  not Mantine semantic chrome colors. The mapping is component state only: not persisted, not in any
  payload, not part of cache identity.

### Preview

- Step-3 open, mode switch and adding drafts start nothing: the combined query's `enabled` requires
  `opened && previewMode === "combined" && inspectionRequested && result?.inspection_complete &&
  orderedDrafts.length >= 2`. There is no `drafts.forEach(loadPreview)` anywhere.
- Global cycles come from `stitch.stitch_cycles(refs, CALC_VERSION)`; the endpoint re-implements no
  part of `observed_local_cycles`, the dense map, or missing-source handling, and `segment` index
  alignment with the proposed order was verified against `_stitch_ordered`.
- One trace per segment, `x`/`y` passed through untransformed, color read from the 047.1 map by
  `source_key`, `showlegend: false` on every trace and on the layout, title `Capacity vs. cycle`,
  x axis `Cycle number (global)`, y axis from the backend label. No filename legend.
- Raw data is a single header button bound to the selected source and gated by
  `continuationSourceCanOpenRawData`; no combined raw-data endpoint was added; no table is embedded.
- Individual preview remains lazy and per-source; metadata-only sources render the shared
  "Capacity preview unavailable" copy rather than claiming a preview will load.
- Metadata-only and incomplete chains fail closed with structured per-source detail, now classified by
  an explicit `kind` rather than by matching prose (047.2 R1).

### Validation

- `continuedImportCanSubmit(...)` still gates submission alongside the ≥2-source and scientific-draft
  checks; the server remains authoritative. Blocking findings cannot be acknowledged away;
  confirmations require one checkbox each, driven by severity rather than a hardcoded code list;
  `preserveAcknowledgements` still expires acknowledgements whose finding ID no longer exists, and
  `acknowledgedMetadataOnlySourceKeys` still binds metadata-only consent to the current source keys.
- The main workspace carries no persistent finding stack and no acknowledgement checklist — only a
  single `size="xs"` status line when review or a source error is genuinely outstanding.
- Required review happens in `ContinuationReviewModal`, which also surfaces source-level inspection
  errors that emit no finding (047.3 R1).

### Import lifecycle

- The submitted payload is unchanged from before the branch: one cell with ordered `sources[]`,
  `replicate_groups: []`, the Cell draft fields, and `acknowledged_finding_ids`. The visible order is
  what is submitted, frozen through the submission projection.
- Registration remains the existing asynchronous 202 / job-token / progress / Continue-in-background /
  Done flow; that region of `InboxPage.tsx` is untouched. Scientific cache preparation remains
  post-registration.
- Separate-cell mode is genuinely unchanged: the entire cumulative `InboxPage.tsx` diff is
  continued-mode scoped, and the `ContinuationSourceList` default variant — used by
  `ContinuationManagementPanel` for existing-cell continuation management — is byte-identical.

### Documentation

- `state-and-performance.md` records the explicit combined-preview boundary and keeps the existing
  identity/fingerprint and late-result protections.
- `CELLXPLORER_ARCHITECTURE.md` replaces `SourceFile → Test → Cell` with `Cell └── ordered
  SourceFiles`, explains the single internal Test row and the tracked tail, and updates the MPR
  capability paragraph to the narrow verified source-local cycle-1 path — wording checked against
  `AGENTS.md` on real current `main`, not against this branch.
- Synchronization metadata in both changed project-context files points at `main` at `5e50736`.
- The mirror-replacement statement was made (047.3 R2), though with literal escape sequences in the
  coordination entry; it is restated cleanly at the end of this document.

---

## Noted risks (not findings)

- **`_preview_source_fingerprint` duplicates ~30 lines of the ordinary `/imports/preview` identity
  logic** rather than sharing a helper. The semantics match exactly today — same stat-first match,
  same re-hash fallback, same structured `409 source_changed` payload — so it is not a weaker
  identity path, which is what 047.2 section B1 forbids. But the two can now drift independently, and
  a future change to one will not automatically reach the other. Worth extracting the next time
  either is touched.
- **`_CONTINUATION_PREVIEW_MAX_POINTS` is a new cap** rather than a reused ordinary-preview budget,
  because the ordinary preview has no cap to reuse. Total points are bounded by
  `max(2 × sources, 600)` — bounded by source count, never by raw-record count, which is what
  section E actually requires.

---

## Merge readiness

**Not yet.** Two things stand between this branch and `main`:

1. R1–R4 above, of which only R1 (version/CHANGELOG) is more than tidying.
2. The browser/manual matrix, which no agent in this workflow was able to run.

Once R1–R4 are resolved, the correct terminal state depends on the browser gap. If the user runs the
cumulative matrix and reports results, the parent can complete normally. If it stays unrun, this
workflow should end in `BLOCKED` rather than `COMPLETE` — the feature would be code-clean but not
merge-ready, and marking it complete would claim verification that was never performed.

The branch itself is otherwise in good shape: it fast-forwards onto `5e50736` with no divergence, the
working tree is clean, preflight and an explicit type-check and bundle all pass on the final tree, and
no backend scientific meaning, migration, `CALC_VERSION`, cache-identity or portable-report contract
was touched.

---

## Project mirror handoff

The repository copies are canonical; the user's uploaded ChatGPT Project mirror is stale for the two
files that actually changed:

```text
Replace uploaded Project file:
- CELLXPLORER_ARCHITECTURE.md
- CELLXPLORER_PROJECT_INSTRUCTIONS.md
```

Neither agent replaced the upload; this is an instruction to the user, not a completed action.
