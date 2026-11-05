# 088 review

Reviewer: GPT-6 Astra, medium effort. Scope: the feature working diff against
`main`, including Recents transaction ownership and picker history/races.

One P3 finding: after a failed Back request, the requested directory remains the
same query key. Clicking Back again after reconnection did not automatically
retry. `goBack` now explicitly refetches that failed key while retaining the
back target. Only a successful directory response pops the history stack.

The implementation owner verified the disconnect/reconnect flow in the browser
using task-owned temporary directories. Final independent re-review reported no
actionable findings remaining. The reviewer did not rerun preflight.
