# 076 review — Release CI critical path

Independent read-only review found no actionable failure-gate or parallel-isolation
issues in the source change. The pinned cache action's shared-key branch ignores
`key`; rotating the shared-key is effective. Release warmup's additional
`tauri/custom-protocol` matches Tauri CLI production build options.

Policy and native checks start only after packaging. Policy's disposable HKCU
fixtures and default Cargo debug target are separate from dedicated installation
accounts/roots and the matrix's standalone verifier target. All five commands
and explicit exit checks remain unchanged. Unconditional `wait: installer_policy`
blocks final asset recheck/publication and also applies to manual build-only runs.
No candidate rewrite, signature/provenance relaxation or test-limit change found.

Focused workflow tests: 79 passed. Full local no-cache preflight passed 4/4
stages, all 206 modules, typecheck and production build (252.33s). Cold hosted rehearsal,
trusted main seed with both warmup commands executed, and a genuinely warm
hosted measurement remain required. Overlap and cache savings affect the same
phase; do not add them as independent savings. Application compile/link work
remains even with warm dependency caches.

Cold signed rehearsal `41136612666` at `b57e8def` passed all unchanged gates and
eight native cases. Policy/native stages overlapped and the unconditional join
waited 33 seconds after native success. Job 18m42s with empty new cache; not a
warm speed result. Trusted main seeding and warm measurement remain outstanding.

First warm run `41140124525` passed, with test compile 23s and overlapped policy
75s, but the total remained 15m06s under slower bootstrap/preflight/native work.
End-to-end performance acceptance is not achieved. Follow-up design review
supports fresh-install uv plus explicit interpreter/index and unchanged pip
check, conditional on complete same-image pip/uv inventory equivalence. Root/
frontend npm ci can run separately, and ProfileProbe may begin after checkout
with a mandatory join. This is not approval to skip fresh installs or tests.

Bootstrap source review is clean. Evidence retention was corrected: the isolated
comparison writes verified/failure status, partial/full inventories and failed
phase before propagating errors; pinned always-upload retains the report for
14 days. Focused tests: 87 passed. Final local no-cache preflight: 4/4 stages,
207 modules, typecheck and production build, 132.29s. Hosted installer equivalence,
full signed/native acceptance and measured end-to-end improvement remain required.
