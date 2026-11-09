# 101 — Archive backed timezone data

Status: Complete; frozen science, clean-Windows preflight and signed build-only native installer checks passed.
Branch: `codex/packed-timezone-data`.
Review document: [101 implementation self-review](reviews/101-archive-backed-timezone-data-review.md).

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
| Distribution metadata and licences | 54 | Retained. A ZIP probe preserves version lookup but breaks `Distribution.locate_file()` resolution of a loose NumPy native module. This is not a drop-in archive conversion; deleting metadata/licences is not harmless cache cleanup. |
| PyArrow runtime | 31 | Retained native modules/libraries. Existing hook already excludes SDK headers, Cython sources, fixtures and tests; those are not a new saving from this feature. |
| Python modules and dateutil timezone data | Already archived | PYZ, base_library.zip and dateutil's archive already avoid many loose files. No extra extraction step should be introduced. |

Native DLL/PYD files remain loose for the Windows loader. A single certifi typing
marker is development-only but negligible; no additional group is removed merely
because a narrow import test happens to pass. No Tcl locale/encoding or scientific
runtime coverage is reduced by this feature.

## Packaged acceptance

Implementation checkpoint `285d3d7b` passed clean-Windows preflight run
[42668568897](https://github.com/mattiafelice-palermo/cellxplorer/actions/runs/42668568897):
all 229 committed backend/frontend test files/modules and all four stages passed
in 238.96 seconds. Build-only branch run
[42668616756](https://github.com/mattiafelice-palermo/cellxplorer/actions/runs/42668616756)
passed the actual frozen API/scientific checks, signed artifact construction,
registry/NSIS/recovery policy checks and eight native install/reinstall cases in
disposable profiles. Release creation, publication and channel-pointer steps were
skipped on this non-tag run. No public release or installed local app was changed.

The local Alpha executable and unsigned installer also built successfully. Local
manual desktop inspection was not performed because an older Alpha test instance
already held the single-instance identity; it was left untouched. Native CI
installation acceptance is not interactive UAC or an old installed-updater test.
The concurrent local full preflight had analysis/indexing timing and native
launcher failures while Rust compiled; no deadline/test was suppressed. An
isolated analysis-engine rerun passed all 134 tests in 58.17 seconds, and the
clean-Windows full-suite result above supplies the integration gate.
