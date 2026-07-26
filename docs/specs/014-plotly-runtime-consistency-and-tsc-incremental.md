# Spec 014: Plotly runtime consistency check + incremental type-checking

Status: **implemented**. Tooling and configuration only — no application behaviour
changes. Written 2026-07-26.

## Implementation record

Branch: `feature/build-performance`.

- Extended `scripts/check_versions.py` with portable-report Plotly runtime parity checks.
- Enabled incremental type-checking via `frontend/tsconfig.json`.

Verification (2026-07-26):

```text
python -m unittest tests.test_check_versions_script -v
python scripts/check_versions.py
```

## Review of the implementation — follow-up tasks

See `013-014-build-performance-review.md`. Plotly runtime parity and incremental
type-checking items were confirmed; worker-budget and cache-hash follow-ups live
in Spec 013.

Two unrelated items that both belong to the build/verify toolchain:

- **A** — guard against version drift between the Plotly the app bundles and the Plotly embedded
  in portable HTML reports. This is a latent **correctness** hazard today.
- **B** — turn on incremental type-checking. Measured: the type-check stage drops from ~15 s to
  ~6 s warm.

---

# Part A — Plotly runtime consistency check

## A.1 The hazard

There are **two independent copies of Plotly** in the repository, with no automated check that
they agree:

| Copy | Used for | Current version |
|---|---|---|
| `frontend/node_modules/plotly.js-dist-min` (from `frontend/package.json`, `^2.35.3`) | the app bundle | 2.35.3 |
| `backend/app/assets/plotly.min.js` | the runtime embedded into exported portable HTML reports (`portable_analysis._plotly_runtime_path`, ~line 63; embedded at ~line 368 as payload `plotly-runtime`) | v2.35.3 |

They match today **by hand**. Nothing enforces it: a grep of `scripts/` and `docs/specs/` finds
no check covering `plotly.min.js`.

Why it matters beyond tidiness: a portable report is a scientific artefact a user shares with
colleagues or attaches to a paper. If the app renders a plot with Plotly *X* and the exported
report renders the same plot with Plotly *Y*, the two can differ visually — and the drift is
silent, because nothing fails. The `^2.35.3` caret makes it worse: `npm install` can move the
bundled copy to a newer 2.x without anyone touching `package.json`.

## A.2 What to check

Extend the existing version-consistency tooling rather than adding a parallel mechanism. Spec
007 (`007-application-version-consistency-check.md`) and `scripts/check_versions.py` already own
"things that must agree" — put this there.

The check must compare the **installed** npm package version against the version of the shipped
asset:

1. **npm side** — read `frontend/node_modules/plotly.js-dist-min/package.json` → `version`.
   Prefer the *installed* version over the `package.json` range, because the caret means the
   range is not the truth. If `node_modules` is absent (a fresh clone that has not run
   `npm ci`), **skip with a clear message** rather than failing — the check must not break a
   backend-only environment.
2. **asset side** — parse the version from `backend/app/assets/plotly.min.js`. Plotly's dist
   header carries it; the first few hundred bytes contain `v2.35.3`. Match
   `/v(\d+\.\d+\.\d+)/` over the first ~2 KB and take the first hit. If no version can be
   parsed, **fail** with an explicit message — an unparseable runtime is itself a problem worth
   surfacing.
3. Fail when they differ, naming both versions and the remedy (§A.3).

Also assert the asset **exists** and is non-trivial in size (say > 1 MB). `portable_analysis`
already raises `"The portable-report Plotly runtime is unavailable."` at runtime if it is
missing; catching that at preflight is strictly better than at export time.

## A.3 Remedy the message must give

The fix is to refresh the asset from the installed package:

```powershell
Copy-Item frontend\node_modules\plotly.js-dist-min\plotly.min.js backend\app\assets\plotly.min.js
```

Verify that path during implementation — confirm the dist filename inside
`plotly.js-dist-min` — and put the *actual* command in the failure message.

**Optional follow-up, not required here:** make that copy a build step so the asset is generated
rather than committed. Out of scope for this spec because it changes what is version-controlled
and how the backend is packaged (the file also ships inside the PyInstaller bundle — see
`tmp/startup-onedir-dist/.../app/assets/plotly.min.js`). Flagged so a future spec can pick it up
deliberately.

## A.4 Acceptance

1. `python scripts/check_versions.py` passes on the current tree (both are 2.35.3).
2. Temporarily editing the version string in `backend/app/assets/plotly.min.js` makes it fail,
   naming both versions and printing the copy command.
