---
id: F-0002
summary: Diffraction-spike orientation and glare orientation maintain a constant angular offset (std 2–6°) within NCC templates, indicating shared optical origin
status: agreed
sources:
  - analysis/scripts/155_obs5_unwrap.js
  - analysis/scripts/157_combined_scatter.js
  - analysis/data/155_spike_unwrap.csv
  - analysis/logs/45_obs5_strong.md
  - analysis/logs/46_spike_glare_coupling.md
depends_on: [F-0001]
updated: 2026-04-19
reproducibility: scripted
---

## Summary

Polarity-aware spike unwrap across 10,953 frame-pairs (log 45) gives Δspike vs Δpod-roll slope = −0.92 at correlation −0.985. The spike-glare angular offset, measured within each NCC template, has standard deviation between 2° and 6° across templates (log 46) — i.e., the two rotational channels co-rotate with a locked offset, not a variable one.

This is a falsifier for any hypothesis in which glare and spikes have different physical origins. A sensor-fixed aperture diffraction pattern has slope 0 against pod-roll (independent of pod-roll by construction); an external object has slope 0 through a working derotator; neither can produce slope ≈ −1 with the constant-offset constraint. The only consistent reading is that both channels share an optical element upstream of the derotator.

## Views

- **mick** (`interpretive`): Agreed. Two rotational channels at slope −1 with constant offset is the strongest single line of evidence for the upstream-optical-element reading.
  Source: analysis/agents/agent-mick/r6.md

- **cholla** (`methodological`): Conceded in R6 §2. Noted as "the geometric argument you already granted."
  Source: analysis/agents/agent-cholla/r6.md

- **marik** (`methodological`): Has not directly addressed this specific finding in public; agent-Marik flagged in R4 as the line of evidence most resistant to the close-range reading.
  > "Item 2 is the one I haven't touched."
  Source: analysis/agents/agent-Marik/obs1_corrected_r4.md (inferred)

- **zaine** (`framing`): Accepts the co-rotation result but asked whether the spikes might originate at the fine-steering mirror rather than the coelostat (which would still be upstream of the derotator, so wouldn't change the conclusion).
  Source: analysis/agents/agent-zaine/r6.md

## Evidence pipeline

1. `analysis/scripts/155_obs5_unwrap.js` uses top-4 spike candidates per frame from `analysis/data/102_obs5_spikes.csv`, applies polarity-aware unwrap.
2. Per-frame spike orientation paired with pod-roll → `analysis/data/155_spike_unwrap.csv`.
3. OLS fit with robust outlier rejection → slope −0.92, r −0.985, n=10,953.
4. `analysis/scripts/157_combined_scatter.js` overlays glare (F-0001) and spike channels; offset std computed per NCC template (log 46) at 2–6°.

## Resolution

- **Type:** demonstration
- **Date:** 2026-04-19
- **Signoff:** mick, cholla R6 §2, zaine R6 §3. Marik not explicitly signed off — carried as "not directly addressed" pending new position.

## What would revise this

1. A plausible geometric scenario in which two features with different physical origins maintain offset std ≤ 6° across templates spanning large bank changes.
2. Identification of the spikes as originating at a point in the optical chain that is NOT upstream of the derotator (would contradict the slope−1 signature, requiring re-analysis).
3. A sub-window where spike-glare offset std exceeds 10° — would indicate the lock is noise-dependent and not a structural constraint.
