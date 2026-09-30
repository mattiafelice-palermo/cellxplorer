# Spec 060 independent review

Review checkpoint: seventh implementation checkpoint (nested-dialog closure), 2026-09-30.
Disposition: clean code review; no remaining actionable findings in the reviewed scope. R1-R13 are addressed. This review combines static inspection and isolated metadata/catalog probes. The implementer's preflight/browser/package evidence and the remaining environment limitations are distinguished below.

## Addressed since the first checkpoint

- Atomic local spool batches replace the terminable producer's multiprocessing Queue.
- Traversal publishes filenames before header enrichment, and stalled headers have a skip/resume boundary.
- Catalog initialization isolates failure from ordinary application startup and quarantines incompatible/corrupt derived files.
- Settings persistence and coordinator changes are serialized; changed root paths reset ownership.
- Search result/count/ownership reads share a SQLite transaction.
- Superseded indexing jobs now terminate instead of remaining paused indefinitely.

These changes resolve the earlier structural findings on inspection. The reviewer inspected the final preflight log: all 183 backend/frontend modules and all 4 verification stages passed in 69.73 seconds. The implementer also reports 16 passing focused search tests and a frozen-backend smoke covering actual spawned scanning, metadata queries, pause/restart, rebuild, and corrupt/versioned catalog recovery. These are useful backend packaging checks; they do not establish installed WebView or real UNC acceptance.

## Findings and current status

The original findings below are retained as review history. Their heading statuses describe the current implementation.

### R1 [P2] Retain focused results while refreshing progress and completion — addressed

The current implementation retains a stable result query key and calls its refetch when the separately observed root progress/completion signature changes. Existing result data and keyed rows remain mounted while this request runs. Search/filter/page changes retain their own distinct query identity. This resolves both the missed-final-response race and the intermediate progress-key focus regression on code inspection.

Validation: retain row focus and staged selections across several background progress polls; also reveal the final selectable row when settings observes ready immediately after an intermediate result response.

### R2 [P2] Preserve unknown format compatibility in the shared picker — addressed

The indexed `onSelection` adapter in `ImportFilesystemPickerModal.tsx` writes header hints for every result on the page and maps all non-recognized states to `compatible: false`. A pending XLSX therefore becomes an unsupported file in the ordinary folder picker. Its existing hint then prevents ordinary hint enrichment, even after background recognition finishes. Populate only terminal/selectable hints or preserve the nullable compatibility contract and its retry behavior.

Validation: show a recognized NDAX and pending XLSX together, stage the NDAX, switch to This folder, and verify the XLSX becomes selectable when recognized instead of remaining rejected/hidden.

### R3 [P2] Apply normalized selection identity in both scopes — addressed for normalized full paths

Indexed selection normalizes existing paths, but the ordinary folder `toggleFile`, `includeFile`, and page-selection paths still use exact Map keys. Stage a file under a lower-case root path through indexed search, then include its differently cased/slashed ordinary-folder path: two staged entries are created. Mapped-drive/UNC catalog aliases can similarly change the returned display path between scans. Use shared normalized identity at every insertion/toggle boundary. The `mergeIndexedSelection` helper covered by the new unit test is not used by production selection code, so that test does not establish this behavior.

Validation: exercise actual production selection paths in both directions, including toggling/removing, with case/separator variants and retained hidden selections. Cover mapped/UNC variants if canonical alias dedup is claimed across picker scopes.

### R4 [P2] Do not report expected unsupported workbooks as indexing failures — addressed

`import_search_worker.inspect_fact` sets unsupported workbooks to `metadata_state='unavailable'`, and the enrichment loop counts every unavailable result as a warning. Any ordinary unrelated XLSX consequently leaves the whole root in `needs_attention`, with false incomplete/read-failure wording. Unsupported format exclusions are normal classification outcomes, distinct from inaccessible or malformed recognized sources.

Validation: a root containing a supported NDAX plus an ordinary XLSX should finish ready, exclude the workbook, and report no read failure.

### R5 [P2] Derive relative locations from canonical ownership — addressed

The result renderer obtains a relative path using `file.path.slice(file.root_path.length)`. For overlapping mapped-drive and UNC roots, the catalog's chosen owner can use a different alias from the entry's last scanned path. String slicing then produces an empty or incorrect location. Return a relative path computed from matching canonical entry/root identities, or retain a root-specific display path.

Validation: catalog the same source through `Z:\\...` and its UNC root, filter each owner, and check the displayed relative location and usable source path.

### R6 [P2] Search normalized path representations — addressed

Catalog text contains the original path rather than its normalized canonical form, and query terms are only case-folded. Forward-slash queries do not match stored backslashes; a UNC path query cannot match an entry stored through its mapped-drive alias even though the catalog already knows the canonical identity. Implement the promised normalized-path search while retaining literal metadata matching.

Validation: forward/backslash variants, redundant path separators/components as supported by the chosen normalization contract, and mapped/UNC canonical path queries return the same indexed source without source I/O.

### R7 [P2] Show the required modified date in result rows — addressed

