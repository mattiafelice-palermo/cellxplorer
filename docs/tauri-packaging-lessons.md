# Tauri packaging lessons for future agents

This document records the packaging spike and the issues encountered while turning CellXplorer
into a Windows desktop app with Tauri. Read this before changing the packaging setup.

## Current packaging architecture

- The React frontend is built into `frontend/dist` with an explicit channel stamp
  (`frontend/dist/.cellxplorer-channel.json`).
- The Python/FastAPI backend is frozen with PyInstaller as a Tauri sidecar executable.
- Tauri bundles the frontend and the backend sidecar into a Windows installer.
- Two NSIS products share one template: Stable and Beta differ by Tauri overlay, icons, and frontend
  channel build.
- Default successful installer targets:
  - Stable: `src-tauri/target/release/bundle/nsis/CellXplorer_<version>_x64-setup.exe`
  - Beta: `src-tauri/target/release/bundle/nsis/CellXplorer Beta_<version>_x64-setup.exe`
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

Prefer the channel-aware wrapper:

```powershell
.\scripts\build-app.ps1 -Channel stable
.\scripts\build-app.ps1 -Channel beta
```

When testing packaging manually:

```powershell
npm.cmd install

python scripts\build_frontend_channel.py stable
# or: python scripts\build_frontend_channel.py beta

npm.cmd run build:backend
New-Item -ItemType Directory -Force src-tauri\binaries
Copy-Item dist\cellxplorer-backend.exe src-tauri\binaries\cellxplorer-backend-x86_64-pc-windows-msvc.exe -Force

python scripts\frontend_channel.py verify --channel stable
npm.cmd run tauri:build:stable
```

Direct `npm.cmd run tauri:build:beta` verifies the frontend stamp before packaging. Do not package
a Beta installer from a Stable-built `frontend/dist` or the inverse.

`npm.cmd run tauri:build:stable|beta` expects the frontend and backend sidecar to already be built.

GitHub Actions follows the same invariant: canonical no-cache preflight is followed by
`build_frontend_channel.py <channel>` and two stamp checks, including one immediately before the
Tauri action. Setting `VITE_CELLXPLORER_CHANNEL` on the packaging action alone does not rebuild
`frontend/dist` and is not proof of channel provenance.

Standard self-update and Stable-owned Beta installation must remain different Tauri managed state
types. `PendingBetaInstall` is a real newtype around the shared pending-update state machine; a Rust
type alias would register the same `TypeId` twice and can panic during builder construction.

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
- Tauri requires an `.ico` file for Windows bundling. Stable uses `src-tauri/icons/icon.ico`;
  Beta uses `src-tauri/icons-beta/icon.ico` generated from the Stable source with a blue overlay
  (`python scripts\build_beta_icons.py`; requires `pip install -r scripts\requirements-dev.txt`).
- The runtime window/taskbar icon is set from `src-tauri/icons/icon-256.rgba` (Stable) or
  `src-tauri/icons-beta/icon-256.rgba` (Beta) in `src-tauri/src/main.rs`.
- The visible in-app header icon and favicon are `frontend/public/app-icon.png` (Stable) or
  `frontend/public/app-icon-beta.png` (Beta).
- The generated NSIS shortcut originally had `IconLocation = ,0`, so Windows inferred
  the icon from the target executable and cached it inconsistently across Start/taskbar.
  `src-tauri/nsis-hooks.nsh` rewrites Start/Desktop shortcuts after install with an explicit
  icon location: `$INSTDIR\cellxplorer.exe,0`.
- Pre-install and pre-uninstall hooks call `kill_installation_processes.ps1` with `-InstallDir
  "$INSTDIR"`. That script kills only processes whose executable path is under the installation
  directory being changed. Do **not** revert to shared `taskkill /IM cellxplorer.exe` cleanup —
  Stable and Beta share executable image names but install to different folders.

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

The backend stores Stable data under `%USERPROFILE%\.cellxplorer` and Beta data under
`%USERPROFILE%\.cellxplorer-beta`; `CELLXPLORER_DATA` overrides either root exactly. Use disposable
test data for installer verification. It uses packaged forward-only schema revisions, automatic
SQLite backups before migration,
startup compatibility checks, and schema status in diagnostics. See `docs/database-migrations.md`.
Moving the default data location to `%LOCALAPPDATA%\Cellxplorer` remains a future packaging change.

Never store the user database or cache under the app install directory.

## Release-channel branch invariant

`release-channels` is a pre-provisioned orphan/manifest-only branch; never initialize it from
`main`. Before the first real Beta release it may contain only `README.md` and the last verified
`stable/latest.json`; that Beta workflow creates `beta/latest.json` with a race-safe first write.
Afterward it contains exactly all three files.
The release workflow validates the complete Git tree and both existing pointers before draft
staging, updates only the selected file with its prior blob SHA, and proves the other channel blob
did not change. Missing refs/manifests or unexpected source files block publication.

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

## Custom installer maintenance

The production NSIS bundle now uses `src-tauri/cellxplorer-installer.nsi`, not Tauri's implicit
stock wizard. It owns the visible installer and uninstaller layout, including the data-preservation
choice. Keep Tauri's generated install, upgrade, shortcut, registry, WebView2, and uninstaller
sections intact when changing the appearance. Replacing the entire template with a short custom
script is unsafe because it silently drops those behaviors.

NSIS dialog coordinates use dialog units, while Win32 window sizing uses physical pixels. In the
760-pixel CellXplorer frame, controls must be smoke-tested from the compiled installer; a layout
that looks arithmetically correct can still clip because percentage widths are based on the MUI
dialog resource. The current template intentionally constrains visible content to the tested inner
width and hides all stock MUI header/footer/navigation control IDs on custom pages.
