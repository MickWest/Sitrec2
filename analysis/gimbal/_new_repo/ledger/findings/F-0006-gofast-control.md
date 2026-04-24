---
id: F-0006
summary: GoFast companion video's low pod-roll change (Δ=3.76°) predicts ~4° of artefact rotation under the derotator reading, matching observation
status: agreed
sources:
  - analysis/scripts/20_gofast_predict.js
  - analysis/scripts/158_gofast_formula_decomp.js
  - analysis/data/20_gofast_predict.csv
  - analysis/logs/49_gofast_pod_roll.md
  - analysis/logs/50_gofast_formula_decomp.md
depends_on: [F-0001]
updated: 2026-04-19
---

## Summary

GoFast, recorded in the same engagement as Gimbal, shows pod-roll changing by only −3.76° over its recorded window — compared with Gimbal's ~240°. The derotator-upstream-of-coelostat reading predicts that the artefact rotation on GoFast should scale linearly with pod-roll, i.e. ~4° of visible orientation change. This matches observation: GoFast shows no dramatic rotating-glare phenomenon comparable to Gimbal.

Log 50 identified az×tan(el) coupling at deep look-down as dominant in the 30° gap between Sitrec's scene-rotation prediction and the measurement on GoFast (log 11). This closes the earlier "GoFast breaks the formula" objection.

## Views

- **mick** (`interpretive`): Agreed. GoFast is a kinematic regime where the rotating-artefact mechanism is near-invisible, not a counterexample.
  Source: analysis/agents/agent-mick/r6.md

- **cholla** (`interpretive`): Accepted in R6. Had previously treated GoFast as an open lever against the derotator reading; retired it.
  Source: analysis/agents/agent-cholla/r6.md

- **zaine** (`interpretive`): Withdrew "GoFast breaks the formula" as an objection to the rotating-glare reading; keeps it as an open scene-rotation-formula problem (partially closed by log 50).
  Source: analysis/agents/agent-zaine/r6.md

- **marik** (`interpretive`): Retracted GoFast as a live lever in R4.
  Source: analysis/agents/agent-Marik/obs1_corrected_r4.md

## Evidence pipeline

1. GoFast HUD data: pod-roll change = −3.76° over recorded window.
2. Derotator reading: artefact rotation = −1 × pod-roll = ~4°.
3. Observation: GoFast glare does not exhibit the rotating pattern of Gimbal.
4. `analysis/scripts/158_gofast_formula_decomp.js` decomposes the Sitrec scene-rotation-formula prediction; az×tan(el) dominates the 15° over-prediction.

## Resolution

- **Type:** demonstration
- **Date:** 2026-04-19
- **Signoff:** mick, cholla R6 §4, zaine R6 §5, marik R4 §5.

## What would revise this

1. Evidence that GoFast DOES exhibit a ~4° rotation that I've missed (would actually *strengthen* F-0001, not weaken it).
2. A re-measurement showing pod-roll change on GoFast substantially different from −3.76°.
3. A mechanism under which GoFast *should* exhibit the Gimbal-scale rotation despite low pod-roll — would reopen F-0001 itself.
