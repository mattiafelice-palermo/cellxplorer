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
6. When one modal closes before opening a deferred confirmation, capture the pending mutation
   callback before closing the parent. A ref updated on every render can otherwise point at the
   cleared request by the time the user confirms.

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

### Updater signing and release checks

1. Confirm `bundle.createUpdaterArtifacts` is `true` and the committed updater public key in
   `src-tauri/tauri.conf.json` is real, not a placeholder or file path.
2. Never commit the private updater key, its password, or GitHub release tokens.
3. Local signed packaging requires `TAURI_SIGNING_PRIVATE_KEY` (and password when used) in the
   environment; `.env` files are not read by Tauri signing.
4. After NSIS template changes, smoke-test the `/UPDATER` path in a disposable install. Cancel
   before modifying non-disposable user data.
5. Run `python -m unittest tests.test_updater_configuration -v` when updater config or Rust
   command wiring changes.
6. Stable and Beta use the same committed public key from `src-tauri/tauri.conf.json`, but separate
   fixed `release-channels/stable/latest.json` and `release-channels/beta/latest.json` endpoints.
   The Beta overlay inherits the key; manifest verification must read the base configuration.
7. Persist GitHub release-asset metadata as the raw `Invoke-WebRequest` response body. Do not
   re-encode with PowerShell `ConvertTo-Json`; that can emit nested arrays or stringified rows and
   fail `verify_updater_manifest.py` with `release asset at index 0 must be an object`.

Updater check preferences are local UI state under `cellxplorer-update-preferences`. The default is
12 hours with discovery notifications enabled. Saving **Settings → App updates** dispatches
`cellxplorer-update-preferences-changed`, which makes both Standard and opted-in Beta discovery
reschedule without an app restart. The notification toggle controls native Windows notifications
only; automatic checks and the power-menu badge remain active. Manual **Check for updates** opens
the existing update modal directly and never shows a discovery toaster. Toast display and body-click
activation are owned by Rust (`show_update_notification` / `notify-rust`), not the Tauri
notification plugin JS facade. Verify Windows notification identity and body-click behavior in an
installed NSIS build — `tauri dev` may show PowerShell branding.

In Stable, `betaUpdatesEnabled` means **Notify me about CellXplorer Beta**. It schedules discovery of
the separate Beta product and never changes Stable self-update acceptance. Disabling it clears
non-protected Beta availability/error UI and notification eligibility without interrupting an
explicit download/launch. Beta installations update themselves.

On release days, `preflight.yml` skips its Windows job when a `v*` tag already points at the
pushed `main` commit, and `release.yml` cancels any still-running main preflight for that SHA so
only the release job's `--no-cache` preflight runs.

### Tag and release checklist

Agents use this when the user asks for a release. Unless a spec defers tagging (for example a
multi-spec release train), operate on `main` after the relevant features are merged.

1. Bump every maintained version declaration and add the exact-version section to `CHANGELOG.md`.
   Use `python scripts\bump_version.py --patch --notes "..."` for Stable, or an explicit version
   such as `python scripts\bump_version.py 0.16.2-beta.1 --notes "..."` for Beta prereleases.
2. Before any production tag, pre-provision and verify the orphan `release-channels` branch. Never
   derive it from `main`. For the first Beta it contains `README.md` plus the valid current
   `stable/latest.json`; the workflow creates the first verified Beta pointer safely. Thereafter it
   contains exactly both manifests and the README.
3. Run `python scripts/check_versions.py --expected-version <version>` and
   `python scripts/preflight.py --no-cache` locally. Report the exact preflight result.
4. Confirm `TAURI_SIGNING_PRIVATE_KEY` and password are configured in GitHub repository secrets.
5. Commit the version bump on `main`, push `main`, then tag and push:
   ```powershell
   git tag -a v<version> -m "CellXplorer <version>"
   git push origin main
   git push origin v<version>
   ```
   Validate the tag with `python scripts\release_tag.py --tag v<version>`. Stable tags use
   `vX.Y.Z`; Beta uses `vX.Y.Z-beta.N`. The tagged commit must be reachable from `main`. Tag push
   triggers `.github/workflows/release.yml`. A Beta core must be strictly greater than the highest
   published exact Stable tag; legacy Beta tags are not Stable baselines. Do not re-run a published
   tag to replace binaries.
   If the workflow fails on an early step, fix on `main`, push, move the tag to the fixed commit,
   and push the tag again.
6. The workflow runs no-cache preflight, explicitly builds/stamps the selected frontend channel,
   stages a draft, verifies the installer/signature/manifest with the base public key, and only then
   undrafts. Beta releases are GitHub prereleases; Stable remains GitHub's normal latest release.
7. Inspect the GitHub Release assets: product-specific NSIS setup executable, matching `.sig`, and
   `latest.json`. Confirm only the selected channel pointer changed and the public raw pointer
   verifies.
8. For the first Stable transition release, prove the legacy
   `/releases/latest/download/latest.json` endpoint serves its Stable manifest while the new binary
   embeds the Stable channel-branch endpoint.
9. Complete the disposable installed matrix: side-by-side identities/data, Stable-owned first Beta
   install, channel-specific N→N+1 updates, crossed-manifest rejection, and uninstall isolation.
10. If release verification fails before undraft, fix `main` and move the unpublished tag. If
   pointer publication fails after undraft, do not replace release assets; repair the pre-provisioned
   branch with optimistic SHA protection and rerun exact manifest verification.
11. Run `python -m unittest tests.test_release_notes_script tests.test_release_workflow -v` when
   release scripts or workflow YAML change.
