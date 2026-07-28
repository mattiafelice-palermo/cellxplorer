# Review 023: Separate Stable/Beta release channels and Beta installation UX

Repository: `mattiafelice-palermo/cellxplorer`
Branch: `feature/stable-beta-app-identities`
Reviewed head: `95ad0c652a9ef248a1f13c11472f6e5a4c531371`
Base and merge base: `main` at `6c08a59c61a2607c47e036fac91486fb69a4c200`
Branch position: 6 commits ahead, 0 behind
Review status: **changes required — not ready to merge or release**

The branch is cumulative: it contains Specs 021, 022, their review follow-ups, and Spec 023. This
review therefore covers the complete Stable/Beta release train and raises remaining cross-spec
issues where the Spec 023 implementation bypasses or regresses earlier safeguards.

The supplied URL is a branch/new-PR URL rather than an existing pull request. No PR discussion or
PR-triggered workflow run is attached to the reviewed head.

## Scope and base

The correct comparison is:

```text
main@6c08a59c61a2607c47e036fac91486fb69a4c200
    ...
feature/stable-beta-app-identities@95ad0c652a9ef248a1f13c11472f6e5a4c531371
```

No unrelated scientific, database-migration or calculation-version change was found. The branch
does include all three planned packaging/update specifications in one cumulative history rather
than the originally planned sequence of merged branches.

## Confirmed by code reading

The following architecture is present and should be preserved:

- Stable and Beta have separate Windows product names, Tauri identifiers, install folders,
  shortcuts, uninstall entries, deep-link schemes, autostart values, native frame colors and icons.
- Beta uses the locked pastel-blue theme and header `BETA` badge; Stable remains teal.
- Stable and Beta use separate default data roots:
  `%USERPROFILE%\.cellxplorer` and `%USERPROFILE%\.cellxplorer-beta`.
- The Spec 022 review corrections are materially present:
  - channel-specific destructive-uninstall targets;
  - fail-closed first-run setup UI;
  - SQLite online backup and new database UUID;
  - staged DB/import digests and inventory;
  - symlink/path/live-pristine validation;
  - transactional DB/import rollback;
  - retryable outstanding stage tokens and bounded cleanup;
  - streamed managed-import copying;
  - canonical Stable database recognition.
- Stable and Beta Tauri configurations point to separate fixed updater endpoints.
- Beta GitHub releases are configured as prereleases.
- The old frontend Beta-version filter was removed from the standard self-updater.
- Stable has a distinct Beta availability/install coordinator, modal and Windows notification path.
- Stable detects an installed Beta through the exact Beta uninstall key and leaves later Beta
  self-updates to the Beta application.
- No released migration was edited and `CALC_VERSION` was not changed.

## Findings

### R1 — Critical: Stable and Beta updater state are the same managed Tauri type

**Affected files**

- `src-tauri/src/beta_installer.rs`
- `src-tauri/src/main.rs`
- `src-tauri/src/app_updates.rs`
- Rust updater-state tests

### Current

The implementation declares:

```rust
pub type PendingBetaInstall = PendingAppUpdate;
```

and then registers both:

```rust
.manage(Mutex::new(PendingAppUpdate::default()))
.manage(Mutex::new(beta_installer::PendingBetaInstall::default()))
```

A Rust type alias does not create a distinct type. Both values are therefore
`Mutex<PendingAppUpdate>`.

Tauri `Builder::manage` requires every registration to have a different concrete `T` and panics when
the same type is managed twice. The application can therefore panic during builder construction
before either Stable or Beta opens. If the duplicate registration were merely removed, both command
families would share one pending state, which also violates the locked separation.

Official Tauri reference:
`https://docs.rs/tauri/latest/tauri/struct.Builder.html#method.manage`

### Target

Create a genuine distinct type, for example:

```rust
#[derive(Default)]
pub struct PendingBetaInstall {
    inner: PendingAppUpdate,
}
```

Beta commands must request `State<Mutex<PendingBetaInstall>>` and operate only on its inner state.
Standard commands continue using `State<Mutex<PendingAppUpdate>>`.

Do not duplicate the updater state machine; reuse its pure transition helpers through the newtype.