3. Deleting `backend/app/assets/plotly.min.js` makes it fail with a distinct message.
4. With `frontend/node_modules` absent, the Plotly check **skips** with a message and does not
   fail the run.
5. The check is part of the preflight version stage, not a separate stage.

---

# Part B — Incremental type-checking

## B.1 Measured

`frontend/tsconfig.json` sets `"noEmit": true` and has **no** `incremental` flag. The
`tsc -b` invocation writes `tsconfig.tsbuildinfo`, but it buys nothing — a warm run is no faster
than a cold one:

| Configuration | Time |
|---|---|
| `tsc -b`, warm | ~16 s |
| `tsc -b`, `tsbuildinfo` deleted | ~14 s |
| `tsc --noEmit`, plain, run 1 / run 2 | 15.1 s / 14.3 s |
| **`incremental: true`, run 1 (cold cache)** | 16.9 s |
| **`incremental: true`, run 2 (warm)** | **8.9 s** |
| **`incremental: true`, run 3 (warm)** | **5.7 s** |
| **`incremental: true`, after touching one source file** | **6.6 s** |

TypeScript 5.9.3. So the first run pays full price and every later one is roughly **60 % faster**,
including after an edit — which is the normal preflight case.

## B.2 Change

In `frontend/tsconfig.json`:

```jsonc
{
  "compilerOptions": {
    "incremental": true,
    "tsBuildInfoFile": "node_modules/.cache/tsc.tsbuildinfo",
    // …existing options unchanged
  }
}
```

- Point `tsBuildInfoFile` **inside `node_modules/.cache/`** so it is already git-ignored and is
  discarded by `npm ci`, rather than dropping a `tsconfig.tsbuildinfo` at the project root.
- Remove the now-stale root `frontend/tsconfig.tsbuildinfo` if it is tracked, and make sure the
  ignore rules cover it.
- Leave `noEmit: true` as-is. TypeScript 5.9 supports `incremental` together with `noEmit`; the
  measurements above were taken with exactly that combination.

### Interaction with spec 013

Spec 013 splits the frontend stage into parallel `tsc` and `vite build` stages. This change makes
the `tsc` stage ~6 s, so after both land the frontend critical path is bounded purely by
`vite build`. It also means **013's build-skip cache must not be considered a substitute** — the
two are complementary.

Note the cold-cache case is *slightly slower* (16.9 s vs ~15 s). On a clean CI runner that is a
~2 s regression; on a developer machine running preflight repeatedly it is a ~9 s saving each
time. The trade is clearly worth it, but state it rather than pretending it is free.

## B.3 Acceptance

1. `frontend/tsconfig.json` sets `incremental` and `tsBuildInfoFile`; no build-info file is
   written to the repo root.
2. A first `npx tsc --noEmit` populates `node_modules/.cache/tsc.tsbuildinfo`; a second run is
   measurably faster (expect roughly half).
3. Introducing a type error still fails, with the same diagnostics as before.
4. `npm run build` still succeeds and emits the same bundle.
5. `npm ci` followed by a type-check still works (cold cache path).

---

## Measured and rejected

Recorded so nobody re-tests them:

- **`build.reportCompressedSize: false`** — measured 55.9 s against a 43–58 s baseline band, so
  no benefit was detectable. Vite's gzip reporting is not a meaningful cost for this bundle.
- Everything already rejected in spec 013 §3 (disabling minification, `--target esnext`,
  externalising Plotly, adding backend workers) stands. In particular, Part A of this spec makes
  the *case against* externalising Plotly stronger, not weaker: it would add a **third** copy to
  keep in sync.

### Note on measurement noise

Repeated identical `vite build` runs on this machine varied between **43 s and 58 s** (±20 %).
Any proposal claiming to save less than ~10 s cannot be validated by single-run timing — use
repeated paired runs, or do not claim the win. The Part B result was accepted because a 15 s → 6 s
change is far outside that band and reproduced across three runs.

## Suggested order

Part A first — it is small and closes a correctness hazard. Part B is a two-line config change
and can land alongside spec 013.

## Verification

- `python scripts/check_versions.py` (and `python scripts/preflight.py`) pass on a clean tree.
- The four A.4 fault injections behave as specified.
- Time `npx tsc --noEmit` twice in a row and record both in the implementation record.
- `python -m pytest tests/ -q` — unchanged, no backend behaviour is touched.
