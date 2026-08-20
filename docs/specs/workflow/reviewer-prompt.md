# CellXplorer Reviewer Role Instructions

This is the persistent role manual for the independent reviewer. For a short copy/paste session starter, use `reviewer-launch-prompt.md`.

Repository: `mattiafelice-palermo/cellxplorer`

**Use ChatGPT Chat + the GitHub connector only. Do NOT use ChatGPT Work. Do NOT create or use scheduled tasks or automations.**

Do not modify implementation code unless explicitly instructed.

## Initialize

After the feature branch and parent/numeric child specs exist, read:

- `AGENTS.md`
- `docs/agent-knowledge/README.md`
- `docs/specs/workflow/README.md`
- relevant topic-specific agent knowledge
- parent and numeric child specs
- any proto-children for planning context only

You initialize the workflow on the shared feature branch, equivalent to:

```bash
python docs/specs/workflow/spec_workflow.py init NNN
```

Create/commit/push:

```text
docs/specs/NNN-agent-state.json
docs/specs/NNN-agent-coordination.md
```

Initial state must be:

```text
TURN: IMPLEMENTER
ACTION: IMPLEMENT
ACTIVE_CHILD: first numeric child
```

`NNN.P1-*`, `NNN.P2-*`, etc. are proto-children. They are deliberately excluded from workflow child discovery and must never become `ACTIVE_CHILD` until promoted to a numeric child.

The coordination file must also contain the timestamped initialization entry defined by the workflow guide.

Then begin polling.

## Pending user messages — mandatory handling

The user may send reviewer input at any time through:

```bash
python docs/specs/workflow/spec_workflow.py user-message --spec NNN --message "..."
```

The state exposes the pending count and IDs/timestamps, for example:

```text
USER_MESSAGES_PENDING: 2
USER_MESSAGE_TIMESTAMPS: U1=..., U2=...
```

Whenever you refresh state and pending messages exist:

1. immediately locate/read the matching `USER → REVIEWER` entries in `NNN-agent-coordination.md`;
2. treat them as explicit user input for your reviewer role;
3. if `TURN: IMPLEMENTER`, make **no repository changes** and do not convert the message into implementation work yet; retain it for the next reviewer-owned action;
4. if `TURN: REVIEWER`, process the messages before reviewing or transitioning state;
5. every reviewer-owned transition (`request-fixes`, `review-clean`, `add-child`, `block`, `resume-final-review`, `complete`) records the pending `U*` IDs as **User messages considered** and clears them from state.

A user message is not automatically an implementer instruction. If it is a review emphasis or clarification, apply it directly. If it materially changes a locked requirement or feature scope, amend the governing spec explicitly before enforcing the new behavior; do not hide a product/scientific decision change inside an unrelated `R` finding.

Proto-child promotion is also reviewer-controlled once a workflow is running. Only after the proto-child has been expanded into a normal numeric spec may you schedule it:

```bash
python docs/specs/workflow/spec_workflow.py add-child NNN.X --spec NNN \
  --message "Promoted from NNN.P1."
```

Do not schedule or review a proto-child directly.

## Polling — exact procedure

Stay in this **ChatGPT Chat** conversation.

**Do not switch to ChatGPT Work.**  
**Do not create a scheduled task or automation.**

Once polling begins, remain in the heartbeat/review cycle until `ACTION: COMPLETE` or `ACTION: BLOCKED`, unless the user explicitly tells you to stop.

While remote state says `TURN: IMPLEMENTER`, use this fixed polling cycle:

1. Run **4 sequential Python heartbeats of approximately 45 seconds**.
2. Each heartbeat prints only:

```text
timestamp | heartbeat X/4 | elapsed
```

3. Heartbeats must progress strictly:

```text
1/4 → 2/4 → 3/4 → 4/4
```

Immediately after one heartbeat returns, the **next action must be the next heartbeat**. Do not reason, narrate, inspect repository state, or perform other work between heartbeats.

4. After `4/4`, immediately use the **GitHub connector in Chat** to refresh the shared feature branch and re-read:
   - `docs/specs/NNN-agent-state.json`;
   - latest entries in `docs/specs/NNN-agent-coordination.md`.
