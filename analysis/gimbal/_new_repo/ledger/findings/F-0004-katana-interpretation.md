---
id: F-0004
summary: The katana panorama shape does not by itself discriminate between the derotator, camera-pan, and frustum-roll readings
status: agreed
sources:
  - analysis/logs/58_katana_panorama.md
  - X-MB-14839
depends_on: [F-0003]
updated: 2026-04-19
---

## Summary

The katana panorama shape (F-0003) can be produced by:
- **Derotator / optical-artefact reading**: natural consequence of an AH-stabilized view of distant clouds while the pod sweeps azimuth, mediated by the derotator and az×tan(el) coupling.
- **Camera-pan-down reading**: slight downward pan across 34 s produces the curve (Cholla, Marik).
- **Frustum-roll reading**: jet pitch change produces the curve (Zaine).

All three are consistent with the observed 4283 px path. The shape is a *necessary* consequence of the AH-stabilized cloud-stitch geometry given a pod swing of ~38° azimuth × 0.4° elevation; it is not a *sufficient* signature of any particular mechanism.

Therefore the katana shape on its own is *neutral* evidence. Discrimination between the mechanisms requires additional signatures — specifically the pod-roll coupling (F-0001) and spike-glare offset constancy (F-0002).

## Views

- **mick** (`interpretive`): Agreed. "On its own it doesn't discriminate between the dero reading and a pan reading" (draft response to Cholla, 2026-04-19). Argument for derotator lives in F-0001/F-0002, not here.
  Source: analysis/drafts/metabunk_response_cholla_2026-04-19.md

- **cholla** (`interpretive`): Agreed. Explicitly argued the katana does not give more evidence to derotator than panning.
  > "I really don't think there is more evidence for the dero explanation than the camera panning one."
  Source: X-MB-14839

- **marik** (`framing`): Disputes the framing. Treats the downward component of the curve as positive evidence of close range, independent of the general geometric explanation.
  Source: X-marik2026-transcript

## Evidence pipeline

1. F-0003 establishes the shape exists and is reproducible.
2. Each of the three readings is geometrically capable of producing the curve with different free parameters (pod kinematics, pan rate, jet pitch rate).
3. The question of which reading is *correct* is resolved elsewhere: F-0001 and F-0002 are discriminators that the katana alone is not.

## Resolution

- **Type:** demonstration
- **Date:** 2026-04-19
- **Signoff:** mick, cholla. Marik disputes the framing (treated as persisting `framing` disagreement but not blocking the finding's status).

## What would revise this

1. A quantitative test that IS sensitive to the difference between the three mechanisms at the precision the katana provides — e.g., a specific curvature profile that only one mechanism predicts.
2. Evidence that the katana *does* discriminate in a specific regime (e.g., the polarity-flip region, the late-rapid-roll region) that hasn't been inspected yet.
