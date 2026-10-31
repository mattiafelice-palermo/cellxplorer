# 078 — Installer recovery crash

Status: Confirmed correction and local verification complete; Alpha.14 integration/publication in progress.
Branch: `codex/fix-installer-recovery-crash`.

## User request

Investigate and fix the installer crash observed during an installed Alpha.11 to
Alpha.13 update. Restore reliable update behavior, preserving all signature,
installation-identity, consent, payload-lock, data-preservation and timeout gates.
Published releases/tags remain immutable. Do not run an actual installer, alter
registration, restart/stop a live application or touch real user data locally.

## Evidence and verification boundary

Two Windows crash reports at 2026-10-31 13:21:10 and 13:21:32 Europe/Paris identify
staged `installer.exe` failures in `windows.storage.dll`, exception `0xc0000005`.
The client remained open and showed the generic early-launch exit message.
The running Alpha.11 and its HKLM all-users registration agree on their target.
This is not evidence that the user cancelled or that the download signature failed.
Private crash dumps are analysis inputs only and must not be committed.

Trace the actual failure before changing production launch code. Add executable
regressions for the failing boundary and negative cases, not only textual checks.
Exercise current-user and machine recovery, live peer/lock ownership and failure
propagation. Keep installed-client/UAC coverage distinct from compile fixtures and
direct installer upgrade/reinstall checks. No blanket promise that all historical
clients retroactively gain new protocols. Report unsupported/unverified cases.

## Acceptance

1. Crash mechanism established from dumps and/or a safe deterministic reproduction.
2. Narrow correction retaining full command identity and native launch semantics.
3. Focused positive/negative executable checks, canonical no-cache four-worker
   preflight, and signed hosted verification proportional to the changed path.
4. Record the remaining interactive/UAC boundary honestly. No local live-install
   testing or guessed registry repair. Commit/push completed work; follow the
   sequential branch workflow. A new published hotfix requires a new immutable tag.

## Confirmed cause and correction

Both retained x86 minidumps show `ShellExecuteExW` called by NSIS `System.dll`
with a malformed `SHELLEXECUTEINFO`: `lpParameters=0x3a`,
`lpDirectory=0x10000`, `nShow=0`. The faulting read uses the same `0x3a` pointer.
The shared relay interpolated `$0` into System's own quoted structure expression;
embedded scope/origin command quotes terminated that string and became parser
syntax. This was not a signature failure, timeout, cancelled approval or registry
repair requirement.

A harmless inspector compiled the exact production allocation expression and
never called ShellExecute/UAC/installation/registry APIs. Original expression:
exit 2 and the same malformed fields; register-source candidate: exit 0, valid
argument pointer, null directory, show=1, exact `lstrcmpW` argument comparison=0.
The production correction is `w r0` in place of `w "$0"`; lock ownership, mask,
scope, command contents and all deadlines remain unchanged.

The client transport source is unchanged between the Alpha.11 tag and current
main. The repair is in the incoming signed payload, so an existing client with
this protocol can consume it without retroactively patching its own updater.
Older clients that lack this protocol are not claimed fixed by that comparison.

## Verification so far

- 45 focused updater/scope/configuration regressions passed.
- All **19** harmless production NSIS/Rust policy cases passed, retaining all 18
  prior cases and adding quoted command round-trip. The actual checked child
  validates both values (spaces, comma, Unicode) before readiness; both payload
  and directory locks, exit status and original 10/15-second fixture limits stay.
- Real Rust transport validates peer, byte/directory locks and consent handshake
  against the harmless NSIS payload. Actual interactive UAC and live installed
  application mutation were not performed locally.
- Private minidumps, token-bearing commands and raw user paths are not committed.
  Final canonical and signed hosted verification follow.

Canonical no-cache fix checkpoint passed **4/4** in **210.70 seconds**, four
workers and all 209 local task files/modules. The extra local converter module
is unrelated/untracked and is not included in this feature.

The user explicitly authorized publishing Alpha.14 after verification. Keep the
existing Alpha.13 release immutable. Bump all maintained declarations and notes,
verify the versioned checkpoint, push/merge this branch, require exact-main CI,
and run the normal signed draft-verify-publish gates including the new quoted
relay case. Audit public bytes/signature/feed and protected Stable/Beta channels
before calling publication complete. No repeated performance benchmark is required.

Versioned Alpha.14 canonical no-cache verification passed **4/4** in **191.37
seconds**, four workers, all 209 local backend/frontend task files/modules. All
maintained version declarations match. The only production behavioral change is
the opaque register source in the shared installer elevation structure; no client
transport, registry policy, signature check, scientific calculation or deadline
was changed. The three-channel compiler/policy check and full signed/native gates
remain required by the existing release workflow.
