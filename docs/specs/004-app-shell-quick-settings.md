# Spec 004: app shell — right-click policy, quick-settings menu, dark mode

Status: **implemented**. Frontend + a small Rust command + a small backend endpoint.
Written 2026-07-25.

Makes the app feel like a desktop application rather than a web page, and puts the four
utilities a user reaches for most behind one control in the top-right strip.

Three parts:

- **A** — suppress the browser context menu except where a right-click means something.
- **B** — a split "quick settings" control next to Activity / Downloads / Debug, with:
  reload interface, restart CellXplorer, theme, and pause automatic updates.
- **C** — dark mode, scoped to the app chrome. **Plots stay light** (decision locked, §C.1).

Dark mode lives here rather than in its own spec because the theme control is one of the four
menu items; splitting them would leave both specs incomplete.

---

## Part A — Right-click policy

### A.1 Current behaviour

Right-clicking anywhere shows the webview's own menu (Reload / Back / Inspect …), which reads
as "this is a web page". The app has exactly **four** custom context menus, all on Projects
tree rows — grep `onContextMenu` in `frontend/src/pages/ProjectsPage.tsx` (~lines 1394, 1517,
1576, 1643), all routing to `handleContextMenu`.

### A.2 Target

Suppress the native menu **by default**, and allow it only where the platform menu is genuinely
useful or where the app supplies its own:

| Target | Native menu | Why |
|---|---|---|
| `input`, `textarea`, `[contenteditable]` | **allowed** | cut / copy / paste is expected in text fields |
| Element with `data-native-menu="true"` (or inside one) | **allowed** | escape hatch |
| Anything with an app context menu (Projects rows) | suppressed (the app's own menu opens) | already handled by React |
| Everything else | **suppressed** | plots, tables, buttons, empty space |

### A.3 Implementation

One listener registered once in `frontend/src/App.tsx` (or a tiny `useNativeContextMenuPolicy`
hook):

```ts
useEffect(() => {
  const onContextMenu = (event: MouseEvent) => {
    if (import.meta.env.DEV) return;                  // keep Inspect Element in dev
    const el = event.target as HTMLElement | null;
    if (el?.closest("input, textarea, [contenteditable=''], [contenteditable='true'], [data-native-menu='true']")) {
      return;
    }
    event.preventDefault();
  };
  document.addEventListener("contextmenu", onContextMenu);
  return () => document.removeEventListener("contextmenu", onContextMenu);
}, []);
```

Notes:
- Register on `document` **without** capture, so React's own `onContextMenu` handlers have
  already run and opened their menu. Calling `preventDefault()` afterwards is harmless (those
  handlers already call it themselves).
- Do **not** disable text selection (`user-select`) — reading values off a table is a normal
  thing to do in this app.

### A.4 Acceptance

1. Right-click on a plot, a table row, the sidebar, or empty space → **no** browser menu.
2. Right-click inside any text input or textarea → normal cut/copy/paste menu.
3. Right-click a Projects tree row → the app's existing menu, unchanged.
4. In a `npm run dev` build, right-click still offers Inspect Element.

---

## Part B — Quick-settings control

### B.1 Placement and shape

In the top-right strip beside **Activity**, **Downloads**, **Debug** (`frontend/src/App.tsx`,
around the `IconActivity` / `DownloadsButton` / debug group, ~line 484).

A **split-looking control**: a gear icon plus a downward chevron, styled to match the existing
strip (same size and teal treatment as Activity / Downloads / Debug).

**The whole control opens the menu** — the icon half performs no action of its own. A split
button whose body fired "Reload interface" would make an accidental click destructive (it can
discard unsaved plot state), and none of the four items is a safe enough default to earn a
one-click target. The chevron is there to signal "this opens something", not to separate two
behaviours.

The trigger shows a **state dot** when anything is non-default:
- automation paused → amber dot
- theme manually overridden (not `auto`) → no dot (that is a normal preference, not a warning)

### B.2 Menu contents

```
┌────────────────────────────────────┐
│ ⟳  Reload interface                │
│ ⏻  Restart CellXplorer             │
├────────────────────────────────────┤
│ Appearance                         │
│  [ Auto | Light | Dark ]           │   ← SegmentedControl
├────────────────────────────────────┤
│ Automatic updates                  │
│  ● Running                         │   ← or "Paused · 1 h 42 m left"
│  Pause for  [30 min][2 h][8 h][24 h]│
│  Resume now                        │   ← only while paused
└────────────────────────────────────┘
```

### B.3 Reload interface

`window.location.reload()`. Clears a wedged UI while leaving the backend and its warm caches
alone. This is the correct answer most of the time and must be listed **first**.

Guard: if any analysis workspace is dirty, confirm before reloading. The helper already exists —
`hasDirtyAnalysisWorkspaceEditors()` in `frontend/src/analysisWorkspace.ts`. Show a
`modals.openConfirmModal` warning that unsaved plot changes will be lost.

### B.4 Restart CellXplorer

Full relaunch, including the Python backend.

Verified against the current Rust source — this is genuinely small:

- Tauri v2's `AppHandle` exposes `restart()`, so **no new plugin is needed**. Add
  `#[tauri::command] fn restart_app(app: tauri::AppHandle)` beside the existing **`quit_app`**
  command and register it in the same `invoke_handler` list (which already carries 11 commands:
  `backend_api_base`, `quit_app`, `open_download`, …).
- **No capability entry is required.** `src-tauri/capabilities/default.json` gates core and
  plugin permissions; commands the app defines itself are not permission-gated in Tauri v2, as
  the eleven existing commands demonstrate.
- **The sidecar helper already exists.** `fn stop_backend(app: &AppHandle)` in
  `src-tauri/src/` (~line 125) terminates the Python process tree via `taskkill`. `restart_app`
  must call it **before** `app.restart()`; otherwise the old backend keeps port 8642 and the
  relaunched instance fails to bind. Do not assume the child dies with the parent.
- Same dirty-workspace confirmation as B.3, with stronger wording.
- In a browser dev session (no Tauri), hide the item or fall back to `Reload interface`;
  detect with the usual `"__TAURI__" in window` guard used elsewhere.

### B.5 Appearance

`SegmentedControl` with **Auto / Light / Dark**, bound to Mantine's
`useMantineColorScheme().setColorScheme(...)`. Mantine persists the choice itself; `auto`
follows the OS. See Part C for what makes dark actually work.

### B.6 Pause automatic updates

The app has **two** independent automatic systems, and the pause must stop **both**:

1. **Source monitor** — `backend/app/services/source_monitor.py`, a background thread that
   rescans registered source files on a schedule (`source_monitor_config` in `app_settings`:
   `enabled`, `schedule_mode`, interval, and `auto_update`, which re-parses changed files).
   Its loop is `_run_scheduler()`.
2. **Cache warmup** — `frontend/src/components/CacheWarmupCoordinator.tsx`, gated by
   `warmup_enabled` from `GET /api/cache/settings`; it pre-renders saved-plot thumbnails.

#### Storage

A single **backend** setting, so the pause survives a UI reload *and* an app restart (an
in-memory or `localStorage` pause would be defeated by the very Restart button next to it):

- key `automation_paused_until` in the existing `app_settings` table (`AppSetting`, key/value —
  no migration needed), value = ISO-8601 UTC timestamp, or absent/empty when not paused.

#### Endpoints

Add a small router (e.g. `backend/app/routers/automation.py`, prefix `/api`):

- `GET /api/automation/pause` → `{ "paused": bool, "paused_until": str | null, "seconds_remaining": int | null }`
- `POST /api/automation/pause` body `{ "minutes": int | null }` — `minutes > 0` pauses for that
  long from now; `null` or `0` resumes immediately. Validate `1 ≤ minutes ≤ 7 * 24 * 60`.

Expiry is implicit: `paused` is `now < paused_until`. Never rely on a timer to clear it.

#### Enforcement

- **Source monitor:** in `_run_scheduler()`, right after `config = load_config(db)`, if paused
  then set `LAST_STATUS_KEY` to `"paused"`, sleep the normal 30 s tick, and `continue` — do
  **not** advance `NEXT_RUN_KEY`. A run that was already in flight is allowed to finish; pause
  prevents *starting* work.
- **Cache warmup:** `CacheWarmupCoordinator` already takes an `enabled` prop
  (`frontend/src/App.tsx` ~line 446). Poll `GET /api/automation/pause` (60 s, plus an immediate
  refetch after the menu changes it) and AND it into that gate.
- **Do not** touch manual actions. Explicit user-triggered source checks, imports, recomputes
  and exports must keep working while paused; this pauses *background* work only.

#### Surfacing

- The menu shows live state: `Running` (teal dot) or `Paused · 1 h 42 m left` (amber dot) with
  **Resume now**.
- The Settings page's source-monitor section must show the same paused state so the two do not
  disagree — a short amber note with a Resume action is enough.

### B.7 Acceptance

1. Reload interface reloads the window; with a dirty analysis open it confirms first.
2. Restart relaunches the app **and** the backend; the app is usable afterwards with no port
   conflict and no orphaned Python process.
3. Appearance switches immediately and persists across a restart; `Auto` follows the OS.
4. Pausing for 2 h stops scheduled source checks and warmup; the trigger shows an amber dot and
   the menu counts down. A manual source check still runs. After the deadline (or Resume now)
   background work resumes without a restart.
5. The pause survives both Reload interface and Restart CellXplorer.

---

## Part C — Dark mode (chrome only)

### C.1 Locked decision: plots stay light

Plot surfaces do **not** follow the UI theme. Two reasons:

1. **Exports are publication artefacts.** PNG/SVG/PDF output must be white regardless of the
   UI, so plot theming has to be decoupled from chrome theming anyway.
2. **Plot colours are persisted user data.** `plot_bgcolor` and `paper_bgcolor` are fields of
   `PlotStyle`, stored inside `spec.presentation.plot_styles[tab]` — saved per analysis *and*
   per saved plot (`frontend/src/pages/AnalysisPage.tsx`, `DEFAULT_PLOT_STYLE` ~line 651).
   Every existing analysis has `#ffffff` baked in. Following the theme would mean either a
   spec migration or a render-time override, for no scientific benefit.

Users who want a dark plot already can: the per-analysis style panel exposes both colours, and
that choice correctly persists into exports.

So: plot **cards** (the `Paper` around them, headers, sidebars, style panels) are themed; the
plotting surface itself is not.

### C.2 Starting position — better than it looks

| Factor | Status |
|---|---|
| Mantine **7.17** | full CSS-variable theming, `useMantineColorScheme`, built-in dark palette |
| `frontend/src/app.css` | **zero** hardcoded colours — already all `var(--mantine-color-*)` |
| `MantineProvider` | already configured in `main.tsx` (~line 46), `defaultColorScheme="light"` |
| Hardcoded hex in `src/**/*.tsx` | 104 occurrences / 70 distinct — but only **9** are chrome surfaces |

The other ~95 are plot internals (`gridcolor`, `zerolinecolor`, frame and marker colours) that
belong to the plot style system and are **out of scope** by §C.1.

### C.3 Work

1. `main.tsx`: `defaultColorScheme="auto"`, and confirm `<ColorSchemeScript />` is present in
   `index.html` so the first paint does not flash the wrong theme.
2. Replace the **9 chrome-surface hexes** with Mantine variables or
   `light-dark(<light>, <dark>)`. They are the `#ffffff` / `#fcfcfd` / `#f8f9fa` / `#f1f3f5`
   style backgrounds on `Paper`/`Box` wrappers — grep
   `#(fff|ffffff|fcfcfd|f8f9fa|f1f3f5)` under `frontend/src` and fix each. Leave any hex that
   is passed into a Plotly layout or into `PlotStyle`.
3. Audit hardcoded greys used as text/borders in components written recently
   (`FolderTree.tsx`, `PlaceInFoldersModal.tsx` status pills, `RecognitionProgress.tsx`) —
   several use literal `#F1F3F5` / `#495057` and will need `light-dark(...)`.
4. Walk every page in dark: Projects, Library, Inbox, Analyses index, Analysis (all tabs),
   Settings, plus the modals (place-in-folders, protocol segment editor, protocol structure
   viewer, export preview) and the Activity / Downloads / Debug popovers.

### C.4 Acceptance

1. Auto / Light / Dark all render every page with no white-on-white or black-on-black patches.
2. Plot surfaces remain white in **both** themes, and an export produced in dark mode is
   byte-comparable in appearance to one produced in light mode.
3. The choice persists across restart; `Auto` tracks an OS theme change without a reload.
4. No regression to the plot style panel: per-analysis background colours still apply and still
   export.

---

## Suggested implementation order

1. **A** (self-contained, immediately makes the app feel native).
2. **B.3** + **B.6** (reload + pause; pure frontend/backend, no Rust).
3. **B.4** (restart — the Rust command and the sidecar kill; test the port-collision case
   explicitly).
4. **C**, then **B.5** last, since the theme control is only worth exposing once dark mode
   actually looks right.

## Verification

- `cd frontend && npx tsc --noEmit && npx vite build`
- `python -m pytest tests/` — add coverage for the pause endpoint and for
  `_run_scheduler` skipping while paused (the monitor is already exercised by
  `tests/test_source_monitor.py`; extend it rather than starting a new file).
- Manual: the five B.7 checks, and the C.4 dark-mode walk.
- Tauri: `restart_app` cannot be tested from a browser dev server — verify in a real
  `npm run tauri dev` (or a packaged build) and confirm with Task Manager that no orphaned
  Python process remains.

---

# Review of the implementation — follow-up tasks

Reviewed 2026-07-25. **Overall: accepted.** All three parts are implemented as specified, and
the one invariant that mattered most — plots stay light — is intact. One hazard the spec did
**not** anticipate needs a manual check before this ships (R1).

## What the review verified

`tsc` / `vite build` / the full suite were run by the implementer and taken as given. The
reviewer ran only:

| Check | Result |
|---|---|
| `pytest tests/test_automation.py tests/test_source_monitor.py` | **11 passed** |

Confirmed by reading the code — do not re-litigate:

- **Part A** matches §A.3 exactly: `document` listener without capture, dev-build escape,
  and the `input, textarea, [contenteditable], [data-native-menu]` allow-list. Text selection
  untouched.
- **B.1** the whole control opens the menu — the `Button` carries no `onClick` of its own, so
  there is no accidental one-click action. Amber `Indicator` shows only while paused.
- **B.3/B.4** both route through `hasDirtyAnalysisWorkspaceEditors()` before acting.
- **B.4** `restart_app` calls `stop_backend(&app)` **before** `app.restart()`, and
  `stop_backend` does `taskkill /F /T` on the process tree, which is what handles the
  PyInstaller onefile re-exec. Registered in the existing `invoke_handler`; hidden when not
  running under Tauri.
- **B.6** is faithful throughout: `automation_paused_until` in `app_settings`, expiry implicit
  (`until <= now`) with no timer anywhere, clamped server-side *and* validated in the router.
  The scheduler checks pause immediately after `load_config`, sets `LAST_STATUS_KEY="paused"`,
  and **does not advance `NEXT_RUN_KEY`**. Warmup is gated by
  `!automationPause.data?.paused`. Settings shows a matching amber alert with Resume.
- **Part C** the locked decision holds: `DEFAULT_PLOT_STYLE` still carries `#ffffff`, and there
  is **no** `colorScheme` reference anywhere in `AnalysisPage.tsx` or any `*PlotCard.tsx` —
  plots are genuinely untouched by the theme. `ColorSchemeScript` + `MantineProvider` are both
  `auto`, and `index.html` has no hardcoded colours to flash.
- Only two literal hexes remain in `.tsx` and **both are correct**: the transparency
  checkerboard behind the export preview (`AnalysisPage.tsx` ~6628) and the thumbnail canvas
  fill (~6970), which must stay white because thumbnails depict light plots.

> **Correction (added after user-supplied dark-mode screenshots).** An earlier draft of this
> review concluded from the above that "the chrome sweep is effectively complete". **That was
> wrong.** The check only grepped hex literals in `.tsx`, which structurally cannot see
> `bg="gray.0"` props, `var(--mantine-color-*-0)` values, or `.module.css` files — and those
> are where the remaining light surfaces actually live. See **R4**.

## R1. `app.restart()` may deadlock against the single-instance plugin

**Priority: high — verify before shipping. Cannot be reproduced from a browser dev server.**

`src-tauri/src/main.rs` registers `tauri_plugin_single_instance` (~line 386), whose callback
calls `show_main_window(app)` for a second launch.

Tauri v2's `AppHandle::restart()` **spawns the replacement process first and then exits the
current one**. For the duration of that overlap the old process still holds the single-instance
lock, so the sequence can be:

1. `restart_app` kills the backend (`stop_backend`) — port 8642 is now free, backend gone.
2. `app.restart()` spawns the new process.
3. The new process sees the lock still held, hands its args to the old instance
   (`show_main_window`), and **exits immediately**.
4. The old process finishes `restart()` and exits too.

Net result: **no app running and the backend already killed** — the worst possible outcome for
a button labelled "Restart". Whether it actually happens depends on how quickly the lock is
released on exit, so it may work by luck on one machine and fail on another.

**Action:** test in a packaged build (or `npm run tauri dev`) — click Restart, confirm the app
comes back **and** that Task Manager shows exactly one `cellxplorer-backend` process and no
orphan. If it fails, the fix is to not rely on `restart()`'s spawn-then-exit: have the command
exit the current process and let a short-lived detached helper (or a spawn with a small delay)
start the replacement after the lock is released.

## R2. The pause countdown can read wildly wrong for up to 30 s

**Priority: medium** (cosmetic, but it misreports the one number the feature exists to show).

`frontend/src/components/QuickSettingsMenu.tsx`:

```ts
const [nowMs, setNowMs] = useState(() => Date.now());   // set once, at mount
useEffect(() => {
  if (!menuOpen || !pause.data?.paused) return;
  const id = window.setInterval(() => setNowMs(Date.now()), 30_000);   // no immediate tick
  return () => window.clearInterval(id);
}, [menuOpen, pause.data?.paused]);
```

`secondsRemaining` is computed as `paused_until − nowMs`, but `nowMs` is only refreshed by that
interval — which fires **30 s after** the menu opens, and never while the menu is closed. So
`nowMs` is stale by the app's entire uptime on the first read.

Concrete: leave the app open for 3 h, then pause for 2 h. `paused_until` is `now + 2h`, but
`nowMs` is still the mount time, so the menu displays **"5 h 0 m left"** for a 2-hour pause,
correcting itself only at the next tick. It always over-reports, never under-reports.

**Fix:** call `setNowMs(Date.now())` at the top of the effect (before starting the interval),
and again in `setPause.onSuccess`. Alternatively derive `secondsRemaining` from the server's
`seconds_remaining` and decrement locally.

**Acceptance:** open the app, wait a few minutes, pause for 2 h — the menu reads ≈"1 h 59 m
left" immediately, not something larger.

## R3. A failed restart silently degrades into a page reload

**Priority: low.** In `restartApp`:

```ts
try { await invoke("restart_app"); } catch { window.location.reload(); }
```

The menu item only renders when `isTauriApp()` is true, so reaching `catch` means the command
genuinely failed. Reloading the interface then makes it look as though *something* happened
while the app was not restarted and the backend may already be dead (`stop_backend` runs first
inside the command). Show an error notification instead of, or in addition to, the reload.

## R4. Light surfaces survive in dark mode (Mantine numbered shades never flip)

**Priority: high** — reproduced from user screenshots across four different screens. Several
panels render near-white with light-grey text in dark mode, which makes them unreadable.

### Root cause

Mantine's **numbered** colour shades are fixed values: `gray.0` is `#f8f9fa` in *both* colour
schemes, as are `teal.0`, `--mantine-color-gray-0` and `--mantine-color-white`. Only the
**semantic** tokens respond to the scheme — `--mantine-color-body`, `--mantine-color-default`,
`--mantine-color-default-hover`, `--mantine-color-default-border`, `--mantine-color-text`,
`--mantine-color-dimmed` — plus the CSS `light-dark(…)` function.

The C.3 sweep replaced hex literals but left every numbered-shade surface untouched, so those
panels stayed light while their text switched to a light-mode-appropriate grey.

### Inventory (~33 sites)

| Pattern | Count | Where |
|---|---|---|
| `bg="gray.0"` | 15 | `SettingsPage.tsx` 1251, 1334, 1468, 1799 · `InboxPage.tsx` 785, 1450, 1460, 1578 · `AnalysisPage.tsx` 6555, 6736, 10162 · `App.tsx` 391, 407, 707 · `AnalysisDatabaseTable.tsx` 257 |
| `bg="teal.0"` | 2 | selected/highlight rows |
| `background: var(--mantine-color-*-0)` | 15 | incl. `FolderTree.module.css` (`gray-0`, `teal-0` ×2) |
| `background: var(--mantine-color-white)` | 1 | `CellDetailTabs.module.css` |
| `background: #fbfbf8` | 2 | `CellDetailTabs.module.css` (hardcoded cream) |

### Mapped to the reported screenshots

- **Settings → Source monitoring**: the white "Enable automatic checks" and "Update stable
  changed files automatically" panels → `SettingsPage.tsx` 1251 / 1334 / 1468.
- **Settings → Activity log**: white SYSTEM event cards → `SettingsPage.tsx` 1799.
- **Load cell files**: the white Name/Size/Modified header band → `InboxPage.tsx` 785.
- **Cell detail → Protocol**: washed-out step cards and barely-visible "Initial sequence" /
  "Repeated block" headings → `CellDetailTabs.module.css` (`#fbfbf8` and
  `var(--mantine-color-white)`).
- The bright highlighted row in the picker sidebar and in the folder tree → the `teal.0`
  entries and `FolderTree.module.css`.

### Fix

Use the pattern **already established in this codebase** — `PlaceInFoldersModal.tsx` (~line
455) does exactly this and works:

```ts
background: "light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))"
```

Per case:
- **Subtle raised panel** (`bg="gray.0"`): prefer the semantic token —
  `bg="var(--mantine-color-default)"` — or `light-dark(var(--mantine-color-gray-0),
  var(--mantine-color-dark-6))`. Pick one and use it everywhere; do not mix idioms.
- **Selection tint** (`teal.0`): `light-dark(var(--mantine-color-teal-0),
  var(--mantine-color-teal-9))`, keeping the teal hue in both schemes.
- **CSS modules**: same `light-dark(…)` treatment; replace the `#fbfbf8` literals outright.
- **Do not** touch the two legitimate hexes noted above (checkerboard, thumbnail canvas), nor
  anything feeding a Plotly layout or `PlotStyle` — plots stay light by §C.1.

### Acceptance

Re-walk C.4 in dark mode with these four screens explicitly on the list: Settings → Source
monitoring, Settings → Activity log, the Load cell files picker, and Cell detail → Protocol. No
panel may render near-white, and every heading and body string must stay legible against its
own surface.

### Note for future reviews

Grepping hex literals is not sufficient to audit theming in a Mantine codebase. The audit must
also cover `bg="<colour>.<0|1>"` props, `var(--mantine-color-*-0)`, `--mantine-color-white`,
and every `*.module.css`. This has been added to the review guidance in `README.md`.

## Follow-up order

R1 first — it is the only one that can leave the app unusable. **R4** next: it is the most
visible defect and touches ~33 sites across six files. R2 after (a two-line fix). R3 is
optional polish.

## Still unverified

- The **C.4 dark-mode walk** — every page and modal in dark. The sweep looks complete by grep,
  but only a real pass will catch a component whose contrast is poor rather than absent.
- **B.7 items 2 and 5** — restart behaviour and pause surviving a restart, both blocked on R1.
- Right-click behaviour in a **packaged** build (`import.meta.env.DEV` is the gate, so dev
  sessions deliberately behave differently from what users will see).

---

## R* implementation record

Implemented 2026-07-25 in follow-up order R1 → R4 → R2 → R3.

### R1 — restart vs single-instance

**Changed:** `src-tauri/src/main.rs` — `restart_app` no longer calls `AppHandle::restart()`.
It now `schedule_relaunch()` (Windows: detached PowerShell `Start-Sleep 1; Start-Process`,
non-Windows: `sh -c "sleep 1; exec …"`), marks `LifecycleState.quitting`, `stop_backend`,
then `app.exit(0)`. Schedule runs **before** `stop_backend` so a failed spawn leaves the
sidecar running. Returns `Result<(), String>` for the frontend.

**Also:** `docs/agent-knowledge/architecture.md` updated to document the lock race and the
`light-dark` chrome rule from R4.

**Ran:** `cargo check` in `src-tauri` → **OK**.

**Not done / cannot verify here:** a real packaged or `tauri dev` Restart click with Task
Manager confirmation (exactly one `cellxplorer-backend`, app comes back). That remains a
manual ship gate.

### R4 — light surfaces in dark mode

**Changed:** replaced numbered-shade chrome fills with the PlaceInFoldersModal idiom
`light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))` (panels) and
`light-dark(var(--mantine-color-teal-0), var(--mantine-color-teal-9))` (selection), plus
`light-dark(var(--mantine-color-white), …)` where `"white"` / `--mantine-color-white` /
`#fbfbf8` were used as chrome. Touched 16 files under `frontend/src` (pages + components +
`FolderTree.module.css` + `CellDetailTabs.module.css`). Left plot `#ffffff` /
checkerboard / thumbnail canvas fill alone (§C.1).

**Ran:** `npx tsc --noEmit` → **EXIT 0**; `npx vite build` → **EXIT 0**.

**Not done:** full C.4 dark-mode walk in a browser (Settings monitoring/activity, Inbox
picker, Cell detail → Protocol called out by the review). Contrast was fixed by token
choice; visual confirmation still needs eyes.

### R2 — pause countdown stale `nowMs`

**Changed:** `QuickSettingsMenu.tsx` — `setNowMs(Date.now())` at the top of the open/paused
effect (before the 30 s interval) and again in `setPause.onSuccess`.

**Ran:** covered by the frontend `tsc` / `vite build` above. No new unit test (pure UI
clock).

### R3 — failed restart notification

**Changed:** `QuickSettingsMenu.tsx` — removed the silent `window.location.reload()`
fallback. Failed `invoke("restart_app")` shows a red notification after 1.5 s (so a
successful process exit that drops IPC does not flash an error). If the command returns
`Ok` without exiting, an immediate “Restart did not complete” notification is shown.

**Ran:** frontend build as above. Restart failure path not exercised (needs Tauri).
