# Spec 009: automatic clean-environment preflight

Status: **implemented**. Depends on Specs 007 and 008. Written 2026-07-26.

## Goal

Add one GitHub Actions workflow that automatically runs CellXplorer’s canonical preflight command on a clean Windows machine.

The workflow must run:

* whenever `main` changes;
* whenever a version tag such as `v0.15.0` is pushed;
* when manually started from GitHub Actions.

The workflow provides an independent check that the committed code installs, passes its tests and builds outside the developer’s existing computer.

The workflow does not build or publish the CellXplorer installer.

---

## Existing commands

Spec 007 provides:

```powershell
python scripts\check_versions.py
```

Spec 008 provides:

```powershell
python scripts\preflight.py
```

The GitHub workflow must use these scripts rather than duplicating their internal checks.

---

## File to create

Create:

```text
.github/workflows/preflight.yml
```

Also:

* add Spec 009 to `docs/specs/README.md`;
* add a short GitHub preflight section to `docs/local-development.md`.

Do not modify application code.

---

# 1. Workflow triggers

The workflow must run on:

```yaml
on:
  workflow_dispatch:
  push:
    branches:
      - main
    tags:
      - "v*"
```

This means:

| Event                              | Run preflight |
| ---------------------------------- | ------------: |
| Push or merge into `main`          |           Yes |
| Push tag such as `v0.15.0`         |           Yes |
| Manual start from GitHub Actions   |           Yes |
| Push to an ordinary feature branch |            No |
| Open or update a pull request      |            No |

Do not add a `pull_request` trigger.

---

# 2. Workflow name and permissions

Use:

```yaml
name: CellXplorer preflight
```

Set read-only repository permissions:

```yaml
permissions:
  contents: read
```

Do not:

* request write permissions;
* use repository secrets;
* create commits;
* create tags;
* create GitHub releases.

---

# 3. Job configuration

Use one job:

```yaml
jobs:
  preflight:
    name: Clean Windows preflight
    runs-on: windows-latest
    timeout-minutes: 45
```

The job must run on Windows because CellXplorer is currently a Windows-first application.

---

# 4. Runtime setup

Use:

```yaml
actions/checkout@v6
actions/setup-python@v6
actions/setup-node@v6
```

Configure:

```text
Python 3.12
Node.js 22
```

Enable pip and npm dependency caching.

Python cache dependency:

```text
backend/requirements.txt
```

Node cache dependency:

```text
frontend/package-lock.json
```

Caching is only an optimisation. Dependencies must still be installed during every workflow run.

---

# 5. Install dependencies

## Backend dependencies

Run:

```powershell
python -m pip install --upgrade pip
python -m pip install -r backend/requirements.txt
python -m pip check
```

## Frontend dependencies

Run:

```powershell
npm --prefix frontend ci
```

Do not install:

* Rust;
* Cargo dependencies;
* PyInstaller;
* Tauri build dependencies;
* NSIS;
* installer tooling.

This workflow does not build the desktop installer.

---

# 6. Version-tag verification

When the workflow is triggered by a tag, confirm that the tag matches the application version.

Run:

```powershell
python scripts/check_versions.py --expected-version "${{ github.ref_name }}"
```

Only run this step when:

```yaml
if: github.ref_type == 'tag'
```

The version checker from Spec 007 accepts one leading `v`.

Examples:

```text
Tag v0.15.0 + application version 0.15.0 → pass
Tag v0.15.0 + application version 0.14.1 → fail
```

Run the tag check before the full preflight so an incorrect release tag fails quickly.

---

# 7. Run the canonical preflight

Run:

```powershell
python scripts/preflight.py
```

Do not repeat these commands separately in the workflow:

```text
python scripts/check_versions.py
python -m unittest discover tests -v
node --test ...
npm --prefix frontend run build
```

Those commands are already owned by `scripts/preflight.py`.

The local preflight script is the single source of truth.

---

# 8. Required workflow content

See `.github/workflows/preflight.yml`.

---

# 9. Documentation

Updated `docs/local-development.md` and `docs/specs/README.md`.

---

# 10. Failure behaviour

Any dependency install failure, tag mismatch, or non-zero exit from
`scripts/preflight.py` fails the GitHub job. No `continue-on-error` and no
suppressed failures.

---

# 11. Out of scope

Installer builds, releases, pull-request triggers, branch protection, coverage,
linting, and application behaviour changes.

---

# 12. Verification

## Local verification

```powershell
python scripts\preflight.py
```

## GitHub manual verification

Run **CellXplorer preflight** manually from the GitHub Actions page on the
implementation branch after push.

## Automatic `main` trigger verification

Confirm after the change reaches `main`.

## Tag verification

The first real `v*` release tag provides end-to-end tag-trigger verification.

---

# 13. Acceptance criteria

See spec body above.

---

# 16. Implementation record

## Files changed

* `.github/workflows/preflight.yml`
* `docs/specs/009-automatic-clean-environment-preflight.md`
* `docs/specs/README.md`
* `docs/local-development.md`

## Local verification

```text
python scripts\preflight.py
```

Passed on 2026-07-26.

## GitHub manual verification

Not run in this session. Push the branch and start **CellXplorer preflight** manually from
the GitHub Actions page to confirm clean Windows execution.

## Automatic `main` trigger verification

Not run in this session. Confirm after the change reaches `main`.

## Deliberately not implemented

* Installer builds and publishing
* Pull-request triggers
* Branch protection and required checks
* Release creation and automatic tagging
* Coverage, linting, and dependency security scanning
