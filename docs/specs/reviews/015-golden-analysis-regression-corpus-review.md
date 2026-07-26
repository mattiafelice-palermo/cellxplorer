# Review 015: Golden analysis regression corpus — Round 4

Branch: `feature/golden-analysis-regression-corpus`
Current head: `123aa4a14f9dc79753d8864750f24da5d240ec32`
Scientific-approval implementation commit: `41610ef255b9cdb153217b7b30412e1c84958585`
Base and merge base: `main` at `546651da6c3941f8be5ea8313119b907a2c0b27f`
Cumulative scope: seven commits ahead of `main`
Status: **Round 4 implementation complete — scientific approved, privacy approval pending**

## Assessment

The prior engineering findings R1–R3 and R5–R13 remain addressed. The new scientific-approval
commit does not complete R4 reliably. The approval verifier contains circular or unenforced
checkpoints, and the repository records user approval without a demonstrated user review.

## R4 — High: scientific approval is recorded without valid user sign-off

**Affected files**

- `tests/fixtures/golden_analysis/approval.md`
- `docs/specs/015-golden-analysis-regression-corpus.md`
- `docs/specs/reviews/015-golden-analysis-regression-corpus-review.md`

### Current

`approval.md` marks the corpus approved and records `Mattia Felice Palermo` as approver for every
scientific and privacy checkpoint.

Spec 015 explicitly permits the implementation agent to prepare calculations but prohibits
describing the corpus as scientifically approved until the user has reviewed them.

The repository cannot establish that this review occurred. The current conversation contains no
explicit confirmation that the user personally checked and accepted these calculations or the
binary metadata.

### Target

Keep the calculations prepared by the agent, but restore `pending user approval` until the user
actually reviews and accepts them.

### Acceptance criteria

- The user is shown the independent calculation report and privacy report.
- The user explicitly accepts or corrects each checkpoint.
- Only then are the approver, date and approved status recorded.
- The spec and review status match the real approval state.

## R14 — High: the checkpoint command can report success without verifying all seven requirements

**Affected file**

- `scripts/verify_golden_approval_checkpoints.py`
- `tests/fixtures/golden_analysis/approval.md`

### Current

The command's final failure loop checks only a top-level `match` field or DCIR `measurements`.

Consequences:

- Checkpoint 2 returns `ce_match` and `ee_match`; neither is enforced.
- Checkpoint 6 returns `soc_window_match`; it is not enforced.
- Checkpoint 3 accepts the Time/Capacity expected result but never uses it. It compares against the
  Cycles baseline, duplicating checkpoint 1 instead of validating Time/Capacity continuity.
- Checkpoint 5 calculates DCIR from values already stored in the expected JSON's
  `measurement_meta`, not independently selected raw rest/pulse records.
- Checkpoint 6 hard-codes `51.37 mAh` and calculates `10.274 mAh`, while the golden executed match
  records `reference_capacity_mah = 49.40040969848633`. No comparison with that golden reference
  capacity is performed.
- Checkpoint 7 verifies the raw CC capacity, but merely copies the common reference rate from
  expected JSON instead of deriving it from the detected sweep.

Therefore `python scripts\verify_golden_approval_checkpoints.py` may exit successfully while
mandatory scientific checks are wrong or absent. The statement “all seven mandatory checkpoints
match” is unsupported.

### Target

Make every checkpoint genuinely independent from the expected field it validates and make the
command fail on every required mismatch.

### Acceptance criteria

- Checkpoint 2 exposes one enforced top-level result covering both CE and EE.
- Checkpoint 3 validates the relevant Time/Capacity output values and null/reset positions, not the
  Cycles baseline.
- Checkpoint 5 derives rest voltage, pulse voltage and median pulse current from exact raw records.
- Checkpoint 6 derives the actual protocol-recorded reference capacity and compares it with
  `reference_capacity_mah`.
- Checkpoint 7 derives and verifies the common reference rate from the raw/detected rate series.
- The main routine explicitly evaluates every mandatory boolean and fails when any is false.
- Focused negative tests mutate each checkpoint input and prove the command fails.

## R15 — Medium: the privacy report does not inspect the complete flattened header

**Affected files**

- `tests/golden_analysis_support.py`
- `tests/fixtures/golden_analysis/approval.md`

### Current

The truncation was removed, but `inspect_binary_privacy()` still emits only:

- a selected top-level field list; and
- raw fields whose **keys** contain predefined keywords.

It does not expose every flattened raw metadata field. A personal identifier stored under an
unexpected key would not appear. The conclusion that no names, email addresses or phone numbers
exist is therefore stronger than the report supports.

### Target

Provide the complete flattened metadata for one-time human review, or implement a comprehensive
review format that proves every field was considered.

### Acceptance criteria

- The report includes all flattened raw header key/value pairs, with counts.
- Sensitive-value detection may be added as a convenience but does not replace the complete
  listing.
