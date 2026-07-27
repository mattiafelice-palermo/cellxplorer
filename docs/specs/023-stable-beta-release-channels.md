# Spec 023: Separate Stable/Beta release feeds and Beta installation UX

Status: **implemented — awaiting review**  
Repository: `mattiafelice-palermo/cellxplorer`  
Target branch: `feature/stable-beta-app-identities` (Specs 021–023 release train)  
Review document: `docs/specs/reviews/023-stable-beta-release-channels-review.md`

## 1. Goal

Complete the side-by-side Beta system:

- Stable updates only Stable;
- Beta updates only Beta;
- Beta GitHub releases are real prereleases;
- the Stable app may notify an opted-in user that Beta is available and install the separate
  `CellXplorer Beta` product with explicit confirmation;
- the existing Stable installation and data remain intact;
- release automation publishes and verifies both channels without one channel replacing the other.

This specification replaces the current client-side approach where a Beta release is published as
GitHub's normal latest release and Stable merely filters versions containing `beta`.

## 2. Locked channel behavior

| Behavior | Stable app | Beta app |
|---|---|---|
| Normal self-update feed | Stable only | Beta only |
| Normal **Check for updates** | checks Stable | checks Beta |
| Beta opt-in control | shown | hidden |
| Can install first Beta copy | yes, with confirmation | not applicable |
| Updates an existing Beta install | no | Beta updates itself |
| GitHub release type | normal release | prerelease |
| Product overwritten by update | Stable only | Beta only |
| Data root | `.cellxplorer` | `.cellxplorer-beta` |

A Stable self-update must never install `CellXplorer Beta`. A Beta self-update must never install
Stable.

## 3. Release-channel endpoints

Create a dedicated branch in the same repository:

```text
release-channels
```

It contains exactly:

```text
stable/latest.json
beta/latest.json
README.md
```

Updater endpoints:

```text
Stable:
https://raw.githubusercontent.com/mattiafelice-palermo/cellxplorer/release-channels/stable/latest.json

Beta:
https://raw.githubusercontent.com/mattiafelice-palermo/cellxplorer/release-channels/beta/latest.json
```

Rules:

- `release-channels` contains manifests only, no source branch work;
- each manifest is the verified Tauri updater JSON generated for that channel;
- installer URLs point to immutable assets on the corresponding SemVer GitHub release;
- channel files update only after the draft release and its assets pass all existing verification;
- update the file atomically through the GitHub contents API;
- a failed channel-pointer update leaves clients on the previous valid release;
- do not force-push or rewrite channel history;
- do not put signing secrets in the branch.

The first Stable release after this change must still be published as a normal GitHub latest release
with its ordinary `latest.json` asset so currently installed old Stable clients can bootstrap to it.
That release's embedded configuration then moves future checks to `release-channels/stable/latest.json`.

## 4. Tag and release rules

Keep exact tag formats:

```text
Stable: vMAJOR.MINOR.PATCH
Beta:   vMAJOR.MINOR.PATCH-beta.N
```

Rules:

- tag channel is determined only by `scripts/release_tag.py`;
- configured package version must exactly match the tag without leading `v`;
- Stable tags build the Stable configuration;
- Beta tags build `src-tauri/tauri.beta.conf.json`;
- Stable releases set `prerelease: false`;
- Beta releases set `prerelease: true`;
- Beta releases must no longer be disguised as normal releases;
- a Beta series targets a future Stable version, for example `0.18.0-beta.1` before `0.18.0`;
- reject a Beta tag whose core version is not greater than the latest published Stable version;
- published release assets remain immutable; cut a new Beta sequence number or patch instead of
  replacing a published release.

Use the same updater signing key for both channels unless a later security specification explicitly
changes key ownership.

## 5. Current implementation anchors

### Existing Beta filter

- `frontend/src/appUpdater.ts`
  - `betaUpdatesEnabled`
  - `isBetaUpdateVersion`
  - `acceptUpdateReleaseForPreferences`
- `frontend/src/components/AppUpdateCoordinator.tsx`
- `frontend/src/pages/SettingsPage.tsx`
  - `Receive beta versions`

### Updater implementation

- `src-tauri/src/app_updates.rs`
  - `PendingAppUpdate`
  - `check_app_update`
  - `download_app_update`
  - `install_app_update`
