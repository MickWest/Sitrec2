// rockTargets.js — small fixed-wing drone patterns for the rock datasets
// (lib/rockV3.js): a racetrack, a circle and a square, flown as GROUND TRACKS
// at constant ground speed and constant height.
//
// Ground-referenced on purpose. A survey or patrol drone flies its pattern by
// waypoints, so the ground track is the pattern and the airspeed absorbs the
// wind. That is the opposite of the balloon targets, which ride the wind, and
// it is why these tracks take no wind input: the set's wind numbers are still
// in the spec (and so in the truth key), but they move nothing here.
//
// Every pattern is one closed loop of straight legs and circular arcs at one
// turn radius, so the bank a real airframe would need is a single number,
// atan(v^2 / (g r)), which the set keeps under 40 degrees. The clip starts at
// a random point on the loop (phaseFraction of the perimeter), and the track
// is shifted so that frame 0 sits at the scenario origin, which is what the
// generator's range convention requires (the platform starts at [0, -R]).
//
// Frame: scenario ENU, metres, z = height above the flat-proxy ground.

const G = 9.80665;
const DEG = Math.PI / 180;

/**
 * The loop as a list of segments, each {kind: "straight"|"arc", length,
 * ...}, starting at the origin heading along +y (north) before the pattern
 * heading is applied. Arcs turn to the right (clockwise seen from above) for
 * turnDir 1; turnDir -1 mirrors the whole loop.
 */
function loopSegments(kind, p) {
    const r = p.radiusM;
    if (kind === "drone-circle") {
        return [{kind: "arc", length: 2 * Math.PI * r, angle: 2 * Math.PI}];
    }
    if (kind === "drone-racetrack") {
        return [
            {kind: "straight", length: p.legM},
            {kind: "arc", length: Math.PI * r, angle: Math.PI},
            {kind: "straight", length: p.legM},
            {kind: "arc", length: Math.PI * r, angle: Math.PI},
        ];
    }
    if (kind === "drone-square") {
        const side = p.legM;
        const straight = Math.max(0, side - 2 * r);
        const segs = [];
        for (let i = 0; i < 4; i++) {
            segs.push({kind: "straight", length: straight});
            segs.push({kind: "arc", length: (Math.PI / 2) * r, angle: Math.PI / 2});
        }
        return segs;
    }
    throw new Error(`rockTargets: unknown drone kind "${kind}"`);
}

/**
 * Position and heading at arc length s along the loop (before the pattern
 * heading and mirror are applied). Walks the segments once per call; the
 * loops are short, so this is cheap enough for 3000 frames.
 */
function loopPoint(segs, perimeter, s, r) {
    let arc = ((s % perimeter) + perimeter) % perimeter;
    let x = 0, y = 0, psi = 0;   // heading: radians clockwise from +y
    for (const seg of segs) {
        if (arc <= seg.length) {
            if (seg.kind === "straight") {
                return {x: x + arc * Math.sin(psi), y: y + arc * Math.cos(psi), psi};
            }
            const a = arc / r;   // angle turned so far, right turn
            const cx = x + r * Math.cos(psi), cy = y - r * Math.sin(psi);   // centre to the right
            return {x: cx - r * Math.cos(psi + a), y: cy + r * Math.sin(psi + a), psi: psi + a};
        }
        arc -= seg.length;
        if (seg.kind === "straight") {
            x += seg.length * Math.sin(psi);
            y += seg.length * Math.cos(psi);
        } else {
            const cx = x + r * Math.cos(psi), cy = y - r * Math.sin(psi);
            x = cx - r * Math.cos(psi + seg.angle);
            y = cy + r * Math.sin(psi + seg.angle);
            psi += seg.angle;
        }
    }
    return {x, y, psi};
}

/**
 * The loop's perimeter, period at the pattern speed, and the bank a
 * coordinated turn at that speed and radius would need.
 */
export function dronePatternGeometry(kind, p) {
    const segs = loopSegments(kind, p);
    const perimeter = segs.reduce((a, s) => a + s.length, 0);
    return {
        perimeter,
        periodSeconds: perimeter / p.speedMS,
        bankDeg: Math.atan((p.speedMS * p.speedMS) / (G * p.radiusM)) / DEG,
        segments: segs.length,
    };
}

/**
 * The truth track for a drone pattern.
 *
 * parameters: speedMS, altitudeAGL (also startAGL, see rockV3.js), radiusM,
 * legM (racetrack straight leg, or the square's side), headingDeg (pattern
 * orientation, compass degrees), phaseFraction (where on the loop frame 0 is,
 * 0..1 of the perimeter), turnDir (1 right-hand, -1 left-hand).
 */
export function generateDroneTruth(targetSpec, {n, fps}) {
    const p = targetSpec.parameters ?? {};
    const kind = targetSpec.kind;
    const speed = p.speedMS ?? 20;
    const alt = p.altitudeAGL ?? p.startAGL ?? 300;
    const r = p.radiusM ?? 150;
    const segs = loopSegments(kind, {...p, radiusM: r, legM: p.legM ?? 600});
    const perimeter = segs.reduce((a, s) => a + s.length, 0);
    const s0 = (p.phaseFraction ?? 0) * perimeter;
    const mirror = p.turnDir === -1 ? -1 : 1;
    const heading = (p.headingDeg ?? 0) * DEG;
    const cosH = Math.cos(heading), sinH = Math.sin(heading);

    // Loop coordinates -> scenario ENU: mirror x for a left-hand loop, then
    // rotate by the pattern heading (compass: x east, y north), then shift so
    // that frame 0 is at the origin.
    const place = (pt) => {
        const lx = mirror * pt.x, ly = pt.y;
        return [lx * cosH + ly * sinH, -lx * sinH + ly * cosH];
    };
    const [x0, y0] = place(loopPoint(segs, perimeter, s0, r));
    const pos = new Float64Array(n * 3);
    for (let f = 0; f < n; f++) {
        const t = f / fps;
        const [x, y] = place(loopPoint(segs, perimeter, s0 + speed * t, r));
        pos[f * 3] = x - x0;
        pos[f * 3 + 1] = y - y0;
        pos[f * 3 + 2] = alt;
    }
    const valid = new Uint8Array(n).fill(1);
    return {
        target: {kind: "track", family: targetSpec.family, positionENU: pos, valid,
            profile: {kind, speedMS: speed, altitudeAGL: alt, radiusM: r, legM: p.legM ?? null,
                headingDeg: p.headingDeg ?? 0, phaseFraction: p.phaseFraction ?? 0,
                turnDir: mirror, ...dronePatternGeometry(kind, {...p, radiusM: r, legM: p.legM ?? 600, speedMS: speed}),
                groundReferenced: true, anomalous: false}},
        events: [],
    };
}
