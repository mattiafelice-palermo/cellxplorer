# CellXplorer Implementer/Reviewer Workflow

This folder contains the lightweight two-agent workflow used to implement CellXplorer specs.

The workflow deliberately separates three responsibilities:

- `docs/specs/NNN-agent-state.json` — the **single source of truth for turn/state** plus compact pending user-message metadata;
- `docs/specs/NNN-agent-coordination.md` — the **timestamped append-only communication log** between user, implementer, and reviewer;
- `docs/specs/reviews/...-review.md` — the **canonical technical review**, including `R1`, `R2`, etc.

The specs define what to build. `AGENTS.md` and `docs/agent-knowledge/` define how CellXplorer code should be changed.

The long files `reviewer-prompt.md` and `implementer-prompt.md` are role instructions. For starting a fresh agent session, use the short copy/paste prompts in `reviewer-launch-prompt.md` and `implementer-launch-prompt.md`.

## 1. Complete workflow

The **reviewer initializes the workflow** after the feature branch and parent/child specs exist.

```text
REVIEWER initializes workflow
        ↓
IMPLEMENTER implements ACTIVE_CHILD
        ↓
IMPLEMENTER verifies + hands off
        ↓
REVIEWER reviews actual code/tests
        │
        ├── problems
        │     ↓
        │   reviewer writes R1/R2/... in canonical review file
        │     ↓
        │   reviewer hands those findings to IMPLEMENTER
        │     ↓
        │   IMPLEMENTER fixes only those findings
        │     ↓
        │   IMPLEMENTER verifies + hands back
        │     ↓
        │   REVIEWER re-reviews
        │     └──────── repeat until clean
        │
        └── child clean
               ↓
            another scheduled child?
             ├── yes → IMPLEMENTER implements next child
             └── no  → REVIEWER performs cumulative parent review
                              │
                              ├── problems → same fix/review loop
                              ├── clean + all required evidence available → COMPLETE
                              └── clean + required external dependency unavailable → BLOCKED
                                                                                     ↓
                                                                           later resume final review
```

The remote Git branch is authoritative. A new agent should be able to resume by reading the state file, recent coordination entries, active spec, and canonical review file.

Proto-children (`NNN.P1-*`, `NNN.P2-*`, ...) are planning placeholders only and are **not scheduled children**. They never enter the diagram above until explicitly promoted to a numeric child.

## 2. Reviewer initializes the workflow

From the repository root, the reviewer initializes Spec `NNN` with the equivalent of:

```bash
python docs/specs/workflow/spec_workflow.py init NNN
```

This creates:

```text
docs/specs/NNN-agent-state.json
docs/specs/NNN-agent-coordination.md
```

Child specs named `NNN.1-*.md`, `NNN.2-*.md`, etc. are discovered automatically. Proto-children named `NNN.P1-*.md`, `NNN.P2-*.md`, etc. are intentionally ignored by child discovery.

Initial state:

```text
TURN: IMPLEMENTER
ACTION: IMPLEMENT
ACTIVE_CHILD: first child
```

Initialization also appends the first timestamped reviewer → implementer communication entry. Commit/push both workflow files together.

## 3. JSON state: turn/state plus compact user-message metadata

The JSON file is the only authority for whose turn it is.

Important fields:

- `active_child` — the only work unit currently allowed;
- `children` — the scheduled numeric children for this workflow;
- `turn` — `IMPLEMENTER` or `REVIEWER`;
- `action` — what that role must do;
- `findings` — unresolved canonical review finding IDs;
- `resume_review` — internal state used to return fixes to ordinary or final review;
- `pending_user_messages` — message IDs and timestamps only, so the reviewer can immediately see that user input is waiting;
- `user_message_seq` — monotonic counter used to assign stable `U1`, `U2`, ... IDs.

Normal states:

