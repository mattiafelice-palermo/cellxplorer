# Golden analysis corpus — scientific approval

Status: **scientific checkpoints approved; privacy approval pending**

The implementation prepared independent scientific calculations and a complete flattened-header
privacy report. On 2026-07-26, Mattia Felice Palermo explicitly approved the scientific checkpoint
suite, covering checkpoints 1–7. The separate privacy decision remains pending.

Generate the review artifacts with:

```powershell
python scripts\verify_golden_approval_checkpoints.py `
  --output tmp\golden-analysis-checkpoint-report.json

python scripts\build_golden_analysis_corpus.py inspect-privacy `
  --manifest tests\fixtures\golden_analysis\manifest.json `
  --output tmp\golden-analysis-privacy-report.json
```

Both reports remain outside the committed fixture tree because the privacy report contains the
complete embedded metadata.

## Approved scientific checkpoints

| # | Case / topic | Raw basis / formula | Independent result | Golden comparison | Prepared result |
|---|---|---|---|---|---|
| 1 | CC+CV capacity | Cycle 1 charge rows; sum of each step's `max-min` charge-capacity counter | 51.326969 mAh | `cycles_baseline` cycle 1 charge capacity | match |
| 2 | CE and EE | Cycle 1 raw charge/discharge capacity and energy totals | CE 97.985137%; EE 95.760870% | `cycles_baseline` cycle 1 CE and EE | both match |
| 3 | Time/Capacity continuity | Reconstruct all 5,247 selected raw rows; compare time, display X, phase, voltage, current, capacity, null positions and reset positions | 18 raw step-time resets; 7 half-cycle capacity resets; no nulls | Complete `time_capacity_baseline` arrays | match |
| 4 | Steps duration | Cycle 1, protocol steps 2–4; raw timestamp span / 3600 | 40.833333 h | `steps_baseline` block duration | match |
| 5 | DCIR charge + discharge | Exact adjacent rest/pulse raw runs; last rest/pulse voltage and median absolute pulse current | discharge 2355.302 mΩ; charge 1897.120 mΩ | First measurement in each `dcir_baseline` direction | both match |
| 6 | Chargeability | Protocol-derived 20%→80% candidate; raw maximum capacity on reference step 19 | 49.400410 mAh, discharge capacity, cycle 7 | Executed match `reference_capacity_mah` and reference metadata | match |
| 7 | Rate capability | Median raw measurement-step currents divided by 51.37 mAh; lowest rate shared by charge/discharge; CC-only capacity from step 132 | raw common reference 0.200555 C (protocol label 0.2 C); CC capacity 49.693832 mAh; CV step 133 separate | `comparison.reference_rate_c` and first charge point | match |

The verifier is fail-closed: every checkpoint must expose a top-level `match: true`. Focused tests
mutate each checkpoint's expected input (CE and EE separately) and prove the same command evaluator
rejects it.

## Checkpoint detail

### 1 — CC+CV capacity

- Fixture: `cycles_time_steps.ndax`, cell 101, cycle 1.
- Formula: sum, over charge steps, of
  `max(charge_capacity_mah) - min(charge_capacity_mah)`.
- Result: 51.326969146728516 mAh.

### 2 — Coulombic and energy efficiency

- CE formula: discharge capacity / charge capacity × 100.
- EE formula: discharge energy / charge energy × 100.
- Results: CE 97.9851367407808%; EE 95.7608698636625%.
- Both booleans feed the checkpoint's enforced top-level result.

### 3 — Time/Capacity continuity

- Scope: all 5,247 rows selected by the committed Time/Capacity spec (cycles 1–3).
- Independently reconstructed arrays: continuous `time_s`, `display_x`, half-cycle
  `capacity_mah`, current, voltage, cycle and phase.
- Explicit structural comparison: all null positions and all capacity-reset positions.
- Result: 18 raw step-time resets are made continuous; the seven expected half-cycle reset
  positions are identical (`1355`, `2575`, `3192`, `3795`, `4413`, `5020`, `5216`).

### 4 — Steps duration

- Scope: cycle 1, protocol step indices 2–4 (2,454 raw rows).
- Formula: `(max(timestamp) - min(timestamp)) / 3600`.
- Result: 40.833333333333336 h.

### 5 — DCIR

- Discharge: cycle 6, raw rows 11402–11442 (rest) and 11443–11455 (pulse);
  3.422399998 V → 3.340199947 V at median 34.900001526 mA gives
  2355.302199 mΩ.
- Charge: cycle 7, raw rows 11509–11549 (rest) and 11550–11561 (pulse);
  3.423799992 V → 3.490000010 V at median 34.895000458 mA gives
  1897.120420 mΩ.

### 6 — Chargeability

- Protocol candidate: `ChargeAh-0.6*User1`, step 29, preparation step 25, reference step 19.
- Protocol window: 20% → 80%; current ceiling 10 C.
- The actual reference is not 20% of nominal capacity. It is the protocol-recorded maximum
  discharge capacity on reference step 19: 49.40040969848633 mAh in cycle 7.
- This matches the executed golden curve's `reference_capacity_mah` and reference metadata.

### 7 — Rate capability

- The raw median currents of every detected charge/discharge measurement step are converted to
  C-rate using the fixture's 51.37 mAh nominal capacity.
- The lowest raw rate shared by both families is 0.20055481046438217 C, within the committed
  3% protocol-rate tolerance of the golden label 0.2 C.
- Cycle 26 step 132 CC capacity is 49.69383239746094 mAh.
- CV step 133 is separate and contributes 0.13363583385944366 mAh; it is not included in the
  plotted CC-only point.

## Complete binary-header privacy review

The current report schema includes every leaf returned by
`parsing.read_header_metadata`, not only fields with recognized names:

| Fixture key | Flattened fields | Keyword/value convenience hits |
|---|---:|---:|
| `cycles_time_steps` | 1,172 | 15 |
| `dcir` | 6,052 | 43 |
| `chargeability` | 2,850 | 14 |
| `rate_capability` | 2,850 | 14 |
| **Total** | **12,924** | **86** |

The chargeability and rate-capability entries intentionally point to the same binary checksum, so
their metadata appears twice under the two manifest source keys.

Preliminary inspection shows internal experiment/batch remarks, creator initials `CY`, device,
unit and channel identifiers, GUIDs, timestamps, instrument serial/version data, and Neware backup
paths containing internal project folders. This is not a final privacy decision: the user must
review `tmp/golden-analysis-privacy-report.json` and explicitly accept or correct it.

## Approval record

Scientific approver: **Mattia Felice Palermo**

Scientific approval date: **2026-07-26**

Scientific approval statement: **“I approve the scientific checkpoint.”**

Privacy reviewer: **pending**

Privacy review date: **pending**
