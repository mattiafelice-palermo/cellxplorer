# Changelog

## 0.3.0 - 2026-07-14

- Added background diagnostics, runtime session tracking, and a persistent activity view.
- Added tray-aware source monitoring with configurable schedules, lightweight metadata scans,
  and retries for files that are still growing.
- Added explicit Active, Complete, and Source changing states in the cell database.

## 0.2.0 - 2026-07-14

- Added a Settings workspace with persistent download-location preferences for browser and
  Windows desktop use.
- Added visible background-job progress, detailed source-check status, and a durable activity
  history with start and finish times.
- Parallelized source checks and made changed-file updates immediately return cells to a ready
  state.
- Improved large cell-library loading by deferring cache-derived totals and exposing their
  calculation status instead of blocking page rendering.
- Refined application scaling, segmented controls, header alignment, and analysis export behavior.

## 0.1.1 - 2026-07-13

- Added richer analysis plot legend controls, including outside/inside placement, side selection,
  custom dragged positions, orientation, and horizontal entry sizing.
- Added plotted-data export options for CSV and XLSX, including decimal separator and delimiter
  preferences.
- Raised default plot export quality to 300 PPI with larger default image dimensions.
- Added the `xlsx` frontend dependency used by analysis data exports.
