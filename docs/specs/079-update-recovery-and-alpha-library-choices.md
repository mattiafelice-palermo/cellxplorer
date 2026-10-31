# 079 — Reliable update recovery and explicit Alpha library choices

Status: Complete; published and publicly verified in Alpha 0.28.0-alpha.15.
Live installed-client/UAC acceptance remains unverified.
Branch: `codex/update-recovery-and-alpha-library-choices`.

Release closure: tag `v0.28.0-alpha.15` targets `cd65ee2233bf486ef7f49cda6718a0d24fe9c537`
and includes the subsequent local signed-installer option (080). Exact-main CI
`41217189503` and signed release/native acceptance `41217220435` passed. Independent
public installer, signature, structured notes and byte-identical Alpha updater feed
verification passed; Stable/Beta/README channel blobs are unchanged. See
[080 published evidence](080-local-signed-installer-updates.md#published-release-evidence--2026-10-31).
This does not claim an actual interactive UAC/installed-client test on the user's machine.

## User decisions

1. Investigate the 10–15-second post-download wait and remove avoidable work, not
   safety waits. Show truthful preparation state; retain every required deadline,
   signature/identity check, payload lock and consent boundary.
2. Fix the Alpha.14 post-UAC failure: the installer reports that installation
   scope/directory could not be validated. Trace the elevated, registered-machine
   installed-client path, not only unquoted harmless/direct-install cases.
3. A failed install must have a usable close/X action; restarting cannot be the
   only escape. Closing must not silently permit a live installer to continue or
   pretend an unavailable backend is healthy. Do not make active irreversible
   handoff dismissible without preserving its safety contract.
4. Alpha startup must distinguish Copy Stable, Copy Beta, Keep current Alpha
   library, and a genuine Start empty. Existing nonempty Alpha gets all four
   explicit choices. Start empty requires a separate destructive confirmation AND
   an unchecked acknowledgement checkbox; confirm remains disabled until checked.
   Backend/restart application must also enforce acknowledgement, not just UI.
   Preserve Stable/Beta, original source files, and unrelated paths. Any reset is
   Alpha-local and executed only when the user deliberately selects/acknowledges it.
5. User explicitly requests GPT-6 Astra at high reasoning for installer work.

## Ownership and verification

One shared sequential feature branch. Astra owns installer NSIS/Rust and focused
native fixtures/tests; the main agent owns frontend, bootstrap backend, specs,
integration and release coordination. Coordinate any shared-interface changes.
Do not edit each other's owned files without agreement.

Never run an actual installer, UAC action, registry repair, restart/stop or database
reset against the live user installation. Read-only diagnostics are allowed.
Use disposable data and fixtures. Prove destructive reset preserves source files
and other channel libraries, requires acknowledgement, and cannot apply a stale
stage to a changed target. Prefer existing staged/restart-safe replacement and
recoverable backups rather than deleting an open SQLite database in place.

Add backend/frontend/native regressions and real browser verification using an
isolated test app for new surfaces. Test light/dark and modal UI zoom/geometry.
Perform canonical no-cache four-worker preflight and honest native acceptance;
passing fixtures alone are not a claim that the installed-client/UAC path passed.
Published tags/assets remain immutable. Commit/push completed checkpoints; no
speculative release before the installer failure is understood and verified.

## Implementation decisions

- Empty Alpha is a distinct staged operation, not an alias for Keep current.
  The API and native command both require explicit data-loss acknowledgement.
  A newly migrated database receives a fresh instance UUID; the active database
  is not cleared in place. The previous database and managed imports are retained
  under `backups/alpha-reset-<token>/` after successful activation.
- Typed logical SQLite and managed-import fingerprints bind reset consent to
  the target library. Session/activity bookkeeping and WAL checkpointing do not
  invalidate consent, but scientific data, application preferences, source
  inventory and database identity changes do. Copy activation refuses reset stages.
- Native installer failure metadata distinguishes an aborted pre-shutdown handoff
  from an unclassified IPC error or another active installer owner. Only confirmed
  aborted handoffs enable Close/X. Closing preserves the failure and verified-byte
  retry state, accessible from the application update menu.
- The post-download UI says Preparing update while the verified handoff is pending.
  Diagnostic session bookkeeping runs concurrently rather than blocking preparation.
  Every installer consent boundary and safety deadline remains native-owned.

## Verification

### Alpha.15 release preparation

The user authorized `0.28.0-alpha.15` publication on 2026-10-31, subject to
completion of installer/update checks. Release notes use `### New features` and
`### Bug fixes`. A signed build-only Alpha rehearsal will run the complete hosted
policy, transport, frozen-science and disposable upgrade/reinstall matrix before
tag publication. Hosted Windows has UAC disabled; interactive approval/cancellation
acceptance requires a separate disposable session and is not replaced by fixtures.
Publication remains gated while that acceptance scope is unresolved. The live
user installation and libraries are not test targets.

- Installer cause: the production template includes `update_recovery.nsh` before
  `installation_scope.nsh`, but recovery used `$CxExisting` before its declaration.
  NSIS compiled the unknown reference as literal text (warning 6000), so an existing
  installed-client handoff was always rejected. The Alpha.14 release build log and
  a red/green production-order fixture confirm this; registry corruption was not
  the cause. The declaration now precedes its first use. Fixture compilers reject
  unresolved-variable warnings and use explicit UTF-8 input.
- Astra High installer verification: 29 native recovery fixtures, all three
  Stable/Beta/Alpha template compiles, 50 focused Python tests and 23 native updater
  tests pass. Machine fixtures exercise production scope/discovery and the full
  quoted relay handshake, including spaces/Unicode and identity/hash/version/channel
  rejection cases, without actual elevation or writes to installed registrations.
- Disposable SQLite contention measured diagnostic session completion at 5.53
  seconds versus 0.019 seconds uncontended. Running that bookkeeping concurrently
  removes this proven prelaunch dependency. The complete reported 10–15-second
  delay has not been measured end to end, so no total latency reduction is claimed.

- Alpha/Beta bootstrap: 51 Python tests pass; 23 focused native bootstrap tests
  pass, including both acknowledgements, stale library/import rejection,
  new identity/nonempty-stage rejection, recovery backup and marker-failure rollback.
- A shared Python/Rust typed-digest golden covers Unicode, embedded NUL, NULL,
  integer, float and blob values. Application preference edits also invalidate it.
  A read-only native validation probe also accepted a real Python-generated staged
  migrated database with a Unicode Windows import inventory and rejected a later
  preference edit; active library/source bytes remained intact.
- Astra High reset-safety review found one stale `confirmReplace` callback capture
  in copy confirmation. It is corrected and independently rechecked. Two production
  component/hook regressions cover Stable and Beta replacement with development
  mocks disabled: the original dependency omission fails both tests by submitting
  `false`, and the corrected implementation submits `true` through API and native
  boundaries. No other reset-safety findings were identified in the reviewed scope.
- Real browser checks against disposable data verify four distinct Alpha choices,
  disabled unchecked reset confirmation, acknowledgement reset after cancellation,
  closable terminal install failure and reopening its retained retry state.
  Light/dark and 70/100/160 percent UI zoom checks include measured button/dialog
  bounds; clipped labels and enlarged-view recovery controls were corrected.
- Final canonical no-cache four-worker preflight passes all four stages and all
  210 backend/frontend test files/modules after the review fix (257.06 seconds).
  Full locked native tests pass 83/83. The checks used a short disposable temporary
  directory outside the sandbox: initial sandbox attempts hit Windows filename
  limits and denied junction/registry/pipe fixtures. Identical checks passed with
  those environment constraints removed; no product workaround or skipped check
  was introduced. Logs are retained locally under `tmp/079-final-*` (not published).
- Actual interactive UAC and the live user installation remain untouched. Native
  fixtures do not establish end-to-end acceptance of the installed application.