- `src-tauri/src/update_notifications.rs`
- `src-tauri/tauri.conf.json`
- `src-tauri/tauri.beta.conf.json` from Spec 021

### Release automation

- `.github/workflows/release.yml`
- `scripts/release_tag.py`
- `scripts/check_versions.py`
- `scripts/release_notes.py`
- `scripts/verify_updater_manifest.py`
- `tests/test_release_workflow.py`
- `tests/test_release_notes_script.py`
- `tests/test_updater_configuration.py`

### Windows product detection

- Spec 021 product/uninstall identities;
- `src-tauri/src/main.rs`;
- existing shell/process and updater lifecycle helpers.

## 6. Standard self-updater separation

Update final Tauri configurations:

### Stable config

```json
"endpoints": [
  "https://raw.githubusercontent.com/mattiafelice-palermo/cellxplorer/release-channels/stable/latest.json"
]
```

### Beta overlay

```json
"plugins": {
  "updater": {
    "endpoints": [
      "https://raw.githubusercontent.com/mattiafelice-palermo/cellxplorer/release-channels/beta/latest.json"
    ]
  }
}
```

Remove the temporary Beta updater gate from Spec 021.

The standard Rust updater commands remain one implementation. They use the endpoint embedded in the
current product configuration:

- Stable pending state can hold only Stable feed updates;
- Beta pending state can hold only Beta feed updates;
- do not pass arbitrary endpoint URLs from the frontend;
- do not keep the old `/releases/latest/` endpoint as a fallback;
- continue signature verification and pending-state race protections unchanged.

The update notification title should use the current product name:

```text
CellXplorer update available
CellXplorer Beta update available
```

## 7. Change the Stable preference semantics

Preserve the existing localStorage key and field for migration compatibility:

```ts
betaUpdatesEnabled: boolean
```

But change its meaning in Stable.

Exact copy:

```text
Notify me about CellXplorer Beta

Check for the separate Beta app. Installing Beta keeps this stable installation
and its data unchanged.
```

Rules:

- shown only in Stable;
- default remains off;
- it no longer changes the Standard self-updater's accepted versions;
- Stable feed contains no Beta versions, so remove client-side Beta filtering from
  `AppUpdateCoordinator`;
- when enabled and saved, perform an immediate Beta availability check;
- subsequent automatic Beta checks use the existing application-update interval;
- automatic Beta check failures are silent and debug-logged;
- disabling the preference clears Beta availability UI but does not uninstall Beta.

In Beta Settings, replace the toggle with a small informational card:

```text
Beta release channel

This installation receives CellXplorer Beta updates. Stable CellXplorer remains
a separate application.
```

## 8. Beta installation coordinator in Stable

Create a separate coordinator; do not overload `PendingAppUpdate` or the existing update modal:

```text
frontend/src/components/BetaInstallCoordinator.tsx
frontend/src/betaInstaller.ts
src-tauri/src/beta_installer.rs
```

Mount it only in Stable.

### 8.1 State model

```ts
export type BetaInstallState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "available"; release: AppUpdateRelease }
  | {
      status: "downloading";
      release: AppUpdateRelease;
      downloadedBytes: number;
      totalBytes: number | null;
    }
  | { status: "launching"; release: AppUpdateRelease }
  | { status: "installed"; installedVersion: string; executablePath: string }
  | { status: "error"; phase: "check" | "download" | "install"; message: string };
```

Keep it independent from `AppUpdateState`.

### 8.2 Rust commands

Expose narrow commands:

```rust
detect_beta_installation()
check_beta_install()
download_beta_install(expected_version, on_progress)
install_beta(expected_version)
open_beta_application()
```

Requirements:

- all commands reject the Beta channel; they are Stable-only;
- `detect_beta_installation` reads the exact Spec 021 Beta uninstall registration and validates the
  executable path;
- no broad arbitrary registry/path execution API;
- `check_beta_install` uses a Rust-owned constant Beta channel endpoint;
- use a separate `PendingBetaInstall` mutex/state;
- use Tauri updater `Update::download` so the installer signature is verified with the committed
  public key;
