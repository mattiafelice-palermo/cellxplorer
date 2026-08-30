# CellXplorer NSIS installer — development notes

State dump from the 2026-07-18 styling session so any AI/human can continue
without re-deriving everything. The goal is the mockup the user provided:
compact white window, brand header with the real X icon, 3-step chip
stepper (Welcome / Location / Install), teal primary + outlined secondary
buttons pinned to a bottom divider, teal custom checkboxes, branded
uninstall page with keep-data/remove-data radios.

## Files

- `src-tauri/cellxplorer-installer.nsi` — full custom Tauri NSIS template
  (wired via `bundle.windows.nsis.template` in `tauri.conf.json`). Started
  by ChatGPT, heavily reworked in this session.
- `src-tauri/nsis-hooks.nsh` — `NSIS_HOOK_PREINSTALL`/`PREUNINSTALL` embed a
  reusable install-root predicate and run `kill_installation_processes.ps1`
  before any file op. The predicate matches only executable paths under the
  exact `$INSTDIR` (case-insensitive, with a directory boundary), while the
  cleanup loop also protects its own ancestor chain. This keeps the PyInstaller
  **onefile** sidecar's inner process from locking the installed exe without
  terminating another channel that shares the image name. `NSIS_HOOK_POSTINSTALL`
  refreshes shortcuts.
- `src-tauri/nsis-header.bmp`, `nsis-sidebar.bmp` — generated brand
  bitmaps (only used by stock MUI pages now; template mostly ignores
  them). Generator: scratchpad `make_installer_art.py`.
- Real build: `npm run tauri:build` (root `package.json`); sidecar first
  `npm run build:backend`, then copy `dist/cellxplorer-backend.exe` to
  `src-tauri/binaries/cellxplorer-backend-x86_64-pc-windows-msvc.exe`.

## Preview harness (iterate WITHOUT installing / elevation)

Scratchpad dir of session `aeed7384…` under
`%LOCALAPPDATA%\Temp\claude\C--Users-matti-Documents-Cellxplorer\<session>\scratchpad`:

- `build_preview.py` — turns the raw template into `cx-preview.exe`:
  substitutes the handlebars tokens (values mined from
  `src-tauri/target/release/nsis/x64/installer.nsi`, i.e. run a real
  `tauri build` at least once first), forces `install_mode=currentUser`
  (no UAC), stubs `Section Install`/`Section Uninstall`/`RunMainBinary`
  (NO files, registry, taskkill, or app launch — safe to run anywhere),
  compression off, caption `CXSetupPreview`. Env-var variants for
  bisecting: `PREVIEW_MIN_FINISH=1`, `PREVIEW_NO_SHOW=1`,
  `PREVIEW_STOCK_INSTFILES=1`.
  **Must write the .nsi as UTF-8 WITH BOM** (`utf-8-sig`) — makensis
  parses BOM-less files as ANSI and every ✓ becomes mojibake. (The real
  build is safe: Tauri writes its processed installer.nsi with BOM.)
- `drive_preview.ps1` — launches the preview, screenshots each page
  (`pv1…pv5*.png` in the scratchpad), advances by sending `BM_CLICK`
  (0x00F5) to the hidden native Next button (`GetDlgItem(hwnd, 1)`),
  kills the process at the end + a detached 25 s `taskkill` watchdog.
  **Must call `SetProcessDPIAware()`** or GetWindowRect/CopyFromScreen
  disagree at 150 % DPI and you capture a shifted crop.

Loop: edit template → `python build_preview.py` (~5 s) → run driver
(~15 s) → Read the PNGs. Only run the slow `npm run tauri:build` when the
template is final.

## What is DONE and screenshot-verified (pv1/pv2, 2026-07-18 ~17:3x)

- Welcome page: brand header (real 32 px icon from exe resource via
  `NSD_SetIconFromInstaller`, wordmark, divider), heading + tagline,
  chip stepper (teal filled current/done incl. proper ✓, outlined
  upcoming, connectors, centered labels), body copy, footer divider,
  outlined Cancel + teal Continue. Very close to the mockup.
- Location page: same header/stepper (step 1 = teal ✓ chip, teal
  connector), full-width location field + Browse, teal ✓ custom
  checkboxes, computed "Requires approximately N MB" (from
  `ESTIMATEDSIZE`/1024 — shows the true ~86 MB, the old 420 MB was
  hardcoded fiction), Back (outlined, wired to native **Back** — it used
  to be wired to Cancel!) + teal Install.
- Window: fixed 760×640 logical, centered, maximize+thickframe stripped
  (`GWL_STYLE &= ~0x50000`), white DWM caption.
- Instfiles page (styling in template, verify next run): white bg, MUI
  banner chrome re-hidden (MUI re-shows it on stock pages — hide again in
  the SHOW fn), status/progress/details/log stretched to the 680 px
  column, teal flat progress bar (`SetWindowTheme " " " "` +
  PBM_SETBARCOLOR 0x0086B812), native buttons MoveWindow'ed to
  bottom-right.
- Reinstall ("already installed") page: fully branded (header, heading,
  styled radios, custom Back/Continue). NOT previewable in preview mode
  (HKCU has no install record; page auto-skips) — verify with the real
  installer.
- Uninstaller: mirrored window/header/layout, keep-data/remove-data
  radios, red Uninstall button; `un.CellXplorerUninstallLeave` re-shows
  native buttons (was a dead-end: uninstall progress page had no
  clickable Close).
- Welcome page is now REGISTERED (it existed as dead code; the stepper
  showed a "Welcome" step that never happened).

