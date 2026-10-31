# 081 — Illustrated setup and explicit updater refresh

Status: Complete; merged and published in Alpha 0.28.0-alpha.16.
Branch: `codex/illustrated-bootstrap-refresh`.

## Approved scope

Use the selected Direct actions design: square generated illustrations, four
edition-labelled choices in one desktop row, actual official edition logos on
the sheets. Use compact 88 px illustrations (user refinement: the 128 px preview
was too large). Preserve existing overwrite confirmations, explicit acknowledged
empty reset, staged-source identity checks, backups and native activation.

Only offer installed source editions. A positively verified single-edition setup
can acknowledge/use its current library, or initialize a genuinely pristine one,
without presenting irrelevant choices. Detection failures, pending stages,
validation errors and destructive actions must never auto-resolve. Do not infer
installation absence from a missing data directory or blocked registry access.
The installation-aware chooser applies only to the existing Alpha/Beta startup
flows (explicit user decision). Stable remains unchanged: no new chooser and no
copy-into-Stable routes. Beta continues to copy only from Stable; Alpha continues
to copy from Stable or Beta.

Whenever the update dialog opens, refresh remote release discovery unless a
protected transfer/handoff or a staged local installer owns the update state.
Expose a labelled Refresh action, coalesce concurrent requests, preserve the
last good release while checking/failing, and compare full SemVer including
Alpha/Beta prerelease sequence numbers. Keep byte verification, generation/
revision guards and installer recovery unchanged.

## Required checks

Edition availability/unknown/single-edition policy and no silent data loss;
production confirmation regressions; remote A→B refresh including Alpha sequence,
coalesced refresh/failure and local/protected-state isolation; native discovery
fixtures; typecheck/build; built-in-browser light/dark and UI zoom geometry;
canonical no-cache preflight; commit and push the completed feature branch.

Do not rewrite the published Alpha.15 release. A subsequent version declaration
and changelog entry will identify completed new user-facing work; publishing a
new Alpha release is explicitly authorized by the user's subsequent request to
implement the agreed scope and create a release. Publish only after the required
local and signed hosted gates; verify the public installer, signature and feed.

## Implementation and asset provenance

`installed_editions.rs` provides read-only installed/absent/unknown evidence from
both registry hives and views. Missing data folders are not installation evidence.
Unknown detection remains visible, and unverified copy sources are not offered.
The backend's single-edition acknowledgement preserves existing data and blocks
pending, incomplete or corrupt stages and apply-failure records. Stable's setup
and all native copy/reset activation contracts remain unchanged.

The updater provider owns a coalesced refresh separate from the last good release.
Both manual and automatic results honor superseding epochs; manually opening an
automatic check promotes its feedback. Closing during refresh does not reopen the
dialog on completion. Staged local installers and protected flows remain pinned.

Final square, transparent raster assets are bundled in `frontend/public/setup/`.
They were edited with built-in ImageGen from the selected concept art, using the
repository's actual `app-icon.png`, `app-icon-beta.png`, and `app-icon-alpha.png`
as logo references. The common edit prompt preserves the square framing, trays,
matte isometric materials and transparency; no surrounding UI or new objects.
Final prompt directions by asset:

- `copy-stable.png`: Stable teal source sheets/tray copied rightward into Alpha
  purple sheets/tray; both remain populated, each with its edition's official X logo.
- `copy-beta.png`: Beta blue source copied into Alpha purple, retaining BETA/ALPHA
  logo labels and the rightward copy arrow.
- `keep-alpha.png`: one purple tray and protective arc/check; all three sheets
  show only the official Alpha logo, never mixed-edition sheets.
- `start-empty.png`: one visibly empty purple tray, with an Alpha-logo index card
  behind it and no scientific charts.
- `copy-stable-to-beta.png`: change only the destination of the Stable-copy
  illustration to Beta blue and the official Beta logo; no Alpha logos.
- `keep-beta.png`: blue tray, protective arc/check and only official Beta sheets.
- `empty-beta.png`: visibly empty blue tray with an official Beta-logo index card.

Illustrations render at 88 x 88 CSS px before UI zoom. The Alpha chooser uses
four desktop columns and reflows by available modal width; Beta retains a compact
two-choice dialog. Browser acceptance uses a disposable library, never real data.

## Local verification — 2026-10-31

