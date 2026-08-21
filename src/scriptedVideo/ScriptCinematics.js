// ScriptCinematics.js — measurable cinematic rules for a scripted video.
//
// These are CHECKS, not a camera director. A shot is sampled, measured, and reported
// against thresholds; nothing here moves a camera. That is deliberate: an autonomous
// framing solver is underconstrained (infinitely many cameras "contain" two subjects)
// and tends to produce pumping and surprising moves, whereas a check is cheap, has no
// failure mode worse than a false warning, and tells a human or an agent exactly what
// to change.
//
// Everything below is pure: it takes sampled numbers and returns findings. The sampler
// that gathers poses from the live engine lives with the manager, so the rules stay
// testable without a scene.
//
// THE RULES
//
//  1. A subject that is named must be VISIBLE. If a shot says it is about something,
//     that something should be in frame for essentially all of it.
//  2. Apparent size must suit the shot's INTENT:
//       establish   the subject may be small — that is the point, we are showing where
//                   it is in the world — but not invisible.
//       feature     we have come to look AT it, so it should occupy a healthy part of
//                   the frame: 30-50% of frame height, and anything under ~15% is a
//                   failed close-up.
//     Say which with `& intent feature`; where the author has not, a move that ends
//     closer than it began (a zoom/push-in) is taken as a feature shot, since ending
//     on a speck defeats its own purpose.
//  3. Motion must be DELIBERATE. No whip pans, no snap zooms. Both are measured as
//     rates per second of SCREEN time, which is what the viewer actually experiences —
//     a video may be running world time at 4x, but the camera move is still judged at
//     the speed it is seen. A pan is measured in FRAME HEIGHTS per second rather than
//     degrees, because degrees are meaningless without the lens: 60 deg/s is a gentle
//     drift through a 120-degree wide shot and five frame-heights a second — an
//     unwatchable smear — through a 12-degree telephoto.
//  4. A cut must read as a cut. Cutting between two nearly identical framings is a jump
//     cut — the classic fix is the 30-degree rule: change the angle enough that the new
//     shot is clearly a new viewpoint, or do not cut at all.
//  5. No flash frames. A shot too short to register reads as a glitch.

// Thresholds, named and in one place so they can be argued with and tuned.
export const CINEMATIC_RULES = {
    // fraction of a shot's samples for which the subject must be inside the frustum
    minInFrameFraction: 0.9,

    // apparent size as a fraction of FRAME HEIGHT
    minVisibleSize: 0.004,      // below this a subject is a speck: a few pixels at 1080p
    featureTargetMin: 0.30,     // the "reasonable portion of the screen" band
    featureTargetMax: 0.50,
    featureFloor: 0.15,         // a feature shot ending below this is a failed close-up
    settledFraction: 0.30,      // the closing share of a shot that "is" the framing

    // motion, per second of screen time
    maxAimRateScreensPerSec: 2, // frame heights per second; 2 == 60 deg/s at a 30 deg lens
    maxZoomRatePerSec: 2.5,     // apparent-size multiplier per second; 2.5x/s is brisk
    zoomWindowSeconds: 1,       // window the zoom rate is measured over (see below)

    // cuts
    minCutAngleDeg: 30,         // the 30-degree rule
    minShotSeconds: 0.4,        // shorter than this is a flash frame
};

const DEG = 180 / Math.PI;

// Lens assumed when a sample does not carry one. 30 degrees makes the pan limit
// numerically identical to the plain 60 deg/s it replaced.
const NOMINAL_FOV = 30;

// How much of the frame HEIGHT a subject of angular RADIUS `angRadius` (radians) fills,
// through a lens of vertical field of view fovDeg. This is the size metric everything
// else is stated in: 0.4 means the subject spans 40% of the frame's height.
export function sizeFractionFromAngle(angRadius, fovDeg) {
    if (!(angRadius > 0) || !(fovDeg > 0)) return 0;
    return (2 * angRadius) / (fovDeg / DEG);
}

// The same, for a subject modelled as a sphere of radius r at distance d.
export function apparentSizeFraction(radius, distance, fovDeg) {
    if (!(radius > 0) || !(distance > 0)) return 0;
    return sizeFractionFromAngle(Math.asin(Math.min(1, radius / distance)), fovDeg);
}

// --- small vector helpers, on plain {x,y,z} ------------------------------------------
// This module stays free of three.js so the rules can be tested without a scene.
const vdot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const vcross = (a, b) => ({
    x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x});
