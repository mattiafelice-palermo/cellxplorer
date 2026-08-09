# Spec 005: background warmup queue deadlocks on a failed lookup

Status: **implemented** (see record at the end). Frontend-only. Written 2026-07-25.

A single failed thumbnail/artifact lookup permanently stalls the background cache-warmup queue
for the rest of the session, so saved plots stop getting thumbnails and analyses stop getting
their results pre-computed. Reported symptom: *"sometimes some analyses don't have the
thumbnail rendered, and opening one starts rendering the Plotly plot even though the machine
has been idle for a long time."*

## 1. The defect

`SavedPlotPreview`'s warmup-completion effect (`frontend/src/features/analyses/editor/artifacts/SavedPlotPreviews.tsx`) has
exactly four terminal branches:

```
generationFailed → thumbnailPairReady → preview.isError → (preview.isSuccess && traces === 0)
```

None covers a failure of the two **lookup** queries that gate everything else:

1. `thumbnail` (`lookupPlotThumbnail`) throws on anything that is not a 404 — a network blip, a
   500, the sidecar busy mid-compute or restarting. It is configured `retry: false`, so a single
   blip is fatal.
2. → `thumbnail.isSuccess === false`, so `artifact` is never `enabled`.
3. → `preview.enabled` requires `thumbnail.isSuccess && artifact.isSuccess`, so `preview` never
   runs: both `isError` and `isSuccess` stay `false`.
4. → `thumbnailPairReady` and `generationFailed` are both `false`.
5. → **no branch fires; `onWarmupComplete` is never called.**

In `CacheWarmupCoordinator` (`frontend/src/features/analyses/editor/artifacts/CacheWarmupCoordinator.tsx`),
`busy.current = true` is set before `setTask(...)` and is cleared **only** inside `finish()`.
With no completion, `busy` stays `true` and `task` stays set, so every later tick returns at:

```ts
if (busy.current || task || Date.now() - lastPoll.current < 1500) return;
```

**The queue is dead for the rest of the session** — not just for that plot, but for every
analysis behind it. An app reload clears the refs and recovers, which is why the failure looks
intermittent.

`SavedTimeCapacityPreview` (used for the `time_capacity` tab) is a **separate component with
the identical structure, the identical `retry: false`, and the identical four branches**. It
has the same defect and must be fixed too.

## 2. Why the backend needs no change

`warmup.next_task` pins `self._active` with no lease, so a task abandoned by the client stays
active. That is *correct* here:

- The client is the only worker. Once the client always calls `complete` (§3.2), `_active` is
  always released.
- If the client reloads mid-task, it polls `next` again and `next_task` returns the same
  `_active` task, so the work resumes rather than being skipped.
- Background jobs are session-only in memory, so an app restart rebuilds the queue from
  scratch (`start()` resets `_tasks`, `_next_index` and `_active`).

Adding a server-side lease would introduce a way for the same task to be handed out twice.
**Out of scope, deliberately.**

## 3. The fix

### 3.1 Extract the completion logic into one pure, testable function

The bug exists in two places because the logic was duplicated. Create
`frontend/src/features/analyses/editor/artifacts/warmupCompletion.ts` exporting a pure resolver:

```ts
export interface WarmupSignals {
  generationFailed: boolean;
  thumbnailPairReady: boolean;
  thumbnailErrored: boolean;   thumbnailError?: unknown;
  artifactErrored: boolean;    artifactError?: unknown;
  previewErrored: boolean;     previewError?: unknown;
  previewSucceeded: boolean;
  traceCount: number;
  renderedFresh: boolean;
  rebuiltThumbnail: boolean;
}

export type WarmupResolution =
  | { status: "pending" }
  | { status: "done"; error?: string; detail?: string };

export function resolveWarmup(signals: WarmupSignals): WarmupResolution;
```

Both preview components call it and act on the result. No `.tsx` logic duplication remains.

**Branch order** (order matters — a real success must win over a stale error):

1. `generationFailed` → done, error `"Thumbnail generation failed"`
2. `thumbnailPairReady` → done, no error; detail is `"Computed data and rendered thumbnail"` /
   `"Thumbnail rebuilt from cached plot"` / `"Already cached"` exactly as today
3. **`thumbnailErrored`** → done, error from the exception (**new**)
4. **`artifactErrored`** → done, error from the exception (**new**)
5. `previewErrored` → done, error from the exception
6. `previewSucceeded && traceCount === 0` → done, no error, no detail
7. otherwise → `pending`

Steps 3 and 4 are the fix; 1, 2, 5, 6 must keep their current behaviour and message strings so
Activity entries do not change for cases that already work.

### 3.2 Add a per-task watchdog in the coordinator

§3.1 closes the two known holes. The watchdog makes it **structurally impossible** for any
future unhandled state to wedge the app again — which is the property that actually matters,
given the failure mode is a silent permanent stall.

- When `task` becomes non-null, arm a `setTimeout`; clear it whenever `task` changes or the
  component unmounts.
- On expiry call `finish("Preparation timed out")`, which posts `complete`, clears `busy`, and
  lets the queue advance.
- **Timeout: 5 minutes.** Generous on purpose: a cold compute that has to re-parse several
  large sources can legitimately take minutes, and a false timeout is cheap (the plot keeps no
  prepared marker, so the next `start()` re-queues it) while a missed wedge costs the whole
  session.