### Acceptance criteria

- Tauri builder registers both state types without panic.
- `TypeId::of::<PendingBetaInstall>() != TypeId::of::<PendingAppUpdate>()`.
- A Standard check/download cannot replace or clear Beta pending state.
- A Beta check/download cannot replace or clear Standard pending state.
- Overlapping Standard and Beta checks/downloads are independently serialized.
- Stable and Beta installed applications both reach the main window in a smoke test.

---

### R2 — Critical: the release workflow packages the Stable frontend into Beta artifacts

**Affected files**

- `.github/workflows/release.yml`
- `scripts/preflight.py`
- `scripts/frontend_channel.py`
- `scripts/build_frontend_channel.py`
- `tests/test_release_workflow.py`
- build-only artifact verification

### Current

The workflow runs:

```text
python scripts/preflight.py --no-cache
```

before the Tauri action. Preflight runs `vite build` without
`VITE_CELLXPLORER_CHANNEL`, so `appChannel.ts` defaults to Stable.

The workflow later sets `VITE_CELLXPLORER_CHANNEL=beta` only on `tauri-action`, but:

- `tauri.conf.json` has no `beforeBuildCommand`;
- `tauri-action` packages the already existing `frontend/dist`;
- the workflow only checks that `frontend/dist/index.html` exists;
- it does not run the Spec 021 channel-stamp verifier.

Consequently, a Beta workflow build can have:

- Beta Windows product identity and installer icon;
- Stable frontend icon, teal theme, no `BETA` badge and Stable frontend policy.

This reintroduces the exact cross-channel packaging defect that Review 021 R2 was intended to close.

### Target

Build and verify the requested frontend channel explicitly before every Tauri package operation.

A bounded implementation is:

1. run canonical no-cache preflight for repository verification;
2. run `python scripts/build_frontend_channel.py <stable|beta>`;
3. run `python scripts/frontend_channel.py verify --channel <stable|beta>`;
4. only then invoke `tauri-action`;
5. verify the stamp again immediately before packaging if the action can run another command.

Do not rely on an environment variable that no build step consumes.

### Acceptance criteria

- Stable workflow artifact contains a Stable channel stamp and Stable header/icon/theme.
- Beta workflow artifact contains a Beta channel stamp, Beta icon/theme and `BETA` badge.
- Missing or mismatched stamp fails before Tauri packaging.
- Both manual build-only channel choices exercise the same policy.
- Tests execute the channel-build/stamp contract; string-presence assertions alone are insufficient.
- Extracted artifact inspection records the channel stamp and expected compiled branding strings.

---

### R3 — High: Beta manifest verification reads a config file that has no updater public key

**Affected files**

- `.github/workflows/release.yml`
- `scripts/verify_updater_manifest.py`
- `src-tauri/tauri.beta.conf.json`
- `tests/test_release_workflow.py`

### Current

For Beta, the workflow sets:

```text
tauri_conf=src-tauri/tauri.beta.conf.json
```

and passes that file to:

```text
verify_updater_manifest.py --tauri-conf ...
```

The verifier requires `plugins.updater.pubkey` in the supplied file. The Beta overlay intentionally
contains only the Beta endpoint and inherits the public key from the Stable base configuration; it
does not contain `pubkey`.

Every Beta tag run therefore fails manifest verification before the draft can be published.

The current tests check only that `tauri.beta.conf.json` appears in the workflow. They do not run a
Beta CLI fixture through the verifier.

### Target

Separate the concepts:

- build overlay: `src-tauri/tauri.beta.conf.json`;
- updater signing-key source: the resolved configuration or
  `src-tauri/tauri.conf.json`, since both products intentionally use the same committed public key.

Prefer adding an explicit workflow output such as `updater_key_conf` rather than adding duplicate
key material to the overlay.

### Acceptance criteria

- Offline Stable verifier fixture passes.
- Offline Beta verifier fixture passes while the key remains declared once.
- Wrong Beta signature/key identity fails.
- A Beta build-only workflow reaches artifact upload.
- A staged Beta tag run reaches the post-upload verification step successfully.
- Tests invoke `verify_updater_manifest.py` with the exact workflow arguments for both channels.

