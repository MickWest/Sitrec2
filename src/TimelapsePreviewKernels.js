// TimelapsePreviewKernels.js
//
// The calculations of the timelapse preview (TimelapsePreview.js): star, planet
// and satellite trails as line segments with a linear brightness per vertex.
// Pure — no Sitrec globals, no DOM — so the preview's workers
// (workers/TimelapsePreviewWorker.js) run this same code, and the main thread
// runs it too when there are no workers (and for the planets).
//
// Everything a kernel needs is in a plain `job` object built by the main thread
// (TimelapsePreview.buildJob): the exposure's timeline, the camera and its lens,
// the photometry settings, the Sun's direction at each satellite sample and the
// Camera Nudge rotations. Vectors are plain [x, y, z] arrays there, so the job
// copies to a worker as is.
//
// The physics is the long-exposure render's: refraction (atmosphere/refraction.js),
// extinction, point spread and satellite brightness (ExposurePhotometry.js,
// SatelliteBrightness.js).

import {Quaternion, Vector3} from "three";
import * as satellite from "satellite.js";
import {applyRefractionECI, applyRefractionFromObserver} from "./atmosphere/refraction";
import {LENS_PRESETS} from "./CameraLens";
import {panoramaProject} from "./rendering/PanoramaMath";
import {alongTrackFraction, chooseTrailVertices, extinctionRGB, satelliteExposureFlux} from "./ExposurePhotometry";
import {satelliteECEF, satelliteSunlitFraction} from "./SatelliteBrightness";

// ---------------------------------------------------------------------------
// Projection: camera-relative world vector -> canvas pixel, as the look view
// draws it (job.projection is a snapshot of the drawn camera and its lens).

// The fisheye: FisheyeProjection.fisheyeViewToNDC with the state passed in
// (tests/TimelapsePreviewKernels.test.js checks the two agree).
function fisheyeToNDC(v, f, aspect) {
    const d = v.length();
    if (!(d > 1e-9) || -v.z / d < Math.cos(f.cullTheta)) return false;
    let theta = Math.acos(Math.min(1, Math.max(-1, -v.z / d)));
    theta = Math.min(theta, f.maxTheta);
    const preset = LENS_PRESETS[f.lensType] ?? LENS_PRESETS.equisolidFisheye;
    const rho = preset.rho(theta, f.curveK);
    const l = Math.hypot(v.x, v.y);
    let dx = 0, dy = 0;
    if (l > 1e-9) {
        dx = v.x / l;
        dy = v.y / l;
    }
    const cr = Math.cos(f.roll), sr = Math.sin(f.roll);
    const rx = cr * dx - sr * dy;
    const ry = sr * dx + cr * dy;
    const rNdcY = (rho / f.rhoEdge) * f.circleScale;
    const cx = f.centerX * 2 / aspect, cy = f.centerY * 2;
    v.set(cx + rNdcY * rx / aspect, cy + rNdcY * ry, 0);
    // outside the image circle the render is masked to black
    return !(f.showCircle && Math.hypot((v.x - cx) * aspect, v.y - cy) > f.circleScale);
}

export function makeProjector(projection) {
    const qInv = new Quaternion().fromArray(projection.qInv);
    const v = new Vector3();
    const {lensMode, e, W, H, aspect, fisheye, panorama} = projection;
    return (rel, out) => {
        v.copy(rel).applyQuaternion(qInv);
        if (lensMode === "fisheye") {
            if (!fisheyeToNDC(v, fisheye, aspect)) return false;
        } else if (lensMode === "panorama") {
            panoramaProject(v, panorama.hfov, panorama.vfov);
            if (Math.abs(v.x) > 1 || Math.abs(v.y) > 1) return false;
        } else {
            const cw = e[3] * v.x + e[7] * v.y + e[11] * v.z + e[15];
            if (cw <= 1e-9) return false;
            const cx = e[0] * v.x + e[4] * v.y + e[8] * v.z + e[12];
            const cy = e[1] * v.x + e[5] * v.y + e[9] * v.z + e[13];
            v.x = cx / cw;
            v.y = cy / cw;
        }
        out.x = (v.x + 1) * 0.5 * W;
        out.y = (1 - v.y) * 0.5 * H;
        return true;
    };
}