```text
IMPLEMENTER + IMPLEMENT
IMPLEMENTER + FIX_REVIEW
REVIEWER    + REVIEW
REVIEWER    + FINAL_REVIEW
REVIEWER    + BLOCKED
REVIEWER    + COMPLETE
```

`BLOCKED` is terminal for the current agent sessions but resumable later. It means the implementation/review is clean enough that no implementer finding remains, but a required external dependency or acceptance input is unavailable, so the feature is not complete or merge-ready.

Do not put user-message bodies or other prose communication in the JSON. Message text belongs only in the coordination Markdown. Old version-1 state files without the two user-message fields remain readable; the helper supplies empty defaults when loading them.

A normal `status` makes pending user input obvious:

```text
USER_MESSAGES_PENDING: 2
USER_MESSAGE_TIMESTAMPS: U1=2026-08-21T01:25:00+02:00, U2=2026-08-21T01:31:00+02:00
```

The reviewer can then search the coordination file for `U1`, `U2`, etc.

## 4. Coordination Markdown: communication and handoffs

`docs/specs/NNN-agent-coordination.md` is append-only from the agents' perspective. The workflow script appends one entry on every transition and every user message.

Every entry includes an ISO-8601 timestamp with UTC offset.

### Implementer → reviewer

```markdown
### 2026-08-15T15:50:00+02:00 — IMPLEMENTER → REVIEWER — 040.2

**Result:** Implementation ready

**Verification**

- focused tests: PASS
- preflight: PASS
- browser checks: NOT RUN

**Message**

Saved-plot persistence was the only sensitive area touched.
```

For review fixes, the result is `Review fixes ready`.

### Reviewer → implementer

```markdown
### 2026-08-15T16:05:00+02:00 — REVIEWER → IMPLEMENTER — 040.2

**Result:** Changes required

**Findings**

- R1
- R2

**Message**

R1 is the functional blocker. R2 is isolated.
```

### User → reviewer

The user may add review input at any point while the workflow is not `COMPLETE`:

```bash
python docs/specs/workflow/spec_workflow.py user-message --spec NNN \
  --message "Please verify that reopening the analysis remains effectively immediate."
```

This does **not** change `TURN`, `ACTION`, `ACTIVE_CHILD`, or findings. It:

1. allocates the next stable ID (`U1`, `U2`, ...);
2. appends the full user message to the coordination log as `USER → REVIEWER`;
3. stores only `{id, timestamp}` in `pending_user_messages`;
4. updates `status` so the reviewer sees the pending count/timestamps immediately.

Commit and push the state + coordination files after adding the message; the remote branch is what the reviewer reads.

A user message is addressed to the reviewer, **not directly to the implementer**. The implementer must not treat a pending `U*` entry as new implementation scope. The reviewer interprets it during the next reviewer-owned action and translates any actionable change into the spec/review/handoff in the normal way.

Before any reviewer-owned transition, the reviewer must read every pending `U*` message. Reviewer transitions record the message IDs under **User messages considered** and clear them from `pending_user_messages`. If a user message materially changes a locked product/scientific decision, amend the governing spec explicitly rather than smuggling the change into an unrelated review finding.

A message may be added while `BLOCKED`, but neither agent is polling in `BLOCKED`; the user must explicitly resume the workflow when the external dependency is genuinely available. `user-message` is rejected after `COMPLETE`.

Keep ordinary handoff messages short. Detailed defects belong in the canonical review file.

## 5. Always start a turn by reading state + communication

Run:

```bash
python docs/specs/workflow/spec_workflow.py status
```

Then read the latest entries in:

```text
docs/specs/NNN-agent-coordination.md
```

If `USER_MESSAGES_PENDING` is nonzero and you are the reviewer, locate/read those `U*` entries before taking the next reviewer action.

Act only when `TURN` matches your role. Work only on `ACTIVE_CHILD`.

If `ACTION: BLOCKED` or `ACTION: COMPLETE`, stop the current agent session.

