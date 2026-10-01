# 062 — Search match explanations and release introduction

Status: Implemented; independent Astra review clean. Branch: `codex/search-match-and-whats-new`.
Review document: [062 review](reviews/062-search-match-explanations-and-whats-new-review.md).

## User-authorized scope

1. Explain each indexed result's actual match: filename, folder, and explicitly named source-export
   header field. A file-header “Part number” is a source label, not an inferred Cell name/material.
   Show matching reasons before generic metadata, highlight terms, and expose full explanations
   on keyboard focus/hover. Preserve ranking, speed, scientific parsing and import rules.
2. State current metadata coverage: barcode, remarks, part number, start time, technique. Editable
   Cell names/notes and scientific Cell metadata are outside the source catalog. Prioritize
   material/chemistry, experiment labels, temperature, mass, nominal capacity and protocol limits
   for future structured metadata work, only with explicit provenance and cheap readers. This spec
   does not expand extraction or conflate source files with database Cells.
3. Add a one-time next-release “What’s new” modal highlighting search. Bundle a short silent H.264
   MP4 walkthrough, poster and captions locally; include an expandable guide and direct Try file
   search action. Reopen from the existing power/settings menu.

## Behavior and ownership

- Reuse the import picker, source previews, theme/zoom contract and version/status startup query.
- Automatically show only in a packaged app newer than `0.28.0-alpha.2`, once per channel/feature,
  after a compatible backend and completed Beta/Alpha setup. Wait for existing dialogs/update flows;
  do not block startup, migrate data, index folders, or bump/release versions.
- Store dismissal in local preference storage, protected against storage errors. Manual viewing
  in the current development build must not consume the future packaged announcement.
- The video does not loop, is muted, has controls/captions, and does not autoplay for reduced motion.
  Playback failure leaves a readable guide. Assets are bundled; no external media service or
  runtime encoding dependency is introduced.
- The direct action opens indexed search via the existing Load cells route, with no new wizard.
  The later user-approved [Spec 065 redesign](065-search-introduction-redesign.md)
  replaces this CTA with Choose search folders, opening existing Settings → File search.

## Acceptance

Browser-check filename and metadata-only matches, full explanations, direct onboarding action,
manual replay, guide expansion, video playback and theme presentation. Use an isolated catalog
and public synthetic/golden sources for media; commit no personal paths. Run preflight, obtain
independent Astra review, commit/push and merge sequentially. Packaged WebView startup/video
delivery requires rebuilt-app acceptance; do not infer it from development checks.

## Verification record

Browser acceptance used a disposable database/catalog and committed golden sources. Filename and
metadata-only Part number/Started/Remarks matches were explicit and highlighted. Manual replay,
guide expansion and Try file search opening the indexed picker passed. The bundled 12-second
1280×720 H.264 video reached readyState 4 and played; MP4 size is 243,275 bytes. Captured actual
rendered fixture screens contain no personal paths. No runtime video dependency was added.

Astra found keyboard-tooltip focus, Tauri development announcement eligibility, and slash/canonical
path explanation gaps. All were fixed and focused re-review was clean. Packaged startup and native
WebView media delivery remain unverified until a rebuilt app is launched.

Final preflight passed all four stages: all 183 backend/frontend test modules, type checking,
production bundle and version consistency (63.38 seconds). No version bump or release was made.
