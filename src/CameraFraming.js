// Camera framing for imported tracks.
//
// Purpose and scope: when a track file is imported, the main view has to end up
// somewhere that shows what was just loaded. The old rule ("put the camera one
// bounding-box diagonal south of the track and 45 degrees up") answers that
// badly for a two-track scenario: it is applied per track, so the LAST track
// loaded wins and the other one is left off screen entirely.
//
// This module answers it as a fitting problem instead. Given the points of a
// "left" track (the platform / sensor) and an optional "right" track (the target,
// which for a benchmark file is the ground truth), it returns the camera pose that
//
//   * looks DOWN at 15-30 degrees, so the scene reads as a 3-D layout on terrain
//     rather than as a map;
//   * puts the left track's centroid on the left of the screen and the right
//     track's centroid on the right;
//   * contains every sampled point of both tracks, with a margin.
//
// "Left of" is centroid ordering, not a promise that no point of one track ever
// appears on the other's side. It cannot be: a sensor flying a circle AROUND its
// target has points on both sides of it from every viewpoint. Centroid ordering is
// the strongest statement that is true for all inputs.
//
// The fit is exact, not a heuristic distance formula: with the orientation fixed,
// "every point is inside the frustum" is a set of linear inequalities whose tightest
// solution has a closed form, so the result is snug rather than
// approximately-right-with-slack, and it is reached in one pass over the points.
//
// Everything here is flat-frame: a single `up` is used for the whole scene, so the
// Earth's curvature across it is ignored. That is accurate to well under a pixel at
// the tens-of-kilometres scale these scenarios cover, and the alternative (a
// curved-Earth fit) would be solving a problem no track file poses.

import {Vector3} from "three";

// Fraction of the half-view reserved as empty border on each side. The right
// margin is the larger one because Sitrec draws a track's name label to the RIGHT
// of its marker, so content at the right edge is the content whose label falls off
// the screen.
const DEFAULT_MARGIN_LEFT = 0.10;
const DEFAULT_MARGIN_RIGHT = 0.20;
const DEFAULT_MARGIN_VERTICAL = 0.12;

// Look-down angle limits. Below the minimum the scene's depth collapses into a
// line; above the maximum the altitude differences do.
const MIN_TILT_DEG = 15;
const MAX_TILT_DEG = 30;

// Smallest scene the framing will zoom in to, in metres. A stationary sensor
// watching a hovering target is a single point pair with no extent of its own, and
// without a floor the exact fit would put the camera a metre away from it.
const MIN_SCENE_SPAN_M = 1000;

/**
 * Every valid position on a track.
 *
 * All of them, not a decimated sample of them. The fit is a max over the points, so
 * a point left out is a point that can end up off screen — and the one a fit turns
 * on is precisely the outlying one that a fixed sample budget is most likely to
 * step over. Taking them all costs one pass, which is what computeTrackFraming is
 * built to need.
 *
 * @param {object} track - a data track node (frames, validPoint(f), p(f))
 * @returns {Vector3[]}
 */
export function collectTrackPoints(track) {
    const points = [];
    if (!track || !(track.frames > 0)) return points;
    for (let f = 0; f < track.frames; f++) {
        if (track.validPoint(f)) points.push(track.p(f).clone());
    }
    return points;
}

// How much further than the target the sightline may reach the ground before the
// ground stops being worth framing. Beyond this the LOS is shallow enough that
// its ground intersection is somewhere else entirely — a hillside kilometres
// past the encounter, or nearly the horizon — and including it would zoom the
// view out until the thing the file is actually about is a few pixels.
const DEFAULT_MAX_GROUND_RANGE_RATIO = 3;