// ---------------------------------------------------------------------------
// Shared trail steps

// Linear value at the middle of the trail, per channel: source rgb times the
// fraction of its energy that one pixel along the trail receives, from the pixel
// speed between neighbouring samples. `gapBefore[i]` marks a sample that starts a
// new run: its neighbour before it is not on the same stretch of path.
export function trailValues(job, project, rel, times, rgb, gapBefore) {
    const n = rel.length;
    const px = new Float64Array(n * 2), ok = new Uint8Array(n);
    const p = {x: 0, y: 0};
    for (let i = 0; i < n; i++) {
        if (project(rel[i], p)) {
            px[i * 2] = p.x;
            px[i * 2 + 1] = p.y;
            ok[i] = 1;
        }
    }
    const out = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
        // central difference, one-sided at the ends of a run
        const a = (i > 0 && !gapBefore?.[i]) ? i - 1 : i;
        const b = (i + 1 < n && !gapBefore?.[i + 1]) ? i + 1 : i;
        const dt = times[b] - times[a];
        let speed = 0;
        if (dt > 0) {
            if (ok[a] && ok[b]) {
                speed = Math.hypot(px[b * 2] - px[a * 2], px[b * 2 + 1] - px[a * 2 + 1]) / dt;
            } else {
                // not imaged: angular speed at the image centre's scale
                speed = rel[a].angleTo(rel[b]) * job.projection.pxPerRad / dt;
            }
        }
        const along = alongTrackFraction(speed * job.windowSeconds, job.psfSigma);
        out[i * 3] = rgb[i * 3] * along;
        out[i * 3 + 1] = rgb[i * 3 + 1] * along;
        out[i * 3 + 2] = rgb[i * 3 + 2] * along;
    }
    return out;
}

// A growing list of segments: 6 position and 6 color floats each.
export function makeSink() {
    return {pos: [], col: [], trails: 0};
}

// Append the segments between consecutive vertices whose ends are not both
// dark. With `gapBefore`, a segment that spans the start of a new run of samples
// (out of view between two passes through it) is left out. Returns the
// segments added.
export function emitTrail(sink, rel, values, indices, scale, gapBefore = null) {
    let segments = 0;
    for (let k = 0; k + 1 < indices.length; k++) {
        const i = indices[k], j = indices[k + 1];
        if (gapBefore) {
            let gap = false;
            for (let m = i + 1; m <= j && !gap; m++) gap = gapBefore[m];
            if (gap) continue;
        }
        const vi = Math.max(values[i * 3], values[i * 3 + 1], values[i * 3 + 2]);
        const vj = Math.max(values[j * 3], values[j * 3 + 1], values[j * 3 + 2]);
        if (Math.max(vi, vj) < 1e-6) continue;
        sink.pos.push(rel[i].x * scale, rel[i].y * scale, rel[i].z * scale,
            rel[j].x * scale, rel[j].y * scale, rel[j].z * scale);
        sink.col.push(values[i * 3], values[i * 3 + 1], values[i * 3 + 2],
            values[j * 3], values[j * 3 + 1], values[j * 3 + 2]);
        segments++;
    }
    if (segments > 0) sink.trails++;
    return segments;
}

// ---------------------------------------------------------------------------
// The sky: stars and planets

// EQJ direction -> ECEF at `seconds` after the exposure start: the start's exact
// EQJ->ECEF rotation (CelestialMath.getEQJToECEFMatrix, job.m0), then the
// Earth's turn since. Precession and nutation change by far less than a
// milliarcsecond over a night, so only the sidereal turn moves.
export function skyDirection(job, eq, seconds, out) {
    const m = job.m0;   // Matrix4.elements, column-major
    const x = m[0] * eq.x + m[4] * eq.y + m[8] * eq.z;
    const y = m[1] * eq.x + m[5] * eq.y + m[9] * eq.z;
    const z = m[2] * eq.x + m[6] * eq.y + m[10] * eq.z;
    const a = job.earthRate * seconds;
    const c = Math.cos(a), s = Math.sin(a);
    return out.set(x * c + y * s, -x * s + y * c, z);
}

