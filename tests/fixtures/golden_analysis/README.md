# Golden analysis regression corpus

Committed full Neware sources and approved scientific projections for end-to-end backend
regression testing (Spec 015).

## Sources

| Key | Fixture file | Cycles | Rows | SHA-256 (prefix) | Analysis |
|---|---|---:|---:|---|---|
| `cycles_time_steps` | `sources/cycles_time_steps.ndax` | 193 | 71190 | `1b226f9f…` | Test analysis |
| `dcir` | `sources/dcir_source.ndax` | 221 | 78677 | `36b20c04…` | DCIR test |
| `chargeability` | `sources/chargeability_source.ndax` | 37 | 20491 | `c4c655f8…` | Chargeability test |
| `rate_capability` | `sources/rate_capability_source.ndax` | 37 | 20491 | `c4c655f8…` | Chargeability test (Rate capability plot) |

Total committed fixture size: about **4.8 MB** of source binaries plus JSON specs/expected outputs.

## Cases

| Case | Kind | Source key(s) |
|---|---|---|
| `cycles_baseline` | cycles | `cycles_time_steps` |
| `cycles_normalization` | cycles | `cycles_time_steps` |
| `time_capacity_baseline` | time_capacity | `cycles_time_steps` |
| `time_capacity_derivative` | time_capacity | `cycles_time_steps` |
| `steps_baseline` | steps | `cycles_time_steps` |
| `dcir_baseline` | dcir | `dcir` |
| `chargeability_baseline` | chargeability | `chargeability` |
| `rate_capability_baseline` | rate_capability | `rate_capability` |

## Commands

```powershell
python -m unittest tests.test_golden_analysis -v

python scripts\build_golden_analysis_corpus.py verify `
  --manifest tests\fixtures\golden_analysis\manifest.json
```

Regenerate a **candidate** corpus (never overwrites committed fixtures implicitly):

```powershell
python scripts\build_golden_analysis_corpus.py export `
  --data-root "$env:USERPROFILE\.cellxplorer" `
  --output tmp\golden-analysis-candidate `
  --replace
```

Review the candidate diff and `approval.md` before copying into this directory.

See also [`approval.md`](approval.md) and [`../../../docs/agent-knowledge/scientific-regression-testing.md`](../../../docs/agent-knowledge/scientific-regression-testing.md).
