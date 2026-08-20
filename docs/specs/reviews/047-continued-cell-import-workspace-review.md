# 047 — Continued-cell import workspace — Cumulative parent review

**Spec:** `docs/specs/047-continued-cell-import-workspace.md`
**Children:** `047.1`, `047.2`, `047.3`, `047.4` (all individually review-clean)
**Branch:** `feature/continued-cell-import-workspace`
**Merge base:** `5e50736` (current `main` tip — the branch fast-forwards, no divergence)
**Reviewed range:** `main..HEAD` = 55 commits at `a0d6471` (round 5); earlier rounds reviewed 24
**Round:** 5 (cumulative, current)
**Result:** Changes required — R30 (Medium). See the round-5 section at the end of this file;
earlier rounds are history, not current merge evidence.

> Rounds 1–3 below reviewed the branch at `0.27.0-beta.1` / 24 commits and closed BLOCKED on the
> unrun browser matrix. The user then resumed and ran further tranches (R5–R10) that this file never
> recorded, and afterwards added 047.4 as a fourth child. Round 4 reviews the R7–R10 fixes at
> `398b3c3` / `0.27.0-beta.6`. The cumulative parent review must be performed again, once, after
> 047.4 lands — rounds 1–3 are history, not current merge evidence.

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

## Round 3 — R3 resolved; cumulative review clean

`AGENTS.md` now lists the second module in the same one-line form:

```text
│   │   ├── continuedImportPreviewPolicy.ts  Combined continuation preview request/trace policy (Spec 047.2)
```

The fix touched only `AGENTS.md` plus the two workflow files. **All parent findings R1–R4 are
resolved, and no new defect was found.**

### Final state verified by the reviewer

```text
tracked working tree            clean
merge base                      5e50736 == main tip (0 main-only commits, 24 branch-only)
python scripts\preflight.py     PASS (4/4 stages)
npx.cmd tsc --noEmit            PASS
npx.cmd vite build              PASS
focused continuation suites     33/33 PASS
python scripts\check_versions.py PASS (all declarations 0.27.0-beta.1)
```

The branch is a clean fast-forward onto `main` with no divergence.

### Why this closes BLOCKED rather than COMPLETE

No implementation finding remains, so there is nothing further for the implementer to do. But
`COMPLETE` in this workflow asserts that the cumulative review is clean **and all required acceptance
evidence is available**, and it is not: the browser/manual matrix is entirely unrun, because neither
agent in this workflow was authorized to drive a browser.

That is precisely the documented meaning of `BLOCKED` — clean enough that no implementer finding
remains, but a required acceptance input is unavailable, so the feature is **not merge-ready**.
Recording `COMPLETE` would claim verification nobody performed.

This is resumable, not terminal. When the manual matrix has been run:

```powershell
python docs\specs\workflow\spec_workflow.py resume-final-review --message "Manual matrix run."
```

then the recorded results are folded into this same review and the parent completes normally. The
workflow forbids transitioning directly from `BLOCKED` to `COMPLETE` without that resumed review.

### What still needs a human at the keyboard

The cumulative matrix in 047.3 (items 1–40), plus 047.1 items 1–19 and 047.2 items 1–15. The items
that genuinely cannot be inferred from code are listed under *Browser / manual verification* above:
pane geometry and horizontal overflow, rendered source-colour parity, real drag-and-drop reordering,
light/dark and zoom legibility, keyboard reach of the nested row controls, and long-filename
truncation.

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

**Code-clean, not yet merge-ready.** Every review finding across the parent and all three children is
resolved, and every automated gate available in this repository passes on the final tree. The one
remaining gate is the browser/manual matrix, which is a human task.

Recommendation: run the cumulative matrix, then `resume-final-review` and complete. If any item fails,
it returns through the ordinary finding loop.

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

---

# Round 4 — R7–R10 fixes reviewed at `398b3c3`

## Process note: R3–R10 were never written to a canonical review file

The workflow guide makes the review file the canonical technical record, with each finding carrying
**Current / Target / Acceptance criteria**. This file stops at R4 and the 047.3 review file stops at
R2, yet the state file has cycled through R5, R6 and R7–R10. Those findings exist only as
one-paragraph coordination messages.

The practical cost is immediate: R7–R10 can only be checked against a single prose sentence each,
with no acceptance criteria to test against, and a later reader cannot reconstruct what was asked or
why. R11 below is a defect that acceptance criteria would plausibly have caught at authoring time.

Not a code finding, and not something to fix retroactively — but the remaining rounds should record
findings in this file.

## R7–R10 themselves: implemented