const _dir = new Vector3(), _previous = new Vector3();

// One celestial trail into `sink`. dirAt(seconds, out) gives the geometric ECEF
// unit direction. Returns true when something was drawn.
export function celestialTrail(job, project, dirAt, flux, tint, sink) {
    const up = job.upV, axis = job.axisV;
    // Probe four steps: skip a trail below the horizon all through (refraction
    // lifts less than 1°) or outside the view, and measure its length.
    const horizonAlt = Math.asin(job.horizonSin) - 0.02;
    let near = false, upper = false, length = 0, previousAngle = 0, previousAlt = 0;
    for (let k = 0; k <= 4; k++) {
        dirAt(job.durationSeconds * k / 4, _dir);
        const angle = Math.acos(Math.max(-1, Math.min(1, _dir.dot(axis))));
        const alt = Math.asin(Math.max(-1, Math.min(1, _dir.dot(up))));
        if (k > 0) {
            const step = _dir.angleTo(_previous);
            length += step;
            if (Math.min(angle, previousAngle) - step / 2 < job.coneAngle) near = true;
            if (Math.max(alt, previousAlt) + step / 2 > horizonAlt) upper = true;
        }
        _previous.copy(_dir);
        previousAngle = angle;
        previousAlt = alt;
    }
    if (!near || !upper) return false;

    // Segments Per Trail, but none shorter than minSkySegmentPx.
    const n = Math.min(job.segments, Math.max(1, Math.ceil(length * job.projection.pxPerRad / job.minSkySegmentPx)));
    const rotations = job.skyRotations?.[n];
    const rel = new Array(n + 1), rgb = new Float32Array((n + 1) * 3), times = new Float64Array(n + 1);
    for (let k = 0; k <= n; k++) {
        times[k] = job.durationSeconds * k / n;
        const d = dirAt(times[k], new Vector3());
        applyRefractionECI(d, job.zenithV, job.skyRefraction);
        const sinAlt = d.dot(up);
        if (sinAlt >= job.horizonSin) {
            const ex = extinctionRGB(sinAlt, job.extinctionK, job.kAltScale, job.reddening);
            rgb[k * 3] = flux * tint[0] * ex[0];
            rgb[k * 3 + 1] = flux * tint[1] * ex[1];
            rgb[k * 3 + 2] = flux * tint[2] * ex[2];
        }
        if (rotations) d.applyQuaternion(_q.fromArray(rotations, k * 4));
        rel[k] = d;
    }
    const values = trailValues(job, project, rel, times, rgb, null);
    const indices = Array.from({length: n + 1}, (_, k) => k);
    return emitTrail(sink, rel, values, indices, job.skyRadius) > 0;
}
const _q = new Quaternion();

// A first test for a catalog star, from its RA and Dec alone, before any
// trigonometry: can it enter the view cone during the exposure? Stars turn about
// the pole at constant declination (to within the precession since J2000 and the
// aberration, covered by the margin), and the view axis, fixed on the Earth,
// sweeps east in RA by the Earth's turn. So a star farther in declination from
// the axis than the cone, or outside the RA band the cone sweeps, cannot. Null
// when the cone is too wide for the test to reject anything.
const STAR_BAND_MARGIN = Math.PI / 180;
export function starBand(job) {
    const c = job.coneAngle + STAR_BAND_MARGIN;
    if (c >= Math.PI / 2) return null;
    // the axis in EQJ at the start: the transpose of the EQJ->ECEF rotation
    const m = job.m0, a = job.axisV;
    const ax = m[0] * a.x + m[1] * a.y + m[2] * a.z;
    const ay = m[4] * a.x + m[5] * a.y + m[6] * a.z;
    const az = m[8] * a.x + m[9] * a.y + m[10] * a.z;
    const decAxis = Math.asin(Math.max(-1, Math.min(1, az)));
    const raAxis = Math.atan2(ay, ax);
    const sweep = job.earthRate * job.durationSeconds;
    // the cone's half-width in RA, when it holds no pole
    const halfRA = Math.abs(decAxis) + c < Math.PI / 2 ? Math.asin(Math.sin(c) / Math.cos(decAxis)) : Math.PI;
    const raTest = sweep + 2 * halfRA < 2 * Math.PI;
    const TWO_PI = 2 * Math.PI;
    return (ra, dec) => {
        if (Math.abs(dec - decAxis) > c) return false;
        if (!raTest) return true;
        let d = (ra - raAxis) % TWO_PI;
        if (d < 0) d += TWO_PI;
        return d <= sweep + halfRA || d >= TWO_PI - halfRA;
    };
}

