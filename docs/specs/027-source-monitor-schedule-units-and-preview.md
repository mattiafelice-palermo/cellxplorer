# 027 — Source monitor: weekly schedules, sub-minute retry units, and a schedule preview

**Status:** Implemented
**Branch:** `feature/source-monitor-schedule-units`
**Scope:** backend (`services/source_monitor.py`, `routers/settings.py`, `routers/library.py`)
+ frontend (`api.ts`, `SettingsPage.tsx`) + tests

## What already exists (do not rebuild)

The request was phrased as "add a second modality", but **both modalities already ship**. The
source monitor supports:

- `schedule_mode: "interval"` — every N minutes / hours / days (`interval_value`, `interval_unit`);
- `schedule_mode: "daily"` — every N **days** at `HH:MM` (`daily_every_days`, `daily_time`);
- retries — `retry_count` attempts spaced `retry_delay_minutes` apart;
- a runtime cap so retries never run past the next scheduled check:
  `start_source_check_job(..., retry_deadline_at=following_scheduled_run(config, next_run))`,
  enforced in `_run_deferred_source_retries` (`retries_stopped="next_scheduled_check"`).

`calculate_next_run` and `following_scheduled_run` in `services/source_monitor.py` are the two
schedule functions; `routers/settings.py::update_source_monitor_settings` validates; the UI is
the "Source monitoring" card in `SettingsPage.tsx`.

So this spec is **three deltas plus one addition**, not a new feature.

## Locked design decisions

1. **No months.** Calendar-month arithmetic cannot be expressed as a `timedelta` and drags in
   end-of-month clamping ("the 31st" in February). For a source-file freshness check a monthly
   cadence is too slow to be useful. Days and weeks only. Do not add months without a new spec.
2. **Config keys are renamed, and old configs are upgraded on read.** `load_config` merges
   `{**DEFAULT_CONFIG, **saved}`, so simply adding new keys next to `daily_every_days` /
   `retry_delay_minutes` would leave a saved schedule reading from the *old* key while the code
   reads the new one — the user's setting would silently revert to the default. An explicit
   `_upgrade_config` step maps legacy keys forward. **Legacy keys must keep working for at least
   one release**; there is no migration of the stored JSON, only translation on read.
3. **Retry delay has a 10-second floor.** Seconds-level retries are the point of the unit change
   (a file being written finishes in seconds, not minutes), but a 1-second retry against a
   network share is an accidental denial of service on the user's own file server.
4. **The frequency cap is validated, not silently truncated.** The runtime deadline stays as the
   backstop, but a configuration whose retries cannot possibly finish before the next scheduled
   check is now rejected at save time with an explanatory message. Silently accepting a schedule
   and then not honouring it is worse than refusing it.
5. **The preview endpoint computes on the server.** Reimplementing `calculate_next_run` in
   TypeScript would create two schedule implementations that drift. The UI asks the backend.

## Data shape

`DEFAULT_CONFIG` (`services/source_monitor.py`) after this spec:

```python
{
    "enabled": False,
    "schedule_mode": "interval",          # "interval" | "scheduled"
    "interval_value": 6,
    "interval_unit": "hours",             # minutes | hours | days
    "scheduled_every_value": 1,           # was daily_every_days
    "scheduled_every_unit": "days",       # NEW — days | weeks
    "daily_time": "02:00",
    "auto_update": False,
    "scan_batch_size": 100,
    "stability_value": 5,
    "stability_unit": "seconds",          # seconds | minutes
    "retry_count": 3,
    "retry_delay_value": 5,               # was retry_delay_minutes
    "retry_delay_unit": "minutes",        # NEW — seconds | minutes | hours
}
```

`schedule_mode` keeps accepting the legacy value `"daily"` as a synonym for `"scheduled"`; the
mode is no longer necessarily daily, so the stored/emitted value becomes `"scheduled"`.

## Tasks

### T1 — Config keys, upgrade path, and unit helpers

**File:** `backend/app/services/source_monitor.py`

Add to `load_config` an `_upgrade_config(saved)` step applied **before** the
`{**DEFAULT_CONFIG, **saved}` merge:

| Legacy key / value | Upgraded to |
|---|---|
| `daily_every_days: N` | `scheduled_every_value: N`, `scheduled_every_unit: "days"` |
| `retry_delay_minutes: N` | `retry_delay_value: N`, `retry_delay_unit: "minutes"` |
| `schedule_mode: "daily"` | `schedule_mode: "scheduled"` |

An upgrade must not clobber a new-style key that is already present.

New helpers:

```python
def scheduled_step_days(config) -> int      # value × (7 if unit == "weeks" else 1), min 1
def retry_delay_seconds(config) -> int      # value × {seconds: 1, minutes: 60, hours: 3600}
def retry_span_seconds(config) -> float     # retry_count × retry_delay_seconds
def schedule_period_seconds(config) -> float  # interval delta, or scheduled_step_days × 86400
def is_scheduled_mode(config) -> bool       # accepts "scheduled" and legacy "daily"
```

`calculate_next_run` and `following_scheduled_run` use `scheduled_step_days(...)` in place of
`int(config.get("daily_every_days", 1))`, and `is_scheduled_mode(...)` in place of the literal
`== "daily"` / `!= "daily"` comparisons.

**Acceptance:**
- A config saved before this spec (`{"daily_every_days": 3, "schedule_mode": "daily",
  "retry_delay_minutes": 15}`) loads as every 3 **days**, `"scheduled"`, 15-minute retries.