- Final canonical `python scripts/preflight.py --no-cache` passed all 4/4 stages
  and all 213 local backend/frontend test files/modules in 118.76 seconds, using
  four workers and a short isolated temporary directory. Typecheck and production
  bundle passed. An unrelated untracked converter test is included in that local
  discovery count but is intentionally excluded from this feature/release commit.
- Full locked native suite passed 93/93 at Alpha.16, including disposable HKCU
  installation evidence, denied/malformed/missing/stale records and significant
  Unicode path characters. Registry/pipe tests require execution outside sandbox
  restrictions; the restricted run's access failures were environmental.
- Seven production bootstrap coordinator tests verify both Alpha copy confirmations,
  Beta replacement confirmation, unchecked empty-start acknowledgement and actual
  request/native-command payloads, sole-edition guarded acknowledgement, and hidden
  unverified source choices. Development mocks are disabled in those tests.
- Six production update-provider tests verify A-to-B Alpha refresh, retained A on
  checking/failure, automatic/manual coalescing, local payload isolation, superseding
  local staging, close-during-refresh behavior and full prerelease ordering.
- Alpha's 20 backend tests and Beta's 38 backend tests pass, including retained
  cells/import bytes, pristine acknowledgement and refusal to hide pending,
  incomplete, corrupt or unreadable recovery artifacts.
- Built-in browser acceptance covers light/dark, 70/100/160 percent UI zoom,
  copy replacement and initially unchecked reset confirmation, Refresh, keyboard
  reachability and horizontal overflow. Final illustrations measured 87.99 px at
  normal UI zoom; the Alpha dialog measured 374.05 px high, 40 px shorter than
  the 128 px illustration candidate. Four desktop buttons shared y=497.47 px
  and width=197.90 px. The longest action label fits in full (167/167 px
  scroll/client width). At 160 percent the lower actions remain reachable through
  the ordinary dialog scroll/focus behavior; no horizontal overflow was observed.
- Test appearance and zoom were restored, temporary viewport override reset, and
  the agent-created tab and tracked disposable servers closed. The real installed
  app, its libraries and installer/UAC behavior were not exercised or changed.

## Published release evidence — 2026-10-31

- Feature commit `c0479cf7eabdd8551434826d7a8463051d3acdef` was pushed and
  merged to `main` as `6cf1e8723f6c97fd4f49717b3a7ee765046cbed4`.
  Annotated tag `v0.28.0-alpha.16` points to that exact commit; Alpha.15 remains
  unchanged.
- Exact-commit main CI
  [41224610167](https://github.com/mattiafelice-palermo/cellxplorer/actions/runs/41224610167)
  passed 4/4 preflight stages and all 212 committed backend/frontend task modules.
  The local 213-module count additionally includes the unrelated untracked
  converter test; it was not added to this release.
- Signed release
  [41224635165](https://github.com/mattiafelice-palermo/cellxplorer/actions/runs/41224635165)
  passed in 9m30s. Frozen scientific-runtime parity, 93 native unit tests,
  registry/recovery/local-signed-input policy fixtures, all eight user/machine x
  default/custom x upgrade/reinstall cases, keep-data and other-channel isolation,
  final draft payload/signature recheck and manifest publication passed.
  This is run evidence, not a CI optimization benchmark; this feature did not
  change the workflows.
- The [published prerelease](https://github.com/mattiafelice-palermo/cellxplorer/releases/tag/v0.28.0-alpha.16)
  contains the exact setup executable, matching `.sig` and `latest.json`.
  Independent public downloads matched GitHub asset sizes and SHA-256 digests.
  The setup is 88,158,973 bytes with SHA-256
  `d9a6aacde531819d886590bd4dbd0ed5619d37878b679e73b6ce7d735f2d71c4`.
- Both the unchanged embedded-key signature verifier and the rebuilt production
  local-installer verifier accepted the actual public setup/signature, including
  its Alpha product/version and same-version reinstall policy. No installer ran
  on the user's computer. The canonical public Alpha feed is byte-identical to
  the release manifest; version, URL, signature and structured changelog notes pass.
- The release-channel README, Stable and Beta blobs remain unchanged from the
  pre-publication snapshot; GitHub's normal latest release remains Stable `v0.20.2`.
  Public audit evidence is retained under `tmp/081-public-alpha16/`, and exact-SHA
  hosted logs under `tmp/081-release/`. Interactive installed-client/UAC acceptance
  remains unverified and is not implied by hosted, UAC-disabled native checks.