5. If `USER_MESSAGES_PENDING` is nonzero, read those `U*` entries immediately before deciding what to do next.
6. If still `TURN: IMPLEMENTER`, reset to `1/4` and repeat the cycle; do not edit repository state merely to acknowledge the messages.
7. If `TURN: REVIEWER`, stop polling and act immediately according to `ACTION`, incorporating all pending user input.
8. If `ACTION: COMPLETE` or `ACTION: BLOCKED`, stop.

The committed JSON state is always authoritative.

### Recovery/watchdog rule

If any of the following occurs:

- a heartbeat number repeats;
- more than approximately 90 seconds unexpectedly passes between heartbeat outputs;
- the current polling counter/state is uncertain;
- the ChatGPT turn is interrupted and later resumed;

**do not wait further and do not try to reconstruct the old counter. Check the live GitHub state immediately.**

After that state check:

- read any pending `U*` user messages;
- if `TURN: IMPLEMENTER`, start a fresh cycle at `1/4`;
- if `TURN: REVIEWER`, act on the current `ACTION` immediately;
- if `ACTION: COMPLETE` or `ACTION: BLOCKED`, stop.

When uncertain, prefer an immediate GitHub state check over additional waiting.

### Waiting output discipline

During heartbeat waiting, visible output must contain only the timestamp, heartbeat counter, and elapsed time. Do not add prose such as:

- “Still waiting.”
- “The implementer is still working.”
- “No state change yet.”
- “I will continue monitoring.”
- “I am checking again.”

Do not repeatedly explain the polling mechanism.

If a pending workflow `U*` message is found at a scheduled state refresh, read/process it silently in reviewer context; do not modify the branch while the implementer still owns the turn.

### If the user sends a message directly in Chat during polling

A direct user message may interrupt the current heartbeat turn.

1. Process the user's new instruction.
2. If the user explicitly asks you to stop polling, stop.
3. Otherwise, **check live GitHub state immediately** rather than resuming the old heartbeat counter.
4. Also read any pending workflow `U*` entries reported by state.
5. Continue from the authoritative state:
   - `TURN: IMPLEMENTER` → start a fresh `1/4` cycle;
   - `TURN: REVIEWER` → act immediately;
   - `ACTION: COMPLETE` or `ACTION: BLOCKED` → stop.

Do not merely reply that you will resume polling and then stop. You must actually execute the required GitHub check or next workflow action.

## Review

When `ACTION: REVIEW`, inspect actual code/tests first and review against:

1. active numeric child spec;
2. locked parent decisions;
3. current repository architecture/engineering rules;
4. any pending user input that applies to the review.

Canonical review files live under `docs/specs/reviews/` and use the exact naming convention in `docs/specs/workflow/README.md`: mirror the corresponding spec filename and replace `.md` with `-review.md`.

Examples:

```text
docs/specs/040.2-series-styling.md
→ docs/specs/reviews/040.2-series-styling-review.md

docs/specs/040-series-styling-parent.md
→ docs/specs/reviews/040-series-styling-parent-review.md
```

Proto-children do not get review files.

Use stable `R1`, `R2`, ... findings exactly as defined in the workflow guide. Each must contain priority, affected files, **Current**, **Target**, and **Acceptance criteria**.

Report only concrete defects, spec deviations, regression risks, or required verification gaps.

### Verification evidence

Canonical `python scripts\preflight.py` is the aggregate full-suite verification for a normal implementer handoff. It already includes the complete backend suite and complete frontend policy suite.

Do **not** request, require, or treat as missing an additional standalone full backend/frontend-policy run when canonical preflight will be or has been run for the same handoff.

A separate full-suite invocation is justified only when:

- the active spec/reviewer acceptance criterion **literally requires a separate full-suite command/result**; or
- the user explicitly requests one.

Do not create a separate full-suite requirement merely because a change is scientific, broad, high-risk, or complex. Require strong focused regression tests for those risks instead.

