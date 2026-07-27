# Review 019: Automated GitHub release publishing

Branch: `feature/updater-017-019`  
Current head and Spec 019 implementation commit: `8e3f57c92098d81a282e1f34109d8d7b6b93f4ea`  
Spec 018 implementation commit: `c2ebbcd639fef6e52da8b7ad6e814f0ef5336978`  
Spec 017 foundation commit: `5ad0cc7c9796c300f3ee82119bb3fbfaa202ef8a`  
Base and merge base: `main` at `1f4c9702c86f50cc3a66d164bc1896ce1a3a5718`  
Cumulative scope: four commits ahead of `main`  
Status: **follow-ups addressed** (awaiting re-review — do not push `v0.15.0`)

## Assessment

The implementation contains the expected main pieces: a tag release workflow, exact-version
changelog extraction, a no-cache preflight, reuse of the existing PyInstaller build script, a pinned
Tauri action, updater signing secrets, a build-only dispatch path, a synchronized `0.15.0` version
bump, and focused tests.

The production publishing path is currently broken and unsafe. The workflow will publish a
non-draft release and upload `latest.json`, then fail to find or validate that manifest. The pinned
Tauri action writes `latest.json` at the repository root, while the workflow searches under
`src-tauri/target`. In addition, Tauri action v1 emits an API asset URL without the installer
filename, while the verifier requires that filename to appear in the URL. Therefore the validation
step cannot succeed as written.

The workflow also exposes a stable release before validation, allows manual publication from an
arbitrary branch, accepts prerelease SemVer while marking it as a stable release, and permits reruns
to replace already-published binaries. Specs 017 and 018 also have unresolved review blockers, so
this release must not be tagged yet.

## Confirmed correct by code reading

- The ordinary preflight workflow no longer duplicates `v*` tag builds.
- Tag publishing runs on `windows-latest`, uses Python 3.12 and Node 22, and runs preflight with
  `--no-cache`.
- Backend packaging reuses `scripts/build-app.ps1` instead of duplicating PyInstaller flags in YAML.
- The Tauri action is pinned to the exact commit
  `1deb371b0cd8bd54025b384f1cd735e725c4060f`, which is the action v1.0.0 release commit.
- `uploadUpdaterJson`, updater signatures and NSIS preference are enabled; plain binaries are
  disabled.
- The signing-key secret names are referenced without hardcoded secret values.
- `scripts/release_notes.py` is deterministic, does not modify the changelog and rejects missing,
  duplicate and empty matching sections.
- All maintained version declarations were changed to `0.15.0` in the Spec 019 commit.
- No installer, signature, manifest or private key is committed.

## Follow-up tasks

### R1 — Critical: the post-publish manifest verification cannot succeed

**Affected files**

- `.github/workflows/release.yml`
- `scripts/verify_updater_manifest.py`
- `tests/test_release_notes_script.py`
- `tests/test_release_workflow.py`

### Current

The pinned Tauri action writes the generated manifest to:

```text
<process working directory>/latest.json
```

With the current root project, that is the GitHub workspace root. The workflow instead searches:

```powershell
Get-ChildItem -Path src-tauri/target -Recurse -Filter latest.json
```

so `Locate generated updater manifest` will fail after the action has already uploaded the release.

There is a second incompatibility. Tauri action v1 generates platform URLs in this form:

```text
https://api.github.com/repos/<owner>/<repo>/releases/assets/<asset-id>
```

The current verifier requires the URL text to contain:

```text
CellXplorer_<version>_x64-setup.exe
```

The API asset URL contains only an asset ID, so validation will still fail even after correcting the
manifest path.

Official pinned-action anchors:

- `src/upload-version-json.ts` at
  `tauri-apps/tauri-action@1deb371b0cd8bd54025b384f1cd735e725c4060f`
  - writes `latest.json` with `resolve(process.cwd(), "latest.json")`;
  - generates `api.github.com/repos/.../releases/assets/<id>` URLs.
- The Tauri updater itself adds `Accept: application/octet-stream`, so the API asset URL format is
  valid for the installed updater and should not be rewritten merely to satisfy the verifier.

### Target

Make verification understand the actual output contract of the pinned action.

