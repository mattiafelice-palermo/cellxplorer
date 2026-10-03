# Alpha feedback implementation report

Date: 2026-10-03. Feature branch: `codex/alpha-analysis-improvements`.

## Delivery and repository state

The release checkout was tracked-clean and synchronized with `origin/main` before
this batch. The following existing untracked items were preserved:

- `.tmp-spec0541-matrix/`, `.worktrees/` and `tmp/`;
- `docs/future-improvements.html` and `docs/future-improvements.md`;
- `scripts/convert_neware_protocol.py`, its HTML companion and its test module.

Five specifications were written and pushed on main before the feature branch was
created. Implementation was sequential, with a pushed checkpoint after each
spec and an independent GPT-6 Astra Medium review. No version bump, release or tag
is part of this batch. Browser checks use a disposable library; the real database
and installed applications are untouched.

## 1. CE with replicates — Spec 066

**Problem.** The renderer excluded grouped Cells from the individual CE traces.
The Series Appearance list also used that exclusion, so simply drawing the missing
curves would have left them unavailable for individual styling.

**Change.** A shared eligibility policy now controls the renderer, visibility and
Appearance entries. Cells only shows each displayed member's CE. Mean with band
shows group CE, and enabling individual members can show their CE beside the mean.
An unaggregated group remains visible even when another group has an aggregate.
Primary curves and CE keep independent visibility and styling; missing or
nonfinite CE never becomes an invented curve. CE calculations are unchanged.

**Evidence.** 81 focused frontend tests, TypeScript and canonical preflight passed.
Disposable browser checks confirmed member CE legends, curves and the right axis.
Astra's Appearance-policy finding was fixed and reviewed clean.

Checkpoint: `fe697cd0`. [Specification](066-replicate-ce-rendering.md).

## 2. Understandable C-rate guidance — Spec 067

**Change.** Information buttons open plain-language help explaining what pattern
Rate Capability recognizes, why nominal capacity may be needed, how completed
voltage limits affect inclusion, and why constant-current capacity is used. The
help displays the actual configured minimum rates and tolerances.

Feedback distinguishes not started, running, failed, disabled, no supported sweep
and an empty display filter. Per-Cell details report only evidence the detector
actually established. Ambiguous failures explain the supported pattern and offer
recognition settings/protocol inspection; they do not claim corruption.

**Scientific boundary.** Recognition rules and numerical calculations are
unchanged. The Rate Capability result schema advances from 4 to 5 for additive
evidence. Golden comparisons exclude only that explanatory evidence; regressions
prove changed capacity or recognition status still fails scientific comparison.
No expected golden data or tolerances were altered.

**Evidence.** 21 focused backend tests, 13 corpus subtests, seven frontend policy
tests and 35 golden/approval tests passed. Browser checks covered recognition
states, incomplete-step feedback and light/dark help. No-match wording is
test-covered rather than exercised with a browser fixture. Full preflight passed
all four stages, including 191 test modules. Astra review is clean.

Checkpoint: `0b34e794`. [Specification](067-understandable-rate-capability-guidance.md).

## 3. Reference lines — Spec 068

**Where.** Plot style → Reference lines → Edit reference lines.

Users can add horizontal/vertical references, set exact positions, use full-domain
or bounded spans, duplicate/reorder/remove lines, and control color, width, opacity,
dash and placement in front of or behind data. Labels support custom text,
value/units, along-line or free positions, dragging where safe, alignment,
rotation, offsets, typography, background and border. Apply commits the draft;
Cancel/Escape discard it. Reset clears references within the draft.

**Safety and persistence.** References bind to the scientific axis quantity and
units. An incompatible axis change suppresses the reference until restored or
explicitly rebound. Existing family shapes/annotations are retained. References
survive save/reload and portable export/import; figures include them while data
exports retain measured values. No calculation, worker policy or cache identity
changes. Precise coordinate controls remain available when other annotations make
global Plotly dragging unsafe.

**Evidence.** 70 focused frontend tests and 36 portable-analysis tests passed.
Browser checks covered draft actions, ordering, label positions/dragging,
save/reload, PNG export, light/dark, unit suppression/restoration, WebGL layering,
adaptive zoom and cycle navigation. Astra caught a stacked-plot label jump; it was
fixed, regression-tested and checked in the browser. Full preflight passed 4/4.