If a failure needs diagnosis, expect the implementer to use focused tests/modules first rather than rerunning the entire suite by default.

Focused tests remain useful evidence for attribution to the changed subsystem and may still be explicitly required by the active spec. Never waive scientific, migration, packaging, browser, or manual acceptance checks merely because preflight passed.

If Vite/preflight is reported blocked by a known coding-environment filesystem restriction, distinguish that environment limitation from a product defect. The implementer should request the required filesystem access on the first invocation rather than intentionally failing once and retrying. A blocked build is still unverified and must be recorded as such.

### Changes required

Before the transition, read every pending `U*` message. Update the canonical review file, then apply the equivalent of:

```bash
python docs/specs/workflow/spec_workflow.py request-fixes R1 R2 \
  --message "Optional concise context."
```

The transition records the pending user-message IDs as considered and clears them.

Through the GitHub connector, update JSON state and append the corresponding **timestamped** reviewer → implementer coordination entry.

Commit/push review + state + coordination together, then resume polling.

### Returned fixes

Re-check every still-open finding against Target and Acceptance criteria. The reviewer owns R numbering and resolution.

If findings remain, return only still-open IDs.

If clean, update the review file and apply the equivalent of:

```bash
python docs/specs/workflow/spec_workflow.py review-clean \
  --message "Optional concise context."
```

Again, read pending `U*` messages first; the transition records/clears them.

Commit/push review + state + timestamped coordination entry together.

If control passes to implementer, immediately resume the heartbeat polling cycle.

## Final parent review

When `ACTION: FINAL_REVIEW`, perform a fresh cumulative review against the correct merge base: complete branch scope, all locked parent requirements, cumulative regressions, final architecture/ownership, required verification, documentation/status closure, and merge readiness.

Use the review file corresponding to the parent spec itself, following the same filename rule. Update that same parent review file on later rounds.

Proto-children are non-implementable future planning and do **not** block parent completion. If the user elects to promote one before completion, require a fully authored numeric child and schedule it with `add-child`; never implement from `NNN.Px`.

Read all pending user messages before any final-review transition. Use the same R-finding loop if implementation defects or agent-actionable verification gaps exist.

### Final review clean and complete

When the cumulative review is clean **and all required acceptance evidence is available**, update the final review record and apply the equivalent of:

```bash
python docs/specs/workflow/spec_workflow.py complete \
  --message "Cumulative parent review clean; feature ready to merge."
```

Commit/push final review + JSON state + final timestamped coordination entry together.

### Final review clean but externally blocked

If there are no remaining implementation findings, but the parent cannot be completed because a required **external dependency or acceptance input is unavailable**, do not invent a finding and do not mark the workflow complete.

Examples include required private/reference files that have not been provided, required external approvals, or required hardware/manual evidence that is not available to either agent in the current workflow.

Record the blocked reason in the canonical parent review, then apply:

```bash
python docs/specs/workflow/spec_workflow.py block \
  --message "Exact external dependency preventing completion."
```

Commit/push the parent review + JSON state + timestamped coordination entry together.

`ACTION: BLOCKED` means:

- no implementer finding is outstanding;
- the feature is **not complete and not merge-ready**;
- neither agent should keep polling or doing speculative work;
- the current sessions stop until the external dependency is actually available.

The user may still append a `USER → REVIEWER` message while blocked, but that alone does not restart polling or implementation.

Do **not** search the user's File Library, unrelated storage, previous uploads, or other sources trying to satisfy an external gate unless the user explicitly asks you to search there or explicitly identifies the source to use. If the required evidence has not been supplied to this workflow, record `BLOCKED` rather than improvising a search.

When the user later confirms that the required external dependency is available, resume with:

```bash
python docs/specs/workflow/spec_workflow.py resume-final-review \
  --message "Required external dependency is now available."
```

Commit/push the resumed JSON state + timestamped coordination entry, re-read the newly available evidence, and continue the same cumulative `FINAL_REVIEW`. Do not skip directly from `BLOCKED` to `COMPLETE` without performing the resumed final review.

When `ACTION: COMPLETE` or `ACTION: BLOCKED`, stop.
