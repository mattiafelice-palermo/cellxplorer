# Review 018: In-app update experience

Branch: `feature/updater-017-019`  
Current head: `a8bca38c0c1420aa9cf791b94af71d4c18b08ada`  
Spec 018 implementation commit: `c2ebbcd639fef6e52da8b7ad6e814f0ef5336978`  
Spec 017 foundation commit: `5ad0cc7c9796c300f3ee82119bb3fbfaa202ef8a`  
Base and merge base: `main` at `1f4c9702c86f50cc3a66d164bc1896ce1a3a5718`  
Cumulative scope: three commits ahead of `main`  
Status: **follow-ups addressed** (awaiting re-review)

## Assessment

The implementation uses the intended structure: updater policy and Tauri calls are isolated in
`appUpdater.ts`, process-local state lives in a provider, the power menu only renders the public
state, and the modal remains separate. The initial modal, menu placement, release-note safety,
dirty-workspace guard, notification persistence, automatic schedule and development mock are
substantially aligned with Spec 018.

The implementation is not ready for Spec 019. Automatic refreshes can erase an available or
non-dismissible recovery modal, progress accounting can lose real channel chunks, unknown-size
progress is rendered as a static full bar, Tauri string errors are discarded, and the two power
button indicators use the same corner. Required manual and automated verification is also not
recorded.

Spec 018 additionally remains blocked by the unresolved Spec 017 review. In particular, the current
Rust commands request `State<Mutex<PendingAppUpdate>>` while the application registers the bare
`PendingAppUpdate`. Fix the Spec 017 review before attempting a real packaged update.

## Confirmed correct by code reading

- The updater UI is hidden in ordinary browser mode and enabled only in Tauri or the explicit DEV mock.
- Automatic checks are scheduled after 10 seconds and every 12 hours without blocking initial render.
- The final power-menu item appears after Debug and `Automatic updates` is renamed to
  `Background automation`.
- Check, download and install use the three narrow Spec 017 commands rather than the generic
  JavaScript updater plugin.
- Download progress uses a Tauri IPC `Channel`.
- The setup executable is not routed through CellXplorer's normal Downloads history.
- Release notes are rendered as React text, not HTML, with a bounded scroll area and a fallback.
- The modal has no close button and blocks Escape/overlay dismissal during download and launch.
- Dirty analysis workspaces are confirmed before download begins.
- The session-finish request is best-effort and occurs only after verified download completes.
- A download error keeps the release metadata and offers Later/Retry.
- The implementation does not change backend scientific state, database schema or caches.

## Follow-up tasks

### R1 — High: background checks can erase an active update or mandatory recovery modal

**Affected files**

- `frontend/src/components/AppUpdateCoordinator.tsx`
- `frontend/src/appUpdater.ts`
- `frontend/tests/appUpdater.test.ts`

### Current

`performCheck()` blocks only the `downloading` and `launching` states. It is therefore allowed to
start while the current state is:

- `available`, including while the update modal is open;
- `error/download`;
- `error/install`, where the modal is deliberately non-dismissible until the user restarts.

Every check immediately dispatches `check_started`, replacing the complete current state with:

```ts
{ status: "checking", source }
```

`AppUpdateModal` cannot derive a release from `checking`, so an open modal disappears. This is most
serious for `error/install`: the 12-hour automatic timer can remove the mandatory restart surface
and let the user continue in a session whose diagnostic lifecycle may already have been closed.

The same transition also removes the known badge/release during a background refresh. If the check
fails, the automatic error reducer returns `idle`, permanently forgetting the known update.

`mergeCheckResult()` does not fix this because it reads `stateRef.current` after the state has become
`checking`. It also preserves only exact version equality and does not reject an older result, even
though Spec 018 explicitly requires older/equal automatic results not to replace the current release.

### Target

Background checking must not destroy the last valid update state or any active modal/recovery state.

Use one of these small approaches:

- keep checking as separate process metadata while preserving the current release state; or
- skip automatic checks while a modal/download/recovery flow is active and preserve the available
  release during a background refresh.

Do not add a second large state manager.

When comparing two releases, use a tested semantic-version comparison or an equivalent stable rule.
An older or equal result must not replace a newer currently displayed release.

