# Spec 007: application version consistency check

Status: **implemented**. Developer tooling only. Written 2026-07-26.

## Goal

Add one read-only Python command that verifies that every maintained CellXplorer version declaration contains the same version.

Command:

```powershell
python scripts\check_versions.py
```

This prevents releases where the backend, frontend or desktop installer reports a different application version.

## Files to create

```text
scripts/check_versions.py
tests/test_check_versions_script.py
```

Also add Spec 007 to:

```text
docs/specs/README.md
```

## Version declarations to check

Read these values:

| File                         | Value                                          |
| ---------------------------- | ---------------------------------------------- |
| `backend/app/config.py`      | `APP_VERSION`                                  |
| `package.json`               | top-level `version`                            |
| `package-lock.json`          | top-level `version` and `packages[""].version` |
| `frontend/package.json`      | top-level `version`                            |
| `frontend/package-lock.json` | top-level `version` and `packages[""].version` |
| `src-tauri/tauri.conf.json`  | top-level `version`                            |
| `src-tauri/Cargo.toml`       | `package.version`                              |
| `src-tauri/Cargo.lock`       | version of package named `cellxplorer`         |

All values must exist and be identical.

## Implementation rules

Use only the Python standard library:

* `ast` for `backend/app/config.py`;
* `json` for JSON files;
* `tomllib` for TOML files.

Do not import:

```python
backend.app.config
```

Importing that module creates CellXplorer data directories. Read and parse the file instead.

The script must not modify any file.

## Optional expected version

Support:

```powershell
python scripts\check_versions.py --expected-version 0.14.1
```

Also accept one leading `v`:

```powershell
python scripts\check_versions.py --expected-version v0.14.1
```

This will later be used to compare a Git tag such as `v0.15.0` with the application version `0.15.0`.

## Output

On success:

```text
Backend                     0.14.1
Desktop package             0.14.1
Frontend package            0.14.1
Tauri configuration         0.14.1
Rust package                0.14.1
...

PASS: all version declarations match 0.14.1
```

On failure, identify the exact mismatching or malformed source:

```text
FAIL: version declarations do not match

backend/app/config.py        0.14.1
frontend/package.json        0.14.0
```

Normal validation failures should not produce a long traceback.

## Exit codes

* `0`: success
* `1`: missing, malformed or mismatching version
* `2`: invalid command-line arguments

## Tests

Use `unittest` and temporary fake repository folders.

Test at least:

1. all versions match;
2. one version differs;
3. a JSON version is missing;
4. malformed JSON;
5. malformed TOML;
6. `APP_VERSION` is missing;
7. `Cargo.lock` has no `cellxplorer` package;
8. matching expected version;
9. expected version with leading `v`;
10. mismatching expected version.

Do not edit the real application version files during tests.

## Verification

Run:

```powershell
python -m unittest tests.test_check_versions_script -v
python scripts\check_versions.py
```

Both commands must pass.

## Out of scope

Do not:

* update version files automatically;
* change the application version;
* add release automation;
* add GitHub Actions;
* add dependency checks;
* modify application code.

## Acceptance criteria

* The command exits `0` on the current repository.
* Changing any version in a test fixture makes it fail.
* All listed version declarations are checked.
* No CellXplorer data directory is created.
* No file is modified.

## Implementation record

Added `scripts/check_versions.py` with AST/JSON/TOML readers, optional
`--expected-version`, and stable exit codes. Tests live in
`tests/test_check_versions_script.py` using temporary fixture repositories.

Verification:

```text
python -m unittest tests.test_check_versions_script -v
python scripts\check_versions.py
```

Both commands pass on the repository state at implementation time.
