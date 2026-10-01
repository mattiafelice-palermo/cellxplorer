# 065 — Clear, minimal file-search introduction

Status: Implemented; Astra high review clean, full preflight and browser acceptance passed.
Branch: `codex/search-introduction-redesign`.
Review document: [065 review](reviews/065-search-introduction-redesign-review.md).

## Approved design

Implement the first minimal mockup selected by the user: one benefit-led headline,
one folder-to-search illustration and one primary action. The headline is
“Find files. Skip the folder hunt.” Supporting copy explains chosen folders and
network drives. The illustrative result has Alava in its filename and explains a
filename match, not a header match. The example is static, not a search control.

Use existing Mantine primitives, Tabler icons and semantic/channel theme tokens.
This explicit design permits a restrained 30px announcement headline and readable
16px introduction rather than the ordinary compact modal heading/helper sizes.
Use native HTML/CSS, not the generated mockup image as an application asset.
Keep the presentation responsive and readable at app zoom in light/dark themes.

## Interaction and ownership

- A “See how it works” button requests the existing bundled MP4, poster and captions.
  Do not load/play media until requested; closing/reopening resets playback. Provide
  an accessible way back to the example, controls and a readable failure state.
- Below the video button/player retain a collapsed expander with the full guide:
  choosing roots, indexing/freshness, searching, filtering, match reasons, preview,
  staging/import and already-registered sources. Mention missing cycling facts are
  unknown, not computed by search. Link to the established entry points in prose.
- “Choose search folders” closes the announcement and opens the existing
  Settings → File search surface. No additional onboarding wizard.
- Keep Spec 062's automatic packaged-only eligibility, per-channel dismissal,
  manual development replay and setup/update-dialog deferral unchanged.
- Preserve search/index/parser scientific behavior. No schema or release/tag.

## Acceptance

Browser verify initial minimal view, Alava filename match, manual video playback
and reset, full guide, setup action, small viewport/zoom, light/dark and keyboard.
Use disposable application data. Add focused production-view regressions and run
the full preflight. Browser before independent Astra high review; resolve findings,
commit/push feature branch, merge/push main. Packaged WebView acceptance remains a
rebuilt-app check rather than being inferred from development browser acceptance.

## Verification

Browser verified light/dark, keyboard playback and guide scrolling, state reset,
setup destination, normal viewport and narrow 120% zoom. The example highlights
Alava in its filename. Header/footer remain visible when content must scroll.
Three production-view regressions pass. Astra high independently reran them and
reported clean review. Full no-cache preflight at four-worker CPU budget passed
all four stages in 183.47 seconds. No version bump, release or tag was made.
