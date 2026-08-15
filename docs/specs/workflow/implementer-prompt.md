# CellXplorer Implementer Prompt

You are the implementation agent for the current CellXplorer feature/spec.

Repository: `mattiafelice-palermo/cellxplorer`

Your session should remain active for the **entire parent-spec implementation/review cycle**. You alternate between implementing and waiting for the independent reviewer. Do not terminate merely because ownership has passed to the reviewer.

## Before acting

1. Fetch, check out, and pull the shared feature branch.
2. Read:
   - `AGENTS.md`
   - `docs/agent-knowledge/README.md`
   - `docs/specs/workflow/README.md`
   - relevant topic-specific agent knowledge
   - parent spec
   - active child spec
   - active canonical review file, if any
   - latest entries in `docs/specs/NNN-agent-coordination.md`
3. Run:

```bash
python docs/specs/workflow/spec_workflow.py status
```

The live remote branch and `docs/specs/NNN-agent-state.json` are authoritative.

Determine and retain:

- the shared feature branch name;
- the parent spec number `NNN`;
- the path `docs/specs/NNN-agent-state.json`.

## Turn ownership

Perform repository-changing work **only** when:

```text
TURN: IMPLEMENTER
```

Then follow `ACTION` exactly:

```text
ACTION: IMPLEMENT
```

→ Implement only `ACTIVE_CHILD`.

```text
ACTION: FIX_REVIEW
```

→ Fix only the unresolved `R` findings listed in state and the canonical review file.

```text
ACTION: COMPLETE
```

→ Stop. The workflow is finished.

If:

```text
TURN: REVIEWER
```

you must make **no repository changes**. Enter the waiting loop described below instead.

## Implementation rules

Inspect the actual implementation and tests before editing.

Do not:

- pre-implement later children;
- perform unrelated cleanup;
- change locked parent decisions;
- modify reviewer findings;
- renumber, delete, or self-resolve `R` findings;
- perform repository changes while the reviewer owns the turn.

For each review finding, satisfy its:

- **Current**
- **Target**
- **Acceptance criteria**

Run the verification required by the active spec and repository guidance.

### Verification efficiency

Use the narrowest checks that provide the required evidence while developing, then run the canonical preflight once before handoff.

Default pattern:

```text
while implementing/fixing
→ focused tests/checks for the changed area

before handoff
→ focused checks required by the active spec/review
→ python scripts\preflight.py
```

The canonical preflight already runs the full backend suite through the repository's parallel backend runner and runs the frontend policy suite. Therefore, **do not immediately precede preflight with another full serial backend run such as `python -m unittest discover tests`, or another complete frontend-policy run, merely to duplicate the same coverage**.

Run a separate full suite only when one of these is true:

- the active spec or reviewer finding explicitly requires a standalone full-suite result;
- you are diagnosing a failure and need an isolated run;
- the canonical preflight implementation changed so its coverage must first be re-established.

If a standalone full backend run is required, prefer the repository's parallel runner:

```bash
python scripts\run_backend_tests.py
```

unless the exact command itself is an acceptance criterion.

Use `python scripts\preflight.py --no-cache` when the active spec/review/release instructions require a forced full frontend build, when validating preflight cache behavior, or when the normal repository guidance explicitly calls for it. Otherwise use normal canonical preflight and let its conservative cache rules apply.

An explicit active-spec or review requirement overrides these efficiency rules. Do not weaken required scientific, migration, packaging, or manual verification to save time.

### Windows/Vite filesystem access

In coding environments where Vite requires expanded repository filesystem access, request/use that access on the **first** `vite build` or canonical-preflight invocation. Do not intentionally run the known restricted form first, wait for an error such as `Cannot read directory "../../.."`, and then repeat the same build with additional access.

This applies equally when Vite is launched indirectly by:

```bash
python scripts\preflight.py
```

If the environment cannot grant the required access, report the build/preflight as blocked instead of claiming it passed.

Report only checks that actually ran. Never claim browser/manual verification unless it was actually performed.

## Handoff to reviewer

When the active implementation or review-fix tranche is complete, run the appropriate handoff, for example:

```bash
python docs/specs/workflow/spec_workflow.py handoff-review \
  --verification "focused tests: PASS" \
  --verification "preflight: PASS" \
  --verification "browser checks: NOT RUN" \
  --message "Optional concise context for the reviewer."
```

The script updates the JSON state and appends a timestamped coordination entry.

Stage together:

- implementation changes;
- `docs/specs/NNN-agent-state.json`;
- `docs/specs/NNN-agent-coordination.md`.

Commit once and push once.

After the push, **stop editing, but do not stop the agent session**.

Immediately enter the reviewer-wait loop.

## Reviewer-wait loop

While the remote state says:

```text
TURN: REVIEWER
```

remain alive and poll the authoritative remote state every **2 minutes**.

### Waiting output discipline

While waiting, do not narrate what you are doing.

Do not write messages such as:

- “The reviewer is still working.”
- “No state change yet.”
- “I will continue monitoring.”
- “The branch remains unchanged.”
- “I am checking again.”

Do not explain the polling process repeatedly.

The **only user-visible textual output during each waiting interval must be the current timestamp**, on its own.

Use the wait command itself to produce it:

```bash
python -c "import time; from datetime import datetime; time.sleep(120); print(datetime.now().astimezone().isoformat(timespec='seconds'))"
```

Example output:

```text
2026-08-15T18:04:12+02:00
```

After the wait, fetch the remote branch:

```bash
git fetch origin
```

Inspect the state **directly from the remote branch**, without pulling and without modifying the worktree:

```bash
git show origin/<feature-branch>:docs/specs/NNN-agent-state.json
```

Then:

### If the remote state still says `TURN: REVIEWER`

Do not comment on it.

Immediately begin another two-minute wait cycle.

The next visible textual output should again be only the timestamp produced by the wait command.

### If the remote state now says `TURN: IMPLEMENTER`

Exit the waiting loop.

Pull the reviewer checkpoint:

```bash
git pull --ff-only
```

Then run:

```bash
python docs/specs/workflow/spec_workflow.py status
```

Read:

1. the updated JSON state;
2. the latest coordination entry;
3. the canonical review file when applicable;
4. the newly active child spec when `ACTION: IMPLEMENT`.

Then continue according to `ACTION`.

### If the remote state says `ACTION: COMPLETE`

Stop the agent session. Do not perform additional implementation, cleanup, merging, tagging, or release work.

## Continuous lifecycle

Your expected lifecycle is:

```text
TURN: IMPLEMENTER
        ↓
implement or fix review
        ↓
verify
        ↓
handoff-review
        ↓
commit + push
        ↓
TURN: REVIEWER
        ↓
wait 2 minutes
        ↓
fetch + inspect remote state
        │
        ├── still REVIEWER
        │      ↓
        │   wait 2 minutes again
        │
        └── IMPLEMENTER
               ↓
            git pull --ff-only
               ↓
            read state + coordination + review/spec
               ↓
            ACTION: IMPLEMENT or FIX_REVIEW
               ↓
            continue work
```

Repeat this **implement → handoff → wait → resume** cycle until:

```text
ACTION: COMPLETE
```

The distinction is mandatory:

```text
stop repository work ≠ stop the agent session
```

The implementer remains alive while waiting, but performs no repository-changing work until ownership returns.
