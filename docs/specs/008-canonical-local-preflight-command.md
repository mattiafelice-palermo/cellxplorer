# Spec 008: canonical local preflight command

Status: **implemented**. Depends on Spec 007. Developer tooling only. Written 2026-07-26.

## Goal

Add one command that an AI coding agent runs after every meaningful code change:

```powershell
python scripts\preflight.py
```

The command provides one consistent definition of “the change was verified.”

## Files to create

```text
scripts/preflight.py
tests/test_preflight_script.py
```

Also:

* document the command in `AGENTS.md`;
* add a short “Verify a change” section to `docs/local-development.md`;
* add Spec 008 to `docs/specs/README.md`.

## Required stages

Run these four stages in this order:

### 1. Version consistency

```powershell
python scripts\check_versions.py
```

Use the current interpreter through `sys.executable`.

### 2. Backend tests

```powershell
python -m unittest discover tests -v
```

### 3. Frontend policy tests

Run every file matching:

```text
frontend/tests/*.test.ts
```

Discover and sort the files in Python, then pass the explicit paths to:

```powershell
node --test <test files>
```

Do not rely on wildcard expansion by the shell.

### 4. Frontend production build

```powershell
npm --prefix frontend run build
```

The existing build runs TypeScript compilation and the Vite production build.

## Fail-fast behaviour

Stop immediately when a stage fails.

Example:

```text
[2/4] Backend tests
FAIL: command exited with code 1

Preflight stopped. Later stages were not run.
```

Return a non-zero exit code.

Do not continue and print a successful summary.

## Isolated application data

Create a temporary directory with `tempfile.TemporaryDirectory`.

Set this for all child commands:

```text
CELLXPLORER_DATA=<temporary directory>
```

This must override any existing `CELLXPLORER_DATA`.

The preflight must never use the normal CellXplorer database or cache.

Clean the temporary directory automatically when the command finishes.

## Dependencies

The preflight must not install dependencies.

Before running, check that:

* Python is 3.12 or newer;
* `node` exists;
* `npm` or `npm.cmd` exists;
* `frontend/node_modules` exists;
* frontend test files exist.

When frontend dependencies are missing, print:

```text
Frontend dependencies are not installed.
Run: npm --prefix frontend ci
```

## Subprocess rules

* Use argument lists.
* Do not use `shell=True`.
* Run every command from the repository root.
* Resolve the root from the location of `preflight.py`, not from the current terminal directory.
* Stream command output directly to the terminal.

The command must also work when invoked from another directory using its full path.

## Output

Before each stage:

```text
[1/4] Version consistency
```

After each successful stage:

```text
PASS: Version consistency
```

At the end:

```text
========================================
PREFLIGHT PASSED
4/4 stages completed successfully
========================================
```

On `Ctrl+C`, print:

```text
Preflight cancelled.
```

and return exit code `130`.

## Tests

Use `unittest` and mock subprocess execution.

Test at least:

1. stages use the required order;
2. the current Python executable is used;
3. frontend test paths are sorted and explicit;
4. no frontend tests causes failure;
5. missing Node causes failure;
6. missing npm causes failure;
7. missing `node_modules` gives the installation instruction;
8. `CELLXPLORER_DATA` is replaced;
9. first failed stage stops later stages;
10. successful stages return `0`;
11. interruption returns `130`;
12. `shell=True` is never used;
13. repository root is used as `cwd`.

The unit tests must not recursively run the full preflight suite.

## Documentation

In `AGENTS.md`, state:

* run `python scripts\preflight.py` after meaningful changes;
* report the exact result;
* do not claim verification passed when it was not run;
* do not remove or weaken tests to make it green.

Keep the existing individual test commands.

## Verification

Run:

```powershell
python -m unittest tests.test_preflight_script -v
python -m unittest discover tests -v
python scripts\preflight.py
```

Also invoke `preflight.py` from outside the repository using its full path.

## Out of scope

Do not:

* install dependencies;
* build the Windows installer;
* modify application data;
* add GitHub Actions;
* add linting or coverage;
* change existing scientific or application behaviour.

## Acceptance criteria

* One command runs all four checks.
* The checks run in the required order.
* User data is isolated.
* The first failure stops execution.
* Successful execution ends with `PREFLIGHT PASSED`.
* No application code or version is changed.

## Implementation record

Added `scripts/preflight.py` with four fail-fast stages, isolated
`CELLXPLORER_DATA`, prerequisite checks, and mocked unit tests in
`tests/test_preflight_script.py`.

Two frontend policy tests imported `.tsx` modules, which plain `node --test`
cannot load. Their pure logic was moved to `frontend/src/cellSamplePopoverLogic.ts`
and `frontend/src/protocolGroupNormalization.ts` without behaviour changes so
stage 3 can run every `frontend/tests/*.test.ts` file.

Verification:

```text
python -m unittest tests.test_preflight_script -v
python -m unittest discover tests -v
python scripts\preflight.py
python C:\Users\matti\Documents\Cellxplorer\scripts\preflight.py
```

All commands pass on the repository state at implementation time.
