# Change playbooks

## Verified build boundaries

Cargo's default release `lto = false` can still perform local ThinLTO between
one crate's codegen units. The explicit string `lto = "off"` disables that pass.
Do not conflate this with reducing optimization level, assertions, panic policy,
security features, or a measured runtime speedup. Separate dependency preparation
from warm application compilation; retain full native/runtime acceptance.

The builder's installed dependencies are not the frozen application's runtime.
Setuptools/Distutils remain installed for PyInstaller/tests but are excluded from
the sidecar. `Get-BackendFingerprint` includes the build command, so changed flags
invalidate a staged old bundle. Compare actual native/resource hashes and runtime
module sets, then run the frozen API and lossless scientific checks. Use fresh
PyInstaller work directories when measuring analysis, not a reused Analysis TOC.

Tabler is a pinned MIT-licensed local subset. Keep the rendering factory and icon
modules byte-identical to upstream; retain licence, source hashes and independently
captured SVG references. The import inventory and parity test fail when icons
are added without deliberate regeneration. Do not replace missing icons silently.
Vendored files participate in both preflight cache fingerprints; the parity
scripts also participate in the policy fingerprint so edits cannot reuse a stale pass.

Native worker stdout is buffered. `CXCI_TIMING` begin/end JSON records contain
worker UTC, Stopwatch elapsed milliseconds and pass/fail status; failures remain
exceptions. Read these with `scripts/summarize_native_timings.py`, not adjacent
coordinator log timestamps. Overlapping phases/workers are not additive wall time.

The explicit workflow-dispatch cache seed prepares only the current ref's cache.
The release workflow stays restore-only and executes every mandatory gate. Keep
four preflight workers; neither seed compilation nor a cache hit proves acceptance.

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

### Multi-source analysis output

For a Cell with an ordered continuation chain, keep global cycle numbers and source-local cycle
labels together in every cycle/time result. Source descriptors must be path-free and cover every
ordered source, including missing caches, with the tracked-tail flag and known timestamps. Missing
middle sources fail closed for that Cell rather than returning a scientifically partial prefix.
When adding provenance arrays to persisted analysis results, bump the result/cache format and keep
boundary markers, saved figures, thumbnails, and data exports on the same final figure/result
path. CSV and Excel exports may add stable provenance columns, but must not emit absolute source
paths.

### Portable Cell source chains

1. Resolve selected Cells in analysis selection order, then resolve each Cell's sources through its
   one internal Test row and canonical `TestFile.position` order.
2. Serialize a Cell-level ordered source list with positions, checksums, metadata, and tracked-tail
   state. Never serialize Test names or database-ID order as scientific structure.
3. Use that same order for global source documents, embedded payloads, preflight rows, downloads,
   and ZIP entries; keep one separate original file per source inside the Cell folder.
4. Permit reuse only for an exact complete ordered source-hash chain. Reordered hashes and partial
   overlap conflicts must fail before commit.
5. Create exactly one internal Test row for a newly imported Cell. Reading older nested-Test
   packages is compatibility handling, not support for multiple Test product objects.

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
7. Poll asynchronous inspections only while at least one returned item is `pending`; stop when all
   items are `ready` or terminal `error`. Keep an explicit retry action for terminal failures.

## UI or visual change

1. Read [`visual-style-guide.md`](visual-style-guide.md) before editing.
2. Reuse the closest shared component and match neighbouring control geometry.
3. Check chrome colors for both light and dark; keep Plotly presentation independent.
4. Cover loading, empty, error, disabled, unsaved, and success states as applicable.
5. Check truncation, overflow, keyboard access, tooltips, and accessible names.
6. Run TypeScript/build checks. Perform visual browser verification when requested or required by
   the active spec; never claim an unperformed visual check passed.

## Adding a hook to a large page component