## 6. Proto-children and promotion

A proto-child is a deliberate planning placeholder for work that has been identified but is not yet sufficiently scoped or authorized for implementation.

Naming:

```text
NNN.P1-short-title.md
NNN.P2-short-title.md
```

Rules:

- Proto-child IDs (`P1`, `P2`, ...) are stable and never reused.
- A proto-child must say `Status: Proto-child — non-implementable until promoted` near the top.
- It may capture motivation, verified observations, likely ownership boundaries, questions to answer, dependencies, and promotion criteria.
- It is **not** an implementation instruction. It does not get an `ACTIVE_CHILD`, implementation commit, child review, or acceptance gate.
- Proto-children are excluded from automatic workflow child discovery and do not block final parent review or merge readiness.
- A parent may therefore complete with one or more proto-children still present as documented future work.
- Do not pre-implement a proto-child.

Promotion is an explicit user/spec-author decision. To promote one:

1. expand it into a normal self-contained numeric child using the next appropriate unused child number;
2. record `Promoted from NNN.Px` in the new child;
3. remove/rename the proto-child file so `NNN.Px` is no longer an active placeholder (the ID remains reserved historically and must not be reused);
4. update the parent child sequence/dependencies;
5. if workflow has **not** been initialized, normal `init` discovery will pick up the numeric child;
6. if workflow is already running, the reviewer schedules the newly authored numeric child while owning `REVIEW` or `FINAL_REVIEW`:

```bash
python docs/specs/workflow/spec_workflow.py add-child NNN.X --spec NNN \
  --message "Promoted from NNN.P1."
```

`add-child` refuses retroactive child numbers and cannot be run while the implementer owns the turn. If called during `FINAL_REVIEW`, it returns the workflow to `IMPLEMENTER + IMPLEMENT` for the promoted child.

## 7. Implementer workflow

### IMPLEMENT

When state is `IMPLEMENTER + IMPLEMENT`, implement only `ACTIVE_CHILD`.

### FIX_REVIEW

When state is `IMPLEMENTER + FIX_REVIEW`, read the canonical review file and fix only the `R` IDs listed in state.

For each finding, satisfy:

- **Current** — what is wrong;
- **Target** — what it must become;
- **Acceptance criteria** — what proves resolution.

The implementer does not edit, renumber, delete, or self-resolve reviewer findings.

Pending `U*` user messages are reviewer input. Do not implement them directly unless the reviewer has translated them into the active spec/review/handoff while returning `TURN: IMPLEMENTER`.

### Verification efficiency — mandatory sequence

During implementation and review-fix work, use focused checks for the changed area. Before a normal handoff, use this sequence:

```text
focused tests/checks required by the active spec/review
→ other focused checks such as compileall or git diff --check when relevant
→ python scripts\preflight.py
→ handoff
```

Canonical preflight already runs the complete backend suite through `scripts\run_backend_tests.py` and the complete frontend policy suite.

Therefore:

- do **not** run `python -m unittest discover tests` during the normal implementer workflow;
- never insert a standalone full backend suite or complete frontend-policy suite immediately before canonical preflight;
- if canonical preflight will run before the handoff, it is the aggregate full-suite evidence for that handoff.

Before launching any standalone full backend/frontend-policy suite, apply this gate:

```text
Will canonical preflight be run before this handoff?

YES → DO NOT run a standalone full backend/frontend-policy suite.
NO  → run one only if the active spec/reviewer finding literally requires a separate full-suite invocation/result, or the user explicitly requests one.
```

Do not infer a separate full-suite requirement from the scientific importance, breadth, risk, or complexity of a change. Diagnose failures with focused tests first rather than using the entire suite as a default diagnostic command.

If a standalone full backend run is literally required, prefer:

```bash
python scripts\run_backend_tests.py
```

unless an acceptance criterion or the user explicitly requires a different exact command.

