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

If the backend port is already occupied, the launcher lists the owning program, process ID, and
executable when available. Confirm the prompt with `y` to stop that process and continue launching;
answering anything else leaves it running and exits without starting the app.

## Build the Windows installer

```powershell
.\scripts\build-app.cmd
```

Pass `-Channel stable`, `-Channel beta`, or `-Channel alpha` to build the corresponding
channel-specific installer. Alpha is a fully isolated build with its own product identity,
`.cellxplorer-alpha` data root, and standard updater controls backed by its dedicated feed.

The build command installs npm dependencies, builds the React frontend, freezes the Python backend,
copies the backend sidecar into Tauri's binaries directory, and creates the NSIS installer.

The installer is written to:

```text
src-tauri\target\release\bundle\nsis\CellXplorer_<version>_x64-setup.exe
```

Beta and Alpha builds use `CellXplorer.Beta_<version>_x64-setup.exe` and
`CellXplorer.Alpha_<version>_x64-setup.exe` respectively.

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

## Verify a change

After meaningful code changes, run the canonical local preflight from the repository root:

```powershell
python scripts\preflight.py
```

The command runs version consistency, backend tests, frontend policy tests, and the frontend
production build in order. It uses an isolated temporary `CELLXPLORER_DATA` directory and stops
at the first failure.

Install frontend dependencies first if needed:

```powershell
npm --prefix frontend ci
```

Individual commands remain available for focused debugging. See `AGENTS.md` for the full list.

## Automatic clean-environment preflight

GitHub automatically runs the canonical preflight whenever `main` changes. You can also start it
manually from the GitHub Actions page.

Stable `v*` tags trigger `.github/workflows/release.yml`, which runs preflight with `--no-cache`,
builds the signed Windows release, and uploads updater assets. Tag pushes no longer run the
ordinary preflight workflow.

The preflight workflow installs backend and frontend dependencies on a clean `windows-latest`
runner and then runs:

```powershell
python scripts\preflight.py
```

A red workflow means the committed code failed outside your local development environment.

To run it manually:

1. Open the CellXplorer repository on GitHub.
2. Open **Actions**.
3. Select **CellXplorer preflight**.
4. Select **Run workflow**.
5. Choose the intended branch.
6. Start the workflow.
7. Open the **Clean Windows preflight** job to inspect failures.