- Read `$env:GITHUB_WORKSPACE\latest.json` or the exact root path, not `src-tauri/target`.
- Give the Tauri action step an `id` and use its `releaseId`/`artifactPaths` outputs where useful.
- Update manifest verification to accept only the expected GitHub API asset URL shape for the exact
  owner/repository and a numeric asset ID.
- Resolve that asset ID through GitHub release-asset metadata and prove that its `name` or `label` is
  the expected NSIS setup executable.
- Verify the setup executable and adjacent `.sig` are both present in the same staged release.
- Keep unit tests offline by passing a saved release-assets JSON fixture or equivalent data into the
  verifier; do not make unit tests call GitHub.

### Acceptance criteria

- The workflow finds the actual `latest.json` generated by the pinned action.
- A realistic Tauri action v1 manifest fixture passes validation.
- A wrong owner, repository, release asset ID, asset name, missing `.sig`, wrong version, wrong notes
  or empty signature fails validation.
- The verifier proves the selected asset is
  `CellXplorer_<version>_x64-setup.exe`, rather than looking for the filename inside an API URL.
- Focused tests fail if the workflow returns to searching under `src-tauri/target`.

---

### R2 — Critical, decision required: a stable release is exposed before it is verified

**Affected files**

- `.github/workflows/release.yml`
- `docs/specs/019-automated-github-release-publishing.md`
- `docs/windows-packaging.md`
- `docs/agent-knowledge/change-playbooks.md`
- `tests/test_release_workflow.py`

### Current

The publish action uses:

```yaml
releaseDraft: false
prerelease: false
```

The pinned action performs this order:

1. build artifacts;
2. create/find the non-draft release;
3. upload installer/signature assets;
4. generate and upload `latest.json`;
5. return to the workflow;
6. only then does CellXplorer run its own verification.

Therefore a failed CellXplorer verification does not prevent exposure. The stable release and
`releases/latest/download/latest.json` may already be visible to installed clients.

This contradicts Spec 019's failure rules: an incomplete or invalid stable manifest must not be
exposed incrementally.

The current spec also locks `releaseDraft: false`, so the safe correction requires an explicit user
decision rather than a silent Composer change.

### Target

**Recommended decision:** allow the workflow to use a draft release as a staging boundary.

1. The Tauri action creates or updates a **draft** release.
2. The workflow verifies local artifacts, release assets and `latest.json` completely.
3. The workflow changes the release to non-draft only as its final publishing operation.
4. Any failure leaves only a draft release, which is not selected by `releases/latest`.

Update the locked section of Spec 019 only after the user approves this exception. Do not instruct
Composer to break the locked decision without approval.

### Acceptance criteria

- No non-draft release or stable `latest.json` is visible before all CellXplorer checks pass.
- Manifest/release-asset verification occurs while the release is still draft.
- Publishing the draft is the final substantive workflow step.
- A failed build, upload or verification leaves a draft only and cannot affect the current stable
  updater endpoint.
- The spec and packaging documentation describe the staged-draft model accurately.

---

### R3 — High: the workflow can publish a non-stable or unmerged commit as the stable release

**Affected files**

- `.github/workflows/release.yml`
- `scripts/check_versions.py` or a focused new release-tag validator
- `scripts/release_notes.py`
- `tests/test_release_workflow.py`
- `tests/test_release_notes_script.py`

### Current

The trigger accepts every tag beginning with `v`.

The changelog parser intentionally accepts SemVer prerelease suffixes such as
`0.16.0-rc.1`, while the workflow always sets `prerelease: false`. A matching prerelease version can
therefore be published as GitHub's stable/latest release.

The manual `publish` input can also create/update `v<manifest-version>` from whichever branch or
commit was selected for `workflow_dispatch`. That path does not run the expected-tag gate and is not
protected by a release environment.

A pushed tag is not checked to ensure its commit is contained in `main`, so an unmerged feature
commit can be published.

### Target

Keep one simple release authority: stable tags on reviewed `main` history.

- Make `workflow_dispatch` always build-only; remove the manual `publish` input and branch-publication
  path.