---

### R4 — High: first `release-channels` initialization is broken and creates the wrong branch tree

**Affected files**

- `.github/workflows/release.yml`
- release-channel initialization tooling/tests
- release documentation

### Current

The `release-channels` branch does not currently exist.

When it is absent, the workflow:

1. creates `release-channels` at the current `main` commit;
2. attempts to `PUT /contents/README.md` without the existing file SHA.

Because `main` already contains `README.md`, the README creation request fails. Even if a SHA were
added, the branch would contain the entire source tree inherited from `main`, not the locked
manifest-only tree.

This happens after the draft release has already been made public. On the first transition release,
the result can be:

- a published release;
- no usable channel pointer;
- a new binary whose embedded channel endpoint returns 404.

### Target

Establish the dedicated branch deterministically before the first production tag.

Acceptable approaches:

- a tested one-time script that creates an orphan commit/tree containing only the channel README
  and manifests; or
- a documented, verified pre-provisioning step plus a workflow gate that refuses to publish when the
  branch/tree contract is absent.

Do not derive the channel branch from `main`.

The workflow must verify before undrafting that:

- the branch exists;
- its tree contains no application source;
- the target channel path can be updated;
- the non-target channel path is left untouched.

### Acceptance criteria

- Starting from no `release-channels` ref is tested.
- Initialization does not attempt to overwrite an inherited README.
- The branch contains only `README.md`, `stable/latest.json` and `beta/latest.json` once both
  channels are initialized.
- Unexpected files cause a release gate failure.
- First Stable bootstrap cannot publish a binary pointing to a guaranteed 404 endpoint.
- Optimistic file-SHA protection remains.
- A channel update changes only its own manifest.

---

### R5 — High: runtime self-updaters do not enforce channel identity

**Affected files**

- `src-tauri/src/app_updates.rs`
- `src-tauri/src/beta_installer.rs`
- `src-tauri/src/app_channel.rs`
- Rust updater-policy tests

### Current

Separate endpoints are configured, but the standard updater accepts whatever signed `Update` object
the endpoint returns. The same signing key is intentionally used for both products.

There is no runtime rule that:

- Stable accepts only exact stable `MAJOR.MINOR.PATCH`;
- Beta accepts only exact `MAJOR.MINOR.PATCH-beta.N`;
- Stable-owned Beta installation accepts only an exact Beta version.

A manual channel-branch edit, publishing defect or crossed manifest could therefore place a validly
signed installer from the other product into pending state.

Endpoint separation is necessary but does not satisfy the locked rule that neither channel accepts
the other's manifest/installer.

### Target

Add one exact Rust release-channel parser/policy.

Before replacing pending state:

```text
Stable self-update  -> exact stable SemVer only
Beta self-update    -> exact -beta.N SemVer only
Stable Beta install -> exact -beta.N SemVer only
```

Derive Standard channel from the configured Tauri identifier. Reject invalid/crossed results before
they can replace existing verified pending state.

Do not use loose substring checks.

### Acceptance criteria

- Stable rejects a signed Beta-version update result.
- Beta rejects a signed Stable-version update result.
- Stable-owned Beta install rejects Stable/malformed versions.
- Valid channel results continue normally.
- Rejected results do not clear or replace an existing verified pending update.
- Tests cover exact SemVer, malformed suffixes, additional prerelease/build metadata and crossing.

---

### R6 — High: the workflow does not enforce that a Beta targets a future Stable core version

**Affected files**

- `.github/workflows/release.yml`
- `scripts/release_tag.py` or a focused release-channel policy script
- `tests/test_release_workflow.py`
- release documentation

### Current

The workflow distinguishes a Beta tag only by exact tag syntax. It does not enforce the locked rule:

```text
Beta core version > latest published Stable version
```

This is functionally required by the Stable-owned Beta checker. SemVer defines
`0.18.0-beta.1 < 0.18.0`; a Beta with the same core as the installed Stable release will not be
reported as a newer update by the updater library.

The repository also has legacy Beta releases that were deliberately marked as normal releases.
Using GitHub's `/releases/latest` response alone is therefore not a safe first-transition Stable
baseline.

