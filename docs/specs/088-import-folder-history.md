# 088 — Import Recents and Back navigation

Status: Complete; preflight, browser verification and Astra Medium review passed. Branch: `codex/import-folder-history`.
Review document: [088 review](reviews/088-import-folder-history-review.md).

Browsing currently writes every opened directory to import Recents. Make
directory listing read-only. Record only the parent directories of source files
successfully registered through import or continuation attachment, in
the same transaction as the registration. Retain the bounded, deduplicated
recent list. Existing recent entries remain; do not guess which historic entries
came from browsing. Choosing a search root or monitoring folder is not an import.

Add Back to the left of Up in the shared filesystem picker. Maintain a bounded
per-open navigation stack of successful directory visits, covering folder rows,
quick access, roots, breadcrumbs, typed paths and indexed-search reveal. Back
returns to the previous visited location rather than its parent, without
generating a new forward history entry. Refresh, failed paths and equivalent
path spellings do not add entries. Reset history when reopening the dialog;
selection remains intact while navigating. Keep last-visited startup location
separate from the meaningful imported-folder Recents list.

Verify backend registration/rollback and read-only browsing, navigation policy
and actual nested-folder/breadcrumb/Back flow. Run required preflight and review
before committing, pushing and merging the completed feature.

## Verification

Focused backend import tests passed (97 tests), as did the ten navigation/path
policy tests. Full four-worker no-cache preflight passed all four stages and
220 backend/frontend test files/modules. Browser verification reproduced the
deep-folder → C: breadcrumb → Back scenario and returned directly to the deep
folder. Refresh did not add a history stop, reopening reset Back, and a missing
typed path retained the last listing without creating a visit. None of the
browsing or cancelling actions added a Recent entry. Registration integration
and rollback tests cover when the recent source folder is persisted. A final
frontend check covers the guard that allows navigation during initial loading.

Astra Medium found one retry edge case, corrected before landing. The browser
verified it by visiting two independent test folders, temporarily renaming the
previous folder, pressing Back, restoring it and pressing Back again. Failure
retained the current listing; retry succeeded without Refresh. Final review was
clean. Version 0.28.0-alpha.21; no installer release was requested.
