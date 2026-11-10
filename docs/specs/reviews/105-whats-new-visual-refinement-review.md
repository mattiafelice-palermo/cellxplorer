# 105 — What’s New visual refinement

Status: In progress. Branch: `codex/whats-new-visual-refinement`.

User request: restore the initial release-tour composition. Keep the four
scientific cards, real application plots/components and Previous/Next navigation.
Do not modify the restored Alpha chooser, libraries, eligibility or release state.

Restore centred category/title/description, a compact framed example, quiet
dot navigation and one balanced footer. Fit the complete default card at a
normal desktop viewport without clipping; retain scrolling at narrow widths or
increased UI zoom. Keep the source identity and limitation panels authentic;
do not restore fabricated controls or scientific graphs.

Use the initial prototype's 26 px centred headings as the user's explicit visual
override of ordinary modal typography. Use Mantine tokens for the surrounding
chrome. Verify all four cards, expanded limitations, guide return, light/dark,
390 px width and 70/100/160 percent UI zoom; run focused tests/build/preflight.

## Verification

- 18 focused production-handler/policy tests pass, including retained bootstrap
  safeguards, release gating, navigation, inert example links and guide return.
  Production TypeScript/Vite build passes.
- All four default cards measure `clientHeight == scrollHeight == 523` at
  1280 x 720, with no horizontal document overflow. Expanded limitations fit.
  Light/dark desktop and the 390 x 844 dark FEC card have been visually checked;
  Previous/Next stay inside the viewport at narrow width.
- Alpha chooser coordinator, global CSS and bootstrap handler tests are unchanged.
- Canonical local preflight is running; final clean-Windows check is pending.
