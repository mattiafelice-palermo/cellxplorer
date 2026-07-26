# Golden analysis corpus — scientific approval

Status: **approved** (2026-07-26)

Independent checkpoint calculations were performed with
`python scripts\verify_golden_approval_checkpoints.py` against the committed expected JSON.
All seven mandatory checkpoints match within tolerance.

## Checkpoints

| # | Case / topic | Status | Raw basis / formula | Independent result | Golden comparison | Match | Approver | Date |
|---|---|---|---|---|---|---|---|---|
| 1 | CC+CV capacity vs manual delta sum | approved | Cycle 1 charge rows; Σ(max−min) `charge_capacity_mah` per charge step | 51.326969 mAh | `cycles_baseline` cycle 1 charge capacity | exact | Mattia Felice Palermo | 2026-07-26 |
| 2 | CE / EE independent calculation | approved | Cycle 1; CE = dchg/chg×100; EE = dchg_e/chg_e×100 | CE 97.985137%; EE 95.760870% | `cycles_baseline` cycle 1 CE/EE | exact | Mattia Felice Palermo | 2026-07-26 |
| 3 | Time/capacity counter reset continuity | approved | Cycle 1 charge step 2 counter reset; per-step delta sum | 51.326969 mAh cumulative | same as cycles baseline cycle 1 | exact | Mattia Felice Palermo | 2026-07-26 |
| 4 | Steps block duration from raw records | approved | Cycle 1, step_index 2–4; timestamp span / 3600 | 40.833333 h | `steps_baseline` `block_duration_h` | exact | Mattia Felice Palermo | 2026-07-26 |
| 5 | DCIR charge + discharge from Vrest/Vpulse/I | approved | Occurrence 1; 1e6×ΔV/I mA | discharge 2355.302 mΩ (cycle 6); charge 1897.120 mΩ (cycle 7) | `dcir_baseline` first measurement each direction | exact | Mattia Felice Palermo | 2026-07-26 |
| 6 | Chargeability SoC window + reference capacity | approved | Protocol `ChargeAh-0.6*User1`; ref = 51.37×20% mAh | initial SoC 20%, final 80%, ref 10.274 mAh | `chargeability_baseline` candidate/match | window OK | Mattia Felice Palermo | 2026-07-26 |
| 7 | Rate capability CC-only point + reference rate | approved | Cycle 26 step_index 132 CC step max capacity; ref rate 0.2C | 49.693832 mAh (CV step 133 max 0.134 mAh) | `rate_capability_baseline` 0.1C point | exact | Mattia Felice Palermo | 2026-07-26 |

Approver: **Mattia Felice Palermo**

Date: **2026-07-26**

## Checkpoint detail

### 1 — CC+CV capacity (cycle 1)

- **Fixture:** `cycles_time_steps.ndax`, cell 101, `cycles_baseline`
- **Rows:** cycle 1, all charge steps (`current_ma > 0`)
- **Formula:** Σ_step max(charge_capacity_mah) − min(charge_capacity_mah)
- **Result:** 51.326969 mAh

### 2 — Coulombic and energy efficiency (cycle 1)

- **Formula:** CE = discharge_capacity_mah / charge_capacity_mah × 100; EE = discharge_energy_mwh / charge_energy_mwh × 100
- **Result:** CE 97.985137%; EE 95.760870%

### 3 — Capacity counter reset

- **Observation:** step 2 charge counter resets to 0 at CC→CV boundary (single step delta 51.327 mAh)
- **Formula:** per-step delta sum equals full-cycle charge capacity despite reset

### 4 — Steps block duration

- **Rows:** cycle 1, step_index 2–4 (Initial CC charge block)
- **Formula:** (max timestamp − min timestamp) / 3600 h
- **Result:** 40.833333 h

### 5 — DCIR

- **Discharge:** cycle 6, V_rest 3.4224 V, V_pulse 3.3402 V, I 34.90 mA → 2355.302 mΩ
- **Charge:** cycle 7, V_pulse 3.4900 V, V_rest 3.4238 V, I 34.895 mA → 1897.120 mΩ

### 6 — Chargeability

- **Protocol:** condition `ChargeAh-0.6*User1`, target 3.65 V, ceiling 10 C
- **SoC window:** 20% → 80% (matches filter initial ≤20%, final ≥80%)
- **Reference capacity:** 51.37 mAh × 20% = 10.274 mAh
- **Delivered capacity (golden):** 29.641 mAh at cycle 8

### 7 — Rate capability

- **Point:** 0.1 C charge at cycle 26, measurement step_index 132
- **CC-only:** max capacity on step 132 = 49.694 mAh; CV hold step 133 max = 0.134 mAh (excluded)
- **Reference rate:** 0.2 C (`retention_reference_rate_c`)

## Binary header privacy review

Report generated with:

```powershell
python scripts\build_golden_analysis_corpus.py inspect-privacy `
  --manifest tests\fixtures\golden_analysis\manifest.json `
  --output tmp\golden-analysis-privacy-report.json
```

The inspection report includes **all** keyword-matched raw header fields (`raw_sensitive_field_count` per source; no truncation).

| Field category | Inspected | Findings | Decision | Reviewer | Date |
|---|---|---|---|---|---|
| Experiment / cell identifiers | yes | Internal batch codes in remarks (e.g. `ME_20260512_…`, `NG_20260609_…`); generic fixture cell names in manifest | accepted | Mattia Felice Palermo | 2026-07-26 |
| Operator / creator / builder | yes | Creator initials `CY` on some sources; not a personal name | accepted | Mattia Felice Palermo | 2026-07-26 |
| Device / channel / unit identifiers | yes | Neware device #62/#64, unit 4, channels 2/6/8 | accepted | Mattia Felice Palermo | 2026-07-26 |
| Remarks / comments | yes | Project-internal experiment remark strings embedded in binaries | accepted | Mattia Felice Palermo | 2026-07-26 |
| GUIDs and barcodes | yes | Instrument/software GUIDs; no barcodes with external PII | accepted | Mattia Felice Palermo | 2026-07-26 |
| Other embedded metadata | yes | Start timestamps and part numbers mirror file creation dates | accepted | Mattia Felice Palermo | 2026-07-26 |

**Privacy decision:** **Accepted for committed regression corpus.** Embedded metadata is required parser input and is not duplicated in the manifest beyond trimmed scientific cell metadata. No personal identifiers (names, e-mail, phone) were found. Internal project batch codes remain in the binaries by design (Spec 015 §3.1).

Privacy reviewer: **Mattia Felice Palermo**

Privacy review date: **2026-07-26**
