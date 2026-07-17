# Local development and packaging

These helper scripts are the normal Windows entry points for CellXplorer. Run them from the
repository root, or use the `.cmd` files from any directory.

## Start the web app

```powershell
.\scripts\start-webapp.cmd
```

The command starts both processes needed for frontend development:

- FastAPI backend at `http://127.0.0.1:8642`
- Vite frontend at `http://127.0.0.1:5173`

It opens the frontend in the default browser and keeps both processes attached to the terminal.
Press `Ctrl+C` once to stop both processes.

The first run installs missing npm dependencies automatically. Python dependencies still need to be
installed once with:

```powershell
python -m pip install -r backend\requirements.txt
```

Useful options:

```powershell
.\scripts\start-webapp.cmd -NoBrowser
.\scripts\start-webapp.cmd -BackendPort 8650 -FrontendPort 5174
```

The script passes the selected backend port to both `run.py` and Vite, so the second command keeps
API proxying working when the default ports are occupied.

## Build the Windows installer

```powershell
.\scripts\build-app.cmd
```

The build command installs npm dependencies, builds the React frontend, freezes the Python backend,
copies the backend sidecar into Tauri's binaries directory, and creates the NSIS installer.

The installer is written to:

```text
src-tauri\target\release\bundle\nsis\CellXplorer_<version>_x64-setup.exe
```

Useful options for repeat builds:

```powershell
.\scripts\build-app.cmd -SkipInstall
.\scripts\build-app.cmd -SkipInstall -SkipFrontend
.\scripts\build-app.cmd -SkipInstall -SkipFrontend -SkipBackend
```

`-SkipInstall` reuses installed npm packages. `-SkipFrontend` reuses `frontend/dist`. `-SkipBackend`
reuses the existing sidecar. Do not skip a step after changing the corresponding source unless the
output has already been rebuilt.

PowerShell users can call the scripts directly if their execution policy allows it:

```powershell
.\scripts\start-webapp.ps1
.\scripts\build-app.ps1
```

The `.cmd` wrappers use a process-local execution-policy bypass, so they are the recommended
entry points on Windows and do not require changing the machine's PowerShell policy.

## Manual fallback

The single-process browser mode serves the already-built frontend through FastAPI:

```powershell
python run.py
```

Open `http://127.0.0.1:8642`. For live frontend hot reload, use `start-webapp.cmd` instead.
