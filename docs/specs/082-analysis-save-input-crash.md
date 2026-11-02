# 082 — Analysis plot save input crash

Status: Implemented; browser acceptance and canonical no-cache preflight passed; published in Alpha.17.
Branch: `codex/fix-save-as-input-crash`.

## Report

Create an empty analysis, add a Cell, create a Voltage/Capacity plot, choose Save
as, double-click the prefilled title and type a replacement. The editor fails to
render with `Cannot read properties of null (reading 'value')`.

## Scope

Snapshot text input values while their change event is being dispatched, before
queueing functional state updates. Cover the new-plot title/description, the
quantity-change rename prompt and the save-before-leaving title/description.
Preserve current modal state and cancellation, keyboard behavior, scientific
values, saving and layout. No release/version change or real-profile writes.

## Verification

- Run the production JSX handlers after dispatch cleanup, with currentTarget
  nulled, replacement/empty text, intervening state changes and modal closure.
- Reproduce and verify the reported flow in a disposable browser application.
- Run canonical preflight, commit/push the feature branch and merge to main.

## Acceptance

The production-handler regression first reproduced the reported null-value
exception in all five affected inputs. All six checks pass after capturing the
value before queueing updates; replacement/empty text, concurrent state and
closed-dialog guards remain covered.

Browser acceptance used a disposable database and the committed cycling fixture:
create empty `Test`, add one Cell, create a Voltage/Capacity draft, Save as,
double-click `Test` in the title and type a replacement, then edit the description.
No crash occurs. Enter saves the plot; the replacement title and description
persist after reload, and the analysis name remains `Test`.

Canonical `python scripts/preflight.py --no-cache` passed all four stages with
the supported four-worker budget, including frontend type checking and production
build. No release, installed-app change or real-profile writes are included.

Subsequent user-authorized publication: Alpha `0.28.0-alpha.17` contains this fix.
Exact-main preflight and signed native installer gates passed, with independent
public installer/signature/feed verification; see Spec 083 for release recovery
evidence. The implementation above did not itself change installed applications.
