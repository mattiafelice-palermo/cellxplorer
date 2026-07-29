# 031 — Library and Projects selection refinements

**Status:** Implemented  
**Branch:** `feature/adaptive-beta-scientific-preparation`  
**Branch note:** The user requested this follow-up before Spec 030 was committed. It is implemented
on the existing dirty feature branch to preserve that work; no second concurrent branch is opened.  
**Scope:** Projects analysis creation and selection, Cell Database selection and placement,
destructive-impact confirmation presentation, and updater release-note rendering.

All UI work inherits
[`../agent-knowledge/visual-style-guide.md`](../agent-knowledge/visual-style-guide.md).

## Existing anchors

- `frontend/src/pages/ProjectsPage.tsx`
  - `visibleTreeItems`, `handleSelect`, `openCreateAnalysis`, and the Projects toolbar.
- `backend/app/routers/analyses.py`
  - `AnalysisCreate` and `create_analysis`.
- `frontend/src/pages/LibraryPage.tsx`
  - `toggleCellSelection`, the cell table, placement and replicate dialogs.
- `frontend/src/components/PlaceInFoldersModal.tsx`
  - additive multi-folder placement.
- `frontend/src/components/DestructiveImpactModal.tsx`
  - analysis-usage preflight and the current second-modal handoff for no-impact operations.
- `frontend/src/appUpdater.ts` and `components/AppUpdateModal.tsx`
  - release-note line parsing and rendering.

## Locked behavior

### Projects: create analysis from selected samples

- The primary split-button action reads **New analysis (N)** when the current selection contains
  `N` cells and/or replicate groups.
- Its primary action opens the existing create-analysis form and creates the analysis with those
  sample entries already present, preserving their tree order.
- The joined chevron menu contains **Open empty analysis**, which ignores the current selection.
- With no sample selection, the primary action creates an empty analysis and reads
  **New analysis**.
- The backend accepts optional initial selection entries, validates referenced cells/groups, removes
  exact duplicates without reordering, and writes them into a normal full default analysis spec.

### Selection boundaries and keyboard extension

- A plain row click replaces the current Projects selection.
- Ctrl/Cmd-click toggles compatible items only.
- Shift-click ranges are limited to one semantic scope:
  - samples in one folder;
  - analyses in one folder;
  - folders as folders.
- A folder can never coexist with samples in one selection.
- Sample ranges never cross folder boundaries.
- In both Projects and the Cell Database, Shift+Up/Down extends the current contiguous selection
  within the current folder/list. It does not run while an input, editor, menu, or modal owns the
  keyboard.

### Cell Database row behavior and dark selection

- Clicking a cell row selects/toggles it; Shift-click keeps the existing page-local range behavior.
- The cell name is an explicit keyboard-accessible link-like control with a pointer cursor; clicking
  it opens the existing cell preview without toggling selection.
- Checkbox, hover/popover, and action controls do not bubble into the row action.
- Selected rows use the theme-aware primary-light surface, retaining readable text in Light, Dark,
  and Auto modes.

### Place as replicate

- The Cell Database placement footer uses **Place** instead of **Apply**.
- When at least two cells are selected it also offers **Place as replicate**.
- That action does not create a group immediately. It closes placement and opens the existing
  replicate creation dialog with:
  - the normal suggested name;
  - folders already containing selected cells plus newly staged destinations preselected.
- The user can edit the name and folder list before committing.
- On commit, the backend's existing atomic `remove_folder_cells` operation replaces the selected
  cells' individual references in the chosen folders with the new replicate-group reference. The
  canonical cells remain in the Cell Database.
- Ordinary placement remains additive and unchanged. Single-cell and replicate-group placement do
  not offer the replicate action.

### Destructive preflight and release notes

- Destructive impact preflight does not display a transient loading modal.
- Once the usage request settles, the same modal renders either the impact-aware confirmation, the
  plain confirmation, or the existing warning fallback. There is no second modal handoff.
- Updater notes recognize Markdown ATX headings (`#` through `######`) and render them as weighted
  section labels without visible hashes.
- `**bold**` and `__bold__` spans render with bold weight in headings, prose, and bullets. Other
  Markdown is left as literal safe text; no HTML is injected.

## Data and scientific consequences

- No migration, `CALC_VERSION`, cache identity, or scientific calculation change.
- Existing analysis creation remains backward compatible when initial entries are omitted.
- Replicate creation continues through the existing validated backend endpoint.

## Verification

```powershell
python -m unittest tests.test_analysis_lifecycle
node --test frontend\tests\appUpdater.test.ts frontend\tests\destructiveImpact.test.ts frontend\tests\projectSelection.test.ts
cd frontend
npx.cmd tsc --noEmit
npm.cmd run build
```

Run the full backend/frontend suites if focused checks pass. Do not browser-test unless explicitly
requested.

## Acceptance checklist

- [x] New analysis split action reflects and imports the selected sample count.
- [x] Empty analysis remains explicitly available.
- [x] Projects selection cannot mix folders with samples or cross sample folders.
- [x] Shift+Up/Down extends Library and Projects selections.
- [x] Cell row/name interactions and selected dark-mode contrast are corrected.
- [x] Place and Place as replicate preserve an explicit review step.
- [x] Replicate confirmation no longer flashes a loading/intermediate modal.
- [x] Release-note headings and bold spans render typographically.
- [x] Focused and full automated checks pass; no browser check is claimed.

## Implementation record

Implemented on `feature/adaptive-beta-scientific-preparation`.

- Added validated, order-preserving initial analysis entries to `POST /api/analyses`.
- Added a Projects split action, folder-local selection scopes, and Shift+Arrow extension.
- Made Cell Database rows selectable, names explicit preview controls, and selected surfaces
  theme-aware. Library rows now own keyboard focus so Shift+Up/Down works after either an ordinary
  row click or a checkbox click; names and action controls remain isolated from row selection.
- Extended the additive placement modal with a reviewed replicate path that reuses the existing
  naming/folder dialog and the backend's atomic folder-reference replacement.
- Removed the destructive-confirmation two-modal handoff and kept the surface hidden during its
  usage preflight.
- Added safe release-note heading and inline-bold rendering without HTML injection.

Verification completed:

- `python -m py_compile backend\app\routers\analyses.py`
- `python -m unittest tests.test_analysis_lifecycle -v` — 11 passed.
- Focused frontend policy tests — 50 passed.
- `npx.cmd tsc --noEmit`
- `python -m unittest discover tests` — 613 passed.
- `node --test frontend\tests\*.test.ts` — 251 passed.
- `npm.cmd run build` / final `npx.cmd vite build` — passed; only the existing large-chunk warning.
- `git diff --check`

The Library row-focus follow-up was rechecked with TypeScript compilation, all 251 frontend policy
tests, and a production Vite build.

No browser verification was run, as requested.