Use `python scripts\preflight.py --no-cache` only when the active spec/review/release instructions explicitly require a forced full run, when validating preflight cache behavior, or when current repository guidance explicitly requires it.

Explicit scientific, migration, packaging, browser, and manual verification remains mandatory. This rule removes duplicate aggregate runs; it does not weaken acceptance requirements.

In coding environments where Vite requires expanded repository filesystem access, request/use that access on the **first** Vite/preflight invocation. Do not deliberately perform a known restricted run first and then repeat it after the predictable traversal error.

### Handoff

After verification:

```bash
python docs/specs/workflow/spec_workflow.py handoff-review \
  --verification "focused tests: PASS" \
  --verification "preflight: PASS" \
  --verification "browser checks: NOT RUN" \
  --message "Optional concise context."
```

Then stage implementation changes plus `NNN-agent-state.json` and `NNN-agent-coordination.md`, commit them together, and push once.

**After pushing the handoff, the implementer must stop repository work completely.** Do not begin the next child, do not make speculative fixes, and do not continue editing while `TURN: REVIEWER`. Wait until the reviewer commits/pushes a new state with `TURN: IMPLEMENTER`; only then resume from the new `ACTION` and `FINDINGS`. If the reviewer instead commits `ACTION: BLOCKED` or `ACTION: COMPLETE`, stop the current implementer session.

## 8. Review files and exact naming

Canonical reviews live under:

```text
docs/specs/reviews/
```

The review filename must mirror the corresponding implemented spec filename exactly, replacing `.md` with `-review.md`.

Examples:

```text
docs/specs/040.2-series-styling.md
→ docs/specs/reviews/040.2-series-styling-review.md

docs/specs/040-series-styling-parent.md
→ docs/specs/reviews/040-series-styling-parent-review.md
```

Therefore:

- each numeric child gets its own corresponding review file;
- proto-children do not get review files;
- the final cumulative parent review uses the review filename corresponding to the parent spec itself;
- subsequent review rounds update the same review file rather than creating `-review-2`, `-v2`, etc.

## 9. Reviewer and R findings

Each actionable finding must use:

```markdown
### R1 — High | Medium | Low: concise title

Affected files:
- `path/to/file`

**Current**

Exact defect/spec deviation/regression risk.

**Target**

Required behavior or implementation.

**Acceptance criteria**

- Specific testable condition.
- Required regression coverage/verification where relevant.
```

The reviewer owns finding creation, numbering, updates, and resolution.

Before `request-fixes` or `review-clean`, read all pending `U*` user messages. The workflow transition automatically records their IDs as considered and clears the pending list.

### Changes required

After writing/updating the review file:

```bash
python docs/specs/workflow/spec_workflow.py request-fixes R1 R2 \
  --message "Optional concise context."
```

Commit/push review + JSON state + coordination together.

### Returned fixes

Re-check every open finding against its Target and Acceptance criteria.

If some remain open, return only those IDs. If all are resolved and no new actionable defects exist, mark the child review clean.

### Review clean

```bash
python docs/specs/workflow/spec_workflow.py review-clean \
  --message "Optional concise context."
```

The script either advances to the next scheduled child or enters `FINAL_REVIEW`. Proto-children are not considered by this transition.

Commit/push review + JSON state + coordination together.

## 10. Final parent review

When state is:

```text
TURN: REVIEWER
ACTION: FINAL_REVIEW
```

perform a fresh cumulative review against the correct merge base.

Check complete branch scope, all locked parent requirements, cumulative regressions, final architecture/ownership, required verification, documentation/status closure, and merge readiness.

Outstanding proto-children are documented future work and **do not block completion**. If the user decides to promote one before completion, author its numeric child first and use `add-child`; do not implement from the proto-child itself.

Use the same R-finding loop if implementation defects or agent-actionable verification gaps exist.

### Clean and complete

When the cumulative review is clean and all required acceptance evidence is available:

