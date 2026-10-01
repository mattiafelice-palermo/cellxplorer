# Spec 064 review

Reviewer: GPT 6 Astra, high reasoning. Independent review; implementer owns browser acceptance.

## Round 1 — findings and resolutions

- P1: Same-size changed sources could reuse old cycling facts after observed mtime advanced.
  Resolved by excluding persisted fallback facts unless the adopted source is online; registration
  remains separate. Added changed-source regression.
- P2: Open Cell linked to nonexistent `/library`. Resolved with established `/?cell=ID` route;
  browser verified loader closes and Cell detail opens.
- P2: Active chips renumbered conditions after omitting drafts. Resolved by retaining original
  draft array indexes. Added frontend regression.
- P2: Mapped drive root aliases omitted/duplicated a separator. Resolved with normalized path joins;
  drive-root mapping tested in both directions.
- P2: SQLite legacy SELECT behavior did not establish one relational read snapshot. Resolved with
  explicit owned BEGIN, no autoflush, and read snapshot release before regex execution. Added a
  concurrent WAL writer regression proving consistent metadata and subsequent freshness.
- UX: Range/facet result explanations omitted effective indexed values. Return these bounded
  values and prioritize their explanation ahead of generic header summaries.

## Verification recorded before round 2

- 11 focused backend tests, frontend policy/production-handler harness and TypeScript compile pass.
- Initial full no-cache preflight passes; final preflight is rerun for the final UI follow-ups.
- Actual disposable browser: filter discovery, cycle/date bounds, chips/reset, saved search restore,
  checkbox staging without tab switching, registered source Preview, current Cell match reason,
  Details without tab switching, Open Cell route, light/dark layouts and stable scrollbars.
- 50,000 catalog paths + 5,000 synthetic library relationships, seven rounds, including filter query,
  temporary relationship install, result decoration and JSON encoding: median text 153.5 ms,
  cycle range 509.1 ms, folder count 249.4 ms, relationship query 228.8 ms. HTTP, relational snapshot
  reads and filesystem indexing are excluded from these timings; no NAS latency claim.
- Actual private NAS and rebuilt installed WebView acceptance are deferred environment checks.

## Round 2

- P2: FTS candidate matching used the original term while literal matching accepted both path
  separators. Resolved by applying the same query variants to both branches; regression covers
  Cell notes with backslashes and queries using either separator.
- Independent focused closure verdict: **Clean. All identified findings resolved.** Reviewer
  reran the final regression and inspected the final no-cache preflight log.
- Final full preflight: **4/4 stages passed**, 165.79 seconds, including all backend/frontend
  tests, version consistency, frontend type check and production bundle.
- Final browser check: Show in folder opens the correct source directory; returning to indexed
  search preserves the applied filters and their effective-value explanations.

## Sizing, discovery and ordering follow-up

- Standardized controls and portal menu typography/spacing at modal UI zoom.
- Filter discovery opens matching sections, resets stale scroll offsets and
  preserves manual expansion for restoration when the query clears.
- Taller chips expose separate edit, ascending/descending order and remove
  actions; SQL ordering is whitelisted, global before pagination and places
  unknown values last. Existing saved-sort aliases remain accepted.
- Astra independently reran all seven frontend tests and the focused backend
  ordering regression: clean code review. Its high-zoom results-space concern
  was resolved with a bounded, independently scrolling chip area and omission
  of the empty indexed staging panel. Rendered closure: clean at 100% and 160%.
- Browser verification used disposable application data: automatic discovery,
  manual expansion restoration, range editing, both sort directions, checkbox
  staging, multiple chips, light/dark presentation and zoomed dropdown alignment.
- Astra focused closure for the zoom-aware portal menu correction: clean; rendered alignment
  and option typography verified at 130%.
- Initial final preflight: existing live-monitor rename test exceeded its ten-second spawned
  worker timeout under 16-worker load; filter tests, type check and production build passed.
  Full no-cache preflight rerun at four-worker CPU budget: **4/4 stages passed**,
  176.34 seconds, including the complete backend/frontend test suite.