A manual request that coalesces with an automatic in-flight check must still receive manual outcome
semantics: up-to-date feedback on success and a red notification on failure.

### Acceptance criteria

- An automatic check cannot close an available, downloading, download-error, launching or
  install-error modal.
- An automatic failure preserves an already known available release and its badge.
- An install-error modal remains non-dismissible until `Restart CellXplorer` is used.
- A same-version or older check result does not replace the current release object.
- A newer result may replace an available release only when no download/recovery flow is active.
- A manual check coalesced with an automatic check still gives manual success/error feedback.
- Tests cover each transition above, including the install-error plus automatic-timer case.

---

### R2 — High: progress events can be dropped or counted from stale React state

**Affected files**

- `frontend/src/components/AppUpdateCoordinator.tsx`
- `frontend/src/appUpdater.ts`
- `frontend/tests/appUpdater.test.ts`

### Current

`pushProgress()` reads `stateRef.current`, computes the new byte total outside the reducer and then
dispatches the absolute result:

```ts
if (stateRef.current.status !== "downloading") return;
const next = accumulateDownloadProgress(stateRef.current, event);
dispatch({ type: "download_progress", ...next });
```

`stateRef.current` is updated only by a `useEffect` after React commits a render. Tauri channel
messages are not required to wait for that commit.

Consequences:

- the first `started` or `progress` event can arrive while the ref still says `available` and be
  ignored;
- multiple chunks delivered before the effect runs can all calculate from the same stale byte count,
  so later dispatches overwrite earlier progress;
- the displayed percentage and byte total can under-report the actual verified download.

The current tests exercise only the pure arithmetic helper with sequential local variables. They do
not reproduce queued channel events against the coordinator.

### Target

Progress accumulation must be synchronous and independent of render timing.

Prefer either:

- dispatching raw `started`/`progress` events and accumulating inside the reducer, where queued
  actions are applied in order; or
- a dedicated mutable progress accumulator local to the active download, updated before each
  dispatch.

Keep the version bound to the active download and ignore events from stale/completed downloads.

### Acceptance criteria

- `started` followed immediately by several `progress` events records every chunk.
- Multiple progress events in one JavaScript turn produce the correct cumulative total.
- A stale event from an earlier download cannot modify the current release.
- The final displayed byte count equals the sum of all channel chunks.
- Tests cover rapid back-to-back events rather than only isolated helper calls.

---

### R3 — Medium: unknown-size downloads show a static full bar, not indeterminate progress

**Affected file**

- `frontend/src/components/AppUpdateModal.tsx`

### Current

For unknown content length, `computeDownloadProgress()` correctly returns `percent: null`, but the
modal renders:

```tsx
<Progress
  value={progress?.percent ?? 100}
  animated={progress?.percent === null}
/>
```

This produces a 100% filled bar. Mantine's `animated` behavior is for striped progress; without the
striped treatment, this does not provide the requested visible indeterminate motion.

The result looks complete while the download is still running.

### Target

Render a clearly indeterminate teal progress bar when total bytes are absent or zero. Use the
existing Mantine component and restrained functional motion; do not invent a fake percentage.

A simple acceptable implementation is the Mantine striped+animated treatment for the unknown-size
branch, while retaining the normal determinate bar when total bytes are known.

Official component reference:

`https://v7.mantine.dev/core/progress/`

### Acceptance criteria

- `?mockUpdate=unknown-size` shows visible ongoing motion and no percentage.
- The bar does not look like a completed static 100% download.
- Downloaded bytes continue updating below it.
- Known-size progress remains determinate and unstriped.
- Light, Dark and Auto remain legible.

---

### R4 — Medium: safe Tauri error messages are replaced with generic text

**Affected files**

- `frontend/src/components/AppUpdateCoordinator.tsx`
- `frontend/src/appUpdater.ts`
- `frontend/tests/appUpdater.test.ts`

### Current

The catch blocks preserve a message only when the rejection is an `Error`:

```ts
error instanceof Error ? error.message : "Could not complete the update."
```

Tauri command failures returned as Rust `Err(String)` can be delivered to `invoke()` as string
rejections. Those safe, specific messages are therefore discarded for check, download, install and
restart failures.

This conflicts with the specification's requirement to show the specific safe installation error
and materially reduces diagnosis of version mismatch, missing verified bytes and updater-state
failures.