### Target

Before draft staging:

1. list published, non-draft releases;
2. retain only tags accepted by the exact Stable tag parser;
3. determine the highest Stable SemVer;
4. require the Beta tag's core version to be strictly greater;
5. fail before building/publishing when the rule is violated.

Keep this policy in a testable script rather than an untested PowerShell regex block.

### Acceptance criteria

- `0.18.0-beta.1` is rejected when Stable `0.18.0` exists.
- `0.18.1-beta.1` is accepted when Stable `0.18.0` exists.
- Legacy non-prerelease Beta tags are ignored as Stable baselines.
- Drafts and malformed tags are ignored.
- API failure blocks publishing.
- Manual build-only dispatch does not need online release-policy validation.
- Unit fixtures and workflow contract tests cover the transition history.

---

### R7 — Medium: Stable session finalization is skipped before launching the Beta installer

**Affected files**

- `frontend/src/components/BetaInstallCoordinator.tsx`
- frontend Beta installer tests
- session-lifecycle diagnostics

### Current

The Standard updater calls:

```text
POST /api/session/finish
```

before invoking the installer.

The Beta install flow downloads the verified installer and calls `installBetaTauri()` directly. Its
Rust `on_before_exit` hook kills the sidecar, but it does not perform the backend's orderly session
finish.

This can leave the current Stable session/background-operation record unfinished and diverges from
the existing update lifecycle the specification explicitly required reusing.

### Target

After the Beta download succeeds and immediately before `installBetaTauri`:

1. call `POST /api/session/finish`;
2. record a debug event if it fails, consistently with the Standard updater;
3. invoke the installer;
4. preserve the existing non-returning Windows lifecycle behavior.

### Acceptance criteria

- Beta install call order is download → session finish → install.
- Download failures never finish/stop the session.
- Session-finish failure is recorded and follows the explicitly chosen Standard-update policy.
- Component/adapter tests verify ordering.
- Installed test confirms the Stable session is closed cleanly.

---

### R8 — Medium: Beta automatic checks are disabled by the Standard updater schedule event

**Affected files**

- `frontend/src/components/BetaInstallCoordinator.tsx`
- `frontend/src/components/AppUpdateCoordinator.tsx`
- `frontend/src/betaInstaller.ts`
- frontend timer/preference tests

### Current

The Beta coordinator creates its own recurring interval, then listens for
`UPDATE_SCHEDULE_CHANGED_EVENT` and responds by only clearing that interval.

The Standard updater emits the same event whenever it calculates its next check, including at
schedule startup and after every automatic run. It does not cause the Beta effect to recreate the
cleared interval.

The Beta availability checker can therefore run once and then stop recurring, despite the opt-in
remaining enabled.

Related preference behavior is also incomplete:

- disabling the Beta opt-in stops future scheduling but does not clear an already available Beta
  card/modal state;
- a manual check with no available Beta falls back to `idle` without showing the current status.

### Target

Use one explicit scheduling contract:

- preferences drive both schedules;
- a schedule-change signal causes cancellation **and rescheduling**, not one-way cancellation;
- disabling Beta opt-in clears non-protected availability UI;
- disabling must not corrupt an already downloading/launching explicit install;
- manual no-release feedback reports that no Beta is currently available.

### Acceptance criteria

Using fake timers:

- opted-in Beta checks repeat for multiple intervals alongside Standard checks.
- A Standard next-check event does not permanently stop Beta checks.
- changing interval reschedules both correctly without duplicate timers.
- disabling clears available/check-error UI and native-notification eligibility state as specified.
- a protected Beta download/launch is not interrupted.
- manual no-release feedback is visible and dismissible.

---

### R9 — Medium: required durable documentation was only partially updated

**Affected files**

- `AGENTS.md`
- `README.md`
- `docs/agent-knowledge/change-playbooks.md`
- `docs/tauri-packaging-lessons.md`
- `docs/windows-packaging.md`
- `docs/agent-knowledge/architecture.md`
- `docs/specs/reviews/023-stable-beta-release-channels-review.md`

### Current

The Spec 023 delta updates architecture, Windows packaging and the spec index, but does not update
all files required by the specification.

