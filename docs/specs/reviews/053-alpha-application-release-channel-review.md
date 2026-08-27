# Parent 053 — Fully isolated Alpha application and release channel — cumulative review

**Status:** Final cumulative review clean — **externally BLOCKED**, not complete, not merge-ready
**Spec:** [`053-alpha-application-release-channel.md`](../053-alpha-application-release-channel.md)
**Children:** [053.1 review](053.1-alpha-application-identity-isolation-and-packaging-review.md) (clean),
[053.2 review](053.2-alpha-updater-release-publication-and-closure-review.md) (clean)
**Branch:** `codex/alpha-release-channel`
**Merge base:** `e396a32` — still the exact tip of `origin/main`; the branch is 0 commits behind
**Reviewed head:** `158422e` for all code and verification; `4a1aef4` adds only review/state documents

## Final conclusion

The cumulative implementation is review-clean. Both numeric children were implemented sequentially
and are review-clean (053.1 at `d1fc3e9`, 053.2 at `b8fee81`), and no implementation defect,
regression, or scope violation remains on the branch.

The workflow nevertheless ends **`BLOCKED`, not `COMPLETE`**: the disposable three-product
installed/update/uninstall Windows matrix required by Parent 053 §12 and Child 053.2 §§11–12 has
never been run, and neither agent can run it. Parent 053 §12 and 053.2 §12 forbid substituting
automated tests or unsigned local package rehearsals for that installed evidence. The blocking
dependency is external acceptance evidence, not an implementer defect.

One **documentation-closure item (D1)** remains outstanding below. It is recorded here rather than
returned as a workflow finding because the terminal state is `BLOCKED`, which requires no
outstanding implementer finding; it must be resolved before merge, at the latest when the final
review resumes.

## Concurrent review reconciliation

Two cumulative parent reviews were produced independently and near-simultaneously: this one, and a
second one committed in `41f78ec`/`fb57d39`/`4a1aef4` from another session, which also performed the
`block` transition while the reviewer held the turn. Both reached the same conclusion — cumulative
review clean, terminal state `BLOCKED` on the installed matrix — and neither contradicts the other.

This file is the merged canonical record. It preserves that document's conclusion and its
enumeration of the acceptance items that depend on installed evidence, and adds the verification
this reviewer ran at the final branch head, the programmatic locked-matrix check, the cumulative
regression audit, and D1. Per the workflow guide the reviewer owns `docs/specs/reviews/`; future
rounds record resolution here.

## Branch scope

Thirteen commits, `e396a32..4a1aef4`, 55 files of substance, +3705 / −296 through `158422e`. Both
children were implemented sequentially with a pushed review checkpoint each, and each needed exactly
one fix round:

| Commit | Role |
|---|---|
| `7e37ad4` | Spec 053 plan documents (pre-existing on branch) |
| `ff1dddf` | Reviewer workflow initialization |
| `3885dff` | 053.1 implementation |
| `4cb95c5` → `d1fc3e9` → `4deca60` | 053.1 review R1–R3 → fixes → clean |
| `52ba267` | 053.2 implementation |
| `4c28dee` → `b8fee81` → `158422e` | 053.2 review R1–R3 → fixes → clean |
| `41f78ec` → `fb57d39` → `4a1aef4` | Concurrent cumulative review and `block` transition |

## Cumulative verification run by the reviewer at `158422e`

