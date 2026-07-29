# Feature specs

Implementation plans for requested features. One Markdown file per request (or per coherent
batch of related requests). Each spec is written to be followed closely by an AI agent that
did **not** see the originating conversation, so it must be self-contained:

- State what already exists (files, functions, endpoints) so nothing is rebuilt.
- For each task: the exact file(s), current behaviour, target behaviour, and acceptance
  criteria. Reference code with grep-able anchors, not just line numbers (they drift).
- Call out data shapes, API endpoints, and any cache/recompute implications.
- End with a suggested implementation order and how to verify (`tsc`, `vite build`, `pytest`).

## Visual contract

Every spec that creates or changes UI inherits
[`../agent-knowledge/visual-style-guide.md`](../agent-knowledge/visual-style-guide.md), whether or
not the spec repeats that link. Spec authors and implementers must read it before making visual
decisions.

A spec may override the guide only through an explicit **locked design decision**. State the
exception, its scope, and why it is necessary; all unspecified details still follow the guide.
UI specs must include acceptance criteria for the relevant control geometry, light/dark behavior,
loading and failure states, truncation/overflow, and accessibility. A reference image defines the
requested composition, but it does not silently replace the application's established colors,
button hierarchy, typography, or feedback semantics.

## Branch workflow

Implement features **one at a time** on dedicated branches:

1. **Check for an open branch first.** If a feature branch is already in progress, complete and
   merge it before starting another feature. Do not leave multiple open feature branches.
2. **Branch before implementing.** When a spec moves from Plan to Implement, create a feature
   branch from current `main`. Record the branch name in the spec's implementation record when
   work begins.
3. **Push for review.** After each reviewable checkpoint (spec implementation complete, or a
   logical milestone the user should see), commit on the feature branch and push to `origin`:
   `git push -u origin HEAD` the first time, then `git push`. Other agents and reviewers depend
   on the remote branch; do not leave finished work local-only unless the user explicitly opts out.
4. **Stay sequential.** Finish branch A → merge to `main` → start branch B. Parallel feature
   branches are discouraged because they often touch the same files (for example
   `LibraryPage.tsx` or `AnalysisPage.tsx`) and create merge conflicts.
5. **Verify on the branch.** Run `python scripts\preflight.py` before merge. Do not rely on
   feature-branch pushes for CI; preflight on GitHub runs for `main`, release tags, and manual
   workflow dispatch only.

Example:

```powershell
git checkout main
git pull
git checkout -b feature/cell-table-pagination
```

## Lifecycle

A spec is a living document, not a one-shot brief:

1. **Plan** — the sections above, written before implementation.
2. **Branch** — create one feature branch from `main`. Do not start a new branch while another
   feature branch is still open.
3. **Implement** — the agent follows the spec on that branch.
4. **Push** — commit reviewable work and push the branch to `origin` so another agent or reviewer
   can read the diff without your local tree.
5. **Review** — a reviewer writes findings to a **separate** review file under
   [`reviews/`](reviews/) (`reviews/NNN-short-kebab-title-review.md`), containing:
   - the verification actually run (commands + results), so nobody repeats it;
   - what was confirmed correct by reading the code, so nobody re-litigates it;
   - any pre-existing/known failures, explicitly flagged as *not* to be "fixed";
   - each finding as a numbered follow-up task (`R1`, `R2`, …) in the same
     file / current / target / acceptance format, with a priority;
   - what remains unverified (e.g. anything needing a real browser or the shared dev DB).

The implementing agent then works the `R*` tasks from that review file while keeping the linked
specification as the source of truth for intended behaviour. Do **not** append review findings or
`R*` task lists into the specification file itself.

### Handoff prompt

