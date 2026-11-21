# 111 — Virtual cells for BioLogic experiments

**Status:** Planned. Non-implementable parent. The seven children below are the implementation units on the shared branch `codex/spec-111-virtual-cells`. Implement sequentially, commit and push each tested checkpoint, and merge after the final integration check.

## User workflow

A researcher cycles cell A, stops it, and analyzes the discharge and the individual protocol steps. After replacing the cathode they resume cycling and register that run as cell B. **Create virtual cell** gives them a combined timeline with a visible *Cathode replaced* boundary. They can still open A, inspect B, compare steps from both, or choose **Ungroup virtual cell** later.

**Virtual cell** is the user-facing and domain name. A and B are ordinary physical Cell records, each with its own identity, metadata and ordered source chain. V is a separately identified, named, ordered reference to those cells, with a recorded join between each adjacent pair. Each source file has one physical owner. Analysis interfaces resolve V to measurements through an adapter. Creating V writes its definition and tracking coordination state. It never creates a second internal Test for a cell, transfers files or duplicates raw caches.

## First implementation scope

- Accept two or more distinct physical cells whose registered sources are all BioLogic MPR. Check actual registered format and supported measurements. Apply each source's existing read-mode and capability limits. An OCV source can contribute voltage while supplying no cycle summary. Require some supported measurements in each selected run, and explain any partially unavailable data in preview.
- Physical sources stay in their existing order within each member. The user confirms the order of the members. Show the actual measurement bounds when available. Require an explicit join choice, **Cycling resumed** or **Electrode or setup changed**, plus an optional note. File names and time gaps alone cannot identify an electrode replacement.
- Each physical run can participate in one active virtual cell in the pilot, so the effective tracker is unambiguous. Retired references in saved analyses do not prevent regrouping. Virtual cells cannot be nested. Eligibility applies on creation, reorder and later member source changes, including automatic appends. Physical cells keep their normal source-editing capabilities. If an ordinary physical operation introduces an ineligible source, flag V as outside the pilot, withhold new whole-experiment results, and offer review or ungroup. The physical edit succeeds under its ordinary rules. Never quietly omit the new source from the timeline.
- Use an explicit subject kind at API, selection and cache boundaries. Physical-only callers continue to resolve ordinary cells. The virtual subject carries run provenance, reference values and joins through plotting, analysis and export. No changes to BioLogic decoding are needed to represent membership. Future suppliers can add eligibility without changing the meaning of Virtual cell.

## Lifecycle contract

| Surface | Create V from A → B | While V is active | Ungroup V |
|---|---|---|---|
| Database and editing | Create an expandable V entry. Keep the original cell IDs and records. | Search or expand to open A or B with its normal details, metadata and source actions. Original project/folder/replicate references still identify their original member. | Show A and B independently again, with their current names, files and metadata. Remove V from the active picker. |
| Existing analyses of A or B | Preserve selections, plots, protocol segments and original references. | A-only plots see A. B-only plots see B and receive ordinary updates when B grows. Grouping does not freeze a live analysis. | They reopen as before. Never automatically substitute V, split a series, or change a replicate average. |
| Analysis explicitly using V | Select V to obtain the combined timeline or cycle series. Record its identity in the analysis. | Resolve both member chains in order. An append to B is visible under the ordinary adoption/update policy. | Keep a retired, read-only definition for saved analyses that reference V, including final source membership, joins and reference context. Subsequent additions to the independent runs do not silently extend that retired timeline. Historical raw/cache availability follows normal pinned-source rules. |
| Steps and protocol analyses | Existing Steps plots for A and B keep their series. A new V selection offers individual run choices. | Select A, B or separate series for both. Use each run's protocol signature, programmed step numbers, execution boundaries and existing capability guard. The whole-experiment selection on another tab must not block unrelated eligible Steps series. | Saved A and B series retain their IDs, labels and protocol targets. A saved V analysis can reopen its run-scoped series. No re-numbering or automatic remapping of steps. |
| Tracking the growing file | The effective tracked file is the last source of B, the final run in the confirmed order. | B owns tail updates. V reflects the result. Earlier runs retain their settings and manual inspection. | Release delegation. Each run resumes its own configured monitoring policy. Recheck the current tail before applying pending work. |
| Watching a folder for new files | Use B's existing folder-watch settings. If B's watch is off, automatic discovery stays off. | Only B's effective watch can append. A new file C belongs to B, and C becomes the new tracked tail. A's saved watch preferences are preserved. | C stays attached to B. Restore independent watch eligibility using the actual current settings and revalidate pending candidates. |
| Destructive/source changes | Include dependent virtual uses in impact checks. | Deleting or detaching a referenced run/source previews impact on both originals and V. Concurrent combine, append and ungroup operations recheck the inspected revision. | Ungrouping never deletes original cells or files. Retained analyses participate in later removal-impact checks. |

