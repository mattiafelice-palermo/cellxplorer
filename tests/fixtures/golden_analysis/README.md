# Golden analysis regression corpus

Committed full Neware sources and candidate scientific projections for end-to-end backend
regression testing (Spec 015). See [`approval.md`](approval.md) for the current checkpoint and
privacy approval status.

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
python -m unittest tests.test_golden_approval_checkpoints -v

python scripts\verify_golden_approval_checkpoints.py `
  --output tmp\golden-analysis-checkpoint-report.json

python scripts\build_golden_analysis_corpus.py verify `
  --manifest tests\fixtures\golden_analysis\manifest.json
```

Regenerate a **candidate** corpus (never overwrites committed fixtures implicitly):

```powershell
python scripts\build_golden_analysis_corpus.py export `
  --data-root "$env:USERPROFILE\.cellxplorer" `
  --cycles-analysis "Test analysis" `
  --dcir-analysis "DCIR test" `
  --chargeability-analysis "Chargeability test" `
  --rate-analysis "Chargeability test" `
  --cycles-plot "Charge capacity (mAh/g) comparison test" `
  --time-plot "Time / capacity comparison" `
  --dcir-plot "DCIR comparison 0.7C" `
  --chargeability-plot "Chargeability comparison" `
  --rate-plot "Rate capability comparison" `
  --output tmp\golden-analysis-candidate `
  --replace
```

Regenerate expected JSON for an existing corpus tree into a **candidate** directory (never writes
the committed fixture tree in place):

```powershell
python scripts\build_golden_analysis_corpus.py refresh-expected `
  --source tests\fixtures\golden_analysis `
  --output tmp\golden-analysis-candidate `
  --replace
```

Review the printed SAME/DIFF digest summary, scientific path diffs, optional `--diff-report`
JSON, and `approval.md` before copying approved files into this directory.

Inspect embedded binary metadata for privacy review:

```powershell
python scripts\build_golden_analysis_corpus.py inspect-privacy `
  --manifest tests\fixtures\golden_analysis\manifest.json `
  --output tmp\golden-analysis-privacy-report.json
```

The privacy report includes the complete flattened header and may contain sensitive metadata.
Keep it outside the committed fixture tree and review the entire `flattened_header_fields` list,
not only the convenience `sensitive_field_hits`.

See also [`approval.md`](approval.md) and [`../../../docs/agent-knowledge/scientific-regression-testing.md`](../../../docs/agent-knowledge/scientific-regression-testing.md).