Paste this to the implementing agent, filling in the spec number. Add a short "watch out for"
line only when a task carries a hazard the spec cannot fully express (e.g. "R1 can only be
verified in a packaged build").

```
Implement the review follow-ups in docs/specs/reviews/NNN-<name>-review.md.

Read that review file first, then read the linked specification it reviews. The spec body is the
source of truth for intended behaviour; the review lists the tasks (R1, R2, ...).
For any UI work, also read docs/agent-knowledge/visual-style-guide.md before editing.

Rules:
0. Work on the spec's feature branch. If another feature branch is already open, finish it
   before starting this spec.
1. Do the R tasks in the order given under "Follow-up order", and only those. No
   unrelated refactors, no scope expansion.
2. The review's confirmed/verified list is settled. Do not re-check, re-derive
   or "improve" those — changing them is a regression, not a cleanup.
3. Decisions marked locked in the spec body stay locked. If a task seems to require
   breaking one, stop and ask instead of deciding for yourself.
4. Anything the review flags as a known/pre-existing failure is out of scope. Do not
   try to fix it.
5. Prefer patterns already used in this repo over inventing new ones — the review
   usually names the file that already does it right.
6. Run the checks in the spec's Verification section for the parts you touched. If a
   task cannot be verified in your environment, say so plainly rather than assuming
   it works.
7. When done, append a "## R* implementation record" to the review file (or update the
   linked spec's implementation record section if the spec already defines one): what
   changed per task, what you ran and the result, and anything you deliberately did
   not do.
8. Do not modify unrelated uncommitted work in the tree.
9. UI changes inherit the visual style guide unless this spec explicitly marks an override
   as a locked design decision.
10. After reviewable implementation, commit and push the feature branch to `origin` unless the
   user explicitly opts out. Other agents review from the remote branch.

Ask if a task is ambiguous rather than guessing.
```

The result comes back for review, which updates `R*` outcomes in the review file — the loop
continues until the section is clean.

### When to run `vite build`

`npx vite build` costs ~43 s and is the slowest check in the repo, so do not run it reflexively —
but do not skip it on a hunch either. It catches what `tsc` cannot: Rollup-level module
resolution, missing or renamed static assets, `index.html` references, CSS/asset pipeline
failures, dynamic `import()` of a non-existent path, and plugin/config errors.

**Required** when any of these changed:
`frontend/src/**` · `frontend/index.html` · `frontend/public/**` · `frontend/vite.config.ts` ·
`frontend/tsconfig.json` · `frontend/package.json` / `package-lock.json`.

**Not required** for: `frontend/tests/**` (not in the tsc program — `include` is `["src"]` — and
not in the Vite entry graph, so these need only `node --test`) · `backend/**` · Python `tests/**`
· `scripts/**` · `src-tauri/**` (validated by `cargo` / a Tauri build) · `docs/**` and Markdown.

`tsc --noEmit` is separate and much cheaper: run it for any `frontend/src/**` or `tsconfig.json`
change even when a full build is not warranted.

**When in doubt, build** — an unnecessary build is cheap; shipping an unbuildable tree is not.
Never skip the build for a release or packaging artefact. The authoritative table lives in
[`013-faster-preflight.md`](013-faster-preflight.md) §2.4, which also binds it to the automated
skip cache; keep the two in sync.

### Review effort

Reviews are **code reading first**. The implementer has normally already run `tsc`, the build,
and the test suite, so do not re-run them by default — say in the review that they were taken
as given. Spend the time on the things reading catches and tooling does not: correctness of the
core logic, spec deviations, and hazards the spec did not anticipate.

Run something only when it is cheap **and** decisive for a specific doubt — e.g. a single new
unit-test file that pins the change's core rule, or a read-only probe against real cached data
to confirm a numeric claim. Always state what was run and what was taken on trust.

**Beware of greps that cannot see the thing you are auditing.** A negative grep result only
proves the pattern you searched for is absent. Spec 004's review wrongly declared the dark-mode
sweep complete after grepping hex literals in `.tsx`; the remaining light surfaces were in
`bg="gray.0"` props and `.module.css` files, which that pattern could never match. When
auditing theming in this Mantine codebase, cover **all** of: hex literals, `bg="<colour>.0"` /
`.1` props, `var(--mantine-color-*-0)`, `--mantine-color-white`, and every `*.module.css`.
Numbered Mantine shades are fixed in both schemes — only semantic tokens and `light-dark(…)`
respond to the colour scheme.

## Naming

`NNN-short-kebab-title.md`, where `NNN` is a zero-padded counter that increments per spec
(`001-`, `002-`, …). The number is assigned when the spec is created and never reused, so it
is a stable handle to reference a spec in conversation ("finish 002") regardless of title
edits. Keep the index below in order.

Review documents use the same number and title with a `-review` suffix, stored separately under
[`reviews/`](reviews/): `reviews/NNN-short-kebab-title-review.md`. Multi-spec reviews may use a
combined name (for example `reviews/013-014-build-performance-review.md`).

## Ingesting specs and reviews from Downloads

When a spec or review is provided in the user's **Downloads** folder (or attached in chat), the
implementing agent must **copy it into this repository immediately** — do not implement from the
Downloads path alone.

| Kind | Copy to |
|---|---|
| New or updated spec | `docs/specs/NNN-<name>.md` |
| Review / follow-up tasks | `docs/specs/reviews/NNN-<name>-review.md` |

Rules:

1. Copy on receipt, before or at the start of implementation — not after merge.
2. Normalize Windows duplicate suffixes such as `(1)` to the canonical filename.
3. Update the spec index below and any `Review document:` cross-links in the related spec.
4. Do not edit the Downloads original; the repository copy is the source of truth from then on.
5. If a review arrives while work is in progress, copy it to `reviews/` and continue follow-ups
   from that file.

## Reviews index

- [010-cell-library-columns-and-status-review.md](reviews/010-cell-library-columns-and-status-review.md)
- [011-cell-library-toolbar-source-maintenance-review.md](reviews/011-cell-library-toolbar-source-maintenance-review.md)
- [012-cell-library-sort-and-filter-review.md](reviews/012-cell-library-sort-and-filter-review.md)
- [013-014-build-performance-review.md](reviews/013-014-build-performance-review.md)
- [015-golden-analysis-regression-corpus-review.md](reviews/015-golden-analysis-regression-corpus-review.md)
- [017-secure-tauri-updater-foundation-review.md](reviews/017-secure-tauri-updater-foundation-review.md)
- [018-in-app-update-experience-review.md](reviews/018-in-app-update-experience-review.md)
- [019-automated-github-release-publishing-review.md](reviews/019-automated-github-release-publishing-review.md)
- [017-019-updater-cumulative-review.md](reviews/017-019-updater-cumulative-review.md)
- [020-windows-update-notification-and-manual-modal-review.md](reviews/020-windows-update-notification-and-manual-modal-review.md)

## Index

- [001-folders-replicates-and-recognition-ux.md](001-folders-replicates-and-recognition-ux.md)
  — folder/replicate placement refinements (project view + cell database), a read-only
  protocol-structure viewer for C-rate/Chargeability auto-identification (item 2), and a
  realistic recognition progress bar replacing the spinner (item 9).
  **Implemented; reviewed — follow-ups R1–R3 done.**
- [002-place-in-folders-picker-redesign.md](002-place-in-folders-picker-redesign.md) —
  redesign of the "Place in folders" dialog: collapsible folder tree with search, read-only
  impact pane, and a strictly **additive** model (removal stays in the Projects view).
  Frontend-only. **Implemented; reviewed — follow-ups R1–R4 done.**
- [003-per-cycle-capacity-step-reset-fix.md](003-per-cycle-capacity-step-reset-fix.md) —
  scientific-correctness fix: `per_cycle` took a per-cycle **maximum** of Neware capacity and
  energy counters that **reset at every step**, so a CC+CV charge lost its CV portion and
  coulombic efficiency read above 100 %. Now summed per step. Backend + `CALC_VERSION` bump.
  **Implemented and verified against real data.**
- [004-app-shell-quick-settings.md](004-app-shell-quick-settings.md) — desktop-feel app shell:
  suppress the browser context menu except in text fields, and add a quick-settings menu to the
  top-right strip (reload interface, restart CellXplorer, theme, pause automatic updates).
  Includes dark mode, scoped to the chrome — **plots stay light**.
  **Implemented; reviewed — follow-ups R1–R4 done (R1 still needs a packaged Restart click).**
- [005-warmup-queue-deadlock-fix.md](005-warmup-queue-deadlock-fix.md) — a failed thumbnail or
  artifact lookup left a warmup task with no terminal state, latching `busy` and stalling the
  background queue for the whole session (missing thumbnails, uncached analyses). Completion
  logic extracted to one tested pure resolver, plus a per-task watchdog. Frontend-only.
  **Implemented.**
- [006-destructive-impact-warnings-and-draft-plots.md](006-destructive-impact-warnings-and-draft-plots.md)
  — (A) warn which analyses and saved plots an explode/cell-removal will affect, including ones
  left with no samples, via a new read-only `/api/analyses/usage` endpoint; (B) make an unsaved
  plot visible as an amber draft card that can survive leaving the analysis. **Implemented.**
- [007-application-version-consistency-check.md](007-application-version-consistency-check.md)
  — read-only `python scripts/check_versions.py` command that verifies every maintained version
  declaration matches (backend, npm manifests and lockfiles, Tauri config, Rust crate and lock).
  Developer tooling only. **Implemented.**
- [008-canonical-local-preflight-command.md](008-canonical-local-preflight-command.md)
  — `python scripts/preflight.py` runs version consistency, backend tests, frontend policy tests,
  and the frontend production build in order with isolated `CELLXPLORER_DATA`. Developer tooling
  only. **Implemented.**
- [009-automatic-clean-environment-preflight.md](009-automatic-clean-environment-preflight.md)
  — automatically runs the canonical CellXplorer preflight on a clean Windows environment
  whenever `main` changes, when a version tag is pushed, or when manually requested.
  **Implemented.**
- [010-cell-library-columns-and-status.md](010-cell-library-columns-and-status.md)
  — replace low-value Tests/Files columns with replicate membership and cached maximum specific
  discharge capacity, plus an explanation of the existing status badges.
  **Implemented.**
- [011-cell-library-toolbar-source-maintenance.md](011-cell-library-toolbar-source-maintenance.md)
  — right-align Cell Database actions and combine source checking/updating into a split action while
  preserving selected-cell scope and one-cell add-to-replicate behavior.
  **Implemented.**
- [012-cell-library-sort-and-filter.md](012-cell-library-sort-and-filter.md)
  — add Excel-style header menus with typed filters and one-column sorting to the Cell Database,
  applied before pagination with tested selection safety.
  **Implemented.**
- [013-faster-preflight.md](013-faster-preflight.md)
  — second round of preflight speedups from measured timings: split the serial `tsc && vite`
  stage into two parallel stages, parallelise the one backend test that is 47 % of the suite,
  and skip the frontend build when no frontend input changed. Also carries the normative
  **when-to-run-`vite build`** rule (§2.4). Tooling only.
  **Implemented.**
- [014-plotly-runtime-consistency-and-tsc-incremental.md](014-plotly-runtime-consistency-and-tsc-incremental.md)
  — (A) fail preflight when the bundled Plotly and the Plotly embedded in portable HTML reports
  drift apart, a silent correctness hazard today; (B) enable incremental type-checking, measured
  at ~15 s → ~6 s warm. Tooling/config only.
  **Implemented.**
- [015-golden-analysis-regression-corpus.md](015-golden-analysis-regression-corpus.md)
  — committed full Neware source binaries and golden backend analysis projections for cycles,
  time/capacity, steps, DCIR, chargeability, and rate capability.
  **Implemented** — Round 4 engineering fixes complete; scientific checkpoints approved and
  explicit privacy approval remains pending.
- [016-reindex-remaining-cycles-has-no-effect.md](016-reindex-remaining-cycles-has-no-effect.md)
  — the Cycles-tab "Reindex remaining cycles" toggle does nothing: `viewSignature` omits the
  flag so the trace memo never recomputes, and `zoomSignature`/`uirevision` would re-apply the
  stale x range. Frontend-only. **Implemented** (0.14.3).
- [017-secure-tauri-updater-foundation.md](017-secure-tauri-updater-foundation.md)
  — secure Tauri updater substrate: signed manifest, NSIS updater artifacts, Rust pending-update
  state, and narrow check/download/install commands. Desktop-only; no in-app UI yet.
  Review: [017-secure-tauri-updater-foundation-review.md](reviews/017-secure-tauri-updater-foundation-review.md)
  (**Implemented**; review follow-ups addressed). Branch `feature/updater-017-019`.
- [018-in-app-update-experience.md](018-in-app-update-experience.md)
  — power-menu update indicator, modal, download progress, and installer launch via Spec 017
  commands. Review: [018-in-app-update-experience-review.md](reviews/018-in-app-update-experience-review.md)
  (**Implemented**; review follow-ups addressed). Branch `feature/updater-017-019`.
- [019-automated-github-release-publishing.md](019-automated-github-release-publishing.md)
  — tag-triggered GitHub release workflow, signed `latest.json`, and combined minor version bump to
  0.15.0. Review: [019-automated-github-release-publishing-review.md](reviews/019-automated-github-release-publishing-review.md)
  (**Implemented**; review follow-ups addressed — do not push `v0.15.0` until repo is public and
  017/018 re-review is clean). Branch `feature/updater-017-019`.
- [020-windows-update-notification-and-manual-modal.md](020-windows-update-notification-and-manual-modal.md)
  — native Windows notification for automatic update discovery; manual Check for updates opens the
  existing update modal directly with no Mantine discovery toaster. **Implemented** (0.16.0); review
  follow-ups in progress — not merge-ready until installed Windows body-click matrix is recorded.
  Review: [020-windows-update-notification-and-manual-modal-review.md](reviews/020-windows-update-notification-and-manual-modal-review.md).
  Branch `feature/windows-update-notification`.
- [021-stable-beta-app-identities.md](021-stable-beta-app-identities.md)
  — side-by-side Stable and Beta Windows application identities from one source tree: separate
  product/identifier/installer, Beta blue theme and badge, channel-aware build commands, and
  fail-closed Beta updater until Spec 023 (removed in Spec 023). Data isolation and Beta feed are Specs 022–023.
  Review: [021-stable-beta-app-identities-review.md](reviews/021-stable-beta-app-identities-review.md).
  Branch `feature/stable-beta-app-identities`.
- [022-beta-data-isolation.md](022-beta-data-isolation.md)
  — separate Beta data root (`.cellxplorer-beta`), one-time Stable library copy via SQLite
  backup, blocking first-run modal, and token-scoped apply/restart. Part of the Spec 021–023
  release train on branch `feature/stable-beta-app-identities`. Depends on Spec 021 identities.
  Review: [022-beta-data-isolation-review.md](reviews/022-beta-data-isolation-review.md).
- [023-stable-beta-release-channels.md](023-stable-beta-release-channels.md)
  — separate Stable/Beta updater feeds on `release-channels`, true Beta GitHub prereleases,
  Stable-owned Beta installation UX, and channel-aware release automation. Part of the Spec
  021–023 release train on branch `feature/stable-beta-app-identities`. Depends on Specs 021–022.
  Review: [023-stable-beta-release-channels-review.md](reviews/023-stable-beta-release-channels-review.md).
- [024-same-folder-drop-deletes-items.md](024-same-folder-drop-deletes-items.md)
  — data-loss fix: dropping a cell or replicate group into the folder it already lived in
  deleted it. `move_folder_cells` added to the target then deleted from the source, and
  `add_cell_refs` skips ids already present, so a same-folder move removed the only membership
  row. Backend early return + a per-item client guard that also covers Move to / Copy to.
  **Implemented.** Branch `feature/same-folder-drop-fix`.
- [025-project-folder-sections.md](025-project-folder-sections.md)
  — optional collapsible Analyses / Samples sections inside each project folder, with a global
  samples-first / analyses-first order, counts in the headers, and empty sections omitted. The
  render and `visibleTreeItems` share one ordering function so shift-click ranges cannot drift
  from what is on screen. Frontend-only. **Implemented.** Branch `feature/projects-folder-sections`.
- [026-project-explorer-metric-columns.md](026-project-explorer-metric-columns.md)
  — cycle-count and peak-specific-discharge-capacity columns for cells and replicate groups
  (mean of members), plus a saved-plot count using the exact shared Analysis Database hover
  preview and its cached 4:3 assets. Folder rows deliberately have no scientific rollup.
  Aggregates, effective active masses, and compact saved-plot indexes are bulk-loaded so
  `/api/tree` does not become N+1. **Implemented.**
  Branch `feature/projects-explorer-metrics`.
- [027-source-monitor-schedule-units-and-preview.md](027-source-monitor-schedule-units-and-preview.md)
  — weekly fixed-time schedules (months deliberately excluded), seconds/minutes/hours retry
  delays with a 10 s floor, save-time validation that the retry span cannot outlast the check
  frequency, and a "Next checks" preview computed server-side. Legacy config keys are upgraded
  on read. **Implemented.** Branch `feature/source-monitor-schedule-units`.
- [028-per-cycle-cv-and-status-performance.md](028-per-cycle-cv-and-status-performance.md)
  — `per_cycle` was half of import compute and 77 % of it was one function building a pandas
  sub-frame per (cycle, step) group; status predicates also ran `str.contains` over every row
  when a file carries four distinct status values. Now a numpy walk plus a `status_matches`
  helper shared with `analysis_engine`. Measured 2.61× on `per_cycle` across a real library,
  output bit-identical (the golden corpus diff is 8 paths, all `calc_version`).
  `CALC_VERSION` 1.6.0. Also records why the parse side is **not** worth optimising.
  **Implemented.** Branch `feature/calc-status-and-cv-vectorization`.
- [029-ci-python-314-and-packaged-backend-smoke-test.md](029-ci-python-314-and-packaged-backend-smoke-test.md)
  — CI built the sidecar on Python 3.12 while `requirements.txt` was pinned from 3.14, and
  `release.yml` checked only that the sidecar *file* existed. Now both workflows use 3.14
  (which also brings zlib-ng: 1.54x on `.ndax` inflate, ~4% of import compute, no new
  dependency), and `scripts/smoke_packaged_backend.py` starts the real frozen binary and
  asserts the API before anything is published. **Implemented** — the 3.14 bump still needs a
  real `windows-latest` CI run to prove wheel availability and PyInstaller support.
  Branch `feature/ci-python-314-and-sidecar-smoke`.

## Assets

Mockups and reference images live in `assets/`, named after the spec that owns them
(`assets/002-place-in-folders.png`). Reference them from the spec with a relative Markdown
image link, and state explicitly whether the image or the written rules win where they
disagree.
