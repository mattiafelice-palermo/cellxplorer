# Spec 019: Automated GitHub release publishing

Status: **implemented** (review follow-ups R1–R8 addressed on `feature/updater-017-019`; do not
push `v0.15.0` until the repository is public and Specs 017/018 re-review is clean).

Repository: `mattiafelice-palermo/cellxplorer`  
Target branch: `feature/updater-017-019` (shared with Specs 017 and 018; merge once when all three are complete)  
Base: `feature/updater-017-019` **after Specs 017 and 018 are complete on this branch**  
Dependencies: Specs 017 and 018  
Review document: `docs/specs/reviews/019-automated-github-release-publishing-review.md`

## 1. Goal

Make a stable GitHub version tag produce a complete, signed CellXplorer Windows release automatically:

1. validate that every maintained version declaration matches the tag;
2. run the canonical clean preflight;
3. build the React frontend and bundled Python sidecar;
4. build the branded NSIS installer and Tauri updater signature;
5. create the GitHub Release;
6. upload the installer, `.sig` and generated `latest.json`;
7. provide the release notes consumed by the Spec 018 modal.

After the first updater-enabled release is manually installed, later stable releases must become discoverable by the app without editing application code or a server.

## 2. Locked release model

### 2.1 A stable version tag is the publishing trigger

Publishing is triggered by pushing a tag matching:

```text
v*
```

Example:

```powershell
git tag v0.15.0
git push origin v0.15.0
```

The workflow creates or updates a **draft** GitHub Release, verifies installer / `.sig` /
`latest.json` against release-asset metadata, and only then undrafts the release. Drafts are not
selected by `releases/latest`, so a failed verification cannot expose an incomplete stable updater
endpoint.

Do not publish installers on ordinary `main` pushes. The existing `main` preflight workflow remains the normal post-merge quality check.

### 2.2 Sequential completion and one release bump

Specs 017 and 018 are internal dependent stages and must be merged without publishing separate releases.

When this specification is implemented against the current `0.14.3` baseline, the combined updater feature is a backward-compatible feature and should become **0.15.0**. If `main` has moved to another version by then, choose the next correct minor version instead of forcing `0.15.0`.

Update all maintained version declarations and add the release notes at the top of `CHANGELOG.md` in the same branch. `scripts/check_versions.py` remains authoritative for the version locations.

### 2.3 Public download prerequisite

The current repository is private. GitHub's unauthenticated `releases/latest/download/latest.json` endpoint is not a suitable installed-app update endpoint while it remains private.

Before the first production release from this workflow, do one of:

1. make `mattiafelice-palermo/cellxplorer` public, as currently intended; or
2. return for a new decision and publish the release assets to a separate public repository/CDN.

Do not embed a personal access token, GitHub App token or repository credential in CellXplorer.

The workflow may be implemented and exercised in build-only mode while the repository is still private, but the live updater acceptance test cannot pass until assets are publicly readable.

### 2.4 Use the official Tauri GitHub Action

Use `tauri-apps/tauri-action` for Tauri bundling, GitHub release creation, updater signature upload and `latest.json` generation.

Pin the action to an exact reviewed commit SHA, not a floating `@v0`/`@v1` reference. At implementation time, verify the current stable release and pin its full commit. The latest observed stable when this spec was written was action `v0.6.2`; do not rely on that observation without checking the action repository during implementation.

Required action behavior:

- `uploadUpdaterJson: true`;
- `uploadUpdaterSignatures: true`;
- `updaterJsonPreferNsis: true`;
- `releaseDraft: true` while staging, then undraft only after CellXplorer verification;
- `prerelease: false`;
- no plain unbundled executable upload.

### 2.5 Release notes come from `CHANGELOG.md`

The release's notes and `latest.json.notes` must come from the exact version section in `CHANGELOG.md`.

Add a small deterministic parser, for example:

```text
scripts/release_notes.py
```

It must:

- accept an expected version/tag;
- find exactly one matching changelog section;
- extract content until the next version heading;
- fail on missing, duplicate or empty sections;
- output plain Markdown/text suitable for both the GitHub release body and the updater modal;
- never call GitHub or alter the changelog.

Release notes are frozen into `latest.json` at publish time. Editing only the GitHub release body afterwards does not update the manifest notes; corrections require rebuilding/re-uploading `latest.json` through a controlled release workflow.

### 2.6 Tauri updater signing secrets

GitHub repository secrets:

```text
TAURI_SIGNING_PRIVATE_KEY
TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

Use them only in the release build step. The private key must not be printed, persisted as an artifact or written to the repository workspace unless the Tauri CLI requires a temporary file that is removed in an always-run cleanup step.

`GITHUB_TOKEN` is used only by the workflow with `contents: write` permission.

The workflow must fail before publishing when signing material is absent or invalid.

### 2.7 Windows-only scope

Build only on `windows-latest` for this feature. Do not add Linux or macOS artifacts.

Use:

- Python 3.12;
- Node.js 22;
- current stable Rust toolchain compatible with the repository lockfile;
- the repository's existing PyInstaller and NSIS/Tauri paths.

### 2.8 Do not duplicate tag preflight

The current `.github/workflows/preflight.yml` also triggers on `v*` tags. Once the release workflow independently runs the canonical preflight, remove the tag trigger from `preflight.yml` to avoid paying for two complete Windows jobs for every release.

Keep:

- `main` push;
- `workflow_dispatch`.

## 3. Current implementation anchors

Read before editing:

- `AGENTS.md`
- `docs/specs/README.md`
- Specs 017 and 018 plus their review files
- `docs/agent-knowledge/change-playbooks.md`
- `docs/windows-packaging.md`
- `docs/tauri-packaging-lessons.md`
- `.github/workflows/preflight.yml`
  - Windows clean environment;
  - Python 3.12 and Node 22;
  - tag version validation;
  - `python scripts/preflight.py`.
- `scripts/preflight.py`
- `scripts/check_versions.py`
- `scripts/build-app.ps1`
  - frontend build;
  - backend fingerprint/build/copy;
  - NSIS build;
  - expected setup executable lookup.
- `package.json`
  - `build:backend`;
  - `tauri:build`.
- `backend/requirements.txt`
  - does not install PyInstaller, so CI must install it explicitly.
- `src-tauri/tauri.conf.json`
  - NSIS target and custom template;
  - updater configuration from Spec 017.
- `src-tauri/cellxplorer-installer.nsi`
- `CHANGELOG.md`

Official references:

- Tauri GitHub workflow guide: `https://v2.tauri.app/distribute/pipelines/github/`
- Official action repository: `https://github.com/tauri-apps/tauri-action`
- Tauri updater guide: `https://v2.tauri.app/plugin/updater/`

## 4. Workflow design

Add:

```text
.github/workflows/release.yml
```

Suggested high-level structure:

```yaml
name: Publish CellXplorer release

on:
  push:
    tags:
      - "v*"
  workflow_dispatch:

permissions:
  contents: write

jobs:
  build-release:
    runs-on: windows-latest
```

`workflow_dispatch` is always a **build-only rehearsal**. It must not create or alter a GitHub
Release. Tag pushes are the only publish path.

### 4.1 Checkout and toolchains

Use pinned major versions already established by the repository where possible:

- `actions/checkout`;
- `actions/setup-python` with Python 3.12 and pip cache based on `backend/requirements.txt`;
- `actions/setup-node` with Node 22 and npm caches for both root and frontend lockfiles;
- a pinned/reviewed Rust toolchain setup action or `rustup` command;
- Rust/Cargo cache only if it remains deterministic and does not hide missing source inputs.

Do not use unpinned third-party actions beyond approved official or widely used build actions. Pin release-sensitive third-party actions to commit SHAs.

### 4.2 Dependency installation

Use clean installs:

```powershell
python -m pip install --upgrade pip
python -m pip install -r backend/requirements.txt
python -m pip install pyinstaller
python -m pip check
npm ci
npm --prefix frontend ci
```

Do not replace `npm ci` with `npm install` in CI.

### 4.3 Version and changelog gate

For tag publishing:

```powershell
python scripts/check_versions.py --expected-version "${{ github.ref_name }}"
python scripts/release_notes.py --expected-version "${{ github.ref_name }}" --output release-notes.md
```

The parser should accept a leading `v` and compare the normalized SemVer.

For manual build-only dispatch, validate internal version consistency without requiring a tag and extract the current manifest version's notes.

The job fails before any release upload if:

- versions disagree;
- the tag is not valid SemVer;
- the changelog section is absent/empty;
- the tag version is not newer than the previous stable release when that can be checked safely.

Do not make a network lookup of the previous release a prerequisite for local/unit tests.

### 4.4 Canonical preflight

Run:

```powershell
python scripts/preflight.py --no-cache
```

Use `--no-cache` for releases so a stale local preflight cache cannot skip release gates.

Do not weaken, skip or duplicate individual checks merely because the later packaging stage rebuilds some outputs.

### 4.5 Prepare the sidecar

After preflight, build/copy the packaged backend with the existing build script rather than duplicating PyInstaller flags in YAML:

```powershell
.\scripts\build-app.ps1 -SkipInstall -SkipFrontend -SkipInstaller -ForceBackend
```

The preflight already produced `frontend/dist`; the command above builds the sidecar and copies the target-triple-named executable into `src-tauri/binaries`.

Fail if either required packaged input is absent:

```text
frontend/dist/index.html
src-tauri/binaries/cellxplorer-backend-x86_64-pc-windows-msvc.exe
```

### 4.6 Tauri CLI script

The Tauri action's `tauriScript` must be a command without the `build` subcommand. Add a cross-platform root script if needed, for example:

```json
"tauri": "tauri"
```

Keep the existing local `tauri:build` script unless there is a demonstrated reason to replace it.

Do not use a Windows-only `.cmd` executable in a repository script intended to be understood by the action unless verified on `windows-latest`.

### 4.7 Publish step

For a tag build, invoke the pinned Tauri action with:

```yaml
env:
  GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
with:
  tagName: ${{ github.ref_name }}
  releaseName: CellXplorer __VERSION__
  releaseBody: <contents of release-notes.md>
  releaseDraft: true
  prerelease: false
  uploadUpdaterJson: true
  uploadUpdaterSignatures: true
  updaterJsonPreferNsis: true
  uploadPlainBinary: false
```

After the action returns, verify the workspace-root `latest.json` against the draft release's asset
metadata (API asset URL + setup executable name + adjacent `.sig`). Only then undraft the release.
A published non-draft release is immutable: corrections require a new patch version/tag.

### 4.8 Post-build manifest verification

Before considering publishing successful, verify the generated/uploaded release assets contain:

```text
CellXplorer_<version>_x64-setup.exe
CellXplorer_<version>_x64-setup.exe.sig
latest.json
```

Read `latest.json` and assert:

- `version` equals the tag without the leading `v`;
- `notes` equals the extracted changelog notes, allowing only action-normalized line endings;
- a Windows x86_64/NSIS platform entry exists;
- its URL points to the same GitHub release and setup executable;
- its signature is non-empty;
- no local path, token or private key appears.

If installer-specific keys are emitted, the plugin version from Spec 017 must remain compatible. Do not manually rewrite signatures or URLs after generation.

Implement this as a small read-only script/test rather than fragile inline PowerShell where practical.

## 5. New helper tests

Add focused tests, suggested:

```text
tests/test_release_notes_script.py
tests/test_release_workflow.py
```

Cover:

### Release-note parser

- exact current section extraction;
- leading `v` normalization;
- stop at the next version heading;
- missing, duplicate and empty section failures;
- CRLF/LF stability;
- no file modification.

### Workflow/config contract

Parse YAML/text without network access and assert:

- tag trigger exists only in `release.yml`;
- `preflight.yml` still runs on `main` and manual dispatch but not tags;
- release job runs on Windows;
- `contents: write` is scoped to release workflow;
- release uses `--no-cache` preflight;
- `check_versions.py --expected-version` runs before publishing;
- PyInstaller is installed;
- updater signing environment names are present but no secret values are hardcoded;
- Tauri action is pinned to a full SHA;
- NSIS is preferred for updater JSON;
- plain binary upload is disabled;
- manual dispatch is build-only by default.

Tests must not print or require secrets.

## 6. Documentation and repository maintenance

Update:

- `docs/windows-packaging.md`
  - production release procedure;
  - required secrets;
  - generated updater assets;
  - first updater-enabled bootstrap install;
  - public endpoint requirement;
  - recovery when a signing key is lost.
- `docs/agent-knowledge/change-playbooks.md`
  - tag/release checklist and live updater smoke test.
- `AGENTS.md`
  - maintained tree for `.github/workflows/release.yml` and new scripts/tests if needed;
  - canonical release instructions if the workflow changes them.
- `docs/specs/README.md`
  - Specs 017–019 index/status.
- `CHANGELOG.md`
  - user-facing updater feature notes.

This is a durable release-architecture change. After merge, the ChatGPT Project architecture/workflow mirror files will be stale unless repository copies already exist and are updated. Follow `CELLXPLORER_CONTEXT_MAINTENANCE.md`: report the exact project-context files needing replacement; do not claim uploaded Project files were changed by a repository commit.

## 7. End-to-end acceptance test

A successful GitHub workflow is not enough. Perform one real two-version test on a disposable Windows installation and record exact versions.

### 7.1 Bootstrap limitation

Existing CellXplorer versions do not contain the updater. Therefore the first updater-enabled release must be installed manually.

Example sequence from the current baseline:

1. publish and manually install updater-enabled `0.15.0`;
2. publish a signed stable `0.15.1` test/fix release;
3. verify `0.15.0` discovers and installs `0.15.1`.

Do not publish a fake higher stable release merely to test and then delete it: clients may cache or observe it. Use a real patch release with valid notes, or perform the complete test in a separate public test repository/endpoint before switching the production endpoint.

### 7.2 Required checks

From installed version N:

1. app starts and backend/database are healthy;
2. automatic or manual check detects N+1;
3. power badge and final menu item show N+1;
4. modal displays exactly the N+1 `latest.json` notes;
5. download progress reaches completion in the same modal;
6. branded NSIS installer launches automatically;
7. UAC/basic installer UI is expected for per-machine install;
8. complete installation and start CellXplorer;
9. application and backend versions report N+1;
10. the previous database, cells, analyses, settings and caches remain available;
11. no old Python sidecar remains running and no port conflict occurs;
12. the application session from N is closed rather than left as interrupted where the existing session endpoint permits;
13. another update check reports no newer stable update.

Record which checks were manually performed. Do not claim the real update path passed from unit tests or a local installer build.

## 8. Release failure behavior

- If preflight fails: publish nothing.
- If version/changelog validation fails: publish nothing.
- If signing fails: publish nothing.
- If the installer builds but manifest verification fails: do not mark the release as successful; remove/replace any incomplete draft assets before exposing a stable release.
- Avoid publishing a stable release incrementally asset-by-asset where clients could fetch an incomplete `latest.json`.
- Do not overwrite a previously published version with different binaries. Fix the issue and publish a new patch version.
- Never rotate the updater key casually. Existing clients trust the public key embedded in their installed version.

## 9. Files expected to change

Likely minimum:

```text
.github/workflows/preflight.yml
.github/workflows/release.yml
package.json
package-lock.json
scripts/release_notes.py
scripts/verify_updater_manifest.py
tests/test_release_notes_script.py
tests/test_release_workflow.py
CHANGELOG.md
docs/windows-packaging.md
docs/agent-knowledge/change-playbooks.md
docs/specs/README.md
docs/specs/019-automated-github-release-publishing.md
```

Plus the synchronized version declarations identified by `scripts/check_versions.py`.

Do not add generated installers, signatures, `latest.json`, private keys or workflow artifacts to Git.

## 10. Verification

### Local/focused

```powershell
python -m unittest tests.test_release_notes_script -v
python -m unittest tests.test_release_workflow -v
python scripts\check_versions.py
python scripts\preflight.py --no-cache
```

### GitHub build-only rehearsal

Run `workflow_dispatch` and confirm:

- clean Windows build succeeds;
- signed NSIS/setup signature artifacts are produced when secrets are available;
- workflow artifacts can be inspected;
- no GitHub Release is created or altered.

### Production tag

After public-host and signing prerequisites are satisfied:

- push the intended stable tag;
- inspect the public release assets and `latest.json`;
- perform the two-version installed-app acceptance test in §7.

## 11. Out of scope

- Windows Authenticode certificate acquisition/signing;
- Microsoft Store publishing;
- beta/nightly channels;
- macOS/Linux releases;
- release rollback;
- delta updates;
- a separate update server;
- analytics/telemetry about update adoption;
- automatic release creation on every `main` merge;
- retaining credentials in the installed app.

## 12. Implementation order

1. Copy this spec into `docs/specs/` and update the index.
2. Confirm Specs 017 and 018 are complete and review-clean on this branch.
3. Add release-note and manifest-verification scripts with unit tests.
4. Add build-only/manual and tag-publish workflow paths.
5. Remove the duplicate `v*` trigger from the ordinary preflight workflow.
6. Add/verify pinned action/toolchain dependencies and secret names.
7. Apply the single minor version bump and changelog section.
8. Update packaging/release documentation and maintained tree.
9. Run focused tests and clean preflight.
10. Run GitHub build-only rehearsal.
11. Make the release endpoint publicly readable.
12. Publish the bootstrap updater-enabled release.
13. Perform and record the real N → N+1 installed-app test.
14. Report project-context drift and required replacement files.

## 13. Acceptance checklist

- [ ] A `vX.Y.Z` tag runs one clean Windows release job, not duplicate tag preflights.
- [ ] Tag and every maintained application version must match before publishing.
- [ ] Exact-version changelog notes are required and become both GitHub release notes and updater notes.
- [ ] Release preflight runs with `--no-cache`.
- [ ] Existing scripts build/copy the PyInstaller sidecar rather than duplicating packaging flags in YAML.
- [ ] The official Tauri action is pinned to a reviewed commit SHA.
- [ ] Signing secrets are used securely and never uploaded/logged.
- [ ] Stable release contains NSIS setup executable, matching `.sig` and valid `latest.json`.
- [ ] `latest.json` points to the NSIS asset and carries the correct version, notes and signature.
- [ ] Manual workflow dispatch builds for inspection without publishing by default.
- [ ] Incomplete or failed builds expose no stable update manifest.
- [ ] The first updater-enabled release is identified as a manual bootstrap install.
- [ ] A real installed version N successfully detects, downloads and launches installer N+1.
- [ ] User data survives the real update and no orphan sidecar/port conflict remains.
- [ ] Repository and Project documentation drift is reported accurately.
