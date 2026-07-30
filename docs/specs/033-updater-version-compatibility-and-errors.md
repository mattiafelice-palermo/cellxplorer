# 033 — Updater version compatibility and understandable errors

**Status:** Implemented  
**Branch:** `feature/updater-diagnostics`  
**Scope:** Beta prerelease ordering and user-facing update failure explanations.

All UI work inherits
[`../agent-knowledge/visual-style-guide.md`](../agent-knowledge/visual-style-guide.md).

## Existing anchors

- `src-tauri/src/app_channel.rs`
  - validates Stable and Beta versions after the Tauri updater finds a candidate.
- `frontend/src/appUpdater.ts`
  - normalizes updater failures and currently maps only a few transport phrases.
- `frontend/src/components/AppUpdateModal.tsx`
  - renders manual update-check progress and failures.
- `frontend/tests/appUpdater.test.ts`
  - contains the updater presentation policy tests.
- `scripts/release_tag.py`
  - accepts legacy dotted Beta tags and the compact Beta tags introduced after Beta 9.

## Confirmed failure

`0.17.0-beta.8` accepts only dotted prereleases such as `0.17.0-beta.9`. The published Beta
channel later advertised `0.17.0-beta011`, which the old application found and then rejected.
Its raw version-policy error fell through to the modal's generic “try again” message.

Current builds accept both formats. Under SemVer, compact `0.17.0-beta012` is newer than
`0.17.0-beta011`; dotted `0.17.0-beta.12` is older than the compact version because their
prerelease identifiers have different shapes. Releases within the existing `0.17.0` line must
therefore remain compact.

## Locked behavior

- Preserve acceptance of both dotted `beta.N` and compact `betaNNN` candidates.
- Add a regression proving `0.17.0-beta012` is accepted and ordered after `0.17.0-beta011`.
- Classify update-check failures into understandable cases:
  - incompatible release version or installation identity;
  - missing or malformed release information;
  - offline, DNS, connection, or timeout failure;
  - certificate or other secure-connection failure;
  - server throttling or temporary refusal;
  - unexpected updater failure.
- The modal uses a case-specific title and recovery instruction.
- Retrying remains available for transient failures. A structurally incompatible release does not
  offer a useless retry; it instructs the user to install the official release manually.
- Raw internal error strings are retained in debug state but are not used as the primary
  user-facing explanation.

## Data and scientific impact

No backend, database, migration, cache, parser, or scientific-calculation behavior changes.

## Verification

```powershell
cargo test --manifest-path src-tauri\Cargo.toml app_channel
node --test frontend\tests\appUpdater.test.ts
cd frontend
npx.cmd tsc --noEmit
npx.cmd vite build
cd ..
python scripts\preflight.py
```

No installed-Windows or browser interaction is required for the policy mapping itself.

## Acceptance checklist

- [x] Compact Beta 12 is proven newer than compact Beta 11.
- [x] Beta dotted and compact candidate validation remains covered.
- [x] Known updater failures render distinct, understandable recovery messages.
- [x] Incompatible-format failures do not offer a misleading retry.
- [x] Focused checks and canonical preflight pass.
- [ ] Implementation is committed and pushed on the feature branch.

## Implementation record

Implemented on `feature/updater-diagnostics`.

- Added a typed update-check failure classifier for incompatible versions, release metadata,
  connectivity, secure connections, server throttling, and unexpected failures.
- The update modal uses the classifier's case-specific title and hides retry only when a manual
  installation is required.
- Added Rust ordering coverage proving `0.17.0-beta012 > 0.17.0-beta011` and documenting why
  `0.17.0-beta.12` must not follow a compact version within the same core.
- Updated the durable packaging/release guidance and synchronized the development version to
  `0.17.0-beta012`.

Verification completed:

- `cargo test --manifest-path src-tauri\Cargo.toml app_channel` — 10 passed.
- `node --test frontend\tests\appUpdater.test.ts` — 33 passed.
- `npx.cmd tsc --noEmit` — passed.
- `python scripts\check_versions.py --expected-version 0.17.0-beta012` — passed.
- `python scripts\preflight.py` — initial managed-sandbox run failed only at the documented
  Vite/esbuild path-access restriction after all tests and type checking passed.
- `python scripts\preflight.py` with the required filesystem permission — passed all 5/5 stages:
  all 51 backend modules, all 251 frontend tests, type checking, version consistency, and the
  production bundle. The existing large-chunk warning remains.

No browser or installed-Windows verification was run.