const vnorm = (a) => {
    const l = a ? Math.hypot(a.x, a.y, a.z) : 0;
    return l > 0 ? {x: a.x / l, y: a.y / l, z: a.z / l} : null;
};

// Is a sphere of `radius` at offset `toTarget` (target minus camera position) inside the
// camera's frustum?
//
// The cheap version of this test — angle between the aim and the target against half the
// vertical fov — is wrong in three ways that all matter here: it ignores the ASPECT ratio
// (a 16:9 frame is far wider than it is tall, so it wrongly calls subjects out of frame
// near the left and right edges), it ignores the subject's RADIUS (a large near object
// whose centre is off-screen may still fill the frame), and it treats the frame as a cone
// rather than a rectangle. So do it properly: build the camera basis, put the target in
// camera space, and test the sphere against the four side planes.
//
// `up` is the reference up (Sitrec's poses carry the local ellipsoid normal), which fixes
// the roll — the same convention applyPoseToCam uses, so this measures what is rendered.
export function sphereInFrustum(aim, up, toTarget, radius, fovDeg, aspect) {
    const f = vnorm(aim);
    if (!f || !toTarget || !(fovDeg > 0)) return false;
    // right = forward x up; if `up` is parallel to the aim (looking straight down, which
    // happens for a top-down shot) any perpendicular will do — with no roll to preserve,
    // the choice only rotates the frame about an axis the pose never pinned down.
    let r = vnorm(vcross(f, up || {x: 0, y: 0, z: 1}));
    if (!r) r = vnorm(vcross(f, Math.abs(f.x) < 0.9 ? {x: 1, y: 0, z: 0} : {x: 0, y: 1, z: 0}));
    if (!r) return false;
    const u = vcross(r, f);

    const z = vdot(toTarget, f), x = vdot(toTarget, r), y = vdot(toTarget, u);
    const rad = radius > 0 ? radius : 0;
    const halfV = Math.atan(Math.tan((fovDeg / 2) / DEG));
    const halfH = Math.atan(Math.tan((fovDeg / 2) / DEG) * (aspect > 0 ? aspect : 1));
    // signed distance from the sphere centre to each side plane, inward positive
    const inside = (off, half) => z * Math.sin(half) - Math.abs(off) * Math.cos(half) >= -rad;
    return z > -rad && inside(y, halfV) && inside(x, halfH);
}

// Angle between two aim directions, in degrees. Inputs are {x,y,z}, not necessarily unit.
export function angleBetweenDeg(a, b) {
    if (!a || !b) return 0;
    const la = Math.hypot(a.x, a.y, a.z), lb = Math.hypot(b.x, b.y, b.z);
    if (!(la > 0) || !(lb > 0)) return 0;
    const dot = (a.x * b.x + a.y * b.y + a.z * b.z) / (la * lb);
    return Math.acos(Math.max(-1, Math.min(1, dot))) * DEG;
}

