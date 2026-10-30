# 076 — Release CI critical path

Status: Implemented/review-clean; cold hosted verification passed, warm acceptance pending.
Branch: `codex/release-ci-critical-path`.
Review document: [076 review](reviews/076-release-ci-critical-path-review.md).

## Scope and evidence

The user requests substantially faster CI without weakening any checks. Alpha
.12's release job `41133559623` took 14m59s: dependency/profile setup 103s,
sidecar/helper group 78s, signed packaging 207s, policy/Rust checks 214s and
native matrix 167s, plus setup, cache transfer and provenance/publication work.

The pinned rust-cache action ignores `key` whenever `shared-key` is present
(`src/config.ts` at `779680da715d629ac1d338a641029a2f4372abb5`). The attempted
075 cache generation therefore never rotated; an old exact cache hit suppressed
both warmup commands and left debug test dependencies cold (2m47s compilation).
Tauri's production build additionally enables `tauri/custom-protocol`, absent
from the old release warmup. Fix the effective shared-key and match that graph.

Overlap independent post-package policy checks with the native install matrix,
then explicitly join policy before final asset recheck/publication. Keep identical
commands, assertions, case counts, deadlines, signatures and provenance gates.
Do not run real local installers or change persistent user data. Cache failure
or cold state must remain correct. No tag/release is requested by this change.

## Verification and acceptance

Add structural regressions for the effective cache generation, custom-protocol
warmup and fail-closed policy join. Run focused tests, canonical no-cache
preflight, independent review, and signed build-only hosted rehearsal. Measure
cold and genuinely warm runs separately; cache hit alone does not prove saved
compilation. Preserve a clean source baseline and record test counts/timings.
Commit/push the feature branch, merge only when verified, and obtain a trusted
main-cache seed followed by a fresh warm build-only measurement. Published .12
assets/tag/feed stay immutable. Do not call a predicted speedup measured.

## Cold acceptance

Candidate `b57e8def` passed signed build-only run `41136612666`: full hosted
preflight, frozen science, 13 helper tests, 73 Rust tests plus signature example,
recovery fixtures and all eight native cases. Empty new-generation cache: 18m42s
job, including 461s packaging, 254s policy/Rust and 221s native matrix. The final
join waited 33s, proving successful native completion did not bypass policy.
Both branches overlapped in the hosted runner. This is cold correctness, not the
warm performance acceptance. Local no-cache preflight: 4/4, 206 modules, 252.33s.