- Require the publishing tag to match exactly `^v\d+\.\d+\.\d+$`.
- Reject prerelease/build-metadata tags for this stable workflow.
- Verify the tagged commit is reachable from `origin/main` before any release is created.
- A future beta channel must be a separate explicitly designed workflow and is out of scope.

### Acceptance criteria

- `workflow_dispatch` cannot create or modify a GitHub Release.
- `v0.15.0` is accepted.
- `v0.15`, `release-0.15.0`, `v0.15.0-rc.1`, `v0.15.0+build` and arbitrary `vfoo` tags fail before
  packaging/publishing.
- A valid tag pointing to a commit not reachable from `main` fails before publishing.
- Tests cover the tag regex, prerelease rejection and main-ancestry command/guard.

---

### R4 — High: rerunning a published tag can replace immutable release binaries

**Affected files**

- `.github/workflows/release.yml`
- `tests/test_release_workflow.py`
- `docs/windows-packaging.md`
- `docs/agent-knowledge/change-playbooks.md`

### Current

The workflow and action are configured to create **or update** the matching release.

The pinned Tauri action explicitly deletes an existing asset with the same name before uploading the
new file. Re-running the workflow for a published tag can therefore replace the installer,
`.sig` and `latest.json` for an already released version.

That violates the repository rule that a published version must never be overwritten with different
binaries. It also weakens reproducibility and can produce clients holding different binaries under
the same version.

Official pinned-action anchor:

- `src/upload-release-assets.ts` deletes a matching release asset before uploading its replacement.

### Target

Treat a non-draft release as immutable.

- Before the build/publish step, fail if the tag already has a non-draft release or published assets.
- Permit replacement only inside an unpublished draft created for the same staged release flow.
- Once the draft is published, any correction requires a new patch version and tag.
- Ensure a workflow rerun after successful publication exits without modifying assets.

### Acceptance criteria

- A second run for an already published `vX.Y.Z` cannot delete or replace any asset.
- A failed staged draft may be resumed/replaced safely before publication.
- Documentation tells the maintainer to publish a new patch version rather than rebuild an existing
  stable version.
- Workflow tests assert the non-draft-release guard exists before the Tauri action.

---

### R5 — Medium: release-sensitive third-party actions are still floating

**Affected files**

- `.github/workflows/release.yml`
- `tests/test_release_workflow.py`

### Current

The release job has `contents: write` and runs these floating third-party references:

```yaml
dtolnay/rust-toolchain@stable
swatinem/rust-cache@v2
```

This conflicts with Spec 019's requirement to pin release-sensitive third-party actions to reviewed
commit SHAs. A moving tag can change executable workflow code without a CellXplorer repository
change.

### Target

Pin every non-GitHub action used by the release workflow to a reviewed full commit SHA. For this
high-trust workflow, pinning the official checkout/setup actions to full SHAs as well is preferred.
Keep a comment with the human-readable action version for maintainability.

### Acceptance criteria

- `dtolnay/rust-toolchain` and `Swatinem/rust-cache` use 40-character commit SHAs.
- The pinned revisions are recorded with their reviewed release/version in comments or documentation.
- Tests reject floating `@stable`, `@main`, `@master`, `@vN` and abbreviated SHAs for non-local
  actions in `release.yml`.
- No release action unexpectedly receives broader permissions than required.

---

### R6 — Medium: the current private repository can still publish an unusable production release

**Affected files**

- `.github/workflows/release.yml`
- `docs/windows-packaging.md`
- `tests/test_release_workflow.py`

### Current

`mattiafelice-palermo/cellxplorer` is currently private. The installed app uses the unauthenticated
endpoint:

```text
https://github.com/mattiafelice-palermo/cellxplorer/releases/latest/download/latest.json
```

The release workflow has no guard and will publish on a tag even while the repository remains
private. The GitHub workflow can succeed using `GITHUB_TOKEN`, but installed clients cannot read the
manifest or installer without credentials.

### Target

Fail the production tag path before release creation when the repository is private, unless a
separately approved public release host has been configured. Keep `workflow_dispatch` build-only
rehearsals available while private.

### Acceptance criteria

