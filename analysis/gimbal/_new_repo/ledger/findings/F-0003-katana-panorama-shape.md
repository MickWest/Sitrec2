---
id: F-0003
summary: A stitched panorama of the Gimbal video built from AH-stabilized cloud-feature tracking produces a curved "katana" shape ~27:1 aspect
status: agreed
sources:
  - analysis/scripts/174_sitrec_stitched_panorama.js
  - analysis/scripts/180_final_panorama.js
  - analysis/gimbal-motion-analysis-sitch/Sitrec-Gimbal_Cloud_Motion_Analyss_motion_2026-04-18T21-41-19.csv
  - analysis/outputs/180_panorama.png
  - analysis/logs/58_katana_panorama.md
  - X-MB-14839
depends_on: []
updated: 2026-04-19
reproducibility: recipe
---

## Summary

Stitching the 34 s of the Gimbal video by placing each AH-stabilized frame at its cumulative cloud-motion offset (Sitrec's `CMotionAnalysis` linear-tracklet flow, cumulated) produces a continuous curved band with path length ≈ 4283 px at 160 px cloud-band height — roughly 27:1 aspect. The path curves smoothly: motion-direction rotates from ~21° to ~41° across the video (20° swing), and the mean flow magnitude drops from ~6 px/frame to ~2 px/frame.

The curve is geometrically the expected shape for an AH-stabilized pod tracking a target while the pod's azimuth sweeps through 38° and elevation through 0.4°, with residual rotation from the az×tan(el) coupling and fine-steering residuals.

Participants agree the shape exists and is reproducible. What it *means* is split (F-0004).

## Views

- **mick** (`interpretive`): Public position "cause undetermined" (Metabunk 14839 p2.69). Accepts the shape is real; disputes close-range-pan reading.
  > "That's overstating. I got a similar curve in a panorama, the cause of which is undetermined."
  Source: X-MB-14839

- **cholla** (`interpretive`): Attributes the curvature to "slight downward panning of the camera, as proposed" (14839 p3.86). Argues this is equivalent in evidential weight to Mick's derotator reading.
  Source: X-MB-14839

- **marik** (`interpretive`): Uses the downward component of the curve as evidence of close-range geometry (camera pans down ~0.4° because target is near, producing parallax).
  Source: X-marik2026-transcript

- **zaine** (`interpretive`): Attributes to frustum roll from jet pitch change.
  Source: X-MB-14839

- **LBF** (`interpretive`): Accepts the optical-artefact reading of F-0001/F-0002 as independent of the katana; treats the panorama curve as descriptive.
  Source: analysis/agents/agent-LBF/r6.md

## Evidence pipeline

1. Sitrec's GUI runs `CMotionAnalysis` on an AH-stabilized version of the Gimbal video (user-produced stabilization, see F-0008 for provenance), with default Linear Tracklet method + blur=5 + frameSkip=3.
2. Exported motion CSV (`frame, angle_deg, magnitude_px`) — smoothed per-frame motion direction.
3. `analysis/scripts/180_final_panorama.js` integrates (−mag·cosθ, −mag·sinθ) per frame (Sitrec convention), applies flow alignment rotation, AH-stabilizes each frame by −bank(f), places on canvas via Voronoi cells (nearest-centroid-wins), paints each pixel from the nearest frame.
4. Plateau-smoothing pass (interpolates through CSV plateau runs caused by smoothing).
5. Renders a 4515×2432 canvas; visible blade aspect ≈ 27:1; polarity flip visible mid-blade.

## Resolution

- **Type:** demonstration
- **Date:** 2026-04-19
- **Signoff:** mick (acknowledged shape exists, 14839 p2.69); cholla (14839 p3.86); marik (transcript); zaine (14839).

## What would revise this

1. A reproduction attempt using Sitrec with the same inputs that produces a substantially different shape (aspect, curvature, or path length).
2. Evidence that Sitrec's Linear Tracklet measurement is systematically biased in a way that inflates the path length by a factor ≥ 2 (my direct LK check in script 177 found ~2.5 px/frame at blur=15, consistent with Sitrec's measurement accounting for frameSkip=3).
3. The shape of the curve changes qualitatively under an alternative flow method (phase correlation, ECC) — would indicate method-dependence rather than a real signal.