- do not reuse or mutate `PendingAppUpdate`;
- `install_beta` launches the verified `CellXplorer Beta` installer;
- before installer launch, finish the Stable session and use the existing on-before-exit backend
  cleanup;
- installation requires explicit user confirmation;
- never silently install from a background check;
- after Beta is installed, Stable detects it and no longer offers first installation;
- Stable does not update an already installed Beta—Beta updates itself.

Do not accept an installer URL, public key or executable path from the frontend.

### 8.3 Beta availability and deduplication

Add localStorage key:

```text
cellxplorer-beta-notified-version
```

Automatic behavior when opted in:

- if Beta is already installed, do not notify;
- if a newer Beta is available, show one native Windows notification per Beta version;
- notification title: `CellXplorer Beta available`;
- body: `Version X is available as a separate preview app. Click to review.`;
- click restores Stable and opens the Beta install modal;
- no automatic download.

No global badge is required; do not reuse the Stable self-update badge and confuse the channels.
Settings must show the current Beta status.

## 9. Beta install modal

Use a new modal, not `AppUpdateModal`.

Available state:

```text
CellXplorer Beta X is available

Beta installs beside the stable app and uses a separate library. It will not
replace this installation.

[release notes]

[Install CellXplorer Beta] [Cancel]
```

During download:

- same progress semantics as the existing update modal;
- non-dismissible;
- label must say `Downloading CellXplorer Beta`.

Before install, reuse the dirty-analysis warning pattern:

```text
Install CellXplorer Beta?

The installer will close this Stable CellXplorer session. Unsaved plot changes
will be lost. The stable installation and library will not be replaced.
```

Install failure must show a retry/restart-safe state consistent with current updater lifecycle.
Never claim Stable remains running after `on_before_exit` has executed.

Installed state in Settings:

```text
CellXplorer Beta is installed
Version X

[Open Beta]
```

Do not add uninstall controls.

## 10. Release workflow

Refactor `.github/workflows/release.yml` without duplicating the entire job.

### 10.1 Resolve channel

Add an early step that outputs:

```text
channel=stable|beta
product_name=CellXplorer|CellXplorer Beta
config_args=<empty>|--config src-tauri/tauri.beta.conf.json
channel_manifest=stable/latest.json|beta/latest.json
is_prerelease=false|true
```

For `workflow_dispatch`, add one required input:

```yaml
channel:
  type: choice
  options: [stable, beta]
  default: stable
```

Manual dispatch remains build-only and never creates a release.

### 10.2 Build environment

For every build:

- set `VITE_CELLXPLORER_CHANNEL`;
- use the matching Tauri config;
- build the common sidecar once;
- require expected product-specific installer and `.sig` names;
- verify Stable artifacts do not contain Beta identity and vice versa.

### 10.3 Draft release

Preserve current safeguards:

- exact tag validation;
- commit reachable from `main`;
- public repository;
- signing secret checks;
- draft staging;
- immutable published-release guard;
- manifest/signature/key verification;
- no plain unsigned binary;
- full action SHA pinning;
- per-tag concurrency.

Set:

```yaml
prerelease: ${{ steps.channel.outputs.is_prerelease }}
releaseName:
  Stable -> CellXplorer <version>
  Beta   -> CellXplorer Beta <version>
```

### 10.4 Publish channel manifest

Only after the draft release assets pass verification:

1. publish/undraft the immutable GitHub release;
2. take the uploaded verified `latest.json`;
3. update the exact path on `release-channels` with a normal Git commit through the GitHub contents
   API;
4. use optimistic blob-SHA conflict protection;
5. commit message:
   - `Publish CellXplorer stable channel <version>`
   - `Publish CellXplorer beta channel <version>`
6. fetch the branch file through GitHub's contents API and compare exact bytes;
7. fetch the public raw endpoint with retry/cache-busting and run
   `verify_updater_manifest.py` against it;
8. if the channel update fails, fail the workflow and report that the release exists but clients
   remain on the previous channel pointer.

Never update the other channel's file.

### 10.5 Bootstrap compatibility

For the first Stable release:

- retain `latest.json` as an asset on the ordinary Stable GitHub release;
- confirm the old endpoint
  `/releases/latest/download/latest.json` serves that Stable manifest;
- confirm the new binary's embedded endpoint is the Stable channel branch;
- document this as a one-release bootstrap requirement.