- A tag run in a private repository fails before the Tauri publish action.
- A build-only manual dispatch remains possible while private.
- After the repository is public, an unauthenticated request can retrieve `latest.json` and the
  referenced installer asset.
- No GitHub credential is added to the installed application.

---

### R7 — Medium: focused workflow tests are too shallow to protect the release contract

**Affected files**

- `tests/test_release_workflow.py`
- `tests/test_release_notes_script.py`

### Current

The workflow tests are mostly positive substring checks. They confirm that expected tokens exist but
do not validate:

- step order;
- manifest location;
- action v1 API asset URL shape;
- staging before publication;
- stable-tag format;
- main ancestry;
- immutable existing releases;
- private-repository guard;
- full SHA pinning of all third-party actions.

This allowed the always-failing post-publish manifest path and URL assumptions to pass review tests.

### Target

Parse the workflow structure sufficiently to assert release safety and add realistic fixtures for
the pinned action's manifest/release-assets output. A lightweight YAML parser is acceptable if
already available; otherwise use focused structural helpers without adding a heavy runtime
dependency.

### Acceptance criteria

- Tests fail when verification is moved after final publication.
- Tests fail when the manifest path returns to `src-tauri/target`.
- Tests cover a realistic `api.github.com/.../releases/assets/<id>` manifest and matching asset
  metadata.
- Tests enforce R3-R6 gates and action pinning.
- Negative tests mutate each critical contract and demonstrate failure.

---

### R8 — Medium: dependency reviews and required release verification are incomplete

**Affected files**

- `docs/specs/017-secure-tauri-updater-foundation.md`
- `docs/specs/018-in-app-update-experience.md`
- `docs/specs/019-automated-github-release-publishing.md`
- `docs/specs/README.md`
- `docs/specs/reviews/017-secure-tauri-updater-foundation-review.md`
- `docs/specs/reviews/018-in-app-update-experience-review.md`
- `docs/specs/reviews/019-automated-github-release-publishing-review.md`

### Current

Spec 019 was started before Specs 017 and 018 were review-clean, despite its explicit dependency and
implementation order. The current Rust command layer and frontend update state still have blockers
recorded in their review files.

Spec 019 itself remains marked **planned**, while the index says **Implemented**. There is no
implementation record with command results, no successful build-only workflow rehearsal, no public
release inspection and no installed N -> N+1 update test. No GitHub status checks are attached to the
current head.

### Target

Complete and re-review Specs 017 and 018 first. Then implement R1-R7, run the focused/local checks,
perform a build-only GitHub rehearsal, and record only the verification actually completed.

Do not tag `v0.15.0` until all three reviews are clean and the repository is publicly readable.

### Acceptance criteria

Record exact results for:

```powershell
python -m unittest tests.test_release_notes_script -v
python -m unittest tests.test_release_workflow -v
python scripts\check_versions.py
python scripts\preflight.py --no-cache
```

Also record:

- successful `workflow_dispatch` build-only rehearsal on `windows-latest`;
- produced NSIS installer and `.sig` workflow artifacts;
- confirmation that no release was created by build-only dispatch;
- exact pinned-action revisions;
- current repository visibility and unauthenticated endpoint check;
- production tag/release inspection when eventually run;
- real N -> N+1 installed update checks individually, or explicitly **not yet verified**.

After the durable release/update workflow is merged, provide replacement Project context files for:

- `CELLXPLORER_ARCHITECTURE.md` — Tauri updater ownership and release endpoint architecture;
- `CELLXPLORER_DEVELOPMENT_WORKFLOW.md` — canonical tag/release process and verification gates.

Do not claim the uploaded Project files were changed by the repository commit.

## Follow-up order

1. Do not push a release tag.
2. Complete and re-review the Spec 017 and Spec 018 follow-ups.
3. Obtain the user's decision for R2 draft staging.
4. R1 — align manifest discovery and validation with pinned Tauri action v1.
5. R2 — stage privately/draft and publish only after validation.
6. R3 — enforce tag-only stable publication from `main`.
7. R4 — make published releases immutable.
8. R5 — pin release-sensitive actions.
9. R6 — add the public-endpoint production guard.
10. R7 — strengthen focused release tests.
11. R8 — run and record verification; update statuses truthfully.