/**
 * Where the sightlines land on the ground, as points to be framed alongside the
 * platform.
 *
 * WHY THE GROUND AND NOT JUST THE TARGET. The subject of a sensor file is the
 * sightline: a fan from the platform sweeping across the scene. Framing the
 * platform and the target alone frames the two ENDS of one ray and cuts off the
 * fan, which is the part that shows where the sensor was looking and how the
 * geometry changed. Measured on a real 7 km go-fast clip, the fan ran off the
 * right edge and its far half was never on screen.
 *
 * The ratio guard is what keeps that from backfiring. A sightline only a few
 * degrees below the horizon reaches the ground tens of kilometres away — or, at
 * or above the horizon, never — and framing that would push the encounter into a
 * corner. So the ground is included only while it is within
 * `maxGroundRangeRatio` of the target's own distance, compared at the centroids
 * because that is the one comparison that needs no frame-by-frame pairing
 * between two tracks whose valid frames need not line up.
 *
 * `intersect` is injected rather than imported: this module is deliberately
 * free of every Sitrec dependency but three, which is what lets it be unit
 * tested without a scene, and a ray/ground intersection is a scene question.
 *
 * @param {object} losNode - node with frames and v(f) -> {position, heading}
 * @param {Vector3[]} referencePoints - the target/truth points to compare against
 * @param {(position: Vector3, heading: Vector3) => (Vector3|null)} intersect
 * @returns {Vector3[]} ground points, or [] when they should not be framed
 */
export function collectLOSGroundPoints(losNode, referencePoints, intersect, options = {}) {
    const ratio = options.maxGroundRangeRatio ?? DEFAULT_MAX_GROUND_RANGE_RATIO;
    if (!losNode || !(losNode.frames > 0)) return [];
    if (typeof intersect !== "function") return [];
    // No target means no scale to judge the ground against, and the guard above
    // is the only thing standing between this and a view of half a county.
    if (!referencePoints || referencePoints.length === 0) return [];

    const hits = [];
    const sensors = [];
    for (let f = 0; f < losNode.frames; f++) {
        const los = losNode.v(f);
        if (!los?.position || !los?.heading) continue;
        const hit = intersect(los.position, los.heading);
        // Null is the ordinary case for a sightline at or above the horizon, not
        // an error: there is no ground on that ray to frame.
        if (!hit) continue;
        hits.push({at: hit.clone(), from: los.position.clone()});
        sensors.push(los.position.clone());
    }
    if (hits.length === 0) return [];

    // The limit, set by the target's own distance from the sensor path.
    const from = centroid(sensors);
    const limit = ratio * from.distanceTo(centroid(referencePoints));

    // PER POINT, not just at the centroid. One sightline grazing the horizon
    // reaches the ground tens of kilometres past the rest, and a centroid barely
    // notices it — 99 hits at 7 km and one at 200 km average to 8.9 km, inside a
    // 15 km limit — while the framing is an exact fit over every point and would
    // back the camera off until the encounter was a few pixels. The outlier is
    // dropped and the sightlines that landed near the scene are still framed.
    const ground = hits.filter((h) => h.from.distanceTo(h.at) <= limit).map((h) => h.at);
    if (ground.length === 0) return [];

    // And the surviving set still has to be near the scene as a whole, which is
    // the original guard: a clip whose sightlines ALL reach the ground far away
    // has no outlier to drop, it is simply pointed somewhere else.
    if (from.distanceTo(centroid(ground)) > limit) return [];
    return ground;
}

// Mean of an array of Vector3. Caller guarantees a non-empty array.
function centroid(points) {
    const sum = new Vector3();
    for (const p of points) sum.add(p);
    return sum.multiplyScalar(1 / points.length);
}

// Component of v perpendicular to unit vector up.
function horizontalPart(v, up) {
    return v.clone().sub(up.clone().multiplyScalar(v.dot(up)));
}

/**
 * The camera pose that frames these tracks.
 *
 * @param {Vector3[]} leftPoints   - platform/sensor track points. Required.
 * @param {Vector3[]} rightPoints  - target/truth track points, or empty. When
 *                                   empty the single track is split in half in
 *                                   TIME, so it reads start-left to end-right.
 * @param {Vector3} up             - geodetic up for the scene (unit).
 * @param {object} options
 * @param {number} options.tanH    - tan(horizontal FOV / 2) of the view.
 * @param {number} options.tanV    - tan(vertical FOV / 2) of the view.
 * @param {number} [options.near]  - camera near plane, metres.
 * @param {number} [options.tiltDeg] - override the computed look-down angle.
 * @returns {{position: Vector3, forward: Vector3, up: Vector3, tiltDeg: number,
 *            distance: number}|null} null if there is nothing to frame.
 */