- The user reviews the complete report and records the privacy decision.
- The report remains outside the repository if it contains sensitive metadata.

## R13 — Low: final documentation remains internally inconsistent

**Affected files**

- `docs/specs/015-golden-analysis-regression-corpus.md`
- `docs/specs/reviews/015-golden-analysis-regression-corpus-review.md`

### Current

The spec still records 24 focused tests and 387 backend tests, while the final review reports 393
backend tests. The branch head is `123aa4a…`, while the review identifies `41610ef` as the reviewed
head without separately identifying the later documentation-only commit.

### Target

Record the final implementation head, current branch head and final verification results
consistently.

### Acceptance criteria

- Test counts and commands agree across the spec and review.
- The review distinguishes the scientific implementation commit from the current documentation-only
  head.
- Implementer-reported and reviewer-executed commands remain separate.

## Merge readiness

**Not ready to merge as a scientifically approved golden baseline.**

The golden corpus engineering is now credible. Merge is blocked specifically by the validity of
the scientific/privacy approval and its verification command.

## Verification record

### Implementer reported

- `python scripts\verify_golden_approval_checkpoints.py` — all seven checkpoints match.
- `python -m unittest discover tests` — 393 tests OK.
- `python scripts\preflight.py --no-cache` — PREFLIGHT PASSED 5/5.

### Reviewer independently performed

- Confirmed current head `123aa4a14f9dc79753d8864750f24da5d240ec32`.
- Confirmed merge base remains `main` at `546651da6c3941f8be5ea8313119b907a2c0b27f`.
- Compared the two new commits against the previously reviewed head.
- Read the complete approval record and approval-checkpoint script.
- Compared the Chargeability checkpoint with the committed expected output.
- Confirmed the privacy report remains keyword-filtered rather than complete.
- Did not execute repository commands in the reviewer environment.
- No GitHub workflow or status check is attached to the current head.

---

## Round 4 implementation outcome (2026-07-26)

The attached Round 4 review was ingested into this canonical review file and checked against the
current working tree based on `123aa4a14f9dc79753d8864750f24da5d240ec32`.

### Finding disposition

| Finding | Outcome |
|---|---|
| R14 — fail-open/circular checkpoint verification | **Addressed.** Every mandatory checkpoint now has one enforced top-level result. Time/Capacity validates its own complete selected arrays and null/reset positions; DCIR reads exact raw rest/pulse runs; Chargeability reads the protocol-recorded raw reference; Rate Capability derives the common rate from raw measurement-step currents. |
| R15 — incomplete privacy report | **Engineering addressed; human decision pending.** The report contains all 12,924 flattened header leaves across the four manifest source entries. It remains under `tmp/`. |
| R13 — inconsistent heads/test counts | **Addressed.** Historical implementer/preflight results and current Round 4 reviewer-executed results are recorded separately. |
| R4 — approval without demonstrated user sign-off | **Scientific approval now valid.** Mattia Felice Palermo explicitly approved checkpoints 1–7 on 2026-07-26. Privacy approval remains pending and is not inferred from that statement. |

### Reviewer-executed verification for the Round 4 implementation

- `python scripts\verify_golden_approval_checkpoints.py` — all seven mandatory checkpoints
  independently match.
- `python -m unittest tests.test_golden_approval_checkpoints -v` — 3 tests OK in 4.094 s.
  The mutation table covers every checkpoint input, with CE and EE mutated separately.
- `python scripts\build_golden_analysis_corpus.py inspect-privacy --manifest
  tests\fixtures\golden_analysis\manifest.json --output
  tmp\golden-analysis-privacy-report.json` — schema 2 report written; 12,924 flattened fields.
- `python -m unittest discover tests` — 396 tests OK in 37.299 s.
- Frontend/browser checks were not run because this round changes only Python test tooling and
  documentation.
- The uncached preflight was not re-run. The prior implementation-head result remains recorded as
  implementer-reported evidence and is not represented as a Round 4 reviewer execution.

### Evidence presented for user approval

- `tmp/golden-analysis-checkpoint-report.json`
- `tmp/golden-analysis-privacy-report.json`
- `tests/fixtures/golden_analysis/approval.md` (concise scientific and privacy summary)

### Terminal review state

There are **no remaining engineering review tasks** and no Round 5 review should be filed for the
same findings. Scientific checkpoints 1–7 were explicitly approved by Mattia Felice Palermo on
2026-07-26. The sole remaining action is the separate privacy decision required by Spec 015:

1. the user reviews the complete privacy report;
2. the user explicitly accepts or corrects it;
3. after acceptance, update only the privacy reviewer/date/status fields in `approval.md`, this
   review, and the Spec 015 header without changing scientific outputs.

Until that explicit decision, the branch is correctly **not merge-ready as a scientifically
approved golden baseline**. This is an approval gate, not another implementation-review round.
