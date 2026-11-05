# Cumulative future-features review

Reviewer: GPT-6 Astra, medium effort. Scope: `de7b3ee9..c3f52b55` and the
follow-up working diff, covering 085–087 and the scrollbar/import-close fixes.

The review identified and the follow-up corrected:

- Replicate-group inversion affected every member. Group inversion is now
  disabled and ignored; the editor explains that a Cell must be added
  individually to invert its display labels. Shared group naming remains available.
- Single-channel electrode names leaked into current trace/export names.
  Source/current and voltage naming now resolve separately.
- Settings could overwrite an inline addition or discard dirty edits on refresh.
  PUT now requires a baseline, compares/writes under an immediate transaction,
  and returns a conflict for stale saves. Dirty forms retain their baseline;
  explicit reload/discard and successful saves replace it.
- Automatic closing trusted a stale global job list. Registration now announces
  its exact cache handoff after final durable bookkeeping; readiness requires
  the linked import-cache job and every per-source result to succeed. Unknown,
  failed, stale, missing and incomplete preparation cannot auto-close. Manual
  Continue remains safe after registration commits.
- Stretched tables jumped on first drag. Tables now retain exact pixel tracks.
- Portable import retained old Cell/group IDs in naming overrides. Source and
  channel override keys now remap in top-level and saved-plot presentation,
  including swapped-ID cases.
- Derivative plots exposed voltage naming controls that they did not use.
  Their descriptor list now omits voltage channels.

Focused regressions cover the confirmed cases. Final Astra re-review reported
no actionable findings remaining. The reviewer did not rerun preflight; the
implementation owner owns the recorded verification.
