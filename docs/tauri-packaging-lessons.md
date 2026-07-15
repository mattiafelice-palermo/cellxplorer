# Tauri packaging lessons for future agents

This document records the packaging spike and the issues encountered while turning CellXplorer
into a Windows desktop app with Tauri. Read this before changing the packaging setup.

## Current packaging architecture

- The React frontend is built into `frontend/dist`.
- The Python/FastAPI backend is frozen with PyInstaller as a Tauri sidecar executable.
- Tauri bundles the frontend and the backend sidecar into a Windows installer.
- The default successful installer target is NSIS:
  `src-tauri/target/release/bundle/nsis/CellXplorer_0.1.1_x64-setup.exe`.
- MSI generation reached WiX linking, but WiX ICE validation failed in this environment because
  the Windows Installer service was not accessible to the build process. NSIS is the clean default.

## Required tools

The packaging toolchain needs:

- Node.js / npm.
- Rust toolchain (`rustc`, `cargo`, `rustup`).
- PyInstaller (`python -m PyInstaller --version`).
- Tauri CLI (`npx.cmd tauri --version`).

Useful check:

```powershell
npm.cmd run check:packaging-tools
```

Rust may be installed under `%USERPROFILE%\.cargo\bin`. If `rustc` or `cargo` fail from PATH,
call them directly from there to diagnose.

## Build sequence

Use these steps when testing packaging:

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

`npm.cmd run tauri:build` currently expects the frontend and backend sidecar to already be built.

## Codex sandbox frontend build issue

In the managed Codex sandbox, `npm.cmd run build` from `frontend` can fail before Vite loads its
config:

```text
Cannot read directory "../../..": Access is denied.
Could not resolve "C:\Users\matti\Documents\Cellxplorer\frontend\vite.config.ts"
```

This has been observed as a sandbox path-resolution boundary, not as a broken Vite config. Rerun the
same command with elevated sandbox permission, then continue the documented build sequence.

## Important Tauri sidecar details

- Tauri sidecars belong in `src-tauri/binaries`.
- The Windows x64 sidecar filename must include the target triple:
  `cellxplorer-backend-x86_64-pc-windows-msvc.exe`.
- `src-tauri/tauri.conf.json` should reference the sidecar without the target suffix:
  `"externalBin": ["binaries/cellxplorer-backend"]`.
- The Rust sidecar process handle must be stored as `Mutex<Option<CommandChild>>` because
  `CommandChild::kill(self)` consumes the child.
- Tauri requires an `.ico` file for Windows bundling. The current source icon is
  `CellXplorer_X_teal_flat_transparent.ico`; copy it to `src-tauri/icons/icon.ico`.
- The runtime window/taskbar icon is set from `src-tauri/icons/icon-256.rgba` in
  `src-tauri/src/main.rs`. If the `.ico` changes, regenerate this 256x256 RGBA file
  from the same source icon before rebuilding.
- The visible in-app header icon and favicon are `frontend/public/app-icon.png`.
  Regenerate that PNG from the same source icon when changing branding.
- The generated NSIS shortcut originally had `IconLocation = ,0`, so Windows inferred
  the icon from the target executable and cached it inconsistently across Start/taskbar.
  `src-tauri/nsis-hooks.nsh` rewrites Start/Desktop shortcuts after install with an explicit
  icon location: `$INSTDIR\cellxplorer.exe,0`.

## PyInstaller backend entrypoint

Do not freeze `run.py` directly unless you verify it collects the backend package correctly.
The packaging entrypoint is:

`packaging/backend_entry.py`

It imports the FastAPI app object directly and runs Uvicorn from that object. This is more reliable
than asking a frozen executable to resolve `"app.main:app"` dynamically.

The PyInstaller build must include `--paths backend`; otherwise the frozen sidecar can build
successfully but crash at runtime with:

```text
ModuleNotFoundError: No module named 'app'
```

The entrypoint catches startup exceptions and writes them to
`%LOCALAPPDATA%\Cellxplorer\logs\backend-crash.log` instead of letting PyInstaller show a traceback
dialog.

