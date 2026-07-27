# Spec 023 review: Separate Stable/Beta release feeds and Beta installation UX

Status: **awaiting verification**

Linked spec: [023-stable-beta-release-channels.md](../023-stable-beta-release-channels.md)

## Verification run

```powershell
python -m unittest tests.test_release_tag_script tests.test_release_notes_script tests.test_release_workflow tests.test_updater_configuration tests.test_app_channels -v
node --test frontend/tests/appUpdater.test.ts frontend/tests/betaInstaller.test.ts frontend/tests/appChannel.test.ts
cd frontend
npx tsc --noEmit
npm.cmd run build
cd ..
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
python scripts/preflight.py --no-cache
```

Record exact PASS/FAIL output here after the implementing agent completes local checks.

## Confirmed by code review

- Stable and Beta Tauri configs point at separate `release-channels/*/latest.json` endpoints.
- Temporary Spec 021 Beta self-updater fail-closed gate removed from `app_updates.rs`.
- Stable-owned Beta installation uses separate Rust state/commands and frontend coordinator/modal.
- Release workflow resolves channel, publishes Beta as GitHub prerelease, and updates channel pointers after verification.

## Remaining manual verification

- Full side-by-side Stable/Beta install and N→N+1 update matrix on Windows (Spec §14).
- Build-only workflow dispatch for both `stable` and `beta` choices with artifact inspection.
- First Stable bootstrap release proving legacy `/releases/latest/download/latest.json` handoff.

## Follow-up tasks

None filed yet. Reviewer adds numbered `R*` tasks here if needed.
