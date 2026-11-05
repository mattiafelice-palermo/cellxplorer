# 089 — MPR plotting recovery review

Independent reviewer: GPT-6 Astra, Medium. Final review: no remaining findings.

## Resolved findings

- Recovery instructions and error-panel action must obey the same registered
  and offline eligibility as result-row actions. The panel now checks both.
- Changing mode must preserve genuine same-version Safe and Permissive
  rejections. The mode transition now leaves rejection facts intact, and an
  actual production-handler regression covers repeated toggles and peer modes.
- Browser acceptance caught inherited `aria-disabled` disabling the nested
  recovery button. Recoverable rows expose the action while leaving their
  blocked selection checkbox disabled.

## Verification

Seventeen focused interaction, readability and mode regressions pass. Actual
browser recovery/import/voltage plotting passes for all four supplied originals
in disposable data, including reload and the instrument-error notice. Canonical
four-worker no-cache preflight passed all four stages and all 220 test modules.
