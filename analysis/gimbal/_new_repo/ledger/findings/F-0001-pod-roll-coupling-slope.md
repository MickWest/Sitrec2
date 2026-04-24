---
id: F-0001
summary: Glare in Gimbal video rotates at slope in the range −0.5 to −1.3 against pod-roll across NCC-reliable active-roll windows
status: agreed
sources:
  - analysis/scripts/145_pod_roll_vs_glare.js
  - analysis/scripts/148_ncc_full_video.js
  - analysis/data/145_pod_roll_vs_glare.csv
  - analysis/data/148_ncc_full.csv
  - analysis/logs/36_pod_roll_correlation.md
  - analysis/logs/39_pod_roll_full_video.md
  - X-US9121758
depends_on: []
updated: 2026-04-19
reproducibility: scripted
---

## Summary

Across 394 qualifying same-template NCC pairs covering windows T3, T4, T6 of the Gimbal video (active pod-roll regimes), OLS regression of Δglare-orientation vs Δpod-roll gives slope between −0.66 and −1.3 depending on the sub-window, with a tight central estimate of slope ≈ −1.007 at n=86 in T3. Correlation magnitudes fall in 0.78–0.92 across sub-windows. Full-video NCC (133 reliable samples, log 39) gives average slope ≈ −0.48 when pooling idle + active windows.

This is the signature predicted by an optical artefact upstream of the ATFLIR derotator stage: the derotator applies a rotation equal and opposite to pod-roll on image content, so an artefact injected before the derotator emerges in the final image with rotation angle = −1 × pod-roll. An external object seen through a working derotator would give slope 0; a strictly camera-fixed artefact would also give slope 0; only an upstream-of-derotator optical element matches slope −1.

## Views

- **mick** (`interpretive`): Agreed. Native prediction of the coelostat-upstream-of-derotator reading from US 9,121,758. Already public position since 2022; the measurement confirmed the prediction rather than setting it.
  Source: analysis/agents/agent-mick/r6.md

- **cholla** (`interpretive`): Agreed on the slope; pushed for mechanism specificity (split out as F-0002). Conceded in R6 §2.
  Source: analysis/agents/agent-cholla/r6.md

- **marik** (`interpretive`): Conceded in R4 §6. A close-range real object has no native mechanism to produce a slope −1 coupling with pod-roll.
  > "At slope −1 with correlation 0.92 over 86 pairs, it is not a coincidence; it is a kinematic signature."
  Source: analysis/agents/agent-Marik/obs1_corrected_r4.md

- **zaine** (`interpretive`): Accepted; redirected outstanding concerns to late-rapid-roll residual (F-0005).
  Source: analysis/agents/agent-zaine/r6.md

## Evidence pipeline

1. `analysis/scripts/148_ncc_full_video.js` runs normalized cross-correlation across 5 templates covering the full video, producing `analysis/data/148_ncc_full.csv` (133 reliable samples, corr ≥ 0.9).
2. `analysis/scripts/145_pod_roll_vs_glare.js` pairs reliable NCC samples within the same template, computes Δglare vs Δpod-roll (from HUD bank/az in `data-sources/GimbalData.csv` via the ATFLIR kinematic chain), filters to |Δpod-roll| ≥ threshold for active-roll windows.
3. Robust OLS fit per window (T3: f=500..790, T4: f=...; see log 36). Output: slope, correlation, n.
4. Cross-check: `analysis/data/140_ncc_extended.csv` (3-template) gives consistent slopes.

## Resolution

- **Type:** demonstration
- **Date:** 2026-04-19
- **Signoff:** mick (repo owner); cholla R6 §2; marik R4 §6; zaine R6 §3.

## What would revise this

1. Repeat the NCC measurement with a different cloud mask or template set and obtain slope outside [−1.3, −0.5].
2. Demonstrate a mechanism other than derotator-downstream-of-coelostat that natively produces slope −1 against pod-roll.
3. Show that the ATFLIR public patents cited (US 9,121,758, US 6,288,381, EP 2525235) do not describe the coelostat-and-derotator architecture we relied on.
4. Surface ATFLIR-specific documentation (US 5,967,458 or successors) that contradicts the coelostat-upstream reading.
