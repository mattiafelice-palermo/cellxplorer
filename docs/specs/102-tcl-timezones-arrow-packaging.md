# 102 — Tcl timezone archive and bounded PyArrow packaging

Status: Complete; frozen, clean-Windows and signed native installer verification passed.
Branch: `codex/tcl-timezones-arrow-packaging`.

## Scope

Replace Tcl's loose timezone scripts with one compressed container, with direct
in-memory loading and no startup extraction. Preserve all original script bytes,
aliases, historical transitions, errors and the original loader's name guard.
Keep Tcl/Tk scripts, messages and encodings needed by native dialogs. Fail the
build for an unrecognised clock loader rather than applying a speculative patch.
When Tcl/Tk already embeds its resource archives in DLLs (the newer clean-Windows
builder), preserve that native layout without patching it. Require PyInstaller's
zipfs detection and byte-identical source/bundled DLLs, record their hashes and
verify the frozen all-zone behavior. Never treat a missing loose directory alone
as proof of embedded resources.

Audit native import dependencies before omitting the unused PyArrow Flight,
Substrait and C++ test components. Preserve Arrow core, compute, Parquet/codecs,
dataset/Acero, encryption, local/cloud filesystem modules and existing formats.
Reject a retained binary that imports an omitted DLL. No scientific calculation,
parser identity, schema, source data, installed app or public release changes.

## Verification

- Byte-exact deterministic container, names/membership and safe generated-tree
  cleanup tests. Patch only the recognised Tcl loader call; no global source/file
  interception and no weakened path validation.
- Compare every original Tcl zone, aliases, historical/DST dates, local/POSIX
  behavior, clock scan/add and invalid-name errors in source and frozen runtimes.
- Frozen scientific/API/Arrow-codec/native-dialog checks; retain all unsupported
  or uncertain PyArrow components. Actual packaged desktop launch with disposable
  scientific and WebView data; signed build-only native installer CI.
- Preserve a hash-verified pre-change payload. Repeat interleaved NSIS /SOLID zlib
  extraction profiles of baseline and candidate with identical shell/helper files,
  separate compilation/verification/cleanup from timed sections, and report actual
  timing variation and instrumentation overhead. Do not infer whole-update speed
  from extraction-only fixtures.
- Canonical preflight, pushed checkpoints and final main integration; no release
  publication is part of this request.

## Verification

Implementation checkpoints `d4e48f2d`, `865f06c9` and `741f5501` are pushed.
Clean-Windows preflight
[42685163584](https://github.com/mattiafelice-palermo/cellxplorer/actions/runs/42685163584)
passes on `741f5501`; the earlier compatibility checkpoint also passed
[42683346850](https://github.com/mattiafelice-palermo/cellxplorer/actions/runs/42683346850).
The first checkpoint exposed two differences in the clean
builder: its Tcl/Tk resources already live in DLL-backed zipfs archives, and main
preflight does not install PyInstaller. The follow-up preserves the embedded
layout with byte/hash proof and makes hook unit tests independent of build tools.

The local Python 3.14.4 / Tcl 8.6.15 bundle replaces 609 loose timezone scripts
with one 401,231-byte container. The native import audit permits removal of six
unused Arrow DLL/PYD files (17,355,264 bytes), retaining every other native module.
The audited backend has 575 files, versus 1,189 before this feature. All retained
Tcl resource bytes are verified before generated loose scripts are removed.
All 188 retained DLL/PYD files are byte-identical to the preserved local baseline.
An independent scan of all 188 retained native modules found no eager or delayed
imports of the omitted Flight/Substrait DLLs.
The native-file difference is exactly the six audited optional Arrow components.
This local profile holds Python/Tcl and the desktop/helper bytes fixed. It must
not be presented as an A/B measurement of the newer CI runtime: that builder
already packs Tcl/Tk inside its DLLs, so it does not gain another 608-file Tcl
reduction from the custom loose-resource packer.

Local frozen/source checks agree for all 609 Tcl zones, historical/DST/alias and
clock operations, Neware NDAX/Excel and BioLogic raw/cycle signatures, lossless
Parquet, six Arrow codecs, compute, Dataset/Acero, ORC, JSON, local filesystem,
portable-report assets and Python timezones. The isolated packaged desktop
rendered its empty Cell Database and import browser. The native folder-picker
API returned the expected empty selection after cancellation. The user then
confirmed manually loading sources and plotting successfully. No installed
edition or real library was replaced; the temporary test library is retained.

Signed build-only checkpoint
[42683354948](https://github.com/mattiafelice-palermo/cellxplorer/actions/runs/42683354948)
passed frozen API/scientific checks, signing, registry/NSIS policy and all eight
native install/reinstall cases. The newer Tcl/Tk runtime preserves its own
embedded zipfs libraries and matches source across all 597 of its zones, with
all six Arrow codecs available. This is not interactive UAC, an old installed
updater, or end-to-end recovery acceptance. Release creation/publication and
channel feed changes were skipped. A repeat gate on the final destination-link
safety check also passed in
[42685171789](https://github.com/mattiafelice-palermo/cellxplorer/actions/runs/42685171789),
including the unchanged canonical fallback preflight, actual frozen checks and
all eight native installation cases. The profiler's compiler default is resolved
from `LOCALAPPDATA`, not a developer-specific path; its CLI smoke check passes.

The final local no-cache preflight used the same four-worker CPU budget as CI.
Its version, frontend type/build and all other backend/frontend modules passed;
`tests.test_start_webapp` alone failed two occupied-port assertions because this
host could not identify the temporary listener's process. This is the unchanged
local launcher limitation already recorded in Spec 101, not a suppressed gate
or a packaging-source change. Clean-Windows preflight passes the same tests.
The full local log is retained in `tmp/102-preflight-final.log`.

## Final extraction profile

Five alternating baseline/candidate repetitions used the same precompiled,
hash-locked NSIS `/SOLID zlib` extractors with identical desktop/helper files.
The final timed repetition had no local compilation or test suite overlap.
Each fresh destination was hash-verified and removed outside timing. Filesystem
caches were warm; antivirus policy was unchanged. The initial overlapping
profile is superseded by this repetition, not used for the claimed saving.

| Metric | Baseline | Candidate |
| --- | ---: | ---: |
| Payload files, including identical desktop/helper | 1,191 | 577 |
| Uncompressed payload bytes | 210,989,447 | 192,856,231 |
| Uninstrumented process median | 6.706 s | 5.344 s |
| Uninstrumented observed range | 6.594–7.136 s | 5.039–6.036 s |
| Instrumented process median | 6.513 s | 5.360 s |
| Instrumented Tcl timezone phase median | 0.859 s | 0.011 s |
| Instrumented Arrow phase median | 1.204 s | 0.880 s |

The uninstrumented median saving is **1.362 seconds (20.3%)** on this one local
payload/machine. The instrumented/control medians differ by -0.193 s for the
baseline and +0.016 s for the candidate: run variation prevents assigning a
precise instrumentation cost, so the headline uses uninstrumented controls.
This excludes old uninstall, registration, shortcuts, process shutdown, WebView
installation, UAC and update handoff. It is not a 20.3% whole-update claim and
must not be transferred to the newer CI Tcl/Tk layout without another matched A/B.
Raw trials, executable hashes and source manifests are retained locally under
`tmp/102-comparison-ici1p7yf/results-quiet.json` and its linked `results.json`.
