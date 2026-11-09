# 103 — Cell identification, useful warnings, cumulative quantities and FEC

Status: In progress. Non-implementable parent; one shared branch `codex/spec-103-analysis-usability`.
User-approved plan; preserve Specs 101–102 installation changes, add no dependencies,
and do not publish an installer. Implement children sequentially with pushed checkpoints.

## Locked behavior

1. Show current imported Cell names in disabled source hover tooltips and the right
   preview, with Open cell. Extend folder/header hints with cells [{id,name}], matching
   indexed results. Resolve actual path/hash/source-chain associations in bulk, without
   hover hashing/parsing. Refresh on opening and renaming. List multiple proven matches;
   registered sources without an attached Cell have no Open cell action.
2. Verified Permissive interpretation alone produces no analysis warning. Consolidate
   genuine MPR limitations into one collapsed source-count line, with Cell/source,
   concrete consequences and Open source details. Deduplicate, retain unrelated actionable
   notices, remove generic plot annotations and retain only relevant export qualifications.
   Cached responses must refresh interpretation status.
3. Backend prefix sums over full ordered source-chain cycle summaries, before display
   filtering: cumulative charge/discharge capacities, capacity throughput (sum), net
   coulomb imbalance (charge minus discharge), and equivalent four energy quantities.
   Positive directional magnitudes, mAh/mWh and existing mass normalization.
4. Combined-throughput FEC defaults to sum(Qcharge+Qdischarge)/(2*Qreference).
   Discharge-based FEC is sum(Qdischarge)/Qreference. Resolve a fixed per-Cell effective
   nominal reference; expose it. Missing references disable FEC only. Missing required
   values stop dependent cumulative values from the first gap; never restart or use zero.
5. All recorded cycles count, even hidden diagnostic/formation cycles. Derive members
   before fixed-cohort group aggregation. Any included unknown member stops a group
   cumulative/FEC point. FEC X uses member-mean FEC at indexed-cycle alignment, no interpolation.
6. FEC is available as Y and optional X; retain scientific cycle identity separately.
   Persist convention/axis in plots and portable reports; old plots keep indexed-cycle X.
   Update hover, inspection, references, thumbnails, CSV/XLSX, images and portable rendering.
   Version Cycles responses/dependencies without changing primitive cache identities.

## Children

- [103.1 — Imported Cell identification](103.1-imported-cell-identification.md)
- [103.2 — Useful source limitations](103.2-useful-source-limitations.md)
- [103.3 — Cumulative quantities and FEC](103.3-cumulative-quantities-and-fec.md)

## Final gates

Focused identity/warning/numerical/continuation/gap/group regressions; browser acceptance
in light/dark; saved/export/portable parity; canonical preflight and appropriate frozen
scientific/packaging checks preserving archive-backed timezone/audited Arrow behavior.
No skipping local launcher failures; use clean-Windows verification if needed.
Independent GPT-6 Astra review of final diff/evidence; fix, retest and repeat until clean.
Only then merge and push main. No real-library mutation or installer publication.