```bash
python docs/specs/workflow/spec_workflow.py complete \
  --message "Cumulative parent review clean; feature ready to merge."
```

`complete` records any still-pending user-message IDs as considered, clears them, and transitions to:

```text
TURN: REVIEWER
ACTION: COMPLETE
```

Commit/push final review + JSON state + coordination together. Both agents stop.

### Clean but externally blocked

If no implementation finding remains, but a required external dependency or acceptance input is unavailable, record the exact reason in the parent review and use:

```bash
python docs/specs/workflow/spec_workflow.py block \
  --message "Exact external dependency preventing completion."
```

This transitions to:

```text
TURN: REVIEWER
ACTION: BLOCKED
```

`BLOCKED` means the feature is not complete or merge-ready, but neither agent has productive repository work to do. Commit/push the parent review + JSON state + coordination together, then both agents stop polling and stop their current sessions.

Do not search unrelated user storage, previous uploads, File Library, or other sources to satisfy the missing external gate unless the user explicitly asks for that search or identifies the source to use.

When the required external dependency later becomes available:

```bash
python docs/specs/workflow/spec_workflow.py resume-final-review \
  --message "Required external dependency is now available."
```

This returns the state to `REVIEWER + FINAL_REVIEW`. Commit/push the resumed JSON state + coordination entry, then perform the cumulative final review with the newly available evidence. Do not transition directly from `BLOCKED` to `COMPLETE`.

## 11. Short launch prompts

Use these when starting fresh reviewer/implementer agent sessions. The branch already exists and the specs are already written.

- `reviewer-launch-prompt.md` — short prompt for the independent reviewer; it initializes the workflow if needed and then follows `reviewer-prompt.md`.
- `implementer-launch-prompt.md` — short prompt for the implementer; it follows `implementer-prompt.md` and waits if the reviewer has not initialized state yet.

The launch prompts are intentionally short. The repository-owned role instructions remain authoritative and can evolve without requiring the user to maintain a long external prompt.

## 12. Important rules

- Reviewer initializes the workflow.
- JSON is the sole authority for turn/action.
- Coordination Markdown is append-only communication history.
- Review Markdown is the canonical technical review.
- User messages are addressed to the reviewer; only IDs/timestamps live in JSON.
- Always read state and latest communication before acting.
- Work only on `ACTIVE_CHILD`.
- Numeric children are implementable; proto-children are not.
- Implementer does not edit reviewer findings.
- Reviewer does not modify implementation code unless explicitly instructed.
- After implementer handoff/push, the implementer waits and does no repository work until `TURN: IMPLEMENTER` returns.
- `BLOCKED` is only for a clean final review that cannot complete because a required external dependency/acceptance input is unavailable; it is not a substitute for ordinary review findings.
- While `BLOCKED`, neither agent polls or performs speculative work. Resume only through `resume-final-review` when the external dependency is actually available.
- Transition state before the handoff commit.
- Commit substantive work + state + coordination together.
- Push once, then stop when ownership changes.
- Never invent verification results.

## 13. Command summary

```text
python docs/specs/workflow/spec_workflow.py init NNN [--message "..."]
python docs/specs/workflow/spec_workflow.py status [--spec NNN]
python docs/specs/workflow/spec_workflow.py user-message --spec NNN --message "..."
python docs/specs/workflow/spec_workflow.py add-child NNN.X --spec NNN [--message "..."]
python docs/specs/workflow/spec_workflow.py handoff-review \
  [--verification "..."] [--verification "..."] [--message "..."]
python docs/specs/workflow/spec_workflow.py request-fixes R1 R2 ... [--message "..."]
python docs/specs/workflow/spec_workflow.py review-clean [--message "..."]
python docs/specs/workflow/spec_workflow.py block --message "..."
python docs/specs/workflow/spec_workflow.py resume-final-review [--message "..."]
python docs/specs/workflow/spec_workflow.py complete [--message "..."]
```