### Target

Add one small shared normalizer for unknown errors:

- preserve non-empty strings;
- use `Error.message`;
- otherwise use the phase-specific fallback;
- never stringify objects that may contain internal details.

Use it consistently for updater check/download/install/restart handling and debug events.

### Acceptance criteria

- A rejected string such as `No pending update matches the requested version.` is shown verbatim.
- `Error` objects preserve their message.
- Unknown objects use the safe fallback.
- Automatic check failures remain UI-silent but log the normalized message.
- Tests cover string, `Error` and unknown-object inputs.

---

### R5 — Medium: the teal update badge and amber pause indicator share the same corner

**Affected file**

- `frontend/src/components/QuickSettingsMenu.tsx`

### Current

The update badge and paused-automation dot are implemented as nested `Indicator` components. Both
use the default indicator position and the same `offset={4}`.

When both states are active they occupy the same corner of the same trigger, so they can overlap
rather than remain independently visible. This is exactly the simultaneous state the specification
requires.

The accessible update description is attached to the outer `Indicator` wrapper, while the actual
interactive button keeps the accessible name `Power and settings`. A non-interactive wrapper with
an `aria-label` does not reliably add that description to the trigger's accessible name.

### Target

Give the two states distinct, stable positions without changing header geometry. For example, keep
the teal count at top-end and move the amber paused dot to another corner/offset, or use one small
relative wrapper that positions both explicitly.

Put the update availability in the power button's accessible name or description, not only on a
decorative wrapper.

### Acceptance criteria

- Teal `1` and amber paused state are both fully visible simultaneously.
- Neither badge shifts the header controls at 70%, 100%, 130% or 160% UI zoom.
- The power button's accessible name/description reports `1 application update available`.
- With no update, the button returns to its ordinary accessible name.
- Keyboard opening of the menu remains unchanged.
- Light and Dark screenshots confirm the two indicators do not collide.

---

### R6 — Low: mixed release-note text is converted into one undifferentiated bullet list

**Affected files**

- `frontend/src/appUpdater.ts`
- `frontend/src/components/AppUpdateModal.tsx`
- `frontend/tests/appUpdater.test.ts`

### Current

`releaseNotesAreBulleted()` returns true when any line begins with `-` or `*`. The modal then renders
every parsed line as an `<li>`.

For notes such as:

```text
Important compatibility note
- Fixed updater launch
- Improved progress
```

the introductory line is incorrectly turned into another bullet. Duplicate lines also use the text
itself as the React key.

### Target

Parse each non-empty line into a small typed shape such as `{ kind: "bullet" | "text", text }` and
render each line according to its own prefix. Keep this intentionally limited; do not add a general
Markdown parser.

Use a stable index/composite key so repeated release-note lines do not generate duplicate React
keys.

### Acceptance criteria

- Plain multiline notes remain plain paragraphs.
- All-bullet notes render as a list.
- Mixed text and bullets preserve their individual structure.
- Raw HTML is still displayed as text.
- Empty notes still use the approved fallback.
- Repeated identical lines do not produce duplicate-key warnings.

---

### R7 — Medium: required verification and implementation record are absent

**Affected files**

- `docs/specs/018-in-app-update-experience.md`
- `docs/specs/README.md`
- `docs/specs/reviews/018-in-app-update-experience-review.md`

### Current

Spec 018 is still marked **planned**, the index says **In progress**, and the acceptance checklist is
unchecked. No implementation record lists commands or results. The reviewed head has no attached
GitHub status checks.

The spec requires both automated checks and a substantial browser matrix using the DEV mock. There
is no repository evidence that the modal, simultaneous indicators, error states, themes, keyboard
rules, zoom levels or long-note overflow were actually inspected.

### Target

After R1-R6 and the Spec 017 blockers are addressed, record the exact verification actually
performed. Do not claim the real installer path; that remains deferred to Spec 019.

### Acceptance criteria

Record results for:

```powershell
node --test frontend\tests\appUpdater.test.ts
cd frontend
npx tsc --noEmit
npm.cmd run build
cd ..
python scripts\preflight.py
```

Record manual DEV-mock checks for:

- no-update power menu;
- available badge/menu;
- update plus paused automation simultaneously;
- approved initial modal;
- determinate and unknown-size progress;
- download and install errors;
- dirty-workspace confirmation;
- keyboard and Escape/overlay rules;
- Light, Dark and Auto;
- 70%, 100%, 130% and 160% UI zoom;
- long and mixed release notes.

Also record:

- the exact implementation commit and final reviewed head;
- the real packaged N -> N+1 test as **not yet verified**;
- Spec 018 status/checklist updated to match the evidence.

## Follow-up order

1. Complete the Spec 017 review blockers first; the frontend currently targets unusable Rust state.
2. R1 — preserve active update/recovery state across automatic checks.
3. R2 — make progress accumulation independent of React render timing.
4. R3 — implement true visible unknown-size progress.
5. R4 — preserve safe Tauri string errors.
6. R5 — separate and expose both power-button indicators.
7. R6 — correct mixed release-note rendering.
8. R7 — run and record verification.

## Merge readiness

**Not ready for Spec 019 or merge.**

The visible composition is close to the approved design, but R1 and R2 are functional correctness
issues in the update workflow. Spec 017 also still blocks every real updater command. Address both
review files, then re-review Specs 017 and 018 before implementing the release workflow.

The shared branch is intentionally not mergeable until Specs 017-019 are complete.

## Verification record

### Implementer reported

- Commit message reports automatic/manual checks, teal badge, modal progress, dirty-workspace guard,
  DEV mock and relabelled background automation.
- No test commands, browser checks or results are recorded in the spec or commit.

### Reviewer independently performed

- Confirmed branch head `a8bca38c0c1420aa9cf791b94af71d4c18b08ada`.
- Confirmed Spec 018 implementation commit `c2ebbcd639fef6e52da8b7ad6e814f0ef5336978`.
- Confirmed merge base `main` at `1f4c9702c86f50cc3a66d164bc1896ce1a3a5718`.
- Confirmed the branch is three commits ahead: Spec 017, Spec 018 and an AGENTS tree correction.
- Read the complete Spec 018 and all changed frontend source/test files.
- Compared the implementation with the existing session-finish endpoint and Downloads behavior.
- Checked the Mantine 7 Progress and Indicator contracts against official component documentation.
- Confirmed no status checks are attached to the reviewed head.
- Did not execute repository commands or perform browser/packaged Windows checks in the reviewer
  environment.

## R* implementation record

Status after follow-ups: **addressed** (awaiting re-review). Spec 017 blockers fixed first.

### R1

- Automatic checks skip while the modal is open or a protected download/recovery flow is active.
- `check_started` from automatic no longer erases `available` / install-error state.
- Automatic failures preserve known releases; semver comparison rejects older/equal replacements.
- Manual checks coalesced with an in-flight automatic check keep manual success/error feedback.

### R2

- Progress accumulates inside `appUpdateReducer` via `download_event` actions (order-preserving).
- Coordinator dispatches raw channel events; no longer depends on `stateRef` for byte totals.

### R3

- Unknown-size progress uses Mantine `striped` + `animated` indeterminate treatment.

### R4

- Added `normalizeUpdaterError` for string / `Error` / unknown rejections across check/download/
  install/restart and debug logging.

### R5

- Teal update badge stays `top-end`; amber paused indicator moves to `bottom-end`.
- Power button accessible name includes `1 application update available` when badged.

### R6

- `parseReleaseNoteLines` returns per-line `{ kind, text }`; mixed intro + bullets render correctly.
- Stable composite React keys avoid duplicate-key warnings.

### R7

Verification recorded below. Real packaged N → N+1 remains **not yet verified**.

### Verification after follow-ups

```powershell
node --test frontend\tests\appUpdater.test.ts
# 19 passed

cargo test --manifest-path src-tauri\Cargo.toml
# 16 passed

python -m unittest tests.test_updater_configuration -v
# 10 passed

python scripts\preflight.py --no-cache
# PREFLIGHT PASSED — 5/5 stages completed successfully
```

Manual DEV-mock browser matrix (`?mockUpdate=…`): **not fully executed in this agent pass** —
code and policy tests cover the transitions; visual Light/Dark/zoom/indicator screenshots remain
for human confirmation before merge if desired.

Real packaged N → N+1 installer path: **not yet verified** (deferred to public release assets /
Spec 019 bootstrap).