function median(xs) {
    if (!xs || xs.length === 0) return 0;
    const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Decide what a shot is FOR, when the author has not said.
// A move that ends closer than it started is a push-in — the viewer is being taken to
// look at something, so it is judged as a feature shot. Everything else is treated as
// establishing, which is the permissive case.
//
// Inference is a fallback, not the mechanism: `& intent feature` on the shot says so
// outright, and should be preferred. Guessing from the geometry cannot distinguish a
// push-in from a subject flying towards a static camera, and every attempt to narrow it
// adds another exception below.
export function inferIntent(samples, declared, kind) {
    if (declared === "establish" || declared === "feature") return declared;
    // Point-of-view and chase shots are framed by where the CAMERA rides, not by how big
    // the subject is — the crew watching a light on the horizon is a legitimate shot with
    // a tiny subject. Only a deliberate push-in claims to be taking us in for a look.
    // `track` holds the camera STILL and pans, so it can never be a push-in either — if
    // the subject grows during one, that is the subject approaching, not us closing in.
    if (kind === "ride" || kind === "follow" || kind === "flyto" || kind === "track") {
        return "establish";
    }
    if (samples.length < 2) return "establish";
    const first = samples[0].sizeFrac, last = samples[samples.length - 1].sizeFrac;
    return (last > first * 1.5) ? "feature" : "establish";
}

// Check one shot.
//
// `shot`  = {label, kind, screenIn, screenOut, intent?}
// `samples` = [{t, sizeFrac, inFrame, aim, fov}] in screen-time order, where `aim` is the
//             camera's forward direction, `fov` its vertical field of view in degrees,
//             and sizeFrac is from apparentSizeFraction().
// `prevEndAim`/`prevEndSize` describe the previous shot's last frame, for the cut rules
// (omit them for the first shot, or when the shots are continuous rather than cut).
//
// Returns [{rule, severity, message, ...detail}] — empty when the shot is clean.
export function checkShot(shot, samples, opts = {}) {
    const R = {...CINEMATIC_RULES, ...(opts.rules || {})};
    const out = [];
    const at = (t) => `${shot.label || "shot"} @${(+t).toFixed(2)}s`;
    if (!samples || samples.length === 0) return out;

    const dur = shot.screenOut - shot.screenIn;
    const intent = inferIntent(samples, shot.intent, shot.kind);

    // 5. flash frames
    if (dur > 0 && dur < R.minShotSeconds) {
        out.push({rule: "FLASH_FRAME", severity: "warn", shot: shot.label, seconds: dur,
            message: `${shot.label}: ${dur.toFixed(2)}s is too short to read (min ${R.minShotSeconds}s)`});
    }

    // 1. the subject must actually be in frame
    const inFrame = samples.filter(s => s.inFrame).length / samples.length;
    if (inFrame < R.minInFrameFraction) {
        out.push({rule: "SUBJECT_NOT_VISIBLE", severity: "error", shot: shot.label,
            inFrameFraction: +inFrame.toFixed(2),
            message: `${shot.label}: subject is only in frame for ${(inFrame * 100).toFixed(0)}% `
                + `of the shot (need ${(R.minInFrameFraction * 100)}%)`});
    }

    // 2. apparent size vs intent
    const sizes = samples.map(s => s.sizeFrac);
    const maxSize = Math.max(...sizes);
    // The framing a shot LANDS on is what the viewer takes away from it, so judge a
    // feature shot on where it settles rather than on any one frame: the median over the
    // closing share of the shot, which ignores a transient overshoot but cannot be
    // rescued by one good frame in the middle either.
    const settled = median(sizes.slice(Math.max(0,
        Math.ceil(sizes.length * (1 - R.settledFraction)) - 1)));
    const band = `${R.featureTargetMin * 100}-${R.featureTargetMax * 100}%`;

    if (maxSize < R.minVisibleSize) {
        out.push({rule: "SPECK", severity: "error", shot: shot.label,
            maxSizeFraction: +maxSize.toFixed(4),
            message: `${shot.label}: subject never exceeds ${(maxSize * 100).toFixed(2)}% of frame `
                + `height — a speck. Move closer or narrow the lens`});
    } else if (intent === "feature") {
        // The band the author asked for. Below the floor the close-up has simply failed;
        // between the floor and the band it is readable but not what we came for; above
        // the band it crowds the frame, which is a real choice often enough that it is a
        // warning rather than an error.
        if (settled < R.featureFloor) {
            out.push({rule: "WEAK_CLOSEUP", severity: "warn", shot: shot.label, intent,
                settledSizeFraction: +settled.toFixed(3),
                message: `${shot.label}: close-up settles with the subject at `
                    + `${(settled * 100).toFixed(1)}% of frame height; aim for ${band}`});
        } else if (settled < R.featureTargetMin) {
            out.push({rule: "UNDER_FRAMED", severity: "warn", shot: shot.label, intent,
                settledSizeFraction: +settled.toFixed(3),
                message: `${shot.label}: subject settles at ${(settled * 100).toFixed(1)}% of `
                    + `frame height — under the ${band} a feature shot wants. Move closer `
                    + `or narrow the lens`});
        } else if (settled > R.featureTargetMax) {
            out.push({rule: "OVER_FRAMED", severity: "warn", shot: shot.label, intent,
                settledSizeFraction: +settled.toFixed(3),
                message: `${shot.label}: subject settles at ${(settled * 100).toFixed(1)}% of `
                    + `frame height — over the ${band} band, so it crowds the frame`});
        }
    }

    // 3. deliberate motion.
    // A pan is judged in FRAME HEIGHTS per second, not degrees: what makes a move read as
    // a whip is how fast the picture slides across the frame, and the same angular rate
    // does that ten times faster through a long lens.
    let worstAim = 0, worstAimDeg = 0, worstAimT = 0;
    for (let i = 1; i < samples.length; i++) {
        const dt = samples[i].t - samples[i - 1].t;
        if (!(dt > 0)) continue;
        const deg = angleBetweenDeg(samples[i - 1].aim, samples[i].aim);
        const fov = samples[i].fov > 0 ? samples[i].fov : NOMINAL_FOV;
        const screens = (deg / fov) / dt;
        if (screens > worstAim) { worstAim = screens; worstAimDeg = deg / dt; worstAimT = samples[i].t; }
    }

    // Zoom rate is measured over a ROLLING WINDOW of screen time. Per sample interval it
    // is ill-conditioned — a linear size ramp from something small has an enormous
    // d(log size)/dt at its start, so a smooth push-in gets flagged and the number moves
    // with the sample spacing. Across the whole shot it is well-behaved but blind: a shot
    // that snaps in and back out again returns to where it started and reads as 1x/s. A
    // fixed window is both stable and local, and is what the viewer experiences.
    //
    // A second is about the shortest span over which a change of framing reads as a MOVE
    // at all — quicker than that and the eye takes it for a cut or a jolt, which the cut
    // and flash-frame rules cover — so measuring a zoom over less than a second is not
    // measuring a zoom. It is also long enough to keep the log rate well-conditioned at
    // the small-size end of a push-in, and short enough that an in-and-out cannot hide
    // inside it.
    const span = samples[samples.length - 1].t - samples[0].t;
    const need = Math.min(R.zoomWindowSeconds, span);
    let worstZoom = 0, worstZoomT = shot.screenOut;
    for (let i = 0; i < samples.length - 1; i++) {
        let j = i + 1;
        while (j < samples.length - 1 && samples[j].t - samples[i].t < need) j++;
        const dt = samples[j].t - samples[i].t;
        const a = sizes[i], b = sizes[j];
        if (dt < need - 1e-9 || !(a > 0) || !(b > 0)) continue;    // ran out of shot
        const rate = Math.pow(Math.max(a, b) / Math.min(a, b), 1 / dt);
        if (rate > worstZoom) { worstZoom = rate; worstZoomT = samples[j].t; }
    }

    if (worstAim > R.maxAimRateScreensPerSec) {
        out.push({rule: "WHIP_PAN", severity: "warn", shot: shot.label,
            screensPerSec: +worstAim.toFixed(1), degPerSec: +worstAimDeg.toFixed(0), at: worstAimT,
            message: `${at(worstAimT)}: camera swings ${worstAim.toFixed(1)} frame-heights/s `
                + `(${worstAimDeg.toFixed(0)}°/s, max ${R.maxAimRateScreensPerSec}) — slow the `
                + `move or cut instead`});
    }
    if (worstZoom > R.maxZoomRatePerSec) {
        out.push({rule: "SNAP_ZOOM", severity: "warn", shot: shot.label,
            ratePerSec: +worstZoom.toFixed(1), at: worstZoomT,
            message: `${at(worstZoomT)}: apparent size changes ${worstZoom.toFixed(1)}x/s `
                + `(max ${R.maxZoomRatePerSec}x/s) — give the move more time`});
    }

    // 4. a cut should look like one
    if (opts.isCut && opts.prevEndAim) {
        const ang = angleBetweenDeg(opts.prevEndAim, samples[0].aim);
        const sizeRatio = (opts.prevEndSize > 0 && samples[0].sizeFrac > 0)
            ? Math.max(opts.prevEndSize, samples[0].sizeFrac) / Math.min(opts.prevEndSize, samples[0].sizeFrac)
            : Infinity;
        if (ang < R.minCutAngleDeg && sizeRatio < 1.5) {
            out.push({rule: "JUMP_CUT", severity: "warn", shot: shot.label,
                cutAngleDeg: +ang.toFixed(0),
                message: `${shot.label}: cut changes the angle by only ${ang.toFixed(0)}° `
                    + `at a similar size — a jump cut. Change the angle by `
                    + `${R.minCutAngleDeg}°+ or make it a move`});
        }
    }

    return out;
}

// Check a whole script. `shots` is [{shot, samples, isCut}] in screen order.
export function checkScript(shots, opts = {}) {
    const findings = [];
    let prevEndAim = null, prevEndSize = 0;
    for (const s of shots) {
        findings.push(...checkShot(s.shot, s.samples, {
            ...opts, isCut: s.isCut, prevEndAim, prevEndSize,
        }));
        if (s.samples && s.samples.length) {
            prevEndAim = s.samples[s.samples.length - 1].aim;
            prevEndSize = s.samples[s.samples.length - 1].sizeFrac;
        }
    }
    return findings;
}
