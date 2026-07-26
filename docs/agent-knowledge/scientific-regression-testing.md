# Scientific regression testing

CellXplorer uses two complementary backend test layers:

1. **Synthetic unit tests** — fast, focused checks for formulas, protocol recognition, edge cases,
   and aggregation rules (`tests/test_dcir.py`, `tests/test_chargeability.py`,
   `tests/test_rate_capability.py`, `tests/test_analysis_engine.py`, …).
2. **Golden analysis corpus** — four committed full Neware binaries exercised through production
   parsing, cache construction, and analysis services (`tests/test_golden_analysis.py`).

Golden tests detect unintended changes across the full scientific pipeline. They do **not** replace
synthetic tests and must not be loosened to hide missing `CALC_VERSION` bumps.

## Locked four-source corpus

| Role | Fixture key | Typical analysis origin |
|---|---|---|
| Cycles / Time-Capacity / Steps | `cycles_time_steps` | Test analysis (~193-cycle `.ndax`) |
| DCIR | `dcir` | DCIR test |
| Chargeability | `chargeability` | Chargeability test |
| Rate capability | `rate_capability` | Chargeability test (Rate capability saved plot) |

Sources are complete binaries under `tests/fixtures/golden_analysis/sources/`. Expected JSON stores
stable scientific projections only — never PNG/SVG/Plotly layout.

## File contract

- `manifest.json` — schema version, source checksums, fixture entities, case list, tolerances.
- `specs/<case>.json` — standalone analysis specs using fixture cell IDs.
- `expected/<case>.json` — approved scientific projections.
- `approval.md` — manual checkpoint status.

Normal test runs verify checksums, parse each unique source once, and compare projections with
`relative_tolerance=1e-7`, `absolute_tolerance=1e-9`.

## Updating goldens after an intentional scientific change

1. Make the code change (and bump `CALC_VERSION` or the relevant result schema when required).
2. Confirm `tests.test_golden_analysis` fails first.
3. Export a candidate with `scripts/build_golden_analysis_corpus.py export`.
4. Review numerical diffs and complete `approval.md` checkpoints.
5. Copy the reviewed candidate into `tests/fixtures/golden_analysis/` and commit.

Preflight and normal tests never regenerate expected output automatically.

## Privacy and integrity

- Verify SHA-256 before parsing every source.
- Do not trim or rewrite committed binaries.
- Use generic fixture cell names; keep only scalar metadata required for calculations in the manifest.
- Do not commit the user's SQLite database or live cache directory.

## Runtime rule

The harness creates an isolated `CELLXPLORER_DATA` root, builds caches through production
`scanner.parse_file` / `calc.per_cycle`, and parses each unique source hash at most once per test
module run.
