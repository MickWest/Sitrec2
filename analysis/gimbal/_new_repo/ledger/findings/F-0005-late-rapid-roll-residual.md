---
id: F-0005
summary: Late-video pod-roll-rate window (f>800) residual has a named candidate mechanism (primary-gimbal rate-limit exceeded + fourth-axis fine-steering crossover at the az=0 singularity) but remains unverified; bench telemetry required
status: open
sources:
  - analysis/scripts/156_lbf_upstream_lag.js
  - analysis/scripts/164_gimbal_residual_decomp.js
  - analysis/scripts/165_scaled_ideal_verify.js
  - analysis/scripts/167_late_roll_investigate.js
  - analysis/logs/47_lbf_upstream_falsified.md
  - analysis/logs/55_late_residual_singularity.md
  - analysis/logs/56_r6_r7_close.md
  - X-US9121758
depends_on: [F-0001]
updated: 2026-04-20
---

## Summary

In the late-video window f=800..1030 (pod-roll rate peaks at 313.7°/s at f=901), the simple slope-−1 model of F-0001 leaves residuals up to ~100° after the az sign-change. Lag models (log 47: any τ improves RMS by ≤0.2 %) and single-k az-scaling do not close it. **R7 convergence (log 56)** identifies a named physical mechanism: the primary pod-roll gimbal cannot physically spin at 313°/s (the formula-required rate), so the fourth-axis fine-steering (≤5° envelope per US 9,121,758) takes over through the singularity crossing. The residual is therefore a physical regime change, not a formula breakdown or lag.

Preferred phrasing (per log 56): **"primary-gimbal rate limit exceeded"** rather than "singularity" — the mathematical formula remains analytic through az=0; the physical rate limit is the real mechanism.

**Status interpretation**: the mechanism is **named and plausible** but **not demonstrated**. It remains `open`. Two caveats:
1. The 313.7°/s rate demand is computed from the unscaled geometric-ideal formula; the mid-window residual closure (F-0001-adjacent) scales the formula's az-term by k ≈ 0.25. Applying that same scaling here would change the rate-demand number. This internal tension has not been resolved.
2. The primary pod-roll gimbal's physical rate ceiling is **inferred** from patent text (tens of deg/s is typical for gimbal actuators); no ATFLIR-specific public number exists.

R6/R7 convergence (log 56) is across mick/zaine/LBF; cholla did not explicitly concur and, per profile, flags this regime as one where confident claims are premature. Silence is recorded as abstention, not assent.

## Views

- **mick** (`interpretive`): Accepts this is open. Does not threaten F-0001's central claim (settled in the active-roll windows), but needs an account before the "derotator everywhere" framing is fully defensible.
  Source: analysis/agents/agent-mick/r7.md

- **LBF** (`methodological`): Had proposed upstream-lag variant of log 08's test; falsified in log 47. Carries the cleanest list of falsified sub-hypotheses.
  Source: analysis/agents/agent-LBF/r6.md

- **zaine** (`methodological`): Framed this as the remaining unresolved kinematic feature; pushed for full az×tan(el) + fine-steering-envelope decomposition.
  Source: analysis/agents/agent-zaine/r6.md

- **cholla** (`interpretive`): Abstains; profile explicitly cautions against confident reconstructions in regimes with large input-uncertainty leverage. Silence is not assent.
  Source: analysis/agents/agent-cholla/profile.md

## Evidence pipeline

1. `analysis/scripts/164_gimbal_residual_decomp.js` computes scaled-ideal + residual per frame.
2. Residual RMS in f=800..1030 window is elevated vs mid-window (factor 3-4×).
3. `analysis/scripts/167_late_roll_investigate.js` probed az-sign-change, tan(el) growth, and fine-steering saturation; no single term closes the residual.

## Resolution

_(not resolved — status remains `open`; named candidate mechanism is not the same as demonstration)_

## What would revise this

1. A decomposition that attributes the residual to a specific term (az×tan(el), fine-steering saturation, or a previously-unmodelled effect) with ≤30 % RMS residual.
2. A bench-derived fine-steering envelope number that rules out saturation as the driver.
3. Demonstration that the residual is measurement noise (e.g., NCC reliability falls in this window).