In particular, a new agent still lacks one authoritative end-to-end account of:

- the manifest-only branch and its initialization;
- first Stable bootstrap from the old endpoint;
- exact Stable/Beta tag and version policy;
- Stable-owned first Beta installation versus Beta-owned self-update;
- build-channel stamp requirements in GitHub Actions;
- mandatory release matrix and recovery when pointer publication fails.

The committed review file is also only an “awaiting verification” placeholder and says no findings
have been filed.

### Target

After code corrections, update the smallest durable documentation set with implemented facts only.
Replace the placeholder review with this review and append the implementer's exact correction and
verification record.

### Acceptance criteria

- A new coding agent can build, publish and diagnose either channel without the originating chat.
- Documentation distinguishes current implementation from unperformed verification.
- README explains Stable versus Beta to users.
- AGENTS/change playbook documents channel release gates.
- Tauri packaging lessons records channel stamp, state-newtype and channel-branch invariants.
- No document claims a matrix passed when it did not.

---

### R10 — High: cumulative Specs 021–023 verification remains incomplete

**Affected files**

- `docs/specs/021-stable-beta-app-identities.md`
- `docs/specs/022-beta-data-isolation.md`
- `docs/specs/023-stable-beta-release-channels.md`
- all three review files
- GitHub Actions build-only runs and extracted artifacts

### Current

At the reviewed head:

- there are no combined commit statuses;
- there are no PR-triggered workflow runs;
- Spec 023's acceptance checklist is entirely unchecked;
- its review contains command placeholders rather than results;
- build-only workflow dispatch has not been run for either channel;
- the elevated installed-Windows matrix still pending from Reviews 021 and 022 has not been
  completed;
- the full N→N+1 two-channel update matrix has not been performed.

Earlier Spec 021 installer builds and Spec 022 automated tests predate the Spec 023 commit and cannot
verify the cumulative result.

The source version is still `0.16.2-beta.1`, inherited from an already released line. A final
releasable version/changelog decision has not yet been applied and the existing immutable tag cannot
be reused.

### Target

After R1–R9:

1. run the exact local checks;
2. run build-only workflow dispatch for both channels;
3. download and inspect both artifacts;
4. complete the elevated disposable installed-Windows matrix for Specs 021 and 022;
5. complete the Spec 023 side-by-side and channel-update matrix;
6. choose a new valid version and changelog entry;
7. rerun no-cache preflight;
8. re-review before any production tag.

### Acceptance criteria

Record exact results for:

```powershell
python -m unittest tests.test_release_tag_script tests.test_release_notes_script tests.test_release_workflow tests.test_updater_configuration tests.test_app_channels tests.test_beta_bootstrap -v
node --test frontend\tests\appUpdater.test.ts frontend\tests\betaInstaller.test.ts frontend\tests\betaBootstrap.test.ts frontend\tests\appChannel.test.ts
cd frontend
npx tsc --noEmit
npm.cmd run build
cd ..
cargo test --manifest-path src-tauri\Cargo.toml
cargo check --manifest-path src-tauri\Cargo.toml
python scripts\preflight.py --no-cache
.\scripts\build-app.ps1 -Channel stable
.\scripts\build-app.ps1 -Channel beta
```

Build-only workflow matrix:

- `workflow_dispatch: channel=stable` passes and produces only Stable identity/branding.
- `workflow_dispatch: channel=beta` passes and produces only Beta identity/branding.
- extracted frontend channel stamps match;
- installer names, icons and product metadata match;
- no release is created by manual dispatch.

Installed disposable matrix:

- separate Installed Apps entries, folders, shortcuts, taskbar/tray identities and autostart values;
- simultaneous Stable/Beta execution and same-channel single-instance behavior;
- exact deep-link ownership;
- first-run Copy and Start-empty paths;
- Stable DB hash/UUID unchanged by copy;
- Beta UUID/data/cache separation;
- default and destructive uninstall isolation;
- Stable-owned Beta notification/modal/install;
- Stable remains installed after Beta install;
- Stable self-update affects only Stable;
- Beta self-update affects only Beta;
- cross-channel manifests/installers are rejected;
- first Stable legacy-endpoint bootstrap is proven;
- Beta is a GitHub prerelease and does not replace GitHub's latest Stable release;
- public raw channel pointers and signatures verify;
- no unrelated user data is used.

