# Segmented selection geometry follow-up

Branch: `codex/segmented-highlight-scaling`.

## Diagnosis and scope

The user reported offset selected backgrounds in installed Alpha, while the web
development screenshot was aligned. Reproduced in the development Alpha UI by
reducing application zoom to 90%: the selected scope label was 558.92px wide,
but the highlight was 503.02px, and its left edge was 56.16px too far left.
Mantine FloatingIndicator uses `getBoundingClientRect` viewport coordinates as
inline CSS width/translation inside an ancestor already scaled with `zoom`.
This scales those measurements a second time. The previous global override fixed
height/inset but left measured width/translation in place. This is a shared UI
geometry issue, not an Alpha color or file-search data issue.

Paint the checked label's own CSS pseudo-element, retaining Mantine's theme,
radio inputs, focus, disabled and orientation behavior. Hide the measured
indicator. Keep the existing explicit padding/radius. Migrate the single existing
custom indicator border/shadow (plot legend selector) to root CSS variables.
Scientific calculations and data are unchanged. The selection now switches in
place instead of sliding a measured rectangle.

## Acceptance

- Browser: both scope and Preview/Filters selectors at 70%, 90%, 100% and 160%;
  selected background follows label width/height with zero inset. Switch both
  ways, light/dark appearance, keyboard selection/focus, resize and reopen.
- Run canonical preflight, independent Astra high review after browser checks,
  commit/push branch and merge/push main.
- Native installed Alpha acceptance requires a rebuilt executable. Current
  browser verification does not claim to control or rebuild the installed app.

## Verification

Both selectors passed measured geometry checks at 70%, 90%, 100% and 160% app
zoom: the checked label and its pseudo-element have identical CSS width/height
and zero inset. Clicking and native arrow keys switch folder/indexed and
Preview/Filters correctly; input focus follows keyboard selection. Light/dark
appearance and closing/reopening passed. Screenshots:
`tmp/segmented-highlight-alpha-90.png`, `tmp/segmented-highlight-alpha-dark.png`,
`tmp/segmented-highlight-alpha-fixed.png`.

Independent Astra high review: **Clean; no actionable regressions found**.
Reviewer inspected radio semantics, focus, disabled selection, theme/custom
legend styling and browser screenshots. Full canonical preflight passed all
four stages in 213.03 seconds, including the complete four-worker backend/frontend
suite, type check, production bundle and version consistency. No version bump,
release or tag; installed Alpha verification awaits a rebuilt release.