Indexed result rows show size/extension but omit the stored modified date required by the search-result contract. Add a compact formatted modified date, retaining the full value in accessible text or a tooltip. Review the result row at narrow width and app zoom alongside existing folder rows.

### R8 [P2] Keep retained UNC entries searchable after mapped-root identity changes — addressed during this checkpoint

The original canonical relative-path calculation raised across different drives when an unavailable mapped root lost its UNC resolution but retained old UNC entries. The implementation now uses `relative_location` with a safe display-path/name fallback. An isolated probe with a UNC entry and a root changing to `Z:\\cycling` returned one result before and after the identity change. This is a synthetic identity test, not a real offline-share check.

### R9 [P2] Do not finish ready with indefinitely pending changed-file metadata — addressed

Changed identity now clears metadata/version and ends enrichment as unavailable. NDAX/MPR retain discoverable source recognition; XLSX retains unconfirmed recognition with the explicit “Refresh to check format” status. The worker counts these outcomes as warnings, so completion reports needs-attention rather than ready. The existing root refresh action retries the source. An isolated changed-size/mtime probe confirmed the unavailable outcome and empty metadata/version reset.

Validation: change a candidate between discovery and its final header identity check; the completed scan must not report ready while retaining an indefinitely pending, unselectable row.

### R10 [P2] Clear newly extracted metadata when final identity validation fails — addressed

The reader clears incoming metadata/version before extraction, validates unsupported classification before returning, and clears newly extracted metadata/version on failed final stat. Independent isolated probes confirmed that a successful header followed by `OSError` retains no barcode, and that an unsupported XLSX classification followed by identity drift becomes unconfirmed/unavailable instead of being cached as unsupported.

Validation: successful metadata extraction followed by failed final stat yields no new searchable metadata; successful/unsupported outcomes changed during their read cannot be cached under the earlier file facts.

### R11 [P2] Keep keyboard focus owned by the virtualized list — addressed

The mounted row set now includes the focused source in addition to the visible/overscan range, retaining its keyed DOM node during scrolling and result reordering within the page. Options expose `aria-posinset` and `aria-setsize` for the full current page. Selection and ranges continue to use the complete page array rather than the mounted subset.

Validation: focus a result, wheel/scrollbar-scroll beyond overscan, then use arrows, Space, and Ctrl+A; keyboard operation must remain in the list. Confirm positional announcements and that selection still operates on the complete current page.

### R12 [P2] Reveal keyboard targets inside short result viewports — addressed

Keyboard navigation now places the target at its own top when the measured viewport cannot fit two rows; the preceding-row context is retained only in taller viewports. This removes the fixed 88-pixel offset that previously hid focused targets in short viewports.

Validation: with a result viewport below 88 pixels, ArrowUp/Down must reveal the newly focused filename instead of leaving focus on an invisible option.

### R13 [P2] Close only the active nested search dialog — addressed

The implementer's browser run found that Escape propagated through Mantine's global modal listeners and closed both a search-management child and the loader. The current implementation reports management-open state through a stable React setter so the loader ignores close requests while management is open. Add/rebuild/folder-browser state similarly disables management Escape/outside closure, and folder browsing disables the Add dialog's Escape/outside closure. Cleanup resets the parent guard when the child unmounts. The implementer verified sequential Escape closes Add, then management, while retaining the loader. No further actionable issue was found in these changes on inspection.

## Acceptance evidence and remaining boundaries

- Focused tests now include a simulated blocked header with 150 discovered files, subsequent work after cancellation, derived-catalog recovery, and actual spawned NDAX/ordinary-XLSX scanning with refresh/rename/offline/restart behavior. The frozen-backend smoke extends this evidence to bundled runtime execution.
- Final post-dialog/test-harness preflight passed: all 183 backend/frontend modules, version consistency, frontend type checking, and production bundling; 4/4 stages in 69.73 seconds. The reviewer confirmed this directly from `tmp/indexed-search-preflight-landing2.log`. The final fixture-only adjustment gives the subsequent-success worker the normal 45-second startup allowance; the dedicated blocked-header timeout test remains. Product code is unchanged since the clean nested-dialog review. The reviewer also independently ran `git diff --check` successfully.
- The rebuilt `0.28.0-alpha.1` frozen-backend smoke is reported passed for actual spawned scan, metadata query, pause/restart, rebuild, corrupt/incompatible catalog recovery, and preservation of scientific data/preferences.
- The implementer reports nine browser input-to-result cases at 251-488 ms including the 120 ms debounce after virtualization, and full HTTP p95 up to 364 ms with concurrent four-row writes at 10 Hz. These measurements improve on the earlier 254-904 ms browser range; retain the underlying measurement evidence with final acceptance.
- The implementer reports live preview/staging, metadata search, retained selection across scopes, wizard Continue/Back/Continue, import into isolated data, light/dark checks, nested Escape behavior, and keyboard target visibility at 1100x680 with a 56-pixel result viewport. Browser evidence remains implementer-reported rather than an independent reviewer UI run.
- No real network drive is mounted in this environment, and native desktop UI automation is unavailable. Real UNC/unavailable mapped-drive and installed WebView acceptance must remain explicitly unverified rather than being inferred from synthetic tests or the frozen sidecar smoke.
