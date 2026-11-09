# 102 — Tcl timezone archive and bounded PyArrow packaging

Status: Implementation and packaged verification in progress.
Branch: `codex/tcl-timezones-arrow-packaging`.

## Scope

Replace Tcl's loose timezone scripts with one compressed container, with direct
in-memory loading and no startup extraction. Preserve all original script bytes,
aliases, historical transitions, errors and the original loader's name guard.
Keep Tcl/Tk scripts, messages and encodings needed by native dialogs. Fail the
build for an unrecognised clock loader rather than applying a speculative patch.

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
