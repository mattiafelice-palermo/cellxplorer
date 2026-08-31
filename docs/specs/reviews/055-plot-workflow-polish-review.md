# Spec 055 — Plot workflow polish — Parent review

## Status

**In progress.** Children are reviewed sequentially under `spec_workflow`.

## Deferred final acceptance gate

By explicit user decision on 2026-08-31, the formal manual UI confirmation for Spec 055 is deferred until the **end of the full parent specification**.

This is a timing decision, **not a waiver**. Before Spec 055 can transition from `FINAL_REVIEW` to `COMPLETE`, the reviewer must record the final manual confirmation for the implemented plot workflow, including the 055.1 export/dirty-state acceptance that was previously tracked as child finding R2.

At minimum, final parent acceptance must verify the completed workflow in the real intended UI across the relevant plot families and confirm that:

- export/preview does not create false saved-plot dirty state;
- real persistent edits remain dirty across export;
- discard/reopen restores the persisted saved view and leaves `Update` disabled;
- 055.2 saved-plot rename behavior works as specified;
- 055.3 show-only/show-all behavior and legend interaction work as specified.

Do not mark this parent review complete until that manual confirmation is explicitly recorded.
