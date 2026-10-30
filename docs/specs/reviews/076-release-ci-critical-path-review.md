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