## 11. Manifest verification

Extend `scripts/verify_updater_manifest.py` with channel expectations:

```text
--channel stable|beta
--expected-product-name
--expected-installer-name
```

Validate:

- exact SemVer form for channel;
- Stable manifest cannot contain `-beta.`;
- Beta manifest must contain `-beta.N`;
- installer asset name belongs to the correct product;
- asset URL belongs to the exact immutable release tag;
- signature matches the uploaded product installer;
- notes/version/repository/key checks remain;
- Stable/Beta channel paths are not crossed.

The channel branch stores no secrets and no unsigned executable.

## 12. Version tooling

Keep one version across maintained declarations for each source commit.

Extend tests/tooling so:

- `bump_version.py` can set an explicit Beta version such as `0.18.0-beta.1`;
- Stable auto-bump behavior remains;
- release notes extraction supports exact Beta headings;
- tag/version checks understand Stable and Beta without loose substring matching;
- package product identity is channel-specific but version consistency remains global.

Do not hardcode the next version in this specification. Resolve it from current `main` at
implementation time.

## 13. Tests

### Standard updater channel

- resolved Stable config has only Stable endpoint;
- resolved Beta config has only Beta endpoint;
- no `/releases/latest/` endpoint remains in final configs;
- Stable self-updater accepts only Stable manifest fixtures;
- Beta self-updater accepts only Beta manifest fixtures;
- temporary Spec 021 gate is removed.

### Beta installation policy

- commands are Stable-only;
- exact Beta uninstall key detection;
- invalid/missing executable is not treated as installed;
- Beta endpoint is Rust-owned, not frontend-provided;
- pending Beta installer state is separate;
- version mismatch and overlapping downloads fail safely;
- notification deduplicates per Beta version;
- disabled preference does not check/notify;
- installed Beta suppresses first-install offer;
- notification activation opens modal only;
- no Beta check affects Stable self-update state.

### Settings/modal

- Stable shows new exact opt-in copy;
- Beta hides the toggle and shows information card;
- enabling triggers immediate check;
- available/download/error/installed states render;
- explicit confirmation required;
- dirty-workspace warning mentions Stable closure and separate installation;
- no global ambiguous update badge.

### Release workflow

Add fixtures/tests for:

- Stable and Beta tag resolution;
- true prerelease flag for Beta;
- channel-specific Tauri config and Vite environment;
- product-specific asset names;
- stable/beta manifest validation;
- only correct channel path updated;
- contents API SHA conflict fails safely;
- channel file updated after—not before—release verification;
- manual dispatch build-only for both choices;
- first Stable bootstrap asset retained;
- existing SHA pins, concurrency and signing guards preserved.

Run:

```powershell
python -m unittest tests.test_release_tag_script tests.test_release_notes_script tests.test_release_workflow tests.test_updater_configuration -v
node --test frontend\tests\appUpdater.test.ts frontend\tests\betaInstaller.test.ts frontend\tests\appChannel.test.ts
cd frontend
npx tsc --noEmit
npm.cmd run build
cd ..
cargo test --manifest-path src-tauri\Cargo.toml
cargo check --manifest-path src-tauri\Cargo.toml
python scripts\preflight.py --no-cache
```

Run build-only workflow dispatch for both channels and inspect artifacts.

## 14. Mandatory release/install matrix

Use disposable test versions and data.

### Side-by-side first install

1. Install Stable.
2. Enable `Notify me about CellXplorer Beta`.
3. Confirm immediate/automatic Beta check.
4. Open the Beta install modal from Settings and from notification click.
5. Install Beta.
6. Confirm Stable remains installed in its original folder.
7. Confirm Beta is installed in its separate folder.
8. Confirm Stable and Beta data roots remain separate.
9. Confirm both run simultaneously.
10. Confirm Stable now shows Beta installed and can open it.

### Channel updates

- publish Stable N+1; Stable detects/downloads/installs it; Beta does not;
- publish Beta M-beta.2; Beta detects/downloads/installs it; Stable standard updater does not;
- Stable Beta-availability checker may report a not-yet-installed Beta only;
- after Beta is installed, Stable does not attempt to update it;
- stable and beta native notification titles identify the correct product;
- neither channel accepts the other's manifest/installer.