// Stars of the catalog with index offset, offset + stride, ... (a worker's share).
export function computeStarTrails(job, catalog, offset, stride, sink) {
    const project = makeProjector(job.projection);
    const tint = job.tint;
    const V = job.aberration;
    const eq = new Vector3();
    const dirAt = (seconds, out) => skyDirection(job, eq, seconds, out);
    const inBand = starBand(job);
    let drawn = 0;
    for (let i = offset; i < catalog.count; i += stride) {
        if (inBand && !inBand(catalog.ra[i], catalog.dec[i])) continue;
        const flux = Math.pow(10, -0.4 * (catalog.mag[i] - job.satMag));
        if (flux < 1e-5) continue;
        // CelestialMath.raDec2Celestial, then applyAnnualAberration with the
        // Earth's velocity at the render's start instant, as the render does.
        const ra = catalog.ra[i], dec = catalog.dec[i];
        eq.set(Math.cos(dec) * Math.cos(ra) + V[0], Math.cos(dec) * Math.sin(ra) + V[1], Math.sin(dec) + V[2]).normalize();
        if (celestialTrail(job, project, dirAt, flux, tint, sink)) drawn++;
    }
    return drawn;
}

// ---------------------------------------------------------------------------
// Satellites

// Sample spacing for a satellite: at most this much motion between samples, and
// at least one sample this often (seconds). Never finer than the render's samples.
const MAX_STEP_PX = 2;
const MAX_STEP_RAD = 0.005;
const MAX_STEP_SECONDS = 30;
// The orbit-phase test: checked this often (seconds), with this margin (radians).
const PHASE_STEP_SECONDS = 60;
const PHASE_MARGIN = 3 * Math.PI / 180;
const EARTH_TURN = 7.2921158553e-5;   // rad/s
// Sunlit fraction within this of 1 (or 0) at both ends of a coarse interval is
// interpolated rather than calculated: the full model is costly near the shadow.
const LIT_TOLERANCE = 0.005;

// The tle filter's sample nearest to timeMS (CSatellite._nearestSampleIndex).
function nearestSampleIndex(times, timeMS) {
    let bestIdx = 0;
    let bestDist = Math.abs(timeMS - times[0]);
    for (let s = 1; s < times.length; s++) {
        const d = Math.abs(timeMS - times[s]);
        if (d < bestDist) { bestDist = d; bestIdx = s; }
        else break;
    }
    return bestIdx;
}

// Can the satellite be above the horizon and in the view between coarse points
// a and b? Every point of the arc between them lies within half the arc of an
// end, so each test is widened by half the step (and 2° for the arc's curve).
function mayShow(job, a, b, dirs, axisAngles, altitudes, horizonAlt) {
    const half = dirs[a].angleTo(dirs[b]) / 2 + 2 * Math.PI / 180;
    return Math.min(axisAngles[a], axisAngles[b]) - half < job.coneAngle
        && Math.max(altitudes[a], altitudes[b]) + half > horizonAlt;
}