Checkpoint: `eacc49b0`. [Specification](068-customizable-reference-lines.md).

## 4. Voltage/Capacity cycle shading — Spec 069

**Where.** Time/Capacity → Capacity X axis → Plot style → Series Appearance →
Cycle shading. It is deliberately unavailable for Time plots and other families.

Users can vary lightness, saturation or both, reverse the progression, choose
smooth or stepped bands, and apply settings to all samples or selected samples.
The sample hue still comes from its normal palette/rule/channel color. Charge and
discharge use the same shade for the same scientific cycle. Gray stays neutral;
unknown or display-only cycle identities keep their base color.

Bounds are frozen from the full scientific range, not the displayed window.
Navigation and source growth do not recolor existing cycles; Update full range
explicitly changes the mapping. Unknown full bounds require explicit manual
bounds. A compact key explains the mapping. Local preview/reset changes need
Apply; dismissing them leaves the plot unchanged. Save/reload and figure outputs
preserve shading, and measured data exports are unchanged.

**Evidence.** 132 focused tests and TypeScript passed. Browser checks covered
all/selected application, smooth/reversed stepped modes, navigation, base hue,
reset dismissal, save/reload, Time-axis exclusion, light/dark and actual PNG.
A compact-preview clipping issue was fixed and regression-tested. Canonical
preflight passed 4/4 in 122.92 seconds. No calculation, worker or cache changes.

Checkpoint: `a3174f66`. [Specification](069-voltage-capacity-cycle-shading.md).

## 5. Installation scope and updates — Spec 070

**Scope policy.** Fresh installations default to the current user in LocalAppData,
with an explicit All users choice. Updates preserve the registered scope and exact
folder; they do not silently create a second installation. All-users installations
continue to require legitimate Windows approval. A one-time reinstall while
keeping data is the supported way to change scope.

**Handoff.** The existing signed download, version and channel checks remain in
place. Windows launch is checked before the app shuts down. A cancelled elevation
or failed launch keeps the running app and downloaded update available for retry.
Conflicting or incomplete installation records fail closed. Restart arguments are
passed as data, and elevated setup does not operate on another user's data or
startup preferences.

**Release transition.** An already released app still uses its old updater for the
first update into this implementation. The improved cancellation behavior applies
once the new client is installed. WebView2 installation or repair can independently
require Windows approval.

**Evidence.** Stable, Beta and Alpha NSIS templates compile. Production scope
logic passed disposable Windows registry checks for discovery, normalization,
conflict rejection and registration cleanup. Focused checks passed 29 tests;
independent scope/updater reruns passed 28. The complete Rust suite passed 59 tests.
Restart argument quoting was exercised in Windows PowerShell with empty strings,
quotes, backslashes, Unicode and shell-like text, without launching the app.
Final canonical preflight passed 4/4 in 118.11 seconds. Astra review is clean.

**Acceptance limit.** Actual signed install/update/UAC behavior still needs a
disposable native Windows matrix. Compiler and policy fixtures do not establish
that acceptance. The user's installed application was not used as a test target.

Checkpoint: `aa402a4d`. [Specification](070-user-scope-updates.md).

## Deliberately deferred

- **Li||Li voltage scaling:** no speculative parser/scaling change. A representative
  source and expected values are needed to establish the cause.
- **BioLogic MB cycling mixed with PEIS:** reference files are needed before
  extending the verified adapter. EIS analysis remains outside scope.
- **Axis breaks:** declined as requested; no additional discontinuous axes were added.

## Final verification and handoff

All five implementations have passed their independent reviews and verification.
Browser acceptance covered the plotting changes using a disposable library,
including adaptive zoom, cycle navigation, saved configuration and actual figure
exports. The temporary browser tab and servers were closed; the user's development
servers were left alone. Installation acceptance remains limited as stated above.

All five implementation checkpoints are committed and pushed on the feature
branch. This report accompanies the final merge to main. Existing intentional
untracked files remain intact. No release or version bump was made; preparing the
next release is a separate action.