export function computeTrackFraming(leftPoints, rightPoints, up, options = {}) {
    const leftSamples = leftPoints ?? [];
    const rightSamples = rightPoints ?? [];
    const all = leftSamples.concat(rightSamples);
    if (all.length === 0) return null;

    const tanH = options.tanH;
    const tanV = options.tanV;
    if (!(tanH > 0) || !(tanV > 0)) return null;

    const near = Math.max(options.near ?? 1, 1);
    const marginLeft = options.marginLeft ?? DEFAULT_MARGIN_LEFT;
    const marginRight = options.marginRight ?? DEFAULT_MARGIN_RIGHT;
    const marginVertical = options.marginVertical ?? DEFAULT_MARGIN_VERTICAL;

    const pivot = centroid(all);

    // The two things that have to end up left and right of each other. With no
    // second track, the halves of the one track stand in for them, so the path
    // runs the way it is flown: earliest on the left.
    let leftCentre, rightCentre;
    if (rightSamples.length > 0 && leftSamples.length > 0) {
        leftCentre = centroid(leftSamples);
        rightCentre = centroid(rightSamples);
    } else {
        const single = leftSamples.length > 0 ? leftSamples : rightSamples;
        const half = Math.max(1, Math.floor(single.length / 2));
        const tail = single.slice(half);
        leftCentre = centroid(single.slice(0, half));
        rightCentre = centroid(tail.length > 0 ? tail : single);
    }

    // Screen-right is the direction from the left thing to the right thing, flattened
    // to the horizontal. Note there is NO "too small to bother with" threshold here:
    // substituting a fixed compass direction for a small-but-real separation is how
    // the two tracks end up the wrong way round. Only an exactly zero separation —
    // where no ordering exists to respect — falls back to a fixed axis.
    const separation = horizontalPart(rightCentre.clone().sub(leftCentre), up);
    let screenRight;
    if (separation.length() > 1e-6) {
        screenRight = separation.normalize();
    } else {
        // No ordering to respect, so any horizontal axis will do. East, which is what
        // looking north gives you, matches the old south-of-the-track default. In ECEF
        // the horizontal part of +Z is local north; at the poles it is zero, so fall
        // back to another axis there rather than normalising a zero vector.
        let north = horizontalPart(new Vector3(0, 0, 1), up);
        if (north.length() < 1e-6) north = horizontalPart(new Vector3(1, 0, 0), up);
        north.normalize();
        screenRight = new Vector3().crossVectors(up, north.negate()).normalize();
    }

    // Horizontal forward. cross(up, screenRight) is the direction whose own
    // screen-right IS screenRight, which is what makes the left/right placement come
    // out of the orientation rather than out of a later correction.
    const forwardHorizontal = new Vector3().crossVectors(up, screenRight);

    // How far the scene extends along the view direction, and how tall it is. These
    // are the two spreads the look-down angle trades against: depth only shows up on
    // screen in proportion to sin(tilt), height in proportion to cos(tilt). So a
    // scene that is mostly depth (a flat layout seen from its side) wants the steeper
    // end of the band, and one that is mostly height wants the shallower end.
    let depthMin = Infinity, depthMax = -Infinity;
    let heightMin = Infinity, heightMax = -Infinity;
    for (const p of all) {
        const q = p.clone().sub(pivot);
        const depth = q.dot(forwardHorizontal);
        if (depth < depthMin) depthMin = depth;
        if (depth > depthMax) depthMax = depth;
        const height = q.dot(up);
        if (height < heightMin) heightMin = height;
        if (height > heightMax) heightMax = height;
    }
    const depthExtent = depthMax - depthMin;
    const heightExtent = heightMax - heightMin;

    let tiltDeg = options.tiltDeg;
    if (tiltDeg === undefined) {
        const tallness = heightExtent / Math.max(depthExtent, 1);
        tiltDeg = MAX_TILT_DEG - (MAX_TILT_DEG - MIN_TILT_DEG) * Math.min(1, tallness / 2);
    }
    tiltDeg = Math.max(MIN_TILT_DEG, Math.min(MAX_TILT_DEG, tiltDeg));
    const tilt = tiltDeg * Math.PI / 180;

    const forward = forwardHorizontal.clone().multiplyScalar(Math.cos(tilt))
        .add(up.clone().multiplyScalar(-Math.sin(tilt))).normalize();
    // Recovered from the tilted forward rather than reused from above, so these are
    // exactly the axes three.js will build from (position, lookAt, up).
    const right = new Vector3().crossVectors(forward, up).normalize();
    const camUp = new Vector3().crossVectors(right, forward).normalize();

    const tanLeft = tanH * (1 - marginLeft);
    const tanRight = tanH * (1 - marginRight);
    const tanUpDown = tanV * (1 - marginVertical);

    // The camera sits at pivot + a*right + b*camUp - distance*forward. A point at
    // camera-space (r, u, f) relative to the pivot then has depth z = f + distance,
    // and is on screen exactly when
    //     -tanLeft*z   <=  r - a  <=  tanRight*z
    //     -tanUpDown*z <=  u - b  <=  tanUpDown*z
    //
    // Rearranged for a, and with z expanded, the distance term separates out — it is
    // the same for every point, because they all share one camera:
    //     a >= (r - tanRight*f) - tanRight*distance
    //     a <= (r + tanLeft*f)  + tanLeft*distance
    //
    // So the whole track collapses into four numbers (and a fifth for the near
    // plane), the tightest of each bound, and the smallest distance that leaves any
    // room between them comes straight out of the algebra. No search, and one pass
    // over the points — which is why they can ALL be used. Decimating the track to
    // some sample budget would be trading the guarantee that every imported point is
    // on screen for a saving that is not needed.
    let aBound = -Infinity;      // max of (r - tanRight*f)   -> right edge
    let aOpposite = Infinity;    // min of (r + tanLeft*f)    -> left edge
    let bBound = -Infinity;      // max of (u - tanUpDown*f)  -> top edge
    let bOpposite = Infinity;    // min of (u + tanUpDown*f)  -> bottom edge
    let nearestF = Infinity;
    for (const p of all) {
        const q = p.clone().sub(pivot);
        const r = q.dot(right), u = q.dot(camUp), f = q.dot(forward);
        if (r - tanRight * f > aBound) aBound = r - tanRight * f;
        if (r + tanLeft * f < aOpposite) aOpposite = r + tanLeft * f;
        if (u - tanUpDown * f > bBound) bBound = u - tanUpDown * f;
        if (u + tanUpDown * f < bOpposite) bOpposite = u + tanUpDown * f;
        if (f < nearestF) nearestF = f;
    }

    const tanNarrow = Math.min(tanLeft, tanRight);
    const distance = Math.max(
        (aBound - aOpposite) / (tanLeft + tanRight),   // wide enough horizontally
        (bBound - bOpposite) / (2 * tanUpDown),        // wide enough vertically
        near - nearestF,                               // nothing behind the near plane
        // Floor for a scene with (almost) no extent of its own — a stationary sensor
        // watching a hovering target is a single pair of points, and an exact fit to
        // that would park the camera on top of them.
        MIN_SCENE_SPAN_M / (2 * tanNarrow));

    // Centre the content in whichever direction has slack left at this distance. The
    // bounds are now known to overlap, so the midpoints are inside the frustum.
    const a = ((aBound - tanRight * distance) + (aOpposite + tanLeft * distance)) / 2;
    const b = ((bBound - tanUpDown * distance) + (bOpposite + tanUpDown * distance)) / 2;

    const position = pivot.clone()
        .add(right.clone().multiplyScalar(a))
        .add(camUp.clone().multiplyScalar(b))
        .add(forward.clone().multiplyScalar(-distance));

    return {position, forward, up: up.clone(), tiltDeg, distance};
}
