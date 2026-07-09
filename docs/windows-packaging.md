# Windows packaging spike

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

## Spike command

```powershell
cd frontend
.\node_modules\.bin\tsc.cmd -b
npx.cmd vite build
cd ..

pip install pyinstaller
python -m PyInstaller --noconfirm --onefile --noconsole --disable-windowed-traceback --paths backend --name cellxplorer-backend packaging/backend_entry.py
New-Item -ItemType Directory -Force src-tauri\binaries
Copy-Item dist\cellxplorer-backend.exe src-tauri\binaries\cellxplorer-backend-x86_64-pc-windows-msvc.exe

npm.cmd install
npm.cmd run tauri:build
```

Expected output, once the toolchain is installed:

- `src-tauri/target/release/bundle/nsis/Cellxplorer_0.1.0_x64-setup.exe`

MSI is possible, but the default target is NSIS because WiX validation can fail on
machines where the Windows Installer service is not available to the build process.
For this spike, MSI could be emitted manually with WiX `light.exe -sval` after Tauri
generates `src-tauri/target/release/wix/x64/main.wixobj`.

## Current blocker found during the spike

This spike produced an NSIS installer. The MSI path reached WiX linking, but WiX ICE validation
failed because the Windows Installer service was not accessible in the build environment.
