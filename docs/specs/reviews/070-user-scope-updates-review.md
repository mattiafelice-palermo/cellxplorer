# Spec 070 independent review

Reviewer: GPT-6 Astra Medium. Date: 2026-10-03.
Checkpoint: working tree on `codex/alpha-analysis-improvements` after `a3174f66`.
Verdict: **PASS for implementation**. No actionable code findings remain.
Signed native installation/update acceptance remains unverified.

## Review scope

Reviewed current-user setup defaults, explicit machine installation, registry
discovery across both Windows registry views, directory preservation, generated
current-version uninstallers, cleanup, startup ownership, restart arguments,
verified update handoff, and the focused regression/compile harnesses.

Fresh setup runs without an elevation manifest and defaults to LocalAppData.
Existing installations retain their authenticated scope and directory. Machine
actions still request Windows approval. Ambiguous, conflicting, wrong-channel,
or incomplete registration fails closed. Elevated machine actions avoid the
administrator account's per-user startup and data settings. Uninstall removes
authenticated registration in both views while preserving scientific data by
default. No automatic machine-to-user migration is implemented.

The updater retains the existing signed download verification. It stages and
rechecks those exact bytes under a deny-write/delete handle, uses the scope's
appropriate Windows launch verb, and checks the returned process before closing
the application. Cancellation and launch errors restore pending update state.
Restart arguments are JSON encoded as hex through NSIS and decoded as data by
the bundled helper; the final executable is fixed to the installation. Windows
PowerShell is selected by an absolute system path, and argument quoting retains
empty strings, quotes, backslashes, shell-like text, and Unicode.

Review findings resolved during the cycle include the NSIS normalization
register-clobber bug, ambiguous path handling and Unicode slicing, duplicate
registration cleanup, normalized manufacturer-path comparison before uninstall,
and conservative command-length limits. The helper's final PowerShell 5 decoding
and quoting correction was included in the last review and test run.

## Verification

Independent final checks passed:

- **28/28** Python installer-scope and updater-configuration tests, including
  running the production helper's quote function in Windows PowerShell and
  decoding the result with Windows `CommandLineToArgvW` without launching an app.
- **4/4** Rust installation-scope tests, including the final path-normalizer
  change, identity conflicts, preserved directories, and opaque bounded argv.
- NSIS compilation of the production template for **Stable, Beta, and Alpha**.
  These use compiler-only placeholder payloads and were never installed.

The implementer/parent additionally report successful execution of the production
NSIS scope policy against disposable HKCU records, including negative discovery
cases and both-view uninstaller registration cleanup. That execution is attributed
evidence, not independently repeated here. Canonical preflight and the final
commit/push checkpoint are owned by the parent implementation workflow.

The parent subsequently reports final canonical preflight **4/4 passed** in
118.11 seconds (`tmp/070-preflight.log`), the complete Rust suite **59/59 passed**
(`tmp/070-full-rust-tests.log`), and a post-freeze rerun of scope **9/9** plus
updater **19/19** tests. These broader results are attributed to the parent.
Final Spec 070, Windows packaging guidance, and the updater change playbook were
also reviewed. Their current-user transition instructions, old-client caveat,
and explicit pending native signed/visual matrix are consistent with the code
and with this verdict. The fresh custom-path direct-folder check was inspected.

## Acceptance boundary

Compiler fixtures and disposable policy execution do not prove a signed native
install/update/uninstall matrix or actual UAC-free update behavior. No real user
installation or scientific database was modified for this review. Existing
machine installations continue to require elevation. An already-installed old
updater retains its old handoff behavior for its first upgrade; the new checked
handoff cannot retroactively change that client. Claiming full native acceptance
requires a separate disposable Windows installation matrix with real signed
payloads and native controls.
