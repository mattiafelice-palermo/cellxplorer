# Windows packaging

This repository can be packaged as a native Windows app with Tauri:

1. Build the React frontend into `frontend/dist`.
2. Build the Python backend into a sidecar executable named `cellxplorer-backend.exe`.
3. Let Tauri bundle both into an installer.

User data must stay outside the install directory. The current backend already stores data under
`CELLXPLORER_DATA` or the user's `.cellxplorer` folder. The SQLite database is protected by
explicit packaged schema migrations and automatic pre-migration backups. See
`docs/database-migrations.md`.

## Required local tools

- Node.js and npm
- Rust toolchain (`rustc` and `cargo`)
- Tauri CLI (`@tauri-apps/cli`)
- PyInstaller
- Windows installer toolchain required by Tauri for MSI/NSIS

## Recommended build command

From the repository root, run:

```powershell
.\scripts\build-app.cmd
```

This performs the complete frontend, backend sidecar, and NSIS build. See
`docs/local-development.md` for incremental options and the expected output path.

## Manual build sequence

```powershell
npm.cmd install

cd frontend
npm.cmd run build
cd ..

npm.cmd run build:backend
New-Item -ItemType Directory -Force src-tauri\binaries
Copy-Item dist\cellxplorer-backend.exe src-tauri\binaries\cellxplorer-backend-x86_64-pc-windows-msvc.exe -Force

npm.cmd run tauri:build
```

The backend build includes `backend/app/assets/plotly.min.js`. This offline runtime is embedded
once in each portable HTML analysis so serialized Plotly figures remain interactive without an
internet connection.

## Agent build note

When running the frontend build from a managed Codex sandbox, Vite/esbuild can fail while resolving
`frontend/vite.config.ts` with errors like:

```text
Cannot read directory "../../..": Access is denied.
Could not resolve "...\frontend\vite.config.ts"
```

This is a sandbox path-resolution issue, not a project build failure. Rerun the same frontend build
command with elevated sandbox permission, then continue with the normal packaging sequence.

Expected output, once the toolchain is installed:

- `src-tauri/target/release/bundle/nsis/CellXplorer_0.1.1_x64-setup.exe`

The app icon is sourced from `CellXplorer_X_teal_flat_transparent.ico`.
The Tauri bundle uses `src-tauri/icons/icon.ico`, and the runtime window/taskbar icon
uses `src-tauri/icons/icon-256.rgba`. If the root `.ico` is replaced, regenerate both
of those files before rebuilding.

## Branded NSIS installer

`src-tauri/cellxplorer-installer.nsi` is a vendored copy of Tauri's NSIS template with the
CellXplorer installer and uninstaller surfaces built directly in nsDialogs. Tauri is configured to
use it through `bundle.windows.nsis.template` in `src-tauri/tauri.conf.json`. The first visible
installer page is the location step; it includes the three-step progress indicator, desktop and
startup options, and the custom CellXplorer actions. Uninstall preserves `%USERPROFILE%\.cellxplorer`
by default and offers deletion only as an explicit, confirmed destructive choice.

The template is version-coupled to the Tauri CLI. When upgrading Tauri, compare it with the exact
upstream template for the new CLI before carrying the branded sections forward. A template can
compile successfully while stock MUI controls overlap the custom page, so visually smoke-test both
the installer and uninstaller after template or NSIS changes. Never test the destructive uninstall
choice against a real user data directory.

## Desktop startup performance

The packaged backend is a PyInstaller one-file sidecar. A cold launch includes extraction of the
scientific Python runtime before FastAPI can listen. Database migration inspection itself is small
(about 0.1-0.2 seconds on the development database); do not weaken schema compatibility checks to
optimize startup. Expensive pandas, NewareNDA, PyArrow, analysis, and cache modules are loaded lazily
after API startup, and old-cache capacity backfilling starts from the same deferred warm-up thread.

The frontend deliberately mounts its normal route immediately while the database-status query is
pending. Network-only query failures are retried during the short sidecar boot window. The backend
compatibility middleware remains authoritative: if the schema is unsupported, normal API requests
are rejected and the frontend replaces the route with the compatibility screen as soon as status
arrives. This restores the pre-0.6 responsive shell without bypassing migration safety.

MSI is possible, but the default target is NSIS because WiX validation can fail on
machines where the Windows Installer service is not available to the build process.
For this spike, MSI could be emitted manually with WiX `light.exe -sval` after Tauri
generates `src-tauri/target/release/wix/x64/main.wixobj`.

## Current blocker found during the spike

This spike produced an NSIS installer. The MSI path reached WiX linking, but WiX ICE validation
failed because the Windows Installer service was not accessible in the build environment.
