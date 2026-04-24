---
id: F-0007
summary: Clean-cloud image rotation (20.3° endpoint swing) exceeds the bank×cos(az) geometric prediction (~12°) by ~8° across the whole clip; spatial uniformity of flow across the frame implicates camera-internal mechanical rotation, not scene parallax
status: open
sources:
  - analysis/scripts/182_zaine_check.js
  - analysis/scripts/183_offaxis_decomp.js
  - analysis/scripts/184_offaxis_refined.js
  - analysis/scripts/185_residual_structure.js
  - analysis/scripts/187_linear_model_fit.js
  - analysis/scripts/188_with_heading.js
  - analysis/scripts/190_tile_flow.js
  - analysis/outputs/185_residual_structure.png
depends_on: [F-0001]
updated: 2026-04-20
reproducibility: scripted
---

## Summary

The cumulative optical-flow direction measured on masked cloud pixels in the Gimbal video swings by **+20.3°** over 1031 frames. A full geometric model (bank × cos(az) projection + pitch × sin(az) coupling + az × sin(el) + AH post-rotation) predicts only **+12.4°**, leaving a robust **~8° gap**. The gap is insensitive to reasonable variation in el (±15°), pitch (±1°), jet-pitch scaling, and aircraft-heading rotation (world-Z rotation is geometrically invariant on image roll for near-horizontal LOS).

Empirically (script 187), the observed flow angle is almost perfectly linear in pod azimuth: `obs ≈ −0.39·az + 38.8°`, RMS 1.5° — az alone beats the full geometric model as a predictor. Spatial-uniformity test (script 190): template-matched flow vectors sampled on a 6×3 grid across the cloud band show ±1–2° angular spread per frame-pair. No left-right or center-edge gradient. This is the camera-internal signature; a near-field parallactic scene would print a position-dependent gradient.

Working mechanical hypothesis (agents mick + cholla converged in r5): an outer-roll coupling to the pod az gimbal that adds ~0.13°/° of image rotation beyond the cos(az) projection. Not yet documented in public ATFLIR patents. The coupling could also be a calibration artefact in the sitrec formula.

## Views

- **mick** (`interpretive`): Supports the outer-roll-tracks-az interpretation. Acknowledges this weakens Obs #4's endpoint-match precision claim (F-0003 remains intact; refinement only). F-0001's pod-roll coupling survives re-regression: Δglare vs Δaz adds zero explanatory power once pod-roll is in (b_az = −0.01).
  Source: r4, r5 of the F-0007 agent sequence (2026-04-20)

- **cholla** (`interpretive`): Accepts the uniformity test falsifies parallax as the explanation for this 8°. Withdraws near-field scene-locked interpretation of the cloud-rotation excess. AIAA paper's size-growth and shape-evolution arguments remain independent and live; rotation is neutral between readings.
  Source: r3–r5 of the F-0007 agent sequence (2026-04-20)

## Evidence pipeline

1. `182_zaine_check.js` compares predicted flow direction under H1 (world-level / perfect derotator) vs H2 (body-locked) against raw and AH-stabilized observations. H2 wins cleanly: raw flow correlates with +bank, AH-stab flow goes flat.
2. `183_offaxis_decomp.js` computes full geometric image-roll: endpoint swing 12.36° vs observed 20.3°.
3. `184_offaxis_refined.js` grids el (−15° to +15°) × pitch (3–4.2°) × scaleByBank: p95 of grid is 12.93°, well below 14° threshold. Gap is robust.
4. `185_residual_structure.js` shows residual is structured: obs lags pred early, overshoots late. Residual correlates with az at r=−0.49.
5. `187_linear_model_fit.js` shows `obs ≈ −0.39·az + 38.8°`, RMS 1.5°.
6. `188_with_heading.js` proves world-Z yaw rotation is invariant on image roll for near-horizontal LOS.
7. `190_tile_flow.js` tiles the cloud region 6×3 via template-matching; high-magnitude tile flow angles agree within ±1–2°. Uniform → camera-internal.

## Resolution

_(not resolved — mechanism named but not independently verified)_

## What would revise this

1. Regression of residual cloud-rotation **rate** against az-rate (not az itself) — clean test of the outer-roll-tracks-az hypothesis. If residual rate ∝ az rate with consistent slope, mechanism confirmed. If not, new hypothesis needed.
2. ATFLIR engineering documentation or patent text describing an outer-roll gimbal angle coupled to az slew at ~0.13°/°.
3. A tile-flow measurement on a different ATFLIR clip (e.g., GoFast — but pod-roll is tiny there, so signal may not be visible).
4. Demonstration that the cos(az) projection in sitrec's horizon-flattening formula is itself mis-calibrated by ~40% (would shift the "gap" into the geometric model rather than into real ATFLIR mechanics).