Windowless PyInstaller apps have no usable `stdout`/`stderr`. Uvicorn's default logging formatter
can crash with:

```text
AttributeError: 'NoneType' object has no attribute 'isatty'
ValueError: Unable to configure formatter 'default'
```

The backend entrypoint therefore configures file logging and starts Uvicorn with
`log_config=None` and `access_log=False`.

## API origin issue in packaged Tauri

The packaged frontend is not served from `http://127.0.0.1:8642`; it is served by Tauri's webview
origin. Therefore relative frontend calls like `/api/cells` do not automatically hit FastAPI.

The frontend API client must:

- keep relative `/api/...` URLs for normal backend-served browser use and Vite dev proxy use;
- ask the Tauri command `backend_api_base` for the sidecar address when running from the packaged
  desktop origin.

The desktop sidecar must not bind the fixed development port `8642`. A developer server, stale
process, or another local program may already own it. Tauri selects a free loopback port at startup,
passes it to the sidecar as `CELLXPLORER_PORT`, and exposes the matching base URL to the frontend.
`packaging/backend_entry.py` keeps `8642` only as the browser-development fallback.

The backend must allow local Tauri origins with CORS. `backend/app/main.py` includes
`CORSMiddleware` with permissive local settings. The backend binds only to `127.0.0.1` and does
not use cookies, so this is acceptable for the desktop sidecar model.

Be careful with localhost detection in the frontend. Packaged Tauri can use a localhost-like
webview origin, so only Vite dev builds should keep relative `/api/...` calls for non-8642
localhost ports. Production bundles should fall back to `http://127.0.0.1:8642/api/...`.

If a packaged app launches but pages show generic "Could not load..." messages while
`Invoke-RestMethod http://127.0.0.1:8642/api/...` works, suspect frontend origin/API routing first.
Check `backend.log` for WinError 10048 as well; it means a fixed-port build could not start its own
backend. Export code should fall back to the native Save As dialog if download preferences are
temporarily unavailable, so a settings failure does not block the user's export.

## Windowless backend sidecar

Build the PyInstaller backend with `--noconsole --disable-windowed-traceback --paths backend`.
Without `--noconsole`, PyInstaller uses the console bootloader and Windows opens a black terminal
window next to the desktop app. Without `--disable-windowed-traceback`, a crash in a windowed
sidecar can still show a PyInstaller error dialog. The root `build:backend` script should keep:

```powershell
python -m PyInstaller --noconfirm --onefile --noconsole --disable-windowed-traceback --paths backend --name cellxplorer-backend packaging/backend_entry.py
```

When this is correct, PyInstaller logs mention the `runw.exe` bootloader.

The Tauri Rust executable also needs this crate attribute at the top of `src-tauri/src/main.rs`:

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
```

Without it, the main desktop app can open a terminal even if the backend sidecar is windowless.

## Data location and compatibility

The backend currently stores user data under `CELLXPLORER_DATA` or `%USERPROFILE%\.cellxplorer`.
Before serious distribution, move the default to `%LOCALAPPDATA%\Cellxplorer` and add:

- explicit schema versioning;
- automatic DB backup before migrations;
- logged migration results;
- a diagnostics export that includes logs, versions, and schema status without raw user data.

Never store the user database or cache under the app install directory.

## Logging gap

Packaging currently has weak diagnostics. Add rotating backend logs under the user data directory
before beta distribution. Frontend errors should be posted to a local `/api/log/client` endpoint or
stored in Tauri-managed app logs. This will make "it launches but X fails" bug reports actionable.

## Known successful artifacts

The packaging spike successfully produced:

- `src-tauri/target/release/cellxplorer.exe`
- `src-tauri/target/release/bundle/nsis/CellXplorer_0.1.1_x64-setup.exe`

The first installed-app smoke test showed the Tauri shell launched and the backend health endpoint
responded, but the frontend initially failed to load the cell database because it used relative API
URLs. That is why the API base URL/CORS changes above matter.