- Make `finish` **idempotent** via a `finishedTaskId` ref, so a watchdog firing and a late
  renderer callback cannot both report the same task.

### 3.3 Allow one retry on the lookups

Change `retry: false` → `retry: 1` on the `thumbnail` and `artifact` queries in **both** preview
components. These are loopback calls to a sidecar that is frequently busy computing; one retry
removes most triggers. 404 is already converted to `null` before it can look like an error, so
retrying never re-requests a legitimately absent artifact.

`CachedSavedPlotPreview`'s thumbnail query keeps `retry: false` — it is display-only, never
drives a warmup task, and a failure there cannot stall anything.

## 4. Explicitly out of scope

Server-side task leases (§2); changing the idle/hidden gating, poll cadence, or queue
construction; anything about which plots get queued. This spec only guarantees that **every
task reaches a terminal state**.

## 5. Acceptance criteria

1. A failing `thumbnail` lookup completes its task with an error instead of stalling; the queue
   moves to the next task.
2. Same for a failing `artifact` lookup.
3. All four pre-existing terminal branches keep their exact behaviour and Activity strings.
4. A task that never resolves for any other reason is force-completed after 5 minutes and the
   queue continues.
5. `finish` runs at most once per task id.
6. Both `SavedPlotPreview` and `SavedTimeCapacityPreview` use the shared resolver — the logic
   exists in exactly one place.
7. Warm-cache behaviour is unchanged: an already-prepared plot still completes immediately via
   `thumbnailPairReady` with detail `"Already cached"`.

## 6. Verification

- Unit-test `resolveWarmup` in `frontend/tests/warmupCompletion.test.ts` (plain `.ts`, so it
  runs under node's type stripping). Cover every branch, the branch **order**, and — as the
  regression lock — that a thumbnail/artifact error resolves to `done`, never `pending`.
- `npx tsc --noEmit && npx vite build`.
- Existing frontend tests: expect the two known pre-existing `.tsx` type-stripping failures
  (`cellSamplePopovers`, `protocolGroups`) and no new ones.
- No backend change, so no `pytest` needed.

---

# Implementation record

Implemented 2026-07-25, same session as the spec.

## Changes

| File | Change |
|---|---|
| `frontend/src/features/analyses/editor/artifacts/warmupCompletion.ts` *(new)* | Pure `resolveWarmup(signals)` + `warmupErrorMessage(...)`. Seven ordered branches per §3.1. |
| `frontend/tests/warmupCompletion.test.ts` *(new)* | 10 tests: every branch, branch order, message fallbacks, and an exhaustive "no terminal signal stays pending" guard. |
| `frontend/src/features/analyses/editor/artifacts/SavedPlotPreviews.tsx` | Both `SavedPlotPreview` and `SavedTimeCapacityPreview` now call `resolveWarmup`. The two completion blocks were **byte-identical** — the duplication that let the bug exist twice — and are now one shared function. `retry: false` → `retry: 1` on the four warmup lookup queries (lines ~3377, ~3399, ~3748, ~3770). |
| `frontend/src/features/analyses/editor/artifacts/CacheWarmupCoordinator.tsx` | `WARMUP_TASK_TIMEOUT_MS` (5 min) watchdog re-armed per task; `finish` made idempotent via `finishedTaskId`. |

`CachedSavedPlotPreview`'s thumbnail query (line ~4042) intentionally keeps `retry: false` — it
is display-only and cannot stall a task.

## A regression caught during implementation

The first version of the idempotency guard keyed on task id alone:

```ts
if (!task || finishedTaskId.current === task.id) return;
```

That reintroduces the deadlock through a different door. If the `complete` POST itself fails —
the *same* class of transient failure this spec exists to handle — the `finally` clears local
state but the backend's `_active` stays pinned, so `next_task` hands the **same task id** back.
The guard would then block `finish` permanently and `busy` would never clear.

Fixed by clearing `finishedTaskId` at each fresh activation, in the poll's `setTask` branch. The
guard now protects only against a double report *within one activation* (watchdog racing a late
renderer callback), which is all it was ever meant to do, while a legitimate retry of the same
task id still reports.

## Verification

| Check | Result |
|---|---|
| `node --test frontend/tests/warmupCompletion.test.ts` | **10 passed** |
| `node --test frontend/tests/*.test.ts` | **96 passed, 2 failed** — the two known pre-existing `.tsx` type-stripping failures (`cellSamplePopovers`, `protocolGroups`); no new failures |
| `npx tsc --noEmit` | clean |
| `npx vite build` | success |
| `resolveWarmup` call sites | 2 — both preview components |

## Not verified at runtime

The deadlock was diagnosed statically and the fix is proven by unit tests over the resolver, but
the end-to-end path was **not** reproduced in a running app. Worth confirming in normal use:

1. Saved plots keep gaining thumbnails over a long session (previously the queue died at the
   first transient lookup failure).
2. The Activity entry for a genuinely failing plot now shows a failure and the queue **moves
   on**, rather than sitting at "Preparing …" forever.
3. Nothing regressed on the warm path: an already-prepared plot still completes instantly with
   detail "Already cached".

A cheap way to force the failure: block the
`/api/analyses/{id}/plot-artifacts/{plot}/thumbnail/lookup` request in devtools during a warmup
pass and confirm the queue advances instead of stalling.
