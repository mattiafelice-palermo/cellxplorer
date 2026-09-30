# Spec 063 independent review

Reviewer: GPT 6 Astra. Final checkpoint: 2026-09-30.

Disposition: clean independent code review; no remaining blocking findings. The reviewer did not
edit code or run tests. Implementation verification is recorded separately below.

## Findings addressed

1. Exceptions after consuming change batches now schedule bounded recovery; catalog failures
   cannot silently kill the coordinator.
2. Refresh-only roots reconcile pause/recovery gaps even when their periodic interval is manual.
3. Replacing a folder with a file prunes old descendants only after successful scope inspection.
4. Ready changed roots receive round-robin admission instead of starving behind the first root.
5. Native watchers check the watched root identity because Windows omits changes to the root
   itself from its directory notifications.
6. Bulk header enrichment publishes progress before each read and incremental results, avoiding
   an aggregate batch timeout while preserving individual-header stall detection.

The second review cleared findings 1–5. The third review found item 6 after the bulk optimization;
the fourth review confirmed its fix and reported no remaining blocking findings.

## Implementation evidence

- Final canonical preflight passed all four stages and all 184 backend/frontend test
  files/modules in 183.75 seconds after the last watchdog fix.
- Regression coverage includes native Windows deep additions/rename/deletion, events during
  scanning, replacement of the watched root, unsupported monitoring, blocked workers, recovery,
  overflow, pause/resume, scheduled refresh and acknowledgement validation.
- Bulk tests cover shared settling, rename during header extraction and
  simulated 200-second aggregate enrichment with individual reads below the watchdog limit.
- Browser checks used disposable data in light and dark themes, including a 1600 × 1000 viewport.
  Checked per-root states, daily fallback, disabled subdaily choices before acknowledgement,
  the eight-subscription limit, and automatic additions/deletions in an open search while retaining
  the user's query. A real NDAX fixture became searchable in about 1.17 seconds locally.
- A local 256-tiny-file experiment with metadata disabled improved from 10.137 seconds to
  0.584 seconds after shared settling and batched catalog publication. This is not a NAS or
  metadata-enabled throughput claim.

Actual private NAS notification behavior and installed desktop WebView acceptance remain
unverified. Local native tests and browser acceptance do not establish those environment gates.
