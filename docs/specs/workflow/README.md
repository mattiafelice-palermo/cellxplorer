# Implementer/Reviewer Spec Workflow

This folder contains CellXplorer's lightweight two-agent spec workflow.

The workflow separates three responsibilities:

- `docs/specs/NNN-agent-state.json` — machine-readable **source of truth** for turn/state;
- `docs/specs/NNN-agent-coordination.md` — timestamped append-only communication/handoff log;
- `docs/specs/reviews/...-review.md` — canonical technical review findings (`R1`, `R2`, ...).

The specs define what to build. `AGENTS.md` and topic-specific repository guidance define how to work in the codebase.

## Core lifecycle

```text
REVIEWER initializes
        ↓
IMPLEMENTER implements ACTIVE_CHILD
        ↓
IMPLEMENTER verifies + handoff-review
        ↓
REVIEWER reviews code/tests
        ├── defects → request-fixes → IMPLEMENTER fixes → handoff-review → re-review
        └── clean   → review-clean
                         ├── next child → IMPLEMENTER
                         └── no child   → FINAL_REVIEW
                                           ├── fixes required → normal finding loop
                                           ├── external gate unavailable → BLOCKED
                                           └── clean + evidence complete → COMPLETE
```

No scheduled tasks, automations, heartbeat jobs, or background polling are part of this workflow. Agents act when activated by the user or while already executing their current owned turn.

## Initialize

The reviewer initializes after the feature branch and specs exist:

```bash
python docs/specs/workflow/spec_workflow.py init NNN
```

Optional explicit branch check:

```bash
python docs/specs/workflow/spec_workflow.py init NNN --branch feature/example
```

Numeric children `NNN.1-*.md`, `NNN.2-*.md`, ... are discovered automatically. If none exist, the standalone spec `NNN` becomes the active child.

Initial state is always:

```text
TURN: IMPLEMENTER
ACTION: IMPLEMENT
ACTIVE_CHILD: first child
FINDINGS: NONE
```

Commit/push the generated state and coordination files.

## Read status

```bash
python docs/specs/workflow/spec_workflow.py status --spec NNN
```

If exactly one workflow state is active, `--spec` may be omitted. The committed JSON state is authoritative.

## Clarification messages without handoff

Implementer and reviewer should use `message` whenever a material ambiguity can be resolved by asking the other agent instead of guessing or spending an avoidable review cycle.

```bash
python docs/specs/workflow/spec_workflow.py message --spec NNN --role IMPLEMENTER \
  --message "Question: does acceptance criterion X require Y or Z?"

python docs/specs/workflow/spec_workflow.py message --spec NNN --role REVIEWER \
  --message "Clarify: was behavior X intentional, and what evidence supports it?"
```

A clarification message:

- appends a timestamped entry to `docs/specs/NNN-agent-coordination.md`;
- does **not** alter `TURN`, `ACTION`, `ACTIVE_CHILD`, findings, or state JSON;
- may be sent by either role even when that role does not own the current turn;
- does not authorize the non-owner to change implementation, findings, or workflow state.

Commit/push the coordination entry so the other agent can read it. Replies use the same command with the opposite role.

Use messages for genuine uncertainty. A reviewer must still raise a concrete defect, spec deviation, regression risk, or required verification gap as an `R*` finding rather than turning it into a question.

## Implementer handoff

While `TURN: IMPLEMENTER`, follow `ACTION` exactly:

- `IMPLEMENT` — implement only `ACTIVE_CHILD`;
- `FIX_REVIEW` — fix only the unresolved `R*` findings in state/review.

Before handoff, run the focused verification required by the active spec/review and the repository's current canonical aggregate validation when applicable. Report only checks actually run.

Then:

```bash
python docs/specs/workflow/spec_workflow.py handoff-review --spec NNN \
  --verification "focused tests: PASS" \
  --verification "python scripts\\preflight.py: PASS" \
  --message "Concise implementation context."
```

Commit implementation + state + coordination together and push.

## Reviewer findings

Canonical review files are separate from specs and live in `docs/specs/reviews/`.

Naming:

```text
docs/specs/NNN-name.md
→ docs/specs/reviews/NNN-name-review.md

docs/specs/NNN.1-child.md
→ docs/specs/reviews/NNN.1-child-review.md
```

Each finding uses a stable `R1`, `R2`, ... identifier and contains:

- priority;
- affected files;
- **Current**;
- **Target**;
- **Acceptance criteria**.

If changes are required:

```bash
python docs/specs/workflow/spec_workflow.py request-fixes R1 R2 --spec NNN \
  --message "Concise review context."
```

Commit review + state + coordination together and push.

## Clean child review

When the active child is clean:

```bash
python docs/specs/workflow/spec_workflow.py review-clean --spec NNN \
  --message "Child review clean."
```

The helper either advances to the next child with `TURN: IMPLEMENTER / ACTION: IMPLEMENT`, or leaves the reviewer in `FINAL_REVIEW` after the last child.

## Final parent review

`FINAL_REVIEW` is cumulative. Review the entire branch against the **correct merge base**, all locked parent decisions, cumulative regressions, required evidence, documentation closure, and merge readiness.

If implementation fixes are needed, use the normal `request-fixes` loop. If clean and all required evidence exists:

```bash
python docs/specs/workflow/spec_workflow.py complete --spec NNN \
  --message "Cumulative parent review clean; feature ready to merge."
```

If implementation is clean but a required external/manual acceptance dependency is unavailable:

```bash
python docs/specs/workflow/spec_workflow.py block --spec NNN \
  --message "Exact external dependency preventing completion."
```

Later, when that dependency is actually available:

```bash
python docs/specs/workflow/spec_workflow.py resume-final-review --spec NNN \
  --message "Required external dependency is now available."
```

Re-run the cumulative final review before `complete`; never jump directly from `BLOCKED` to `COMPLETE`.

## Ownership rules

- Implementation code changes require `TURN: IMPLEMENTER`.
- Review-state/findings changes require `TURN: REVIEWER`.
- Clarification messages are the only operation intentionally allowed from the non-owner.
- Never modify unrelated user work.
- Never claim a command, browser check, packaged check, or manual check passed unless it actually ran.
- Use the repository's current validation commands rather than remembered commands.

## User-driven checks

When ownership is with the other agent, do not create a polling daemon or scheduled action. The user may ask the reviewer/implementer to check the branch again; on that activation, refresh remote state and continue only if ownership/action requires it.
