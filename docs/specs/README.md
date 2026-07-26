# Feature specs

Implementation plans for requested features. One Markdown file per request (or per coherent
batch of related requests). Each spec is written to be followed closely by an AI agent that
did **not** see the originating conversation, so it must be self-contained:

- State what already exists (files, functions, endpoints) so nothing is rebuilt.
- For each task: the exact file(s), current behaviour, target behaviour, and acceptance
  criteria. Reference code with grep-able anchors, not just line numbers (they drift).
- Call out data shapes, API endpoints, and any cache/recompute implications.
- End with a suggested implementation order and how to verify (`tsc`, `vite build`, `pytest`).

## Lifecycle

A spec is a living document, not a one-shot brief:

1. **Plan** — the sections above, written before implementation.
2. **Implement** — the agent follows the spec.
3. **Review** — a reviewer appends a `# Review of the implementation — follow-up tasks`
   section to the **same file**, containing:
   - the verification actually run (commands + results), so nobody repeats it;
   - what was confirmed correct by reading the code, so nobody re-litigates it;
   - any pre-existing/known failures, explicitly flagged as *not* to be "fixed";
   - each finding as a numbered follow-up task (`R1`, `R2`, …) in the same
     file / current / target / acceptance format, with a priority;
   - what remains unverified (e.g. anything needing a real browser or the shared dev DB).

The implementing agent then works the `R*` tasks from the same document.

### Handoff prompt

Paste this to the implementing agent, filling in the spec number. Add a short "watch out for"
line only when a task carries a hazard the spec cannot fully express (e.g. "R1 can only be
verified in a packaged build").

```
Implement the review follow-ups in docs/specs/NNN-<name>.md.

Read the whole file first. The spec body is the source of truth for intended behaviour;
the "Review of the implementation" section at the end lists the tasks (R1, R2, ...).

Rules:
1. Do the R tasks in the order given under "Follow-up order", and only those. No
   unrelated refactors, no scope expansion.
2. The review's "What the review verified" list is settled. Do not re-check, re-derive
   or "improve" those — changing them is a regression, not a cleanup.
3. Decisions marked locked in the spec body stay locked. If a task seems to require
   breaking one, stop and ask instead of deciding for yourself.
4. Anything the review flags as a known/pre-existing failure is out of scope. Do not
   try to fix it.
5. Prefer patterns already used in this repo over inventing new ones — the review
   usually names the file that already does it right.
6. Run the checks in the spec's Verification section for the parts you touched. If a
   task cannot be verified in your environment, say so plainly rather than assuming
   it works.
7. When done, append a "## R* implementation record" to the same spec file: what
   changed per task, what you ran and the result, and anything you deliberately did
   not do.
8. Do not modify unrelated uncommitted work in the tree.

Ask if a task is ambiguous rather than guessing.
```

The result comes back for review, which appends `R*` outcomes to the same file — the loop
continues until the section is clean.

### Review effort

Reviews are **code reading first**. The implementer has normally already run `tsc`, the build,
and the test suite, so do not re-run them by default — say in the review that they were taken
as given. Spend the time on the things reading catches and tooling does not: correctness of the
core logic, spec deviations, and hazards the spec did not anticipate.

Run something only when it is cheap **and** decisive for a specific doubt — e.g. a single new
unit-test file that pins the change's core rule, or a read-only probe against real cached data
to confirm a numeric claim. Always state what was run and what was taken on trust.

**Beware of greps that cannot see the thing you are auditing.** A negative grep result only
proves the pattern you searched for is absent. Spec 004's review wrongly declared the dark-mode
sweep complete after grepping hex literals in `.tsx`; the remaining light surfaces were in
`bg="gray.0"` props and `.module.css` files, which that pattern could never match. When
auditing theming in this Mantine codebase, cover **all** of: hex literals, `bg="<colour>.0"` /
`.1` props, `var(--mantine-color-*-0)`, `--mantine-color-white`, and every `*.module.css`.
Numbered Mantine shades are fixed in both schemes — only semantic tokens and `light-dark(…)`
respond to the colour scheme.

## Naming

`NNN-short-kebab-title.md`, where `NNN` is a zero-padded counter that increments per spec
(`001-`, `002-`, …). The number is assigned when the spec is created and never reused, so it
is a stable handle to reference a spec in conversation ("finish 002") regardless of title
edits. Keep the index below in order.

## Index

- [001-folders-replicates-and-recognition-ux.md](001-folders-replicates-and-recognition-ux.md)
  — folder/replicate placement refinements (project view + cell database), a read-only
  protocol-structure viewer for C-rate/Chargeability auto-identification (item 2), and a
  realistic recognition progress bar replacing the spinner (item 9).
  **Implemented; reviewed — follow-ups R1–R3 done.**
- [002-place-in-folders-picker-redesign.md](002-place-in-folders-picker-redesign.md) —
  redesign of the "Place in folders" dialog: collapsible folder tree with search, read-only
  impact pane, and a strictly **additive** model (removal stays in the Projects view).
  Frontend-only. **Implemented; reviewed — follow-ups R1–R4 done.**
- [003-per-cycle-capacity-step-reset-fix.md](003-per-cycle-capacity-step-reset-fix.md) —
  scientific-correctness fix: `per_cycle` took a per-cycle **maximum** of Neware capacity and
  energy counters that **reset at every step**, so a CC+CV charge lost its CV portion and
  coulombic efficiency read above 100 %. Now summed per step. Backend + `CALC_VERSION` bump.
  **Implemented and verified against real data.**
- [004-app-shell-quick-settings.md](004-app-shell-quick-settings.md) — desktop-feel app shell:
  suppress the browser context menu except in text fields, and add a quick-settings menu to the
  top-right strip (reload interface, restart CellXplorer, theme, pause automatic updates).
  Includes dark mode, scoped to the chrome — **plots stay light**.
  **Implemented; reviewed — follow-ups R1–R4 done (R1 still needs a packaged Restart click).**
- [005-warmup-queue-deadlock-fix.md](005-warmup-queue-deadlock-fix.md) — a failed thumbnail or
  artifact lookup left a warmup task with no terminal state, latching `busy` and stalling the
  background queue for the whole session (missing thumbnails, uncached analyses). Completion
  logic extracted to one tested pure resolver, plus a per-task watchdog. Frontend-only.
  **Implemented.**
- [006-destructive-impact-warnings-and-draft-plots.md](006-destructive-impact-warnings-and-draft-plots.md)
  — (A) warn which analyses and saved plots an explode/cell-removal will affect, including ones
  left with no samples, via a new read-only `/api/analyses/usage` endpoint; (B) make an unsaved
  plot visible as an amber draft card that can survive leaving the analysis. **Implemented.**

## Assets

Mockups and reference images live in `assets/`, named after the spec that owns them
(`assets/002-place-in-folders.png`). Reference them from the spec with a relative Markdown
image link, and state explicitly whether the image or the written rules win where they
disagree.