- **R7** — `ContinuationPreviewRequest` now carries `quantity` and `interpretation`, and the frontend
  sends both, so metric selection genuinely reaches the backend. `voltage_preview_from_raw` plots raw
  voltage against a source-total elapsed timeline. Discharge-only sources no longer error on absent
  charge points.
- **R8** — no layout-level plot title remains (the surviving `title` keys are axis titles);
  `showline: true` restores both axis lines; the interpretation selector is now a compact
  `Continuous cycles` switch below the chart.
- **R9** — `continuationSourceCanOpenRawData` takes a `rawDataAvailable` option and no longer keys
  raw inspection off `canonical_cycling`, with a comment stating the distinction correctly: raw
  inspection is a data-availability surface, not a canonical-cycle claim.
- **R10** — `buildContinuationPreviewTraces` dims unselected segments to `opacity: 0.62` while
  keeping every source's own colour, so emphasis does not break colour parity.

---

### R11 — High: in stitched mode, a cycle spanning a source boundary plots a false zero-capacity point

Affected files:
- `backend/app/routers/files.py`
- `tests/test_import_flow.py`

**Current**

`infer_contiguous_cycle_ids` deliberately assigns **one** cycle id across a file join — that is the
whole point of the Continuous cycles interpretation, and its docstring says so:

> "This makes a chain of discharge-only file fragments one logical cycle while retaining the source
> boundaries separately on the returned frame."

The endpoint then tears that logical cycle apart again. Capacity is computed per segment, on a slice
of the merged frame:

```python
segment_frame = merged[merged["segment"] == segment_index]
segment_cycles = calc.per_cycle(segment_frame)
segment_preview = capacity_preview_from_cycles(segment_cycles, ..., quantity=selected_quantity)
```

`calc.per_cycle`'s `phase_total` ends in `.reindex(index).fillna(0.0)`, so a cycle with **no rows of
the selected phase in that slice yields 0.0, not NaN**. `capacity_preview_from_cycles` only drops
NaN, so the zero survives into the response and is plotted.

Verified by running the real functions on a two-file chain whose cycle charges in file A and
discharges in file B:

```text
inferred cycle ids per segment: {0: [1], 1: [1]}      # same cycle spans the join, by design
segment 0: discharge points plotted = [(1, 0.0)]      # false zero
segment 1: discharge points plotted = [(1, 0.9999999999999999)]
```

So every boundary-spanning cycle draws a spike down to zero in the earlier source's trace — the exact
discontinuity artifact that Continuous cycles exists to remove, manufactured by the feature itself.
An interrupted-then-resumed run is the normal case for continued cells, so this is the common path,
not an edge case.

The existing test does not catch it because its fixture is symmetric — both files contain discharge
rows, so both segments produce a real value:

```python
self.assertEqual([segment["y"] for segment in response["segments"]], [[1.0], [2.0]])
```

That assertion also locks in the second facet of the same root cause: a shared cycle is emitted
**twice at the same x**, each value computed from only part of the cycle. Whether two partial points
at one x is acceptable display is a decision that was never made explicitly; a false `0.0` is not
defensible either way.

**Target**