// A cheap test before the SGP4 grid, one SGP4 call per satellite. Its position
// and velocity at mid-exposure give the orbit plane and the angular rate; along
// the orbit it moves at that rate (near enough for a circular orbit over the
// exposure). It can only be above the observer's horizon where it comes within
// arccos(R/r) of the observer, who turns with the Earth (plus the observer's own
// horizon reach). False when it never does. Eccentric and deep-space orbits always
// pass, as does an orbit that fails to propagate (the full test decides).
function phaseTester(job) {
    const R = job.satSettings.equatorRadius / 1000;   // km, as SGP4
    const startMS = job.coarseMS[1];
    const midDate = new Date(startMS + job.durationSeconds * 500);
    const camR = job.camPosV.length();
    const reachObserver = Math.acos(Math.min(1, job.satSettings.equatorRadius / camR));
    const o = job.camPosV.clone().divideScalar(camR);
    const steps = Math.max(1, Math.ceil(job.durationSeconds / PHASE_STEP_SECONDS));
    const half = job.durationSeconds / steps / 2;
    const checks = [];
    for (let k = 0; k <= steps; k++) {
        const seconds = job.durationSeconds * k / steps;
        const g = satellite.gstime(new Date(startMS + seconds * 1000));
        checks.push({dt: seconds - job.durationSeconds / 2,
            o: new Vector3(o.x * Math.cos(g) - o.y * Math.sin(g), o.x * Math.sin(g) + o.y * Math.cos(g), o.z)});
    }
    const e1 = new Vector3(), e2 = new Vector3(), h = new Vector3(), v = new Vector3(), sDir = new Vector3();
    return (satrec) => {
        if (satrec.method === "d" || !(satrec.ecco < 0.05)) return true;
        const pv = satellite.propagate(satrec, midDate);
        if (!pv || !pv.position || !pv.velocity) return true;
        e1.set(pv.position.x, pv.position.y, pv.position.z);
        v.set(pv.velocity.x, pv.velocity.y, pv.velocity.z);
        const r = e1.length();
        if (!(r > R)) return true;
        h.crossVectors(e1, v);
        const rate = h.length() / (r * r);   // rad/s
        e1.divideScalar(r);
        h.normalize();
        e2.crossVectors(h, e1);
        const reach = Math.acos(R / r) + reachObserver + PHASE_MARGIN + (rate + EARTH_TURN) * half;
        for (const {dt, o: oc} of checks) {
            const a = rate * dt;
            sDir.copy(e1).multiplyScalar(Math.cos(a)).addScaledVector(e2, Math.sin(a));
            if (Math.acos(Math.max(-1, Math.min(1, sDir.dot(oc)))) < reach) return true;
        }
        return false;
    };
}