- `scheduled_every_unit: "weeks"` with value 2 advances `calculate_next_run` by 14 days.
- `retry_delay_seconds` returns 30 for `{value: 30, unit: "seconds"}` and 7200 for
  `{value: 2, unit: "hours"}`.

### T2 — Plumb retry delay in seconds

**Files:** `backend/app/services/source_monitor.py`, `backend/app/routers/library.py`

`_run_deferred_source_retries` already computes `delay_seconds = retry_delay_minutes * 60`.
Replace the `retry_delay_minutes: int` parameter with `retry_delay_seconds: int` in
`_run_deferred_source_retries`, `_run_source_check_job` and `start_source_check_job`, and pass
`source_monitor.retry_delay_seconds(config)` from the monitor loop. The job snapshot key
`retry_delay_minutes` becomes `retry_delay_seconds`.

The progress label `"… in {retry_delay_minutes} min"` must become a humanised duration
(`"in 30 s"` / `"in 5 min"` / `"in 2 h"`) — a sub-minute retry reported as "in 0 min" is a bug
the user would see in the background-jobs list.

**Acceptance:** a monitor run with `{retry_delay_value: 30, retry_delay_unit: "seconds"}` sleeps
30 s between attempts and describes itself as "in 30 s".

### T3 — Validate the schedule, including the frequency cap

**File:** `backend/app/routers/settings.py`

`SourceMonitoringSettings` gains `scheduled_every_value`, `scheduled_every_unit`,
`retry_delay_value`, `retry_delay_unit`; `schedule_mode` becomes
`Literal["interval", "scheduled"]`; `daily_every_days` and `retry_delay_minutes` are removed
from the model (the *stored config* still reads them via T1's upgrade, but the API surface moves
on in one step).

Validation rules, each with its own message:

| Rule | Bound |
|---|---|
| `scheduled_every_value` | 1–365 days-equivalent, i.e. 1–52 when the unit is weeks |
| `retry_delay_value` | resolves to **≥ 10 s** and ≤ 24 h |
| `retry_count` | 2–10 (unchanged) |
| retry span vs frequency | `retry_count × retry_delay_seconds` **<** `schedule_period_seconds` |

The last rule is the user's "not exceeding the main frequency check". Message must name both
numbers, e.g. *"3 retries every 30 min need 1 h 30 min, which does not fit inside a 1 h check
interval. Reduce the retries or the delay, or check less often."*

**Acceptance:** saving 10 retries × 1 h against a 6 h interval returns 422 and the stored config
is unchanged; 3 × 5 min against 6 h saves normally.

### T4 — Schedule preview endpoint

**File:** `backend/app/routers/settings.py`

```
POST /api/source-monitor/schedule-preview  →  {"runs": ["<iso>", "<iso>", "<iso>"]}
```

Takes the same `SourceMonitoringSettings` body as the PUT. It **does not write anything** —
POST only because it needs a body, since the point is previewing an *unsaved* form. It runs the
identical validation as T3, so an invalid form surfaces its error here before the user saves.

Returns the next three run times: `calculate_next_run(config)` then two applications of
`following_scheduled_run`.

**Acceptance:** interval mode 6 h returns three times 6 h apart; scheduled mode every 2 weeks at
02:00 returns three 02:00 local times 14 days apart; an over-long retry span returns 422.

### T5 — Settings UI

**File:** `frontend/src/pages/SettingsPage.tsx`, types in `frontend/src/api.ts`

Inherits [`../agent-knowledge/visual-style-guide.md`](../agent-knowledge/visual-style-guide.md).

- The scheduled branch gains a unit `Select` (Days / Weeks) beside the existing count input,
  laid out like the interval branch's existing value+unit pair — reuse that geometry, do not
  invent a new one.
- The retry delay gains a unit `Select` (Seconds / Minutes / Hours), same treatment.
- A **"Next checks"** line showing the three previewed times, placed **below the retry
  controls** rather than immediately under the schedule ones: the preview also reports the
  retry-span validation error, and a message about retries rendered above the retry inputs
  reads as a non sequitur.
  formatted in the user's locale. Debounce the preview request (~400 ms) so typing in a number
  input does not fire a request per keystroke.
- A 422 from the preview renders inline as the validation message — this is how the user learns
  the retry span does not fit, *before* pressing Save.
- Loading and failure states: while the preview is in flight keep the previous values visible
  rather than blanking the line; if the request fails outright (not 422), hide the line rather
  than showing a stale-but-wrong schedule.

**Acceptance:** switching Days → Weeks updates the preview to 7× spacing; setting an impossible
retry span shows the message inline and Save reports the same error.

### T6 — Tests

**File:** `tests/test_source_monitor.py`

- legacy config upgrade (all three mappings, and that a new-style key already present wins);
- `scheduled_every_unit: "weeks"` advances `calculate_next_run` / `following_scheduled_run` by
  `7 × value` days;
- `retry_delay_seconds` for each unit;
- the frequency-cap validator: one rejecting case, one passing case at the boundary;
- the preview endpoint returns three increasing times for both modes.

## Implementation order

T1 → T6 (schedule tests first, they pin the upgrade) → T2 → T3 → T4 → T5.

## Verification

- `python -m unittest tests.test_source_monitor tests.test_settings`
- `npx tsc --noEmit` and `npx vite build` — `frontend/src/**` changed.
- Manual: set a 2-week schedule and confirm the preview shows three 02:00 dates 14 days apart.

## Known pre-existing issue (out of scope)

`calculate_next_run` resolves `daily_time` through `now.astimezone()`, i.e. local time. On a DST
transition night a 02:00 schedule can be skipped or run twice. This predates the spec and is not
addressed here; fixing it needs a zoneinfo-aware schedule and its own spec.
