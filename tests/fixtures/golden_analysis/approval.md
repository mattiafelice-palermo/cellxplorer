# Golden analysis corpus — scientific approval

Status: **pending user approval** (2026-07-26)

The automated golden tests run against the committed expected JSON below. This file records the
independent checkpoints required before the corpus is treated as a scientifically approved baseline.

After review follow-ups R1–R3 and R5–R7, the committed expected outputs now contain real protocol-
dependent measurements for Steps, DCIR, Chargeability and Rate Capability, distinct cycles and
Time/Capacity normalization cases, and cold isolated parsing under the test harness.

## Checkpoints

Each checkpoint must record: exact raw rows or protocol fields; formula and unit; manually verified
value; comparison with the golden output; approver and date.

| # | Case / topic | Status | Raw basis / formula | Golden comparison | Approver | Date |
|---|---|---|---|---|---|---|
| 1 | CC+CV capacity vs manual delta sum | pending | cycles baseline, cell 101 | `cycles_baseline` charge capacity series | | |
| 2 | CE / EE independent calculation | pending | cycles baseline per-cycle rows | `cycles_baseline` CE/EE metrics | | |
| 3 | Time/capacity counter reset continuity | pending | raw charge/discharge counters across step reset | `time_capacity_baseline` capacity arrays | | |
| 4 | Steps block duration from raw records | pending | steps 2–4 block timing | `steps_baseline` block quantities | | |
| 5 | DCIR charge + discharge from Vrest/Vpulse/I | pending | rest/pulse windows in DCIR source | `dcir_baseline` mΩ series | | |
| 6 | Chargeability SoC window + reference capacity | pending | semantic candidate protocol fields | `chargeability_baseline` matches | | |
| 7 | Rate capability CC-only point + reference rate | pending | swept CC step capacities | `rate_capability_baseline` points | | |

Approver: _not yet recorded_

Date: _not yet recorded_

Privacy review: committed manifest metadata is limited to active mass, nominal capacity and electrode
area. Full protocol fields are derived at runtime from parsed `SourceFile.header_meta`.
