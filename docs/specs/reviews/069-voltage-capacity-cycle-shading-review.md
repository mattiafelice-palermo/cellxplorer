# Spec 069 independent review

Reviewer: GPT-6 Astra Medium. Date: 2026-10-03.
Checkpoint: working tree on `codex/alpha-analysis-improvements` after `eacc49b0`.
Verdict: **PASS**. No actionable implementation findings remain.

## Review scope

Reviewed the shading policy, persisted style normalization, Series Appearance
scratch/Apply/reset flow, production trace integration, compact key and preview
layout, tests, and documentation. Shading uses canonical segment cycles and the
fully resolved sample/channel base color, retaining hue and CSS alpha. It reuses
existing phase/cycle segments and legend grouping; current, time, derivative,
unknown-cycle, and display-only curves retain prior behavior. Scientific values
and export columns are unchanged.

Full-range bounds are frozen from the existing scientific maximum, never from
the navigation window. Unknown bounds cannot enable fabricated defaults until
the user supplies explicit bounds or a full range becomes available. Selected
sample application preserves other samples; all-sample application intentionally
replaces exceptions. Scratch dismissal does not persist shading. Reference
geometry is retained, and foreign annotation ownership continues to disable
global label dragging safely.

The reported compact-preview clipping issue is resolved: the preview fitter
preserves the shading key's required top margin, with regression coverage.
Multiline key content is bounded; closing retains the last preview during the
modal fade. Old plots keep shading absent/disabled.

## Verification

Independent reruns passed **8/8** shading-policy/preview tests and **13/13**
production Time/Capacity renderer tests. These cover CSS names/RGB/HSL/alpha,
mode endpoints, reversal and stepped bands, frozen navigation, group/channel
identity, same-cycle charge/discharge shading, display-only exclusion, existing
trace counts, and interactive/export color and scientific-column parity.

The implementer reports **132 focused tests**, TypeScript, and final canonical
preflight **4/4 passed** (122.92 seconds, four workers). The parent reviewer
reports light/dark browser checks of all/selected application, scratch-reset
dismissal, smooth and reversed six-band modes, base-hue updates, saved reload,
Time-view exclusion, and actual PNG export. Frozen bounds were 1–193 while
the navigated window was 173–192; the corrected compact key was fully visible.
These browser and full-preflight results are attributed evidence, not checks
independently rerun by this reviewer. Native desktop acceptance is not claimed.
