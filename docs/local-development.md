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

If either selected backend or frontend port is already occupied, the launcher lists the owning program, process ID, and
executable when available. Confirm the prompt with `y` to stop that exact process tree and continue launching;
answering anything else leaves it running and exits without starting the app.

If Windows cannot identify an occupied port's owner, the launcher offers an available
replacement port instead. Answer `y` to use it and leave the existing server running.
The replacement backend port is also passed to Vite's API proxy. The launcher never
stops a process whose ownership could not be verified; `-StopExisting` reports an
explicit alternative-port command in this case.

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

## Diagnose source indexing

Set `CELLXPLORER_INDEX_TRACE` to a local directory before starting the backend.
Each process appends its own `index-<pid>.jsonl`; merge by UTC `time` to inspect
worker messages, discovery counts, per-file header durations, metadata field names,
parser errors, scan generations, worker restarts/timeouts, and monitoring recovery.
Tracing is disabled by default and works despite worker standard-log suppression.
These opt-in local logs contain source paths and error text, but omit metadata
values and cycling records. Disable tracing after investigation; files are not
rotated automatically. Normal backend stderr remains useful alongside the trace.

Indexer IPC uses the process temporary directory rather than the data/catalog root.
Short sharing locks retry within the existing worker-silence deadline. Discovery
is indeterminate; header-check progress has a known total. Searchable counts can
shrink as unsupported candidates are excluded, independently of scan completion.

The launcher checks both selected ports (default 8642 and 5173), including custom
`-BackendPort` / `-FrontendPort` values. For an intentional unattended restart use
`.\scripts\start-webapp.cmd -StopExisting`; it stops only the process trees
owning those two ports. Normal startup prompts before stopping an existing owner.
Shutdown also stops the launched child trees so Vite and backend workers are not
left behind. Optional checkout-local Python/Node tools are discovered automatically.

The development launcher defaults to `data\development` inside this checkout.
An explicit `CELLXPLORER_DATA` environment override is preserved. This keeps browser
testing separate from installed Stable/Beta/Alpha libraries.

### Compare full-scan header readers

`python scripts/benchmark_index_headers.py --root "O:\your-folder" --output data\header-benchmark`
reads original files without changing them, uses fresh isolated catalogs, and compares
the legacy serial implementation with two and four readers in both orders. It checks
exact metadata/classification/source-identity parity, fixed-total monotonic progress,
and unchanged rescans. Logs and manifests contain private paths; keep them local.
OS/NAS caches are not flushed, so compare repeats rather than claiming cold-disk timing.
Use `--resume` to reuse completed runs in that output directory. If an interrupted run
left a `run-N-X` directory without `result.json`, move that partial directory aside
before resuming; the script refuses to overwrite its diagnostic artifacts.

Full scans use at most four individually stoppable header readers, with one file per
reader and independent 45-second deadlines. They exit after enrichment; cached
unchanged ready/unsupported entries do not start a reader. Watcher deltas retain their
existing serial processing. A slow Windows process exit retains its reader slot and
spool until reaped; healthy readers continue without exceeding the global four-reader cap.
