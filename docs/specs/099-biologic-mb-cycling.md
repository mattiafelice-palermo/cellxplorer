# 099 — BioLogic MB cycling measurements

Status: Complete; Astra review and clean-Windows canonical preflight passed.
Branch: `codex/mb-cycling-support`.
Review document: [099 review](reviews/099-biologic-mb-cycling-review.md).

Support the supplied RDO and ISL MB recordings for voltage/time and
voltage/capacity. Add a dedicated MB adapter; leave GCPL, CP, OCV and Neware
interpretation and parser identities unchanged. Do not bump CALC_VERSION.

The observed MB discriminator is 0x7f. RDO uses extended 65-byte module headers,
10/11/10 module versions, big-endian column IDs and data offset 1007. ISL uses
classic 57-byte headers, 0/3/0 versions, little-endian column IDs and offset 406.
Enable the classic combination only for MB; keep bounded exact module walks,
declared record counts, registry widths and malformed-input rejection.

Use measured current and incremental charge, never a control target. Exclude
the entire recorded Ns execution containing positive frequency from curves and
capacity; preserve display breaks across omissions. Restart capacity accounting
at each ordinary operation boundary, omitting the first sample's unassignable
interval. Never difference a counter across an omitted operation. Preserve
original record indices and native elapsed time. Validate finite values,
monotonic clocks, current/charge signs and half-cycle identity. Pair only
adjacent half-cycle identities with opposite measured directions for summaries;
unmatched phases remain plottable. MB settings and classic LOG offsets are not
verified metadata and must not be decoded as GCPL settings/LOG.

Verify independent synthetic bytes for both layouts, EIS counter contamination,
error flags, boundaries, malformed layouts and full cache/analysis paths. Run
both private existing-reader corpora and real-file acceptance in disposable data.
Have Astra review the implementation, resolve findings, then canonical preflight,
commit/push and merge. No release, installation or live database changes.

## Verification evidence

Ten focused MB tests cover independent classic/extended bytes, EIS counter
contamination, neutral and zero-duration contradictions, malformed containers,
unmatched phases, exact cache reload/hit behavior, informational diagnostics,
indexed source previews, selected-cycle full/compact navigation, reusable-array
admission, derivative boundaries and mixed-source preservation. Renderer tests
exercise both interactive and exported traces. A catalog migration regression
preserves recognized entries and retries old negative MPR facts only once.

Both original files passed production Safe/Permissive parsing, scanner ingest,
cache round trips, full/compact Time/Capacity analyses on both axes for the
whole file and cycles 2–3, and bounded indexed source previews. Their SHA-256
values remain unchanged. Capacity totals agree with Astra's independent
increment accounting within 1e-8 mAh. Absolute timestamps and MB protocol
settings remain unavailable; MPT parity and native installer/browser acceptance
are not claimed.

Both unchanged private existing-reader corpora pass: six sources / three chains
(9, 9, 1,175 cycles), and thirteen sources / twelve chains (1,867 and 207 paired
cycles, with the remaining curve-only chains retaining zero complete cycles).
Canonical no-cache preflight is the final integration gate. Its initial run
encountered the sandbox's Windows temporary-path limit, reproduced independently
in an existing canonical-cache test. The unchanged suite is rerun with a short
repository-local TEMP/TMP root; no checks are skipped or weakened.

Normal-Windows local preflight ran all 228 files/modules (including an unrelated
untracked local test), with 226 passing. The two exceptions were the previously
documented local launcher-listener visibility limitation from Spec 098 and an
existing two-second header fixture expiring before child startup. An isolated
copy of unchanged main reproduces that fixture failure in 2.049 seconds. The
fixture now uses the existing virtual reader harness, retains its two-second
deadline and directly asserts that healthy sibling completions cannot renew it.
Astra verified the corrected tests and injected a deadline-renewal regression,
which fails the new assertion. The complete native header module passes after
the correction. Production watchdogs, launcher behavior and test deadlines are
unchanged. A clean-Windows branch preflight is required before merging; local
listener failure is not relabeled a pass.

Clean-Windows branch run [42534318242](https://github.com/mattiafelice-palermo/cellxplorer/actions/runs/42534318242)
at implementation commit `c5a5f54b` passed all four stages and all 227 committed
test files/modules, including native launcher tests. Canonical preflight took
176.24 seconds with four workers. This supplies full verification unavailable
on the local host. No application/calculation/parser version changed, no release
was created, and no real user profile was modified.