`AnalysisEditor` (and any component with early returns such as
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

The expected installers are channel-specific: `CellXplorer_<version>_x64-setup.exe`,
`CellXplorer.Beta_<version>_x64-setup.exe`, and
`CellXplorer.Alpha_<version>_x64-setup.exe`. Packaging must derive the expected filename from the
selected overlay and fail if that exact artifact is absent.

Direct Tauri bundling leaves spaces in local Beta/Alpha NSIS filenames (for
example `CellXplorer Alpha_<version>_x64-setup.exe`); GitHub upload sanitizes the
release-asset name to dots. Release-gate provenance must map these two exact names
and compare bytes/signatures, not assume the uploaded name is also the local path.

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

Do not omit runtime modules to shrink the sidecar. The verified build-tool-only
Setuptools/Distutils exclusion above is not permission to trim scientific modules.
`tkinter` is used by `routers/files.py` for
the native folder picker, and the remaining unused modules are ~3MB against pandas 62MB, numpy 31MB
and pyarrow 84MB.

### Updater signing and release checks

Windows scope and handoff are owned by `installation_scope.nsh` and
`src/installation_scope.rs` (Spec 070); see the scope section in
`docs/windows-packaging.md`. Keep the NSIS manifest asInvoker and default
currentUser. Runtime machine actions authenticate both-view HKLM identity and
elevate explicitly. Stock `both`/Highest elevates fresh user setup too. Never
trust scope/path flags as arbitrary machine write targets, or elevated HKCU/
LocalAppData/profile as the original standard user's state.

The NSIS language preference can leave an HKCU manufacturer product key with
no default install-location value, including alongside a machine install.
Treat only a missing default as absent when no Uninstall record exists; keep an
Uninstall record without that location fail-closed. Regression tests must run
the registry reader against unique disposable HKCU fixtures, not only parsed
`InstallationRecord` values. HKCU `Software` views were shared on the reviewed
Windows host; conflict fixtures should use disjoint subkeys rather than depend
on same-path values diverging between WOW64 views.

Tauri updater 2.10.1's Windows install method ignores ShellExecuteW's result
and exits after its before-exit hook. The standard self-updater keeps Tauri
check/download signature verification but launches the exact verified bytes
through `src/update_recovery.rs`. This launcher deliberately does not interpret
installation registry state: new signed payloads must be able to repair discovery
rules without an old client blocking their execution. `update_recovery.nsh` runs
after new-payload scope discovery and before any uninstall/process-stop/copy phase.
It binds the existing destination to the live originating process. A named pipe
authenticates both process IDs; the client additionally pins the responder to the
locked staged image. READY, COMMIT, explicit ACK and client exit authorization
precede shutdown. Pre-E cancellation remains strict; final E is irreversible
installation consent followed only by backend/app shutdown. The successful client keeps
the pipe and locks owned until actual OS termination, not merely until Tauri queues
exit. Launch/process liveness
alone never counts as readiness. Keep the staged READ-only deny-write/delete lock
through preparation, compare bytes after reopening, serialize pending update state,
and bound the full command (bundled NSIS has 1024 UTF-16 units). Scope elevation
must forward the complete recovery identity, version/channel and verified-byte
SHA256. The signed unelevated relay locks its own file and directory, checks its
locked bytes against that original hash, and supervises its checked elevated child
through exit. This protects an outstanding UAC request even if the client closes.
Old clients cannot retroactively gain this protocol. `scripts/check_update_recovery.py`
executes production NSIS logic and the actual Rust transport against harmless
fixtures; it does not establish signed/installed-client/UAC acceptance.

NSIS fixture declaration/include order must match production. NSIS compiles an
undeclared variable reference as literal text with warning 6000 even when its exit
code is zero. Recovery is included before scope policy, so shared variables used
by recovery must be declared in that earlier header. Reject warning 6000 and use
explicit UTF-8 compiler input; a successful compile alone is not verified policy.

For System plug-in structure fields, pass arbitrary command text by register
source (`w r0`), never by interpolating it into the expression (`w "$0"`). Quoted
scope/origin paths otherwise become syntax in System's own parser. Two installer
crash dumps showed `lpParameters=0x3a`, `lpDirectory=0x10000`, `nShow=0`; a harmless
compiled layout inspector reproduced these exact values. Register-source input
restored a valid argument pointer, null directory, SW_SHOWNORMAL and exact argument
comparison. The mandatory quoted relay case now round-trips multiple quoted
values, spaces, a comma and Unicode through the real production relay and child,
retaining its lock/exit/deadline assertions. Unquoted relay success is not coverage
of the machine-update command shape. Never commit private crash dumps.

Keep relay-fixture lifetime synchronized with its controller. A child that writes
its marker then blindly sleeps two seconds can exit before a descheduled observer
checks liveness and locks. The harmless fixture uses a unique controller-owned
manual-reset event: the checked child holds its locks until both replacement
assertions finish, then exits with the required status. The original 10-second
readiness and 15-second completion deadlines stay fixed; the child also has a
bounded guard using that completion budget. Always release/join the exact owned
relay on failure before temporary-directory cleanup. Cleanup cannot turn a timed
out or failed assertion into a passing result. Keep the delayed-observer native
regression as well as the ordinary relay case; neither substitutes for signed UAC.

Windows `ExitProcess` closes object handles before signaling the process object.
Consequently a broken pipe followed by an immediate unsignaled Wait(0) is NOT
proof of cancellation rather than genuine process teardown. Under the explicit
Spec 073 user amendment, an observed post-E disconnect permits exactly one
100-ms wait on the authenticated origin process. Mutation still requires the
process to signal; expiry permanently aborts, with no renewed deadline or later
unrelated exit accepted. Do not describe this as unchanged immediate cancellation:
an origin exiting inside that observed-disconnect window is authorized to install.

Preflight's real signature-vector check uses the small locked Cargo package in
`scripts/updater_signature_verifier`, reusing the production-equivalent verifier
source without desktop build inputs. Do not require an already-warm/offline Cargo
cache: fresh hosted runners may not have the registry/index even when production
Rust artifacts were restored. Keep its crypto versions pinned to the root lock,
and keep real candidate-byte verification mandatory before installer execution.

Tauri CLI 2.11.4 packages an NSIS-specific main executable, then restores its
unpatched `target/release/cellxplorer.exe`. Do not use that restored file's raw
hash as the installed payload reference. The gate constructs the exact expected
NSIS payload by the pinned single `__TAURI_BUNDLE_TYPE_VAR_UNK` to `..._NSS` change
and compares the entire installed file hash. It rejects changed CLI versions,
missing/multiple markers and Authenticode configuration until reviewed; it never
normalizes installed bytes or uses their observed hash as the expected value.
Native gate hashes use streaming .NET SHA256 with literal paths and read-only
deny-write/delete handles, not Get-FileHash module discovery in fresh accounts.
Keep known-vector regression coverage in both Windows PowerShell and PowerShell 7.

Fresh credentialed Windows CI accounts need genuine shell-folder initialization.
Default .NET `GetFolderPath` may return empty when a folder does not exist.
Validate the token SID's ProfileList profile before resetting inherited profile
environment. Credentialed PowerShell workers can retain the controller's
`APPDATA`/`LOCALAPPDATA` even after `USERPROFILE` changes. Generate a fresh block
with Windows `CreateEnvironmentBlock` for the loaded current token and inheritance
disabled, validate its profile identity and AppData containment, and import only
the explicit profile-variable allowlist; always free the native block. Do not
copy PATH, credentials or workflow-control variables. Resolve AppData with
`DoNotVerify` and validate absolute normalized
profile containment before `Create`, then validate the created directories again.
The credentialed worker's already-started .NET resolver can still return the
controller paths even after its native token block and assigned environment are
correct. Resolve/validate/create known folders in a fresh same-token child that
inherits those corrected variables, matching the installer launch conditions.
Verify its SID/profile, validate both paths before either Create, bound its exit,
and recheck typed JSON identity/path results in the parent. Do not accept stale
parent results, fabricate directories, or rewrite user shell-folder registrations.
Set each credentialed worker's TEMP/TMP to its validated, non-reparse gate-root
scratch child before launching PowerShell and revalidate inside the worker before
loading helpers. Windows PowerShell's Add-Type compiler can otherwise try the
inherited controller temp directory before profile initialization and fail ACLs.
An administrators-group account launched with separate credentials can still
receive a filtered token on a hosted runner. The CI machine worker uses a unique
highest-privilege scheduled task under that dedicated account, checking actual
SID/admin state, run-start evidence, terminal task result and bounded completion.
Only validated non-secret CI/scratch context is forwarded; exact task cleanup is
mandatory. The standard-user worker remains non-admin. This is not UAC acceptance.
Never fabricate AppData paths or create an inherited runner path before checking
containment. The native gate logs empty and outside-profile failures distinctly.

Use the compiler/policy harness in `scripts/check_installer_scope.py` to execute
actual NSIS normalization/discovery/registration cleanup against disposable
HKCU keys; textual contracts alone missed a scratch-register clobber. Win32
GetFullPathNameW with a separate output buffer supports nonexistent fresh
folders; aliased NSIS GetFullPathName input/output cleared that fixture path.
PowerShell5 JSON arrays must be assigned directly before foreach; wrapping
ConvertFrom-Json's pipeline in `@(...)` can nest the array. The restart helper's
Windows parser regression includes empty, quoted, backslash and Unicode args.
Native signed UAC/restart acceptance remains a separate disposable matrix;
compilation and these fixture executions do not establish it.

1. Confirm `bundle.createUpdaterArtifacts` is `true` and the committed updater public key in
   `src-tauri/tauri.conf.json` is real, not a placeholder or file path.
2. Never commit the private updater key, its password, or GitHub release tokens.
3. Local signed packaging requires `TAURI_SIGNING_PRIVATE_KEY` (and password when used) in the
   environment; `.env` files are not read by Tauri signing.
4. After NSIS template changes, smoke-test the `/UPDATER` path in a disposable install. Cancel
   before modifying non-disposable user data.
5. Run `python -m unittest tests.test_updater_configuration -v` when updater config or Rust
   command wiring changes.
6. Stable, Beta, and Alpha use the same committed public key from `src-tauri/tauri.conf.json`, but
   separate fixed `release-channels/stable/latest.json`, `release-channels/beta/latest.json`, and
   `release-channels/alpha/latest.json` endpoints. The channel overlays inherit the key; manifest
   verification reads the base configuration. Alpha uses the shared standard updater commands with
   exact dotted `MAJOR.MINOR.PATCH-alpha.N` validation.
7. Persist GitHub release-asset metadata as the raw `Invoke-WebRequest` response body. Do not
   re-encode with PowerShell `ConvertTo-Json`; that can emit nested arrays or stringified rows and
   fail `verify_updater_manifest.py` with `release asset at index 0 must be an object`.

Alpha/Beta bootstrap edition availability is native, read-only installation
evidence, not the existence of a `.cellxplorer*` data folder. `installed_editions`
checks both registry hives/views and keeps failed or incomplete reads unknown.
An uninstall or manufacturer-only record with a valid local path is stale/absent
only when both `cellxplorer.exe` and `uninstall.exe` are explicitly missing.
Use error-preserving metadata reads, not `exists()`-style checks that hide access
failures. Malformed values, unexpected filesystem objects, denied reads and
surviving partial installations remain unknown. Discovery never deletes records.
Only a verified sole edition can bypass the chooser through the guarded backend
`complete-single-edition` acknowledgement; it never resets data, discards a stage,
or activates a copy. Stable has no bootstrap chooser. Test production confirmation
paths with `bootstrapConfirmationFlow.test.ts`, not development mocks alone.

Opening the standard update dialog joins or starts a manual remote refresh.
Keep the previous available release visible until success; show refresh failure
separately. Staged local payloads and protected transfer/handoff state are excluded.
The provider's epoch must reject superseded manual as well as automatic checks,
and a manual opener must promote an in-flight automatic check rather than drop its
result when the dialog becomes visible. Numeric Alpha/Beta prerelease identifiers
participate in full SemVer ordering. `appUpdateRefresh.test.ts` exercises these
production-provider paths with native IO isolated.

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

On release days, `preflight.yml` always runs its named Windows preflight for a pushed `main`
commit, even when a release tag is created for that SHA. `release.yml` verifies the exact-SHA
trusted `main` push result and reuses it only when the named Windows job completed successfully;
failed results block publication, while missing, skipped, or cancelled results use the complete
release-local `--no-cache` fallback. The independent main workflow also owns the shared production
Rust dependency cache; release jobs restore it without saving a tag-scoped replacement.

### Tag and release checklist

Local signed update testing lives in Settings → App updates. Select an official
Windows setup and matching `.sig`; verification snapshots the bytes, checks the
unchanged embedded updater key and reads product/channel/SemVer from a protected
copy's Windows resources. Same-version reinstall is allowed, downgrades and
cross-channel payloads are rejected. The next explicit action enters the existing
`install_app_update` recovery handoff, not a second launcher. A selected local
candidate pins pending state against discovery until installed or explicitly
discarded. It is a real installation, never a dry-run simulation. Build-only
workflow artifact `local-signed-update-<channel>` contains both files only after
the unchanged native gate and policy join pass. `scripts/check_local_installer.py`
uses newly generated fixture keys and harmless NSIS payloads for read-only
verification; it never launches a setup. Interactive UAC acceptance is separate.

Release build work may overlap the exact-SHA preflight lookup, but background
outputs are unavailable until the explicit `wait`. The independent build group
must finish before canonical fallback can rewrite the frontend. Manual dispatch
always takes full fallback and stamps the requested channel. Main's shared Rust
cache warms both release and test dependency graphs; `--no-run` there is not
verification and never replaces release test execution. New immutable cache
generations must match in main and release; tag jobs remain restore-only.

At pinned rust-cache revision `779680da715d629ac1d338a641029a2f4372abb5`,
`shared-key` overrides `key` (see its `src/config.ts`); rotate the effective
`shared-key` itself when changing cached profiles. Otherwise an old exact hit
skips warming a newly requested test graph. Warm production Rust dependencies
with `--features tauri/custom-protocol`, matching Tauri CLI, as well as ordinary
debug tests. A reported cache hit is not proof those profiles were populated:
inspect the warmup steps and downstream Cargo compilation logs.

Post-package policy checks may overlap the native installer matrix: policy
fixtures use disposable HKCU keys/scratch files and root debug targets, whereas
the matrix uses dedicated accounts/installation roots and a standalone signature
verifier target. They must not rewrite the packaged candidate. The unconditional
`wait: installer_policy` must succeed before final asset recheck or publication,
including build-only runs. Keep NSIS-dependent policy after packaging has made
the compiler available. Do not trade signature/provenance, case coverage, process
quiet periods or test deadlines for apparent CI speed.

CI's fresh Python installation uses pinned uv against the exact setup-python
interpreter and public PyPI index, followed by `python -m pip check`. Root and
frontend `npm ci` may run independently because their installation trees differ;
keep lifecycle scripts and audits enabled. The PowerShell-only disposable profile
probe may overlap tool setup, but must join before build inputs are consumed.
Do not replace these with an unchecked installed-environment cache. When changing
the installer/resolver, dispatch preflight with `compare_dependency_installers`
enabled: `scripts/compare_ci_installers.py` compares complete fresh pip/uv
inventories in isolated environments on one runner, permits only exact pinned uv,
and asserts every runtime/build requirement. Its always-retained report records
failure phases as well as success. Frozen/source science parity in a single
environment is necessary but does not substitute for this distribution comparison.

The candidate-owned `cellxplorer-installer-helper.exe` is a small independent
GUI-subsystem/asInvoker Rust binary. Build it with
`python scripts/build_installer_helper.py` before NSIS compilation. Setup extracts,
pins and hashes its embedded helper before recovery readiness; cleanup executes
that pinned temporary copy, not an old installed helper. Restart remains behind
RunAsUser and launches only the helper's sibling `cellxplorer.exe` using bounded
hex JSON argv and native Windows argument encoding. Native Toolhelp image-path
queries replace repeated WMI startup while retaining the ten-second monotonic
deadline, five 200-ms quiet samples, live-handle ownership and ancestor protection.
Process ownership uses Windows ordinal-ignore-case UTF-16 comparison, not Unicode
lowercasing. Do not trim directory strings: NBSP/EM SPACE can be significant in
valid Win32 names and stripping them can target a distinct plain-name sibling.
The legacy PowerShell files are regression references, not packaged entry points.
Run `cargo test --locked --manifest-path scripts/installer_helper/Cargo.toml
--features test-fixtures --target-dir src-tauri/target/installer-helper` and
`python scripts/check_installer_helper.py` (disposable files only) when changing it.

Agents use this when the user asks for a release. Unless a spec defers tagging (for example a
multi-spec release train), operate on `main` after the relevant features are merged.

1. Bump every maintained version declaration and add the exact-version section to `CHANGELOG.md`.
   Use `python scripts\bump_version.py --patch --notes "..."` for Stable, or an explicit version
   such as `python scripts\bump_version.py 0.16.2-beta.1 --notes "..."` for Beta prereleases or
   `0.28.0-alpha.1` for Alpha prereleases.
   Within a Beta core that has already used compact `betaNNN`, continue with compact successors;
   a dotted `beta.N` candidate compares lower than the existing compact version under SemVer.
2. Before any production tag, pre-provision and verify the orphan `release-channels` branch. Never
   derive it from `main`. Before the first Alpha publication it contains `README.md` plus valid
   `stable/latest.json` and `beta/latest.json`; the Alpha workflow creates the first verified
   `alpha/latest.json` pointer safely. Thereafter it contains exactly all three manifests and the
   README. A published-Alpha release-history result is the authoritative transition evidence.
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
   `vX.Y.Z`; Beta uses `vX.Y.Z-beta.N` or its established compact form; Alpha uses
   `vX.Y.Z-alpha.N`. The tagged commit must be reachable from `main`. Tag push triggers
   `.github/workflows/release.yml`. A Beta or Alpha core must be strictly greater than the highest
   published exact Stable tag; Beta and Alpha are not ordered against each other. Do not re-run a
   published tag to replace binaries.
   If the workflow fails on an early step, fix on `main`, push, move the tag to the fixed commit,
   and push the tag again.
6. The workflow runs no-cache preflight, explicitly builds/stamps the selected frontend channel,
   stages a draft, verifies the installer/signature/manifest with the base public key, and only then
   undrafts. Beta and Alpha releases are GitHub prereleases; Stable remains GitHub's normal latest
   release.
7. Inspect the GitHub Release assets: product-specific NSIS setup executable, matching `.sig`, and
   `latest.json`. Confirm only the selected channel pointer changed and the public raw pointer
   verifies.
8. For the first Stable transition release, prove the legacy
   `/releases/latest/download/latest.json` endpoint serves its Stable manifest while the new binary
   embeds the Stable channel-branch endpoint.
9. Complete the disposable installed matrix: side-by-side identities/data, Stable-owned first Beta
   install, channel-specific N→N+1 updates for Stable/Beta/Alpha, crossed-manifest rejection, and
   uninstall isolation.
10. If release verification fails before undraft, fix `main` and move the unpublished tag. If
   pointer publication fails after undraft, do not replace release assets; repair the pre-provisioned
   branch with optimistic SHA protection and rerun exact manifest verification.
11. Run `python -m unittest tests.test_release_notes_script tests.test_release_workflow -v` when
   release scripts or workflow YAML change.
