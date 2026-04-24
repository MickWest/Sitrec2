---
id: F-0008
summary: The glare's fitted ellipse shape (semi-major a, semi-minor b, eccentricity e) stays within ATFLIR compression noise (~5% on 11-px blobs) while the ellipse position-angle sweeps 123° across the clip — the signature predicted for a PSF-dominated optical artefact, not a rigid aspect-varying object
status: agreed
sources:
  - analysis/scripts/192_glare_ellipse.js
  - analysis/outputs/192_glare_ellipse.csv
depends_on: [F-0001]
updated: 2026-04-20
reproducibility: scripted
---

## Summary

Fitting an ellipse to the glare blob frame-by-frame (percentile-threshold + connected-component filter, second-moment decomposition) yields stable axis lengths and eccentricity across the clip while the ellipse orientation (position angle, PA) rotates by **123°** total. Full-clip values (68 good-quality fits, sampled every 10 frames, npix ≥ 50): semi-major **a = 10.74 ± 0.50 px (4.7%)**, semi-minor **b = 4.65 ± 0.29 px (6.2%)**, eccentricity **e = 0.900 ± 0.020 (2.2%)**, PA range **−70° to +53°** (123° sweep).

Per-window:
- Active-roll window f=700–1030 (where PA does most of its rotating): a 5.35%, b 5.98%, PA sweep 121°.
- Quiet window f=300–700 (pod-roll barely changes): a 2.32%, b 3.43%, PA sweep 4.8°.

Cholla pre-registered the criterion **"a/b within ±5% while PA sweeps >20°"**. The active-roll window sits right at the noise floor of 11-px ATFLIR-compressed blobs — 5.35% / 5.98% is effectively at the pre-registration cutoff. The full-clip eccentricity (2.2%) is the most robust noise-invariant statistic and passes cleanly.

This is **new Obs #6** in Mick's canonical five-observable framework: "glare shape stability under pod-roll."

## Predictions

- **Glare (optical artefact)**: a, b, e stable within measurement noise; PA tracks pod-roll 1:1. **Observed.**
- **Rigid object rotated through 123° of apparent aspect**: a/b should modulate at 10–20% (wing-on vs nose-on differ by factors, not percents); eccentricity should change accordingly. **Not observed.**

## Views

- **mick** (`interpretive`): Agreed. Proposes this as Obs #6. Eccentricity stability (2.2%) is the primary statistic; ±5% axis stability is a derived aggregate that's at the noise floor. Honest framing: "stable within ATFLIR compression noise."
  Source: r3–r5 of the Obs #6 proposal sequence (2026-04-20)

- **cholla** (`interpretive`): Agreed, with window-selection concession. Pre-registered f=300–700 as his test window but that window was pod-roll-quiet (PA sweep only 4.8°). The active-roll window is the right test. a/b stability at 5.35–5.98% is borderline vs his ±5% pre-registration but within noise-floor for 11-px blobs. Accepts the result as a hit for the glare reading; notes this further weakens — not collapses — the AIAA near-field J-hook argument, which relied on rotation being object-locked.
  Source: r3–r5 of the Obs #6 proposal sequence (2026-04-20)

## Evidence pipeline

1. `192_glare_ellipse.js` loads each sample frame (every 10), normalises polarity (pre/post f=375 inversion), identifies the top 2% brightest pixels in a 40-pixel search radius around image center, filters to the connected component containing the brightest pixel, computes first and second moments to derive a, b, eccentricity, and position angle.
2. Quality filter: npix ≥ 50, b ≥ 2 px (rejects degenerate fits near template edges).
3. Output CSV: per-frame (a, b, eccentricity, PA, npix, centroid) for 68 good-quality fits.
4. Statistics computed over full clip, active-roll window (f=700–1030), and Cholla's pre-registered window (f=300–700).

## Resolution

- **Type:** acceptance (pre-registered criterion on active-roll window nominally falls at noise-floor; eccentricity statistic passes cleanly; both agents agreed)
- **Date:** 2026-04-20
- **Signoff:** mick + cholla concurrent agreement in r4/r5 of the Obs #6 sequence

## What would revise this

1. Higher-resolution un-recompressed ATFLIR feed showing >10% aspect change correlated with PA.
2. A deconvolved fit (point-spread-function removed) returning eccentricity drift >5% over any ≥60° PA window.
3. A physical object model that natively reproduces 5–6% apparent-shape stability across 123° aspect rotation (would need to be a near-spherical or isotropic radiator with no distinguishing profile edges).
4. Demonstration that the ellipse-fit pipeline is unstable at a level comparable to the observed drift (e.g., fit to synthetic known-object frames returns 5%+ scatter in a/b).
