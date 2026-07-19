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