// The trails of a list of satellites: [{satrec, name, number, filter}], where
// filter is undefined, "on" or the per-sample visibility array of the TLE filter.
// Propagated (SGP4) on a coarse grid, first one point a minute, and the rest only
// for a satellite that may come into view; the render's samples in between by a
// cubic through four coarse points. Positions are relative to the camera.
export function computeSatelliteTrails(job, satellites, sink) {
    const project = makeProjector(job.projection);
    const camPos = job.camPosV, up = job.upV;
    const a = job.satSettings.equatorRadius, b = job.satSettings.polarRadius;
    const C = job.coarseSeconds;
    const nCoarse = job.coarseMS.length, nFine = job.fineTimes.length;
    const coarseDates = Array.from(job.coarseMS, ms => new Date(ms));
    const coarseSun = Array.from({length: nCoarse}, (_, j) => new Vector3().fromArray(job.coarseSun, j * 3));
    const fineSun = Array.from({length: nFine}, (_, m) => new Vector3().fromArray(job.fineSun, m * 3));
    const rotations = job.satRotations
        ? Array.from({length: nFine}, (_, m) => new Quaternion().fromArray(job.satRotations, m * 4)) : null;
    const horizonAlt = Math.asin(job.horizonSin) - 0.02;
    const coarse = Array.from({length: nCoarse}, () => new Vector3());
    const coarseDir = Array.from({length: nCoarse}, () => new Vector3());
    const coarseAxis = new Float64Array(nCoarse), coarseAlt = new Float64Array(nCoarse);
    const active = new Uint8Array(nCoarse), coarseLit = new Float64Array(nCoarse);
    const lagrange = new Float64Array(4);
    const p = new Vector3(), dir = new Vector3();
    const stats = {candidates: 0, near: 0, active: 0, fineSamples: 0, drawn: 0, msCoarse: 0, msFine: 0, msTrail: 0,
        exactSunlit: 0, phase: 0};

    const coarsePoint = (satrec, j) => {
        if (!satelliteECEF(satrec, coarseDates[j], a, b, coarse[j])) return false;
        const d = coarseDir[j].subVectors(coarse[j], camPos).normalize();
        coarseAxis[j] = Math.acos(Math.max(-1, Math.min(1, d.dot(job.axisV))));
        coarseAlt[j] = Math.asin(Math.max(-1, Math.min(1, d.dot(up))));
        return true;
    };

    // time per stage, for tuning: the stage running is charged at each change
    let clock = performance.now(), stage = null;
    const enter = (next) => {
        const now = performance.now();
        if (stage) stats[stage] += now - clock;
        clock = now;
        stage = next;
    };
    const phase = phaseTester(job);
    for (const sat of satellites) {
        enter("msCoarse");
        stats.candidates++;
        if (!phase(sat.satrec)) continue;
        stats.phase++;
        // One coarse point a minute, then the rest only for a satellite that may
        // come above the horizon and into the view.
        let valid = true, near = false, previous = -1;
        for (let j = 0; j < nCoarse; j = (j === nCoarse - 1) ? nCoarse : Math.min(j + 3, nCoarse - 1)) {
            if (!coarsePoint(sat.satrec, j)) { valid = false; break; }
            if (previous >= 0 && mayShow(job, previous, j, coarseDir, coarseAxis, coarseAlt, horizonAlt)) near = true;
            previous = j;
        }
        if (!valid || !near) continue;
        stats.near++;
        for (let j = 0; j < nCoarse && valid; j++) {
            if (j % 3 === 0 || j === nCoarse - 1) continue;
            valid = coarsePoint(sat.satrec, j);
        }
        if (!valid) continue;

        // the coarse intervals in which it may be above the horizon and in view
        let anyActive = false;
        for (let j = 0; j + 1 < nCoarse; j++) {
            active[j] = mayShow(job, j, j + 1, coarseDir, coarseAxis, coarseAlt, horizonAlt) ? 1 : 0;
            if (active[j]) anyActive = true;
        }
        if (!anyActive) continue;
        stats.active++;
        // Sunlit fraction at the ends of the active intervals. Fully lit or fully
        // dark at both ends means the same all through: the Earth's shadow edge
        // takes far longer than an interval to cross and back.
        coarseLit.fill(-1);
        for (let j = 0; j + 1 < nCoarse; j++) {
            if (!active[j]) continue;
            for (const e of [j, j + 1]) {
                if (coarseLit[e] < 0) coarseLit[e] = satelliteSunlitFraction(coarse[e], coarseSun[e], job.satSettings);
            }
        }

        enter("msFine");
        // The render's samples in the active intervals, and one either side of
        // each run of them.
        const want = new Uint8Array(nFine);
        for (let m = 0; m < nFine; m++) {
            const j = Math.min(nCoarse - 2, Math.floor(job.fineTimes[m] / C + 1));
            if (active[j]) {
                want[m] = 1;
                if (m > 0) want[m - 1] = 1;
                if (m + 1 < nFine) want[m + 1] = 1;
            }
        }
        // Within each run, keep samples by the satellite's speed: at most about
        // MAX_STEP_PX pixels and MAX_STEP_RAD of sky between samples, and at least
        // one every MAX_STEP_SECONDS. A fast pass keeps every render sample; a slow,
        // distant satellite needs few.
        const picks = [], gapBefore = [];
        for (let m = 0; m < nFine;) {
            if (!want[m]) { m++; continue; }
            let m1 = m;
            while (m1 + 1 < nFine && want[m1 + 1]) m1++;
            const j0 = Math.max(0, Math.min(nCoarse - 2, Math.floor(job.fineTimes[m] / C + 1)));
            const j1 = Math.max(0, Math.min(nCoarse - 2, Math.floor(job.fineTimes[m1] / C + 1)));
            let rate = 0;   // radians of sky per second
            for (let j = j0; j <= j1; j++) rate = Math.max(rate, coarseDir[j].angleTo(coarseDir[j + 1]) / C);
            const stepSeconds = rate > 0
                ? Math.min(MAX_STEP_SECONDS, MAX_STEP_PX / (rate * job.projection.pxPerRad), MAX_STEP_RAD / rate)
                : MAX_STEP_SECONDS;
            let last = -Infinity;
            for (let k = m; k <= m1; k++) {
                if (k === m || k === m1 || job.fineTimes[k] - last >= stepSeconds - 1e-9) {
                    gapBefore.push(k === m && picks.length > 0);
                    picks.push(k);
                    last = job.fineTimes[k];
                }
            }
            m = m1 + 1;
        }

        // cubic interpolation, apparent position, flux
        const n = picks.length;
        const rel = new Array(n), rgb = new Float32Array(n * 3), times = new Float64Array(n);
        let any = false;
        for (let i = 0; i < n; i++) {
            const m = picks[i];
            times[i] = job.fineTimes[m];
            const u = job.fineTimes[m] / C + 1;
            const j = Math.min(nCoarse - 3, Math.max(1, Math.floor(u)));
            const s = u - j;
            lagrange[0] = -s * (s - 1) * (s - 2) / 6;
            lagrange[1] = (s + 1) * (s - 1) * (s - 2) / 2;
            lagrange[2] = -(s + 1) * s * (s - 2) / 2;
            lagrange[3] = (s + 1) * s * (s - 1) / 6;
            p.set(0, 0, 0);
            for (let q = 0; q < 4; q++) p.addScaledVector(coarse[j - 1 + q], lagrange[q]);
            const d = applyRefractionFromObserver(p, camPos, job.satRefraction, new Vector3()).sub(camPos);
            rel[i] = d;
            stats.fineSamples++;
            if (Array.isArray(sat.filter) && !sat.filter[nearestSampleIndex(job.filterTimesMS, job.fineMS[m])]) continue;
            const sinAlt = dir.copy(d).normalize().dot(up);
            if (sinAlt < job.horizonSin) continue;
            // Fully lit or fully dark at both ends of the interval (within 0.5 %):
            // interpolate. Otherwise the shadow edge is near: calculate.
            const la = coarseLit[j], lb = coarseLit[j + 1];
            const lit = (la >= 1 - LIT_TOLERANCE && lb >= 1 - LIT_TOLERANCE) || (la <= LIT_TOLERANCE && lb <= LIT_TOLERANCE)
                ? la + (lb - la) * Math.min(1, Math.max(0, s)) : undefined;
            if (lit !== undefined && lit <= 0) continue;
            if (lit === undefined) stats.exactSunlit++;
            const flux = satelliteExposureFlux(job.satSettings, sat, p, camPos, fineSun[m], job.satMag, lit);
            if (!(flux > 0)) continue;
            const ex = extinctionRGB(sinAlt, job.extinctionK, job.kAltScale, job.reddening);
            rgb[i * 3] = flux * ex[0];
            rgb[i * 3 + 1] = flux * ex[1];
            rgb[i * 3 + 2] = flux * ex[2];
            any = true;
        }
        enter("msTrail");
        if (!any) continue;
        if (rotations) for (let i = 0; i < n; i++) rel[i].applyQuaternion(rotations[picks[i]]);
        const values = trailValues(job, project, rel, times, rgb, gapBefore);
        // displayed brightness (0..1, a smooth tone curve) for spacing the vertices
        const bright = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            const v = Math.max(values[i * 3], values[i * 3 + 1], values[i * 3 + 2]) * job.centre * job.gain;
            bright[i] = Math.sqrt(v / (1 + v));
        }
        const chosen = chooseTrailVertices(times, bright, job.segments, job.visibleBright);
        if (chosen && emitTrail(sink, rel, values, chosen, 1, gapBefore) > 0) stats.drawn++;
    }
    enter(null);
    return stats;
}

// Turn the job's [x, y, z] arrays into the vectors the kernels use. Done once
// per job, in whichever thread runs it.
export function prepareJob(job) {
    job.camPosV = new Vector3().fromArray(job.camPos);
    job.upV = new Vector3().fromArray(job.up);
    job.axisV = new Vector3().fromArray(job.axis);
    job.zenithV = new Vector3().fromArray(job.zenith);
    return job;
}

// A sink's lists as transferable arrays.
export function packSink(sink) {
    return {pos: new Float32Array(sink.pos), col: new Float32Array(sink.col), trails: sink.trails};
}