| Gate | Result |
|---|---|
| `python scripts\preflight.py --no-cache` | **PASS** — 4/4 stages, all 157 backend/frontend modules, 119.9 s wall |
| `node --test frontend\tests\*.test.ts` (complete frontend suite) | **PASS** — 712 tests |
| `cargo test --manifest-path src-tauri\Cargo.toml` | **PASS** — 51 tests |
| `python -m unittest tests.test_app_channels tests.test_updater_configuration` | **PASS** — 34 tests |
| `python -m unittest tests.test_release_tag_script tests.test_release_workflow` | **PASS** — 103 tests |
| `python scripts\check_versions.py` | **PASS** — all declarations 0.27.0-beta.12; portable-report Plotly matches bundle |
| Programmatic check of the Parent §4 locked identity matrix against resolved configs and sources | **PASS** — 15 matrix rows, 12 shared-inheritance checks, 17 locked constants, 0 mismatches |
| Offline replay of the first-Alpha release-channel branch lifecycle | **PASS** |
| Working tree after all runs | **CLEAN** (only the user's unrelated pre-existing files) |

This satisfies every automated command in Parent 053 §11 at the final code head. `cargo check` is
accepted from the implementer's `b8fee81` handoff: no Rust source changed between that commit and
this head, and `cargo test` compiles the same crate. `4a1aef4` changes only review, state, and
coordination documents, so it cannot affect these results.

Earlier reviewer-owned evidence, recorded in the child reviews: 55 Python and 58 frontend tests plus
`tsc --noEmit` and direct Alpha `.ico` frame inspection at 053.1; 101 then 103 release/channel tests
plus the offline first-Alpha lifecycle reproduction at 053.2.

**Not run, by anyone:** the disposable installed/update/uninstall matrix, installed side-by-side
identity checks, browser/manual UI acceptance, and signed CI build-only dispatch artifacts. All are
recorded truthfully as NOT RUN in both child specs.

## Locked-decision compliance

- **§3 isolation boundary.** Alpha has its own bundle identifier, install directory and derived
  uninstall/manufacturer keys, single-instance domain, deep-link scheme, profile root, updater
  endpoint and accepted version family, frontend stamp, icon, native frame, installer color, product
  title, badge, and manifest pointer. The repository, React app, FastAPI backend, PyInstaller
  sidecar, Rust shell, NSIS template, schema, GitHub workflow, and updater signing key remain shared
  exactly as the parent intends. No parallel tree was created; the only new configuration file is
  `src-tauri/tauri.alpha.conf.json`.
- **§4 identity matrix.** Verified programmatically against the deep-merged Tauri configs plus
  `app_channel.rs`, `app_channel.py`, `appChannel.ts`, `main.tsx`, `cellxplorer-installer.nsi`, and
  `build-app.ps1`. All 15 matrix cells and all 17 locked constants match, including COLORREF
  `0x00E84870`, `#B197FC` icon brand, `.cellxplorer-alpha`, and the `CellXplorer.Alpha_` setup
  prefix. `CELLXPLORER_DATA` still overrides every channel exactly, with no channel suffix appended.
- **§5 visual design.** The `alphaPurple` palette matches the parent's ten values exactly, with
  `primaryShade` light 7 / dark 6; the header is icon + `CellXplorer` + a filled compact `ALPHA`
  badge with no animation or second palette. Semantic teal/yellow/orange/red, scientific trace
  palettes, persisted series colors, thumbnails, and exports are untouched. Rendered Alpha `.ico`
  frames were inspected directly: purple mark throughout, `ALPHA` badge at 48/256 px, dedicated `A`
  at 16/24/32 px, Stable geometry and transparency preserved, and Stable/Beta assets byte-identical
  after Alpha regeneration.
- **§6.1/§6.2 independent empty product.** Alpha starts from its own empty root with no copy,
  migration, or synchronization path. `beta_installer::require_stable_channel` compares against
  `STABLE_IDENTIFIER` exactly, and the backend Beta-bootstrap router/service and the frontend
  bootstrap policy all gate on `== "beta"`, so Alpha can reach neither Stable's first-Beta install
  flow nor Beta's bootstrap. The Stable-only Beta-install surface is now a pure tested policy.
- **§6.3 fail-closed three-value selection.** A full sweep of `backend/`, `frontend/src/`,
  `scripts/`, `src-tauri/src/`, and `.github/` found no remaining two-value channel enumeration and
  no "not Beta ⇒ Stable" inference. Every surviving `!= "beta"` is a Beta-only restriction that
  fails closed for Alpha. Frontend, Python, Rust, build scripts, stamp verification, manifest
  verification, and release automation all accept exactly `stable|beta|alpha` and reject anything
  else.
- **§7 release/version contract.** Stable stays exact `X.Y.Z` (and the manifest verifier is now
  strictly exact rather than merely "not beta"); Beta's dotted and compact legacy forms are
  unchanged; Alpha accepts only `X.Y.Z-alpha.N` with no leading-zero sequence, no compact spelling,
  no extra prerelease identifiers, no build metadata, and no leading `v`, enforced identically in
  the Rust runtime validator, `release_tag.py`, and `verify_updater_manifest.py`. Beta and Alpha are
  each required to exceed the latest published exact Stable core and are never compared to each
  other. Alpha releases are prereleases and cannot become GitHub's normal latest release.
- **§8 release-channels branch transition.** The branch stays manifest-only and is never
  initialized from `main`. Alpha may be absent only while authoritative published-release evidence
  proves no Alpha release exists; once published, a missing Alpha pointer is an error for every
  target channel; the first Alpha target may create exactly one new pointer. Publication snapshots
  every non-target path including `README.md`, re-checks each blob immediately before the write and
  again at the published commit, re-validates the complete published tree, and verifies exact bytes
  through both the Contents API and the public raw endpoint. The pointer move itself is an atomic
  non-force ref update parented on the verified branch tip, which also protects first-time
  creation — something the previous Contents PUT could not express.
- **§13 out of scope.** Nothing out of scope was implemented: no separate repository or tree, no
  cross-product data copy, no Alpha install offered from Stable or Beta, no automatic promotion, no
  canary/nightly, no macOS/Linux, no Authenticode, no key rotation, no schema migration, no
  `CALC_VERSION` change, no parser or scientific change, no Beta-bootstrap semantic change, and no
  Alpha release published.

## Cumulative regression audit

The application-code footprint of the whole feature is deliberately small and entirely
channel-identity related:

```text
backend/app/config.py                              2 +-   (docstring only)
backend/app/services/app_channel.py               17 ++-
frontend/src/App.tsx                               4 +-
frontend/src/appChannel.ts                        42 ++++-
frontend/src/appUpdater.ts                         8 ++-
frontend/src/betaInstaller.ts                      5 ++
frontend/src/components/AppUpdateCoordinator.tsx  11 ++-
frontend/src/components/BetaInstallCoordinator.tsx 3 +-
frontend/src/main.tsx                             35 ++++-
frontend/src/pages/SettingsPage.tsx               10 +-
src-tauri/src/app_channel.rs                      76 ++++++
```

No migration registry, model, cache, parser, or analysis file was touched. `CALC_VERSION` is
unchanged. Every Stable/Beta behavior change is intentional and covered:

- `SettingsPage`/`BetaInstallCoordinator`/`main.tsx` moved from `isBeta` inference to exact channel
  comparisons — same Stable and Beta behavior, now unable to misclassify Alpha.
- `shouldShowUpdateUi` gained a channel parameter and `AppUpdateCoordinator` gained guards that
  simply require Tauri or a dev mock; Stable and Beta outcomes are unchanged.
- `verify_updater_manifest.assert_channel_version` is stricter for Stable (exact `X.Y.Z`), matching
  Parent §7 and the "do not weaken validation" instruction.
- `scripts/build-app.ps1` normalizes the freshly built installer to the locked dotted artifact name,
  which also changes Beta's *local* filename from spaced to dotted. This matches the Parent §4 setup
  prefixes, the published-asset naming already modeled in `verify_updater_manifest.py`, and the
  packaging documentation that already described the dotted path. CI is unaffected: it builds
  through `tauri-action`, and GitHub applies the same space-to-dot substitution on upload.
- The 053.1 temporary Alpha updater gate was fully removed by 053.2; `tests/test_updater_configuration`
  now asserts its absence, so it cannot be reintroduced silently.

## Parent §12 acceptance

| # | Item | Status |
|---|---|---|
| 1 | Both children implemented sequentially and review-clean | **MET** |
| 2 | Stable and Beta contracts backward compatible | **MET** (deliberate strengthenings listed above) |
| 3 | Alpha is a distinct Windows product with the locked identity matrix | **MET** in code/config; installed proof outstanding |
| 4 | Alpha uses only `.cellxplorer-alpha` and never starts Beta bootstrap | **MET** in code; installed proof outstanding |
| 5 | Three products run simultaneously with channel-local single instance | **NOT RUN** (installed) |
| 6 | Deep links, autostart, shortcuts, uninstall keys, install dirs do not collide | **MET** by exact-identifier derivation; installed proof outstanding |
| 7 | Locked purple theme, icon treatment, frame, installer color, ALPHA badge | **MET** (icons inspected) |
| 8 | Semantic and scientific colors channel-neutral | **MET** |
| 9 | Alpha self-updates only from `alpha/latest.json` and rejects Stable/Beta versions | **MET** in code; installed proof outstanding |
| 10 | Stable and Beta continue to self-update from their existing feeds | **MET** |
| 11 | Alpha tags, manifests, assets, prerelease state validated exactly | **MET** |
| 12 | First-Alpha bootstrap and post-bootstrap exact-tree rules tested | **MET** |
| 13 | Publication protects every non-target pointer | **MET** |
| 14 | Complete three-product disposable install/update/uninstall matrix recorded | **NOT RUN** — blocking |
| 15 | Canonical no-cache preflight passes on the final branch | **MET** — reviewer-run at `158422e` |
| 16 | No migration, `CALC_VERSION`, scientific change, or copied tree | **MET** |
| 17 | No production tag or release without explicit authorization | **MET** — none created |

Items 3, 4, 6, and 9 are satisfied at the code and configuration level and additionally require the
installed matrix for end-to-end proof: installed side-by-side registration, simultaneous execution
with channel-local single-instance focus, same-channel signed self-update isolation, crossed-manifest
rejection in installed products, uninstall isolation and destructive Alpha-data boundaries, and
per-product updater notification/modal identity.

## Outstanding documentation closure

### D1 — Low: branch status documentation does not describe the delivered state

Affected files:
- `docs/specs/README.md`
- `docs/specs/053.1-alpha-application-identity-isolation-and-packaging.md`
- `docs/specs/053.2-alpha-updater-release-publication-and-closure.md`
- `AGENTS.md`

**Current**

Child 053.2 §12 makes documentation and status closure part of this final review, and the branch
currently describes itself inaccurately:

- `docs/specs/README.md` still says "Child 053.2 is the active child" and marks both children
  "**Implemented; review pending.**" Both are review-clean, and the parent review is complete.
- `docs/specs/053.1-...md` and `docs/specs/053.2-...md` both still read
  `Status: **Implemented — review pending**`. The repository convention for landed children (see
  Specs 046 and 048) is "Implemented — review-clean".
- In `AGENTS.md`'s release sequence, the paragraph beginning "Tags must pass
  `python scripts\release_tag.py --tag v<version>`…" lost its list indentation in `52ba267`, so it
  now renders outside numbered step 6 and breaks the ordered list it belongs to.

The branch will sit in `BLOCKED` until installed evidence is available; it should describe itself
accurately while it waits.

**Target**

Status text that matches reality: both children implemented and review-clean, Parent 053
cumulatively reviewed and blocked only on the installed/update matrix, and a correctly formatted
`AGENTS.md` release sequence.

**Acceptance criteria**

- Both child specs read `Status: **Implemented — review-clean**` (or the equivalent wording already
  used by landed children in this repository).
- `docs/specs/README.md`'s Spec 053 entry marks both children review-clean and states that Parent
  053 is cumulatively reviewed and blocked on the outstanding installed/update matrix, rather than
  naming an "active child".
- The `AGENTS.md` "Tags must pass …" paragraph is indented back under step 6 so steps 6–9 render as
  one ordered list.
- No spec requirement, locked decision, or acceptance checkbox is altered, and no other
  documentation claim changes.
- No code, test, workflow, or `release-channels` change is made for this item.

## External blockers preventing completion

These are not implementation findings and must not be resolved by an agent:

1. **Disposable three-product installed/update/uninstall matrix** (Parent §12, 053.1 §10,
   053.2 §11). Requires a disposable Windows account or disposable data roots and signed test
   artifacts, plus installing all three products side by side, exercising same-channel updates,
   crossed-manifest rejection, deep links, autostart, single-instance focus, and uninstall
   isolation. Neither agent has that access, and no user authorization for installed-app testing was
   given.
2. **Signed CI build-only evidence.** The three build-only workflow dispatch choices were exercised
   only as local unsigned `--no-sign` rehearsals (digests recorded in the 053.2 implementation
   record). Parent §11 asks for artifacts from the same reviewed commit with verified channel
   stamps, resolved identity, installer names, icon inputs, and updater endpoints.
3. **Release-channels README preparation** (053.2 §6.2), recorded as a pending, unauthorized
   prerequisite. It must be a separate focused manifest-only commit on the orphan branch before the
   first production Alpha tag, and requires explicit user authorization.

The first Alpha tag, GitHub release, and channel-pointer write remain unauthorized and must not be
performed without a separate explicit user instruction naming that exact operation. When the
installed evidence becomes available, resume with
`python docs/specs/workflow/spec_workflow.py resume-final-review` and complete this same cumulative
review; do not transition directly from `BLOCKED` to `COMPLETE`.

## Non-blocking observations

- `.github/workflows/release.yml` re-implements the three tag grammars as PowerShell regexes instead
  of consuming `release_tag.release_channel_for_tag`. Drift would fail closed, and `release_tag.py`
  validates the tag first.
- `shouldShowUpdateUi` retains an unused, documented `channel` parameter (`void channel;`).
- `scripts/smoke_packaged_backend.py` always passes `CELLXPLORER_CHANNEL=stable`. The sidecar is a
  shared channel-agnostic artifact, the smoke run uses a disposable `CELLXPLORER_DATA`, and
  `CELLXPLORER_STARTUP_MODE=smoke-test` keeps it out of packaged mode, so this proves what it
  claims; passing the selected channel would make the Alpha release path marginally more direct.
- `latest_real_stable_core`'s `blocked_channel` parameter defaults to `"Beta"`, so a future third
  caller that omits the keyword would emit a misleading message.
