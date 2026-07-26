# Change playbooks

## Persistent schema change

1. Add a forward-only revision under `backend/app/migrations/`.
2. Preserve older user data and reject databases newer than the app supports.
3. Never edit a released migration.
4. Add focused migration and data-preservation tests.
5. Verify backup and diagnostics behavior using `docs/database-migrations.md`.

## Scientific calculation change

1. Keep deterministic calculations in backend services.
2. Decide whether the meaning of cached output changed; if so, bump `CALC_VERSION`.
3. Preserve raw/source metadata and provenance.
4. Add numerical tests covering units, missing metadata, and boundary cycles.
5. Check that UI explainers and exported labels describe the implemented formula.

## Frontend server-state change

1. Use React Query for backend-owned state.
2. After a mutation, update or invalidate every affected list, detail, folder, replicate, analysis,
   preview, and activity query.
3. Keep compact cached data visible during background refresh.
4. Distinguish loading, error, and a confirmed empty response.
5. If adding startup persistence, explicitly allowlist the query and verify that it contains no raw
   scientific data.

## UI or visual change

1. Read [`visual-style-guide.md`](visual-style-guide.md) before editing.
2. Reuse the closest shared component and match neighbouring control geometry.
3. Check chrome colors for both light and dark; keep Plotly presentation independent.
4. Cover loading, empty, error, disabled, unsaved, and success states as applicable.
5. Check truncation, overflow, keyboard access, tooltips, and accessible names.
6. Run TypeScript/build checks. Perform visual browser verification when requested or required by
   the active spec; never claim an unperformed visual check passed.

## Adding a hook to a large page component

`AnalysisPage` (and any component with early returns such as
`if (analysis.isLoading || spec === null) return ...`) must receive new `useState`, `useRef`, and
`useEffect` calls **above** those returns. Adding a hook further down compiles and type-checks
cleanly but throws "Rendered more hooks than during the previous render" the moment the early
return path is taken, which blanks the route behind the error boundary. A one-shot effect may
still reference a `const` callback declared later in the body: the closure resolves when the
effect runs, not when it is created.

## Verifying UI in the browser

Scope any DOM probe to the region under test. The header carries its own activity spinner, so a
body-wide search for a loader reports a false positive that looks exactly like the bug you are
hunting.

`tsc` cannot catch a hooks-order violation, and neither can a passing unit test. Any change that
adds a hook to a component with early returns must be opened in a browser before it is believed.


Query the element you actually mean. Placeholders and labels repeat across the app — for example
LibraryPage owns an input whose placeholder starts with "Search cells", so
`input[placeholder*="Search cells"]` silently matches it instead of the command palette and makes
a working feature look broken. Prefer a distinctive substring or a `data-` attribute. When a
control appears not to respond, first check a second control that shares the same state pattern
(a working `Ctrl+B` proved the shared keydown handler and state updates were fine, isolating the
problem to the selector).

Synthetic `input.value = ...` plus a dispatched `input` event does not update React state; drive
text entry with real key events. Dev-server pages can also show duplicated console output, so
confirm suspected regressions against the production build before treating them as real.

## Hiding or filtering scientific data

Any feature that removes data points from a view must satisfy all of these:

1. **Never infer from the quantity being plotted.** Hiding low-capacity cycles by thresholding
   capacity cannot distinguish a diagnostic pulse from a cell that died; both read as "capacity
   collapsed". `diagnosticCycles.ts` keys on charge and discharge *duration* instead, because that
   is what physically distinguishes a diagnostic cycle. Prefer a signal that is causally different,
   not a proxy for the thing you want to exclude.
2. **Compare against a rolling local baseline, not a global one**, so gradual degradation shifts the
   reference instead of tripping it.
3. **Default to off, and state both sides.** Report what was removed *and* what remains; a lone
   "42 hidden" invites the reader to assume the rest is everything.
4. **Keep the filter out of stored and exported data.** Exports carry every point so the choice is
   reversible by whoever opens the file, including when the source files are gone.
5. **Disclose unconditionally in exports.** A "show hidden" toggle in a report is not disclosure: a
   reader who has already zoomed to the meaningful band sees nothing change and concludes nothing
   was hidden. Use a visible chip plus a listing of the affected cycles.
6. **Follow the data, not just the page.** Check every path that leaves the document. The portable
   report's `plottedColumns()` builds its CSV from the chart traces, so a filtered plot yields a
   filtered CSV — a chip protects the reader, a column protects whoever pulls the numbers out.

When logic is duplicated across the frontend and the report generator (`diagnosticCycles.ts` and
`services/diagnostic_cycles.py`), test both against the same real fixture and say so in both files.
A report that describes a different plot than the app rendered is worse than no report.

## Performance change

1. Profile the actual slow boundary before changing behavior.
2. Keep list endpoints relational and bounded.
3. Keep file parsing, checksum work, and backfills off the request/UI critical path.
4. Confirm scientific/export fidelity when adding display downsampling or WebGL.
5. Add a regression test for the confirmed cause, not only the visible symptom.

## Release and Windows package

1. Choose the SemVer bump automatically when committing completed work: patch for compatible fixes,
   minor for backward-compatible features, and major only for intentional compatibility breaks.
2. Update the same version in `backend/app/config.py`, root and frontend package manifests and
   lockfiles, `src-tauri/tauri.conf.json`, and the CellXplorer package entries in Cargo files.
3. Add the release at the top of `CHANGELOG.md` using user-facing language.
4. Run `python -m unittest discover tests`.
5. Run `node --test frontend\tests\*.test.ts`.
6. Run the frontend production build.
7. Build the installer only when requested or when packaging itself changed, following
   `docs/windows-packaging.md`.
8. Visually test custom installer and uninstaller pages after NSIS changes. Never test destructive
   uninstall against real user data.

The expected installer is `src-tauri/target/release/bundle/nsis/CellXplorer_<version>_x64-setup.exe`.

### Packaging cost, measured

A full `scripts/build-app.ps1` run is roughly a minute when nothing forces a sidecar rebuild:
frontend ~22s, cargo ~20s warm, makensis ~6s. Two settings account for most of the difference from
the ~4 minutes it took before:

- `[profile.release] incremental = true` in `src-tauri/Cargo.toml`. `tauri-build` re-runs its build
  script every pass, so without incremental data the app crate was fully recompiled and relinked
  every time — 86s even with no source changes.
- `bundle.windows.nsis.compression = "zlib"`. The payload is ~87MB of which 72MB is a PyInstaller
  onefile sidecar that is *already* zlib-compressed internally. Solid LZMA spent ~80s to produce an
  installer the same size; zlib takes ~6s and costs 1.2MB (1.6%).

PyInstaller caches its own stages, so an unchanged rebuild is ~3s and a changed one ~70s, of which
most is re-analysing the pandas/numpy/pyarrow dependency graph. `scripts/build-app.ps1` fingerprints
the Python sources and skips the stage entirely when nothing changed; `-ForceBackend` overrides.

Do not try to shrink the sidecar by excluding modules. `tkinter` is used by `routers/files.py` for
the native folder picker, and the remaining unused modules are ~3MB against pandas 62MB, numpy 31MB
and pyarrow 84MB.