A stitched cycle is aggregated once, over all of its rows, regardless of how many source files it
spans. `calc.per_cycle(merged)` is already computed for the quantity/label decision — reuse that
single result and partition the resulting per-cycle rows between segments (for example by the segment
that owns each cycle's first row, or its selected-phase rows), instead of re-running `per_cycle` on
segment slices.

Decide and document what a boundary cycle looks like on the chart: one point attributed to one
segment is the natural reading, and it also removes the duplicate-x question.

**Acceptance criteria**

- With a chain whose cycle charges in file A and discharges in file B, no segment reports a `0.0`
  capacity point for that cycle.
- Each stitched cycle contributes **one** point across the whole response, with the value it would
  have if the chain were a single file.
- A regression test covers the asymmetric case specifically (charge-only segment followed by
  discharge-only segment), not only the symmetric discharge/discharge fixture.
- The existing symmetric test is updated to whatever the decided behavior is, rather than continuing
  to assert two partial points at one x.
- Voltage mode is unaffected.

---

### R12 — Medium: `calc.per_cycle` is recomputed once per segment plus once for the whole chain, on the import path

Affected files:
- `backend/app/routers/files.py`

**Current**

The stitched capacity path runs the scientific per-cycle aggregation `N + 1` times over **raw** rows:

```python
merged_cycles = pd.DataFrame() if quantity == "voltage" else calc.per_cycle(merged)   # whole chain
...
    segment_cycles = calc.per_cycle(segment_frame)                                    # once per source
```

`merged_cycles` is used only to choose the quantity and label. This is the same wasteful shape as
047.2's R4 — a full-frame computation whose result is discarded except for a label — reintroduced at
a higher cost, because it now aggregates raw records rather than an already-reduced per-cycle table.
Parent 047 requires the combined preview to "remain cheap enough for import UX".

Fixing R11 as described removes this too: one `calc.per_cycle(merged)`, then partition its rows.

**Acceptance criteria**

- The stitched capacity path aggregates per-cycle data once for the chain, not once per segment.
- Quantity/label selection does not require a discarded full-frame computation.
- The bounded-response guarantees and per-segment point budget are unchanged.

---

## Verified clean in round 4

- No cache is written: the preview reads through `cache.load_raw(...)` only. `CALC_VERSION` is
  unmodified across the whole range, and no migration or model change appears.
- The preview-local mutations in `prepare_segmented_raw` (`__preview_step`, `preview_time_s`,
  `segment`) operate on copies and never reach a cache or the database.
- Missing raw caches fail closed with structured per-source detail and `409`, consistent with the
  classification model established in 047.2 R1.
- Cycle-inference failure is reported as its own `422` kind rather than being folded into a
  source-change conflict.
- `interpretation` defaults to `source_chain` on the API for compatibility while the continued-import
  UI sends `stitched` explicitly, so existing callers are unaffected.

## Round 4 resolution — R11 and R12 resolved (`b11c65d`)

Both findings shared one root cause and were fixed together, as the Target proposed:
`calc.per_cycle(merged)` now runs **exactly once** (a single call site remains in the stitched
builder), and its rows are partitioned between segments through a cycle-ownership map
(`merged[["cycle","segment"]].drop_duplicates(subset="cycle", keep="first")`) rather than being
recomputed on `merged[merged["segment"] == i]` slices.

I re-ran my original reproduction against the fixed path rather than trusting the report:

```text
before: segment 0 -> (cycle 1, 0.0)   segment 1 -> (cycle 1, 1.0)
after : segment 0 -> (cycle 1, 1.0)   segment 1 -> []
```

The boundary cycle now carries the value it would have had in a single file, on exactly one segment,
with no false zero — R11 criteria 1 and 2. The new
`test_continuation_preview_stitched_interpretation_attributes_boundary_cycle_to_one_segment` covers
the asymmetric charge-then-discharge case and asserts `0.0 not in segment["y"]` (criterion 3), and the
symmetric fixture was updated from two partial points to one aggregated point (criterion 4). Voltage
mode never used `calc.per_cycle` and is untouched (criterion 5). The per-segment `max_points`
budget still applies, so the bounded-response guarantee is intact (R12 criterion 3).

**Attribution choice, endorsed.** First-merged-row ownership is stable across metric changes — a
phase-based rule would move a boundary cycle between traces when the user switches capacity metric,
which would be worse. One consequence to watch in the browser matrix rather than fix now: a source
consisting only of the tail of a cycle started in the previous file renders an **empty trace** in
stitched mode, and R10's selection emphasis then highlights nothing for that source. That follows
directly from "one cycle, one point" and is honest, but it should be seen on real data before merge.

047.3 is review-clean. The workflow advances to 047.4; the cumulative parent review will be performed
once, after that child lands.

---

# Round 5 — cumulative parent review at `a0d6471`

**Reviewed range:** `main..HEAD` = 55 commits, merge base `5e50736` (still `main`'s tip — clean
fast-forward, no divergence). Four children, all individually review-clean. Version
`0.27.0-beta.11`.

This supersedes rounds 1–3 of this file, which reviewed `0.27.0-beta.1` at 24 commits and are now
history rather than merge evidence.

**Result:** Changes required — R30 (Medium). Everything else in the cumulative scope is clean.

---

## R30 — Medium: remove the Continuity review ceremony, but relocate the two parts that carry safety

Affected files:
- `frontend/src/components/ContinuedImportEditor.tsx`
- `frontend/src/components/ContinuationReviewModal.tsx`
- `frontend/src/continuationPolicy.ts`

**Current**

The user reports the Continuity review surface as friction whose purpose is unclear, and asks for it
to go. Having traced what it still does, the *ceremony* can go — but two of its jobs cannot, and
deleting the surface outright would break the import flow rather than smooth it.

What is genuinely vestigial: the explicit inspection gate is already gone. `inspectionQuery` now runs
on `enabled: opened && orderedDrafts.length >= 1`, so continuity is inspected automatically. The
command that remains says **Review continuity** and does nothing except open a modal. That button,
the modal, and the auto-open interruption are pure overhead.

What is not vestigial:

1. **Blocking findings.** `continuations.py` raises `duplicate_hash`, `source_missing`,
   `source_unreadable`, `unsupported_extension`, `hash_already_linked`, `cache_build_failed` and
   others at `severity="blocking"`. These set `can_submit = false` server-side. If the only surface
   that displays them is deleted, the footer Import button is disabled with no visible reason — the
   exact dead end that 047.3 R1 was raised to fix.

2. **Confirmation findings.** `metadata_only_source`, `timestamp_overlap`, `path_refresh` and the
   capacity/mass mismatch are `severity="confirmation"`. Submission requires their IDs in
   `acknowledged_finding_ids`, and the server rejects a payload without them. Delete the only place
   they can be ticked and **those imports become impossible** — a metadata-only BioLogic source, or
   any pair with overlapping timestamps, could never be imported at all. That is a far worse outcome
   than the friction being removed.

**Target**

Delete the ceremony; keep the two obligations, inline and compact.

- Remove the **Review continuity** command, `ContinuationReviewModal.tsx`, and the auto-open effect.
- **Blocking findings** render inline in the workspace, attached to the source row they name where a
  source key is present, plus the existing one-line footer reason. Red, concise, no Alert stack.
- **Confirmation findings** render as a compact inline checkbox row above the footer, shown *only*
  when at least one exists. One checkbox per finding, still bound to the finding ID, still driving
  `acknowledged_finding_ids`.
- **Warning/info findings** are simply dropped from the UI. Nothing depends on them and Parent 047
  decision 7 already bans them from the workspace.

The result is less friction than today, not more: no extra button, no modal, no interruption, and in
the clean case — which is the common one — nothing appears at all.

Do not weaken any gate. `continuedImportCanSubmit(...)`, `preserveAcknowledgements(...)` and
`acknowledgedMetadataOnlySourceKeys(...)` keep their current semantics; only where the user reads and
ticks changes. The server stays authoritative.

**Acceptance criteria**

- No Review continuity command and no continuity modal anywhere in the import flow.
- A chain with a blocking finding shows the reason inline and keeps Import disabled.
- A chain with a confirmation finding can be acknowledged inline and imported, and cannot be imported
  without acknowledging — proving the path still exists end to end.
- A clean chain shows no finding UI whatsoever.
- Acknowledgement identity is unchanged: reordering or changing a source still expires a stale
  acknowledgement.
- Existing `continuationPolicy` coverage stays green; `continuationReviewRequired` /
  `continuationHasFindings` are removed or repurposed rather than left orphaned.
- Existing-cell continuation management (`ContinuationManagementPanel`) is unaffected.

---

## Cumulative verification — clean

Run by the reviewer on `a0d6471`:

```text
python scripts\preflight.py       PASS (4/4)
npx.cmd tsc --noEmit              PASS
npx.cmd vite build                PASS
check_versions.py                 PASS (0.27.0-beta.11, all declarations)
focused backend + frontend suites PASS
```

### Invariants held across all four children

- **Merge base `5e50736` is still `main`'s tip** — 0 commits on main only, 55 on the branch. The
  branch fast-forwards; no divergence, no rebase needed.
- **No scientific meaning changed.** `CALC_VERSION` is unmodified across the whole range. No change
  to cache identity, checksum ownership, or the portable-report format.
- **Schema changes are forward-safe.** `v0004` describes what a database stamped `0004` actually
  contains, and `v0005` carries it forward; both paths converge, verified against a real failing
  database (R22).
- **Separate-cell mode is untouched.** Zero lines of the branch diff touch its payload branch,
  replicate groups, or its import button.
- **Existing-cell continuation management is untouched.** `ContinuationManagementPanel` passes no
  `variant`, so the default detailed source list is preserved.
- **Automation cannot act on the user's behalf.** The watcher parks blocking and confirmation
  findings and never acknowledges; and after R26 it never attaches a file the user declined.
- **Documentation closed.** `state-and-performance.md` records the combined-preview boundary;
  `CELLXPLORER_ARCHITECTURE.md` carries the corrected `Cell → ordered SourceFiles` hierarchy and the
  current MPR capability; both project-context files carry updated synchronization metadata.

### Checked and accepted

`ContinuationManagementPanel` also calls `navigate("/settings/monitoring")`, the pattern R29 removed
from the tracking dialog. It is safe there: the panel renders inside `CellDetailTabs` on a Cell page,
not inside a modal flow, so navigating away discards no staged work. No finding.

---

## Merge readiness

Two gates remain, unchanged in character from the first cumulative review:

1. **R30** above.
2. **The browser/manual matrix, still NOT RUN.** It now covers four children — including R13's
   checkbox fix, R23's relocated command row, R26's baseline behavior and R27's banner toggle, none
   of which any automated check in this repository can confirm.

Everything a machine can verify on this branch passes. What remains is what a machine cannot.

## Project mirror handoff

```text
Replace uploaded Project file:
- CELLXPLORER_ARCHITECTURE.md
- CELLXPLORER_PROJECT_INSTRUCTIONS.md
```
