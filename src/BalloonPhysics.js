// BalloonPhysics.js — pure integrator for the simulated balloon target track
// (CNodeBalloonTrack). The wind sampler is injected, so Jest can unit-test the
// kinematics with synthetic wind and no node graph.

import {LLAToECEF, ECEFToLLAVD_radii} from "./LLA-ECEF-ENU";
import {getLocalEastVector, getLocalNorthVector, getLocalUpVector} from "./SphericalMath";
import {meanSeaLevelOffset} from "./EGM96Geoid";
import {mulberry32} from "./DifferentialEvolution";

// Integrate the balloon's per-frame ECEF positions.
//
// params:
//   startLat, startLon   degrees
//   startAltMSL          meters MSL (default: ground at the click point)
//   launchDelay          seconds of sim time the balloon holds at the start
//   ascentRate           m/s vertical rate once launched ("buoyancy")
//   variabilityPct       0..100 — gust magnitude as a percentage of the local
//                        wind speed (plus a 0.5 m/s floor so calm air still
//                        meanders); smooth seeded gusts re-target every 3-8 s
//   seed                 PRNG seed — same seed → identical flight
//   frames               number of frames to generate
//   dt                   sim seconds per frame (Sit.simSpeed / Sit.fps)
//
// windAt(lat, lon, altMSL, f) → {u, v} wind in m/s (u = east, v = north).
//
// Returns an array of {position: Vector3(ECEF)} of length frames — the value
// shape CNodeTrack consumers expect.
//
// Deterministic: same params + same windAt behavior → identical output.
export function integrateBalloonPositions(params, windAt) {
    const {
        startLat, startLon,
        startAltMSL = 0,
        launchDelay = 0,
        ascentRate = 5,
        variabilityPct = 0,
        seed = 1,
        frames,
        dt,
    } = params;

    const rand = mulberry32((seed >>> 0) || 1);
    const out = new Array(frames);

    let lat = startLat;
    let lon = startLon;
    let altMSL = startAltMSL;
    let pos = LLAToECEF(lat, lon, altMSL + meanSeaLevelOffset(lat, lon));

    // smooth gust state (m/s, ENU)
    let gustU = 0, gustV = 0;
    let tGustU = 0, tGustV = 0;
    let nextGust = 0;

    for (let f = 0; f < frames; f++) {
        out[f] = {position: pos.clone()};
        const t = f * dt;
        if (t < launchDelay) continue;   // holding at the start point

        const wind = windAt(lat, lon, altMSL, f) || {u: 0, v: 0};

        if (variabilityPct > 0) {
            if (t >= nextGust) {
                const baseMag = Math.hypot(wind.u, wind.v);
                const mag = (variabilityPct / 100) * (baseMag + 0.5) * (0.3 + 0.7 * rand());
                const ang = rand() * 2 * Math.PI;
                tGustU = Math.cos(ang) * mag;
                tGustV = Math.sin(ang) * mag;
                nextGust = t + 3 + rand() * 5;
            }
            const k = Math.min(1, dt / 2);
            gustU += (tGustU - gustU) * k;
            gustV += (tGustV - gustV) * k;
        } else {
            gustU = 0;
            gustV = 0;
        }

        const dE = (wind.u + gustU) * dt;
        const dN = (wind.v + gustV) * dt;
        const dU = ascentRate * dt;

        // step in the local ENU frame at the current position
        const east = getLocalEastVector(pos);
        const north = getLocalNorthVector(pos);
        const up = getLocalUpVector(pos);
        pos = pos.clone()
            .add(east.multiplyScalar(dE))
            .add(north.multiplyScalar(dN))
            .add(up.multiplyScalar(dU));

        // refresh the geodetic state for the next wind sample
        const lla = ECEFToLLAVD_radii(pos);
        lat = lla.x;
        lon = lla.y;
        altMSL = lla.z - meanSeaLevelOffset(lat, lon);
    }
    return out;
}
