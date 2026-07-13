# Windows packaging

This repository can be packaged as a native Windows app with Tauri:

1. Build the React frontend into `frontend/dist`.
2. Build the Python backend into a sidecar executable named `cellxplorer-backend.exe`.
3. Let Tauri bundle both into an installer.

User data must stay outside the install directory. The current backend already stores data under
`CELLXPLORER_DATA` or the user's `.cellxplorer` folder. Before distributing to users, this should
move to `%LOCALAPPDATA%\Cellxplorer` and be protected by schema migrations and automatic backups.

## Required local tools

- Node.js and npm
- Rust toolchain (`rustc` and `cargo`)
- Tauri CLI (`@tauri-apps/cli`)
- PyInstaller
- Windows installer toolchain required by Tauri for MSI/NSIS

## Build command

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

MSI is possible, but the default target is NSIS because WiX validation can fail on
machines where the Windows Installer service is not available to the build process.
For this spike, MSI could be emitted manually with WiX `light.exe -sval` after Tauri
generates `src-tauri/target/release/wix/x64/main.wixobj`.

## Current blocker found during the spike

This spike produced an NSIS installer. The MSI path reached WiX linking, but WiX ICE validation
failed because the Windows Installer service was not accessible in the build environment.