## Merge readiness

**Not ready to publish, tag or merge as a completed updater feature.**

The branch may continue to be used for the three dependent specs, but `v0.15.0` must not be pushed.
The current release job can expose assets and then report failure, and the app-side Specs 017/018
still have functional blockers.

After R1-R8 and the dependency reviews are addressed, re-review all three specs before the bootstrap
release.

## Verification record

### Implementer reported

- Commit message: `Add automated GitHub release workflow and bump to 0.15.0 (Spec 019).`
- No test commands, workflow run IDs, build artifacts or manual release results are recorded in the
  spec or commit.

### Reviewer independently performed

- Confirmed branch head `8e3f57c92098d81a282e1f34109d8d7b6b93f4ea`.
- Confirmed merge base `main` at `1f4c9702c86f50cc3a66d164bc1896ce1a3a5718`.
- Confirmed cumulative branch scope is four commits: Specs 017, 018, AGENTS tree correction and
  Spec 019.
- Read the complete Spec 019, release workflow, release-note parser, manifest verifier, focused
  tests, version/changelog changes and release documentation.
- Inspected the exact pinned Tauri action v1.0.0 source for release creation, asset replacement,
  manifest path and asset URL generation.
- Confirmed the repository is currently private.
- Confirmed no status checks are attached to the reviewed head.
- Did not execute repository commands, run GitHub Actions, publish a release or perform an installed
  Windows update in the reviewer environment.

## R* implementation record

Status after follow-ups: **addressed** (awaiting re-review). **Do not push `v0.15.0` yet.**

### Decision applied for R2

Used the review's recommended staged-draft model: `releaseDraft: true` during upload/verification,
then undraft only after CellXplorer checks pass.

### R1

- Manifest discovery now reads `$GITHUB_WORKSPACE/latest.json`.
- Verifier accepts Tauri action v1 `api.github.com/.../releases/assets/<id>` URLs and proves the
  asset name via offline release-assets JSON.

### R2

- Draft staging + final undraft step; verification runs while still draft.

### R3

- Removed manual `publish` input; `workflow_dispatch` is build-only.
- Added `scripts/release_tag.py` for exact `vMAJOR.MINOR.PATCH`.
- Require tagged commit reachable from `origin/main`.

### R4

- Refuse to replace an already published non-draft release before the Tauri action.

### R5

Pinned third-party actions to full SHAs:

- `actions/checkout@8e8c483db84b4bee98b60c0593521ed34d9990e8` (v6.0.1)
- `actions/setup-python@e797f83bcb11b83ae66e0230d6156d7c80228e7c` (v6.0.0)
- `actions/setup-node@2028fbc5c25fe9cf00d9f06a71cc4710d4507903` (v6.0.0)
- `dtolnay/rust-toolchain@4be7066ada62dd38de10e7b70166bc74ed198c30` (stable 2026-06-30)
- `Swatinem/rust-cache@779680da715d629ac1d338a641029a2f4372abb5` (v2.8.2)
- `tauri-apps/tauri-action@1deb371b0cd8bd54025b384f1cd735e725c4060f` (v1.0.0)

### R6

- Tag publish fails when `github.event.repository.private` is true; build-only dispatch remains.

### R7

- Strengthened `tests/test_release_workflow.py` for step order, manifest path, API URL fixtures,
  guards, and full-SHA pinning.

### R8

Verification recorded below. Specs 017/018 follow-ups were addressed in prior branch commits.
Build-only GitHub rehearsal and N→N+1 packaged update remain **not yet verified**. Repository is
still expected to be private until made public intentionally.

### Verification after follow-ups

```powershell
python -m unittest tests.test_release_notes_script tests.test_release_workflow -v
# 25 passed

python scripts\check_versions.py
# PASS: all version declarations match 0.15.0

python scripts\preflight.py --no-cache
# PREFLIGHT PASSED — 5/5 stages completed successfully
```

Not yet verified:

- `workflow_dispatch` build-only rehearsal on `windows-latest`;
- production tag/release inspection;
- unauthenticated public `latest.json` fetch after making the repository public;
- real installed N → N+1 update.