### Release behavior

- Beta GitHub release visibly has prerelease status;
- Beta release does not change GitHub's normal latest Stable release;
- Stable and Beta channel branch files point to their correct immutable releases;
- public raw endpoints are accessible without credentials;
- signatures verify;
- uninstalling one product leaves the other product and data intact.

Record:

- Windows version;
- source/target app versions;
- release URLs/tags;
- artifact names;
- installed directories;
- data directories;
- exact updater and notification results.

## 15. Documentation and context

Update:

- `AGENTS.md`;
- `docs/agent-knowledge/architecture.md`;
- `docs/agent-knowledge/change-playbooks.md`;
- `docs/windows-packaging.md`;
- `docs/tauri-packaging-lessons.md`;
- `docs/specs/README.md`;
- README user-facing installation/update section;
- repository-maintained project-context mirrors if present.

Document:

- two products and data roots;
- channel endpoints and release branch;
- Beta prerelease/tag rules;
- first Stable bootstrap release;
- Stable-to-Beta installation ownership;
- exact manual release matrix.

## 16. Out of scope

- silently installing Beta when the preference is enabled;
- Stable updating an existing Beta installation;
- Beta updating Stable;
- shared Stable/Beta database;
- cross-channel downgrade;
- automatic database synchronization;
- macOS/Linux channels;
- Windows Authenticode;
- multiple Beta rings such as alpha/canary/nightly;
- external update hosting beyond the repository channel branch.

## 17. Implementation order

1. Copy/index the spec; create the branch after Spec 022 is merged.
2. Add final Stable/Beta endpoint configs and remove the temporary gate.
3. Remove Beta filtering from the Standard updater and change Settings semantics.
4. Implement separate Stable-owned Beta installation Rust state/commands.
5. Add Beta installation coordinator, notification and modal.
6. Make update notifications/product copy channel-aware.
7. Refactor release workflow to resolve channel and build product-specific artifacts.
8. Add atomic `release-channels` manifest publishing and verification.
9. Extend version/release/manifest tests.
10. Update documentation.
11. Run all local checks and build-only workflows for both channels.
12. Perform the full side-by-side and N→N+1 release matrix.
13. Apply the final version/changelog decision.
14. Re-run no-cache preflight and review before any production tags.

## 18. Acceptance checklist

- [ ] Stable and Beta use separate fixed updater endpoints.
- [ ] Stable standard updater can never install Beta.
- [ ] Beta standard updater can never install Stable.
- [ ] Beta releases are true GitHub prereleases.
- [ ] Stable remains GitHub's normal latest release.
- [ ] Stable opt-in means notification/installation of a separate Beta product.
- [ ] Beta installation is explicit and uses a separate pending state/modal.
- [ ] verified Beta installer launches without replacing Stable.
- [ ] Stable does not manage an already installed Beta's updates.
- [ ] channel manifests are atomically updated only after verification.
- [ ] Stable/Beta artifact names, versions, signatures and URLs are validated.
- [ ] first Stable bootstrap from the old endpoint is proven.
- [ ] both build-only workflow choices succeed.
- [ ] full Stable/Beta install and update matrix passes.
- [ ] final version/changelog/preflight are synchronized.
- [ ] branch is re-reviewed before release tags are pushed.

## 19. Composer handoff

```text
Implement docs/specs/023-stable-beta-release-channels.md.

Read Specs 021 and 022, their reviews, AGENTS.md, architecture.md,
change-playbooks.md, docs/windows-packaging.md, docs/tauri-packaging-lessons.md,
Specs 017-020 and the current release workflow before editing.

Create feature/stable-beta-release-channels from current main only after Spec 022
is merged and no other feature branch is active.

Locked architecture:
- Stable self-updates only from release-channels/stable/latest.json.
- Beta self-updates only from release-channels/beta/latest.json.
- Beta GitHub releases are true prereleases.
- Stable may explicitly install the separate Beta product, but never through
  PendingAppUpdate and never silently.
- Stable does not update an installed Beta; Beta updates itself.
- Keep all current signing, draft verification, concurrency and immutable-release
  guards.
- Do not push production tags until the full two-channel Windows matrix is
  recorded and the implementation is re-reviewed.
```