## Cross-spec status

### Spec 021

Code-level R1–R6 corrections remain present. Spec 023 reopens the channel-provenance risk in the
GitHub release workflow (R2 above). The elevated installed-Windows matrix remains outstanding.

### Spec 022

No new code-level regression was found in the reviewed bootstrap safety corrections R1–R8. The
channel-specific uninstaller target, transactional activation, fail-closed gate, full manifest
validation, retry behavior, recognition policy and streaming copy are present.

The installed disposable matrix—including destructive uninstall, simultaneous installed execution,
copy isolation and folder actions—remains outstanding and is included in R10.

## Verification record

### Implementer-reported

- Commit `95ad0c652a9ef248a1f13c11472f6e5a4c531371` reports implementation of separate updater feeds,
  Beta prerelease publishing and Stable-owned Beta installation.
- The committed Spec 023 review lists the commands that should be run but records no results.
- Review 022 records automated checks before the Spec 023 commit.
- No Spec 023 build-only or installed-Windows result is recorded.

### Reviewer independently inspected

- exact branch head, base, merge base and cumulative scope;
- Specs 021–023 and Reviews 021–023;
- Stable/Beta Tauri configuration overlays and updater endpoints;
- Tauri state registration and Standard/Beta pending update types;
- Standard updater, Beta installer and notification Rust paths;
- Beta installation reducer/coordinator/modal and Settings UX;
- Spec 022 Python/Rust/frontend corrections;
- NSIS process and destructive-data isolation;
- frontend channel-stamp tooling and local build script;
- release workflow, tag parser and manifest verifier;
- release-channel branch availability;
- documentation delta;
- commit statuses and attached workflow runs.

### Reviewer independently ran

No repository command, installer, workflow dispatch or Windows manual check was run. This review is
based on direct GitHub code/configuration inspection and the implementer's recorded earlier results.

The reviewed head has no attached combined statuses or PR workflow runs.

## Follow-up order

1. R1 — create a genuinely separate Tauri Beta pending-state type.
2. R2 — build and verify the correct frontend channel in GitHub Actions.
3. R3 — verify Beta signatures from the resolved/base public-key configuration.
4. R4 — pre-provision or correctly initialize the manifest-only channel branch.
5. R5 — enforce channel identity at runtime.
6. R6 — enforce future-core Beta release policy.
7. R7 — finish the Stable session before Beta installer launch.
8. R8 — correct Beta scheduling, opt-out and no-release feedback.
9. R9 — update durable documentation and this review.
10. R10 — run and record the full cumulative verification matrix.

## Merge decision

**Not ready to merge. Not ready to release.**

R1 can prevent the desktop application from starting. R2 can ship a Beta installer with the Stable
frontend. R3 and R4 prevent the first Beta/channel release from completing correctly. R5 leaves the
products vulnerable to crossed signed manifests. The cumulative installed and release matrix is
still unperformed.

Do not merge, push a production tag or publish either channel until R1–R10 are implemented and the
branch is re-reviewed.

## Composer handoff

```text
Implement the findings in
docs/specs/reviews/023-stable-beta-release-channels-review.md on
feature/stable-beta-app-identities.

Read this review first, then Specs 021–023 and Reviews 021–022.

Complete R1–R10 in order. Preserve the confirmed application identities,
separate data roots, Spec 022 transactional bootstrap, Beta branding, fixed
updater endpoints and dedicated Stable-owned Beta installation UX.

Critical corrections:
- PendingBetaInstall must be a real newtype, not a type alias.
- GitHub Actions must build and verify the requested frontend channel before
  packaging.
- Beta manifest verification must read the inherited updater public key.
- Do not initialize release-channels from main.
- Enforce exact channel SemVer in Rust before accepting pending updates.
- Enforce Beta core > latest real Stable release before draft staging.

Use disposable data and versions for every destructive/install test.
Do not merge, tag or publish until the branch is re-reviewed and the complete
matrix is recorded.
```