## OPEN ISSUE #1 — finish page never shows in PREVIEW (process exits)

After clicking Next on the completed instfiles page the preview process
exits (`HasExited=True`, window gone) instead of showing
`CellXplorerFinishPage`. Bisect matrix (all in preview mode):

| Variant                                   | Result       |
|-------------------------------------------|--------------|
| Full template                              | exits        |
| Minimal finish page (label only)           | exits        |
| No SHOW hook on instfiles                  | exits        |
| Fully stock instfiles (no PRE/SHOW/COLORS) | exits        |

So it is NOT the finish page body and NOT the instfiles hooks. Facts:
`Page custom CellXplorerFinishPage CellXplorerFinishLeave` IS in the
generated script (line ~517); the instfiles Next button says "Next >"
(so NSIS believes a next page exists). The ChatGPT-era build (before the
welcome page was registered, and with a NON-stubbed Section Install)
did reach the finish page in a REAL install.

Next experiments, cheapest first:
1. Preview variant with the welcome-page registration removed (restores
   the old page order) — highest signal.
2. Log the preview's ExitCode (0 = graceful "pages done" vs error).
3. Rapid-frame captures (150/400/800 ms) after the final click to see if
   the finish page flashes before closing.
4. Suspect the STUB: an install section that does nothing but DetailPrint
   might interact with page flow (e.g. NSIS `Quit` on empty…unlikely) —
   try a stub that also does `SetOutPath $INSTDIR` + writes/deletes one
   temp file.
5. Run the REAL installer end-to-end; if the real one shows the finish
   page, this is a preview-harness artifact and can be deprioritized.
   (The user's earlier REAL run got "stuck at the last screen" with an
   unclickable Finish — that build predated the `RunMainBinary` stub and
   several fixes; the real installer's finish-click path runs
   `nsis_tauri_utils::RunAsUser` which is fine when the app exists.)

## OPEN ISSUE #2 — small polish items

Verified in the final preview run (~18:0x): icon gray-square FIXED
(welcome header clean); instfiles restyle CONFIRMED (white bg, full-width
teal bar, styled status/details, buttons bottom-right).

Remaining:
- Instfiles: a few thin dark artifacts on the far-left window edge
  (y≈90–150 px and below) — some MUI control still peeking; find its id
  (Spy++-style enumeration of $HWNDPARENT children) and hide/move it in
  `CxStyleInstFilesBody`.
- Instfiles vertical balance: content sits upper-third with empty lower
  half; consider moving the inner dialog down or adding a heading.
- Finish page content never visually verified (blocked by OPEN ISSUE #1
  in preview; verify via a real install).

## NSIS gotchas learned (do not relearn these)

- `WS_BORDER` added via `NSD_AddStyle` is invisible until
  `SetWindowPos(...SWP_FRAMECHANGED)` — see `CxRefreshControlFrame`.
- MUI re-shows its banner controls (1034/1035/1036/1037/1038/1028/1046/
  1256) when a stock page appears; re-hide them in that page's SHOW fn.
- `MUI_INSTFILESPAGE_COLORS` is GLOBAL — defining it twice (installer +
  uninstaller pages) is a compile error.
- Macros must be defined before their `!insertmacro` point (PageReinstall
  sits near the top, hence the macro block moved before the page
  registrations); function CALLS may be forward references.
- The native wizard buttons keep their template positions when you
  enlarge the window — MoveWindow them (see `CxStyleInstFilesBody`), and
  every custom page must re-hide 1/2/3 while stock pages need them shown
  (`CxBeforeInstFiles`, `un.CellXplorerUninstallLeave`).
- LangStrings like `$(alreadyInstalled)` come from Tauri's language files
  included at the END of the script — forward use is fine.
- The window chrome coloring is DWM attributes 34/35/36 (BGR COLORREFs).

## Related non-installer state (same session)

- App-side orphan fix: `stop_backend` in `src-tauri/src/main.rs` now
  tree-kills the sidecar by PID (`taskkill /F /T /PID`).
- Frontend: App.tsx polls `/api/database/status` at 300 ms (fast boot
  entry) and shows a skeleton AppShell during backend boot.
- Backend: `main.py` warm-imports pandas/NewareNDA/pyarrow on ONE side
  thread (two threads importing the same package → `_DeadlockError`);
  per-launch DB check is `quick_check`, full `integrity_check` only
  pre-migration. Commit `6ca14e5` holds the earlier half of this work;
  everything after (skeleton, installer overhaul) is uncommitted.

## 2026-07-18 compact progress-page pass

- The installer and uninstaller now use a 760 x 500 logical-pixel window
  instead of 760 x 640. At 150% Windows scaling the captured window is
  1140 x 750 physical pixels.
- Custom-page footer dividers and buttons moved from y=310/322 to
  y=250/262. The inner custom dialog height is 470 logical pixels.
- The stock install-files page is now rebuilt as a branded CellXplorer
  surface: icon and wordmark, top divider, page heading and subtitle,
  status, teal progress bar, details toggle/log, and a bottom divider
  above the native wizard actions.
- The expanded details log is 128 logical pixels high and is reserved in
  the layout, so showing it does not move the header, progress bar, or
  footer actions.
- Installer and uninstaller share the same progress macro, with distinct
  install/remove headings and subtitles.
- The side-effect-free preview harness verified welcome, location,
  collapsed progress, expanded progress, and completed progress states.
  The preview stub still exits before the custom finish page as described
  in OPEN ISSUE #1; this pass did not change that harness behavior.