## Scientific meaning of a join

**Cycling resumed.** Preserve normal continuation behavior, including the default programmed-cycle view. A selected discharge-first convention may pair a discharge in A with the next charge in B when the existing measurement evidence supports it. Keep each original run's own analysis and local cycle/step identities accessible.

**Electrode or setup changed.** Draw and label a boundary. Retain the measured voltage, current, capacity and gap information. End phase and cycle pairing at the boundary, keep unmatched measurements visible, and start a new local baseline for retention and normalized lifetime metrics. Global cycle numbering can continue across complete cycles. Apply the effective mass, nominal capacity and electrode area for the contributing run. A missing or incompatible reference affects only quantities that require it.

**Protocol scope.** In A, step 2 may discharge the cell. In B, step 2 may be a rest. Choosing both in Steps yields two identifiable run-specific series. An individual run that is already multi-source retains its existing protocol-mapping limits. DCIR, Chargeability and C-rate also operate within eligible runs. Explicit equivalence mapping or pooled protocol recognition across runs is future work.

## Implementation and verification

| Child | Deliverable |
|---|---|
| [111.1 — Identity, storage and resolution](111.1-virtual-cell-identity.md) | Schema, migration, eligibility and typed source resolution. |
| [111.2 — Combine, ungroup and tracking](111.2-virtual-cell-lifecycle.md) | Atomic create/ungroup and both kinds of tracking. |
| [111.3 — Join-aware timeline and preview](111.3-virtual-cell-timeline.md) | Shared preview and Time / capacity read path. |
| [111.4 — Cycles and scientific references](111.4-virtual-cell-cycle-metrics.md) | Global cycles, run-specific normalization and baselines. |
| [111.5 — Existing analyses, Steps and overlap](111.5-virtual-cell-analysis-selection.md) | Run-scoped protocol series, saved analyses and overlap checks. |
| [111.6 — Library actions and reversible preview](111.6-virtual-cell-library.md) | Library and picker workflow, impact previews and accessibility. |
| [111.7 — Portable reports and pilot verification](111.7-virtual-cell-portable-closure.md) | Portable report round trip, regression coverage and pilot activation. |

The release scenario starts with saved analyses of A and B. Combine them after a cathode replacement, plot V and compare their Steps, append a new MPR to B, export the analysis, ungroup, restart and reopen all three analyses. Verify ownership, monitoring, source membership, step meanings, masses and plot values. Repeat with a simple restart to prove that an admissible cross-file pair still works. Check that selecting V together with B cannot count B twice in statistics.

## Existing implementation anchors

- [Physical ownership and watch tables](../../backend/app/models.py), [impact previews](../../backend/app/services/analysis_usage.py), [file monitoring](../../backend/app/services/source_monitor.py) and [folder discovery](../../backend/app/services/cell_folder_watch.py).
- [Analysis selection and protocol guards](../../backend/app/services/analysis_engine.py), [step executions](../../backend/app/services/step_blocks.py), [current protocol guard regressions](../../tests/test_protocol_analysis_safety.py) and [editor capability policy](../../frontend/src/features/analyses/editor/policies/multiSourceAnalysisPolicy.ts).
- [Continuation preview](../../backend/app/services/continuation_preview.py), [analysis cycle pairing](../../backend/app/services/analysis_cycle_pairing.py), [scientific cache keys](../../backend/app/services/analysis_cache.py) and [portable reports](../../backend/app/services/portable_analysis.py).