## Implementation record (R1–R10)

- **R1:** Replaced the alias with a real `PendingBetaInstall` newtype and added independent `TypeId` and state-isolation tests.
- **R2:** The release workflow explicitly builds the selected frontend channel and verifies its stamp twice before packaging.
- **R3:** Updater verification reads the shared key from the base `tauri.conf`, with offline Beta key tests.
- **R4:** The workflow requires a pre-provisioned, exact manifest-only `release-channels` tree; it never derives that branch from `main`, uses the optimistic target SHA, and verifies the non-target manifest remains unchanged.
- **R5:** Rust enforces exact channel SemVer policy before accepting a pending update.
- **R6:** A testable Beta future-Stable-core policy checks all published exact Stable tags before draft staging.
- **R7:** Beta installation now follows download → `/api/session/finish` → install, using the debug-log-and-continue policy when session finalization fails.
- **R8:** Recurring timers reschedule on Standard schedule events; opt-out clears non-protected UI and notification state, protected flows survive, and manual no-release feedback is dismissible.
- **R9:** Durable documentation was updated.
- **R10:** Local cumulative verification and both unsigned channel installer builds passed at
  `0.17.0-beta.1`. Remote build-only dispatch/artifact extraction and the elevated disposable
  installed/update matrix remain pending. No production tag, publish, merge, commit, or push was
  performed.

Verification actually run so far:

- focused Rust `beta_installer` tests: 4 passed;
- `app_channel` tests: 9 passed;
- focused workflow/frontend-channel tests: 27 passed;
- manifest-only branch tests/workflow tests: 25 passed;
- future-core policy tests: 4 passed;
- `betaInstaller` TypeScript tests: 10 passed;
- frontend `tsc --noEmit`: passed;
- required cumulative Python command: 108 passed;
- required cumulative frontend command: 53 passed;
- full Rust suite: 40 passed;
- `cargo check`: passed with two pre-existing dead-code warnings;
- frontend production build: passed (7,469 modules);
- synchronized version check: passed at `0.17.0-beta.1`;
- `python scripts\preflight.py --no-cache`: **PREFLIGHT PASSED — 5/5 stages**;
- `.\scripts\build-app.ps1 -Channel stable`: passed unsigned and produced
  `CellXplorer_0.17.0-beta.1_x64-setup.exe`;
- `.\scripts\build-app.ps1 -Channel beta`: passed unsigned and produced
  `CellXplorer Beta_0.17.0-beta.1_x64-setup.exe`;
- after the final scheduling correction, both installers were rebuilt from final sources with
  `-SkipInstall -SkipBackend`; both passed channel-stamp verification and packaging;
- installer metadata: Stable `ProductName=CellXplorer`; Beta
  `ProductName=CellXplorer Beta`; both `ProductVersion=0.17.0-beta.1`;
- final installer SHA-256:
  - Stable `86DF889AB5211F7DCDB0AD18BE1E153A5BA403B2C05494832EA02513C759261A`;
  - Beta `A34E3B4A773AE9F0DB65417181F0F2CE852E022F8D6030EACFE69EF0C69B0510`;
- final Beta frontend stamp: channel `beta`, branding hash
  `d65ba5456becc201465c69fe35db93b6b0dfa19eb50603552b1c1c24b5c8090a`.

The first run of the required Python command exposed the absent
`tests.test_release_tag_script` module after all other selected tests passed. A focused module was
added and the exact command was rerun successfully (108/108).

### R10 remaining verification

- GitHub CLI was unavailable and Cursor GitHub connection timed out, so neither build-only workflow
  dispatch was run against these uncommitted changes.
- The per-machine NSIS installed matrix requires an elevated disposable Windows session and was not
  run. No installer was launched and no profile/registry data was modified by matrix testing.
- First Stable legacy-endpoint bootstrap, Stable-owned Beta install, side-by-side runtime,
  channel-specific N→N+1 updates, crossed signed-manifest rejection, public pointer verification,
  and destructive uninstall isolation remain unproven in installed artifacts.
- No commit, push, merge, tag, GitHub Release, or channel-pointer publication was performed.
