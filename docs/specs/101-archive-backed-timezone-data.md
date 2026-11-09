# 101 — Archive backed timezone data

Status: Implementation and packaged verification in progress.
Branch: `codex/packed-timezone-data`.

## Scope and contract

Reduce installer file creation by shipping the unchanged tzdata package in one
deterministic ZIP. Use standard Python zipimport and importlib.resources, without
patching timezone interpretation or extracting the archive on application startup.
Collect package modules outside PyInstaller's PYZ so its loader cannot shadow the
ZIP. Preserve distribution metadata and licences. Install the archive search path
in a PyInstaller runtime hook before application imports, including frozen child
processes. Keep the onedir backend, native libraries, Tcl/Tk and scientific code.

After byte-for-byte archive verification, remove only the generated bundle's
validated loose tzdata subtree. Reject links, junctions, incomplete packages and
unrecognised bundle layouts. Reject loose timezone duplicates in bundle audit.
No real user library, installed application, scientific parser/calculation identity
or public release is changed by this feature's verification.

## Acceptance

- Deterministic archive bytes, exact membership and resource bytes; safe failure
  for malformed layouts and links; unchanged source mode.
- All bundled zones, historical/winter/summer offsets, invalid-zone behavior and
  archive-backed resource origins verified inside the real frozen backend.
- Existing lossless scientific fixtures, native numerical/Arrow operations,
  Parquet round trips, Tcl/file-picker modules, portable assets and API startup.
- Build and launch the packaged desktop executable with a disposable data root.
- Inventory the freshly built payload and classify other small-file groups as
  already excluded, safe candidates requiring tests, or required loose runtime.
  Do not treat an older local payload as the current release inventory.
- Canonical preflight and pushed branch checkpoint before main integration.

## Local frozen verification

A fresh PyInstaller 6.21.0 / Python 3.14.4 build with tzdata 2026.1 packs 627
unchanged members (605 data files plus 22 Python modules) into a 328,487-byte ZIP.
The standard hook previously shipped 605 loose data files and kept Python modules
inside PYZ. The new build retains seven metadata/licence files in addition to
the archive, giving a net reduction of 597 installed files relative to that hook.
The validated fresh backend contains 1,189 files and no loose tzdata package.
All 598 zones agree with source across five historical/winter/summer dates, with
Paris DST-fold offsets and invalid-zone behavior checked. Source/frozen lossless
Neware NDAX/Excel and BioLogic raw/cycle signatures, Parquet/zstd, NumPy/Arrow/CSV,
Tcl/file-picker imports, portable-report asset and API startup checks pass.

## Remaining small file audit

The fresh payload, not an older distribution folder, has these main groups:

| Group | Files | Disposition |
| --- | ---: | --- |
| Tcl data | 832 | Retained. Includes a separate 609-file timezone database, 127 message catalogs and 82 encoding tables. The bundled Tcl 8.6.15 exposes no `zipfs` command; direct Python ZIP loading does not apply. Consolidation needs a Tcl-aware loader and clock, locale, encoding and native-dialog tests. |
| Tk data | 89 | Retained. Native dialogs source these scripts; generic ZIP packing would break filesystem-based loading. |
| Distribution metadata and licences | 54 | Retained. A shared metadata archive is a candidate for dedicated importlib.metadata/resource tests; deleting it is not equivalent to harmless cache cleanup. |
| PyArrow runtime | 31 | Retained native modules/libraries. Existing hook already excludes SDK headers, Cython sources, fixtures and tests; those are not a new saving from this feature. |
| Python modules and dateutil timezone data | Already archived | PYZ, base_library.zip and dateutil's archive already avoid many loose files. No extra extraction step should be introduced. |

Native DLL/PYD files remain loose for the Windows loader. A single certifi typing
marker is development-only but negligible; no additional group is removed merely
because a narrow import test happens to pass. No Tcl locale/encoding or scientific
runtime coverage is reduced by this feature.
