import * as THREE from "three";
import {poseVehicleSpinners} from "./motion.js";

// Editable visual birds in metres, in the flight pose. +Y is up, +Z is forward
// (the bill) and +X is the left wing. The origin is on the body axis, between
// the wing roots. Each wing has two joints, a shoulder and a wrist, and motion.js
// moves them for the wingbeat. The plumage is vertex colors on one material.

const rad = THREE.MathUtils.degToRad, clamp = THREE.MathUtils.clamp, lerp = THREE.MathUtils.lerp;
const ramp = (from, to, value) => THREE.MathUtils.smoothstep(value, from, to);
const UP = new THREE.Vector3(0, 1, 0), DOWN = new THREE.Vector3(0, -1, 0);
const COLORS = ["bodyColor", "bellyColor", "headColor", "neckColor", "headMarkColor", "wingColor", "underwingColor",
    "markColor", "tailColor", "tailBandColor", "billColor", "legColor", "eyeColor"];
const BILL_TILT = {pointed: 4, hooked: 10, flat: 6, pouch: 20};       // degrees below the body axis
const AROUND = 16, CHORD_CELLS = 6, ARM_ROWS = 6, HAND_ROWS = 8, FINGERS = 6, FINGER_START = 0.6;

// A smooth curve through [position, value] keys that does not go past them.
function curve(keys) {
    const count = keys.length, slope = [], tangent = [];
    for (let key = 0; key < count - 1; key++) slope.push((keys[key + 1][1] - keys[key][1]) / (keys[key + 1][0] - keys[key][0]));
    for (let key = 0; key < count; key++)
        tangent.push(key === 0 ? slope[0] : key === count - 1 ? slope[count - 2] :
            slope[key - 1] * slope[key] <= 0 ? 0 : 2 * slope[key - 1] * slope[key] / (slope[key - 1] + slope[key]));
    return position => {
        let key = 0;
        while (key < count - 2 && position > keys[key + 1][0]) key++;
        const [x0, y0] = keys[key], [x1, y1] = keys[key + 1], width = x1 - x0, fraction = clamp((position - x0) / width, 0, 1);
        const squared = fraction * fraction, cubed = squared * fraction;
        return (2 * cubed - 3 * squared + 1) * y0 + (cubed - 2 * squared + fraction) * width * tangent[key] +
            (3 * squared - 2 * cubed) * y1 + (cubed - squared) * width * tangent[key + 1];
    };
}

// Collects grids of points into one geometry. Each cell has its own four corners,
// so a cell can have one flat color while the normals stay smooth.
function surface() {
    const positions = [], normals = [], colors = [], indices = [];
    const diagonal = new THREE.Vector3(), otherDiagonal = new THREE.Vector3(), normal = new THREE.Vector3(), middle = new THREE.Vector3();
    return {
        // points[row][column]. colorAt(row, column) gets the center of a cell, or with `blend` a
        // corner. `wrap` joins the last column to the first. `center` (a point inside) or `facing`
        // (a direction) says which side is the outside; without them it is column × row.
        grid(points, colorAt, {wrap = false, blend = false, center = null, facing = null} = {}) {
            const rows = points.length, columns = points[0].length, cells = wrap ? columns : columns - 1;
            const smooth = points.map(row => row.map(() => new THREE.Vector3()));
            let outward = 0;
            for (let row = 0; row < rows - 1; row++) for (let column = 0; column < cells; column++) {
                const next = (column + 1) % columns;
                const p00 = points[row][column], p01 = points[row][next], p10 = points[row + 1][column], p11 = points[row + 1][next];
                normal.crossVectors(diagonal.subVectors(p01, p10), otherDiagonal.subVectors(p11, p00));
                if (center) outward += normal.dot(middle.copy(p00).add(p01).add(p10).add(p11).multiplyScalar(0.25).sub(center));
                else if (facing) outward += normal.dot(facing);
                for (const corner of [smooth[row][column], smooth[row][next], smooth[row + 1][column], smooth[row + 1][next]]) corner.add(normal);
            }
            const flip = outward < 0;
            for (const row of smooth) for (const corner of row) {
                if (corner.lengthSq() === 0) corner.copy(UP);
                corner.normalize(); if (flip) corner.negate();
            }
            for (let row = 0; row < rows - 1; row++) for (let column = 0; column < cells; column++) {
                const base = positions.length / 3, flat = blend ? null : colorAt(row + 0.5, column + 0.5);
                for (const [cornerRow, cornerColumn] of [[row, column], [row, column + 1], [row + 1, column], [row + 1, column + 1]]) {
                    const point = points[cornerRow][cornerColumn % columns], corner = smooth[cornerRow][cornerColumn % columns];
                    const color = flat ?? colorAt(cornerRow, cornerColumn);
                    positions.push(point.x, point.y, point.z); normals.push(corner.x, corner.y, corner.z);
                    colors.push(color.r, color.g, color.b);
                }
                if (flip) indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
                else indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
            }
        },
        // An ellipsoid of one color.
        ball(center, radii, color, rows = 5, columns = 8) {
            const points = [];
            for (let row = 0; row <= rows; row++) {
                const polar = Math.PI * row / rows, ring = [];
                for (let column = 0; column < columns; column++) {
                    const turn = Math.PI * 2 * column / columns;
                    ring.push(new THREE.Vector3(center.x + radii.x * Math.sin(polar) * Math.cos(turn),
                        center.y + radii.y * Math.sin(polar) * Math.sin(turn), center.z + radii.z * Math.cos(polar)));
                }
                points.push(ring);
            }
            this.grid(points, () => color, {wrap: true, center});
        },
        // A straight rod of one color, closed at its ends.
        rod(from, to, radius, color, sides = 6) {
            const axis = new THREE.Vector3().subVectors(to, from), length = axis.length();
            const turn = new THREE.Quaternion().setFromUnitVectors(UP, axis.normalize()), points = [];
            for (const [along, size] of [[0, 0], [0, 1], [1, 1], [1, 0]]) {
                const ring = [];
                for (let side = 0; side < sides; side++) {
                    const angle = Math.PI * 2 * side / sides;
                    ring.push(new THREE.Vector3(Math.cos(angle) * radius * size, along * length, Math.sin(angle) * radius * size).applyQuaternion(turn).add(from));
                }
                points.push(ring);
            }
            this.grid(points, () => color, {wrap: true, center: new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5)});
        },
        geometry() {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
            geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
            geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
            geometry.setIndex(indices);
            return geometry;
        },
    };
}

// One closed wing surface from stations along it. A station has the point of its
// leading edge, the chord vector (from the leading to the trailing edge), and its
// thickness and camber as fractions of the chord. Columns go from the trailing
// edge over the top to the leading edge, and back under. colorAt(row, top, x)
// gets the row of a cell, its side, and its place on the chord (0 = leading edge).
// `cells` is the number of cells across the chord on each side.
function wingSurface(out, stations, colorAt, cells = CHORD_CELLS) {
    const place = column => Math.pow(Math.abs(column - cells) / cells, 1.25);
    const points = stations.map(({le, chord, thickness, camber, lift = 0}) => {
        const row = [], length = chord.length();
        for (let column = 0; column <= 2 * cells; column++) {
            const x = place(column), half = thickness * 2.6 * Math.sqrt(x) * (1 - x) * (column < cells ? 1 : -1);
            row.push(le.clone().addScaledVector(chord, x).addScaledVector(UP, lift + length * (camber * 4 * x * (1 - x) + half)));
        }
        return row;
    });
    out.grid(points, (row, column) => colorAt(row, column < cells, place(column)));
}

export function buildBird(p) {
    const root = new THREE.Group(); root.name = "Procedural bird";
    const L = p.length, folded = p.neckPose === "folded";
    const tint = Object.fromEntries(COLORS.map(key => [key, new THREE.Color(p[key])]));
    const mixed = (from, to, amount) => from.clone().lerp(to, amount);
    const plumage = new THREE.MeshStandardMaterial({name: "Plumage", vertexColors: true, roughness: p.roughness, metalness: 0});

    // ---- Lengths along the body. `d` is the distance behind the base of the bill. ----
    const billLength = L * p.billLength / 100, headLength = L * p.headSize / 100, tailLength = L * p.tailLength / 100;
    const fullNeck = L * p.neckLength / 100;
    // A folded neck shows little of its length. It makes a bulge under the head.
    const neckLength = Math.max(folded ? fullNeck * 0.12 : fullNeck, headLength * 0.15);
    const billTilt = rad(BILL_TILT[p.billShape]), billInset = headLength * 0.08;
    const billReach = billLength * Math.cos(billTilt) - billInset;
    const bodyLength = Math.max(L * 0.2, L - billReach - headLength - neckLength - tailLength);
    const R = L * p.bodyDepth / 200;                                    // half the depth of the body
    const headRadius = Math.min(headLength * 0.46, R * 1.15), headWidth = headRadius * 0.92;
    const neckRadius = Math.min(headRadius * (0.72 + 0.26 * Math.exp(-neckLength / (1.2 * headLength))), R * 0.95);
    const billDepth = Math.min(billLength * p.billDepth / 100, headRadius * 1.5);
    const billWidth = Math.min(billDepth * {pointed: 0.8, hooked: 0.8, flat: 1.7, pouch: 1}[p.billShape] / 2, headWidth * 0.8);
    const bodyStart = headLength + neckLength, bodyEnd = bodyStart + bodyLength;
    const headY = folded ? R * 0.45 : R * 0.2;
    const bulge = folded ? clamp(p.neckLength / 25, 0.3, 1.3) : 0;

    // The wing: its chord, and the place of the shoulder, which is the front of the wing root.
    const span = p.wingspan, rootChord = span * p.wingChord / 100;
    const shoulderD = bodyStart + bodyLength * 0.1;
    const originD = shoulderD + rootChord * 0.3;                        // z = 0 is here
    const zAt = d => originD - d;

    // ---- Head, neck and body: one tube. Keys are [d, center y, half width, top, bottom, part]. ----
    // `part` is 0 to 1 along the head, 1 to 2 along the neck and 2 to 3 along the body.
    const keys = [
        [0, headY - headRadius * 0.22, billWidth * 1.1, billDepth * 0.62, billDepth * 0.56, 0],
        [headLength * 0.12, headY - headRadius * 0.1, headWidth * 0.68, headRadius * 0.72, headRadius * 0.7, 0.12],
        [headLength * 0.3, headY - headRadius * 0.02, headWidth * 0.94, headRadius * 0.95, headRadius * 0.86 + R * 0.05 * bulge, 0.3],
        [headLength * 0.56, headY, headWidth, headRadius, headRadius * 0.9 + R * 0.2 * bulge, 0.56],
        [headLength, lerp(headY, 0, 0.25), neckRadius, neckRadius, neckRadius + R * 0.5 * bulge, 1],
    ];
    if (neckLength > headLength * 0.6) keys.push([headLength + neckLength * 0.55, lerp(headY, 0, 0.6), neckRadius * 1.03, neckRadius * 1.03, neckRadius * 1.05, 1.55]);
    const shoulders = lerp(neckRadius, R, 0.3);
    keys.push([bodyStart, lerp(headY, 0, 0.8), shoulders * 0.95, shoulders * 0.9, Math.max(shoulders, R * 0.85 * bulge), 2]);
    for (const [along, size] of [[0.14, 0.7], [0.28, 0.92], [0.44, 1], [0.62, 0.9], [0.8, 0.62], [0.93, 0.36]]) {
        const lower = R * size * (folded && along < 0.4 ? Math.max(1, 0.9 + 0.25 * bulge) : 1);
        keys.push([bodyStart + bodyLength * along, R * 0.26 * ramp(0.55, 1, along), R * size * 0.95, R * size * 0.84, lower, 2 + along]);
    }
    keys.push([bodyEnd, R * 0.26, R * 0.3, R * 0.1, R * 0.13, 3]);
    const channel = index => curve(keys.map(key => [key[0], key[index]]));
    const [centerY, halfWidth, topRadius, bottomRadius, partAt] = [1, 2, 3, 4, 5].map(channel);

    const body = surface();
    const distances = [];
    const neckRings = clamp(Math.round(neckLength / headLength * 5), 2, 12);
    for (let ring = 0; ring <= 9; ring++) distances.push(headLength * ring / 9);
    for (let ring = 1; ring <= neckRings; ring++) distances.push(headLength + neckLength * ring / neckRings);
    for (let ring = 1; ring <= 18; ring++) distances.push(bodyStart + bodyLength * ring / 18);
    const angleAt = column => Math.PI / 2 + Math.PI * 2 * column / AROUND;
    const ringAt = (d, size = 1) => Array.from({length: AROUND}, (_, column) => {
        const angle = angleAt(column), height = Math.sin(angle);
        return new THREE.Vector3(halfWidth(d) * Math.cos(angle) * size,
            centerY(d) + (height > 0 ? topRadius(d) : bottomRadius(d)) * height * size, zAt(d));
    });
    // The ends of the tube close on one point.
    const rings = [ringAt(0, 0), ...distances.map(d => ringAt(d)), ringAt(bodyEnd, 0)];
    const ringDistance = [0, ...distances, bodyEnd];
    // A neck ring is at the join of the head and the neck. It always has one ring of points or more.
    const ringEnd = headLength + Math.max(neckLength / neckRings * 1.01, Math.min(neckLength * 0.5, headLength * 0.45));
    function bodyTint(row, column) {
        const d = ringDistance[Math.round(row)], part = partAt(d), height = Math.sin(angleAt(column));     // -1 at the belly, 1 at the back
        const ring = d > headLength * 0.99 && d <= ringEnd;
        const torso = mixed(tint.bellyColor, tint.bodyColor, ramp(-0.45, 0.2, height));
        const color = mixed(mixed(tint.headColor, tint.neckColor, ramp(0.85, 1.1, part)), torso, ramp(1.8, 2.2, part));
        const marked = p.headMark === "cap" ? part < 0.92 && height > 0.3 :
            p.headMark === "cheek" ? part > 0.34 && part < 0.98 && height < 0.4 :
            p.headMark === "collar" ? ring : p.headMark === "nape" ? ring && height > -0.15 : false;
        return marked ? tint.headMarkColor : color;
    }
    body.grid(rings, bodyTint, {wrap: true, blend: true, center: new THREE.Vector3(0, 0, zAt((bodyStart + bodyEnd) / 2))});

    // ---- Bill: a tube from inside the front of the head. ----
    const billAxis = new THREE.Vector3(0, -Math.sin(billTilt), Math.cos(billTilt)), billUp = new THREE.Vector3(0, Math.cos(billTilt), Math.sin(billTilt));
    const billBase = new THREE.Vector3(0, centerY(0), zAt(billInset)), billShape = p.billShape;
    const billRings = [];
    for (let ring = 0; ring <= 9; ring++) {
        // `toTip` is 0 at the base of the bill and 1 at its tip, with more rings near the tip.
        const toTip = 1 - Math.pow(1 - ring / 9, 1.6), blunt = Math.sqrt(Math.max(0, 1 - Math.pow(toTip, 8)));
        let width, top, bottom, drop = 0;
        if (billShape === "hooked") {
            width = Math.pow(Math.max(0, 1 - toTip * toTip), 0.8); top = Math.pow(Math.max(0, 1 - toTip * toTip * toTip), 0.7);
            bottom = 0.85 * Math.pow(1 - toTip, 1.3); drop = 0.4 * Math.pow(toTip, 3.2);
        } else if (billShape === "flat") {
            width = (1 - 0.2 * toTip) * blunt; top = (1 - 0.8 * toTip) * blunt; bottom = 0.5 * (1 - 0.5 * toTip) * blunt;
        } else if (billShape === "pouch") {
            width = (1 - 0.4 * toTip) * blunt; top = 0.55 * (1 - 0.4 * toTip) * blunt;
            bottom = (0.6 + 1.5 * Math.pow(Math.sin(Math.PI * Math.pow(toTip, 0.8)), 0.9)) * blunt; drop = 0.12 * Math.pow(toTip, 6);
        } else {width = Math.pow(1 - toTip, 0.85); top = Math.pow(1 - toTip, 0.8); bottom = Math.pow(1 - toTip, 0.9);}
        const center = billBase.clone().addScaledVector(billAxis, toTip * billLength).addScaledVector(billUp, -drop * billDepth);
        billRings.push(Array.from({length: 10}, (_, column) => {
            const angle = Math.PI / 2 + Math.PI * 2 * column / 10, height = Math.sin(angle);
            return center.clone().addScaledVector(billUp, (height > 0 ? top * 0.55 : bottom * 0.45) * billDepth * height)
                .add(new THREE.Vector3(Math.cos(angle) * width * billWidth, 0, 0));
        }));
    }
    body.grid(billRings, () => tint.billColor, {wrap: true, center: billBase.clone().addScaledVector(billAxis, billLength * 0.4)});

    // ---- Eyes ----
    const eyeD = headLength * 0.34, eyeSize = headLength * 0.085;
    for (const side of [1, -1])
        body.ball(new THREE.Vector3(side * halfWidth(eyeD) * 0.93, centerY(eyeD) + topRadius(eyeD) * 0.2, zAt(eyeD)),
            new THREE.Vector3(eyeSize * 0.6, eyeSize, eyeSize), tint.eyeColor, 4, 6);

    // ---- Tail: a fan of feathers from a point inside the rear of the body. ----
    const pivotD = bodyEnd - bodyLength * 0.1, reach = bodyLength * 0.1 + tailLength, halfFan = rad(p.tailSpread) / 2;
    const featherLength = {
        square: across => Math.min(1.25, 1 / Math.cos(across * halfFan)),
        wedge: across => 1 - 0.3 * Math.pow(Math.abs(across), 1.3),
        pointed: across => 1 - 0.6 * Math.pow(Math.abs(across), 0.8),
        forked: across => (0.5 + 0.5 * Math.pow(Math.abs(across), 1.6)) / Math.cos(halfFan),
        rounded: across => 1 - 0.12 * across * across,
    }[p.tailShape];
    const band = p.tailBand / 100, tailRows = band > 0 ? [0.12, 1 - band, 1] : [0.12, 1];
    const tailY = centerY(pivotD) + topRadius(pivotD) * 0.3, skin = L * 0.0015;
    for (const side of [1, -1]) {
        const fan = tailRows.map(along => Array.from({length: 13}, (_, column) => {
            const across = column / 6 - 1, angle = across * halfFan, radius = reach * featherLength(across) * along;
            return new THREE.Vector3(Math.sin(angle) * radius, tailY + side * skin - reach * 0.04 * across * across * along, zAt(pivotD) - Math.cos(angle) * radius);
        }));
        body.grid(fan, row => band > 0 && row > 1 ? tint.tailBandColor : tint.tailColor, {facing: side > 0 ? UP : DOWN});
    }

    // ---- Legs that trail behind the tail, with the feet beyond its tip. ----
    if (p.legs === "trailing") {
        const footLength = L * 0.07, tipD = bodyEnd + tailLength + L * p.legLength / 100, hipD = bodyStart + bodyLength * 0.72;
        for (const side of [1, -1]) {
            const hip = new THREE.Vector3(side * R * 0.3, centerY(hipD) - bottomRadius(hipD) * 0.55, zAt(hipD));
            const ankle = new THREE.Vector3(side * R * 0.14, tailY - R * 0.22, zAt(tipD - footLength));
            body.rod(hip, ankle, Math.max(L * 0.0055, 0.0015), tint.legColor);
            body.ball(new THREE.Vector3(ankle.x, ankle.y, ankle.z - footLength * 0.45),
                new THREE.Vector3(footLength * 0.16, footLength * 0.07, footLength * 0.55), tint.legColor, 4, 6);
        }
    }

    // ---- Wings. The wingspan is for flat wings: the sweep of the two parts makes the wing longer. ----
    const arm = p.armFraction / 100, sweep = rad(p.wristSweep), forward = sweep * 0.45;      // the inner wing points a little forward
    const shoulderX = R * 0.5, shoulderY = centerY(shoulderD) + topRadius(shoulderD) * 0.45;
    const wingLength = Math.max(span / 2 - shoulderX, span * 0.1) / (arm * Math.cos(forward) + (1 - arm) * Math.cos(sweep));
    const armLength = wingLength * arm, handLength = wingLength * (1 - arm);
    const rootFit = clamp(bodyLength * 0.95 / rootChord, 0.55, 0.9);     // the wing is narrower where it joins the body
    const tips = p.wingTip, fingered = tips === "fingered", extent = p.markExtent / 100, pattern = p.wingPattern;
    function wingTint(top, along, x) {          // `along` is 0 at the shoulder and 1 at the wing tip
        const plain = top ? tint.wingColor : tint.underwingColor;
        if (pattern === "tips") return along > 1 - extent ? tint.markColor : plain;
        if (pattern === "bars")
            return along > 1 - extent || top && along < arm * 1.1 && (x > 0.45 && x < 0.6 || x > 0.84) ? tint.markColor : plain;
        if (pattern === "flight" || pattern === "flightUnder" && !top)
            // The flight feathers are the rear of the inner wing, and most of the outer wing.
            return x > lerp(1 - extent, 0.2, ramp(arm, arm + 0.25, along)) ? tint.markColor : plain;
        return plain;
    }
    const station = (x, back, chord, along, thickness) => ({le: new THREE.Vector3(x, 0, -back), chord: new THREE.Vector3(0, 0, -Math.max(chord, rootChord * 0.004)),
        thickness, camber: 0.045, along});
    const flat = value => ({...value, thickness: 0});
    const rowTint = stations => (row, top, x) => {
        const from = stations[Math.floor(row)].along, to = stations[Math.ceil(row)].along;
        return wingTint(top, (from + to) / 2, x);
    };

    let wingArea = 0;
    const armSurface = surface(), armStations = [];
    for (let row = 0; row <= ARM_ROWS; row++) {
        const outward = row / ARM_ROWS;
        armStations.push(station(outward * armLength, 0, rootChord * lerp(rootFit, 1, ramp(0, 0.45, outward)), outward * arm, lerp(0.075, 0.05, outward)));
    }
    for (let row = 0; row < ARM_ROWS; row++) wingArea += (armStations[row].chord.length() + armStations[row + 1].chord.length()) / 2 * armLength / ARM_ROWS;
    wingSurface(armSurface, [flat(armStations[0]), ...armStations, flat(armStations[ARM_ROWS])], rowTint([armStations[0], ...armStations, armStations[ARM_ROWS]]));

    const handSurface = surface(), handStations = [];
    const handEnd = fingered ? FINGER_START : 1;
    for (let row = 0; row <= HAND_ROWS; row++) {
        const outward = handEnd * (1 - Math.pow(1 - row / HAND_ROWS, 1.25));       // more stations near the tip
        const chord = fingered ? 1 - 0.12 * outward / FINGER_START :
            tips === "rounded" ? Math.pow(Math.max(0, 1 - Math.pow(outward, 2.2)), 0.6) : 1 - Math.pow(outward, 1.4);
        const back = tips === "rounded" ? 0.3 * Math.pow(outward, 4) : 0;
        handStations.push(station(outward * handLength, back * rootChord, chord * rootChord, arm + (1 - arm) * outward, lerp(0.045, 0.02, outward)));
    }
    for (let row = 0; row < HAND_ROWS; row++)
        wingArea += (handStations[row].chord.length() + handStations[row + 1].chord.length()) / 2 * (handStations[row + 1].le.x - handStations[row].le.x);
    wingSurface(handSurface, [flat(handStations[0]), ...handStations, flat(handStations[HAND_ROWS])],
        rowTint([handStations[0], ...handStations, handStations[HAND_ROWS]]));
    if (fingered) {
        // The outer flight feathers are separate, and they fan out from the end of the outer wing.
        const end = handStations[HAND_ROWS], endChord = end.chord.length(), longest = handLength * (1 - FINGER_START);
        for (let finger = 0; finger < FINGERS; finger++) {
            const share = finger / (FINGERS - 1), angle = rad(lerp(-6, 36, share));
            const along = new THREE.Vector3(Math.cos(angle), 0, -Math.sin(angle)), across = new THREE.Vector3(-Math.sin(angle), 0, -Math.cos(angle));
            const length = longest * [0.9, 1, 0.99, 0.92, 0.8, 0.64][finger] / Math.cos(Math.max(0, angle));
            const width = endChord * 0.8 / (FINGERS - 1) * 1.7;
            const start = end.le.clone().addScaledVector(end.chord, 0.06 + 0.8 * share).addScaledVector(along, -length * 0.14);
            const feather = [];
            for (let row = 0; row <= 4; row++) {
                const toTip = row / 4, size = width * (1 - 0.25 * toTip) * Math.sqrt(Math.max(0, 1 - Math.pow(toTip, 5)));
                feather.push({le: start.clone().addScaledVector(along, toTip * length * 1.14).addScaledVector(across, -size / 2),
                    chord: across.clone().multiplyScalar(Math.max(size, width * 0.02)), thickness: 0.04, camber: 0.03,
                    lift: length * 0.09 * toTip * toTip, along: lerp(end.along, 1, toTip)});
            }
            wingSurface(handSurface, [flat(feather[0]), ...feather], rowTint([feather[0], ...feather]), 2);
            wingArea += width * length * 0.7;
        }
    }
    wingArea *= 2;

    // ---- Assembly. The joints are groups, so the right wing can be the mirror of the left. ----
    const flapping = p.flightStyle !== "glide", joints = [];
    const beat = rad(p.flapAngle), fold = p.wingFold / 100, late = 0.4;
    const twist = Math.min(beat * 0.35, rad(14)) * (0.5 + 0.5 * fold), bend = beat * 0.5 * fold;
    const half = Math.PI / 2, upstroke = Math.PI * 1.5;       // a term is largest at this part of the wingbeat
    function joint(name, home, rest, terms) {
        const group = new THREE.Group(); group.name = name;
        group.position.set(...home); group.rotation.set(rest[0], rest[1], rest[2], "ZYX");
        if (flapping) {
            group.userData.vehicleFlap = {rate: p.wingbeatRate, ...(p.flightStyle === "bursts" ? {burst: [p.burstBeats, p.glideSeconds]} : {}),
                order: "ZYX", rest, home, terms};
            joints.push(group);
        }
        return group;
    }
    // The body goes down as the wings go up: its largest upward force is in the middle of the downstroke.
    const bob = Math.min(0.6 * 9.81 / Math.pow(Math.PI * 2 * p.wingbeatRate, 2), L * 0.06) * Math.min(1, p.flapAngle / 30);
    const frame = joint("Bird body", [0, 0, 0], [0, 0, 0], [[4, bob, upstroke, 0]]);
    root.add(frame);
    const mesh = (name, geometry, parent) => {const part = new THREE.Mesh(geometry, plumage); part.name = name; parent.add(part); return part;};
    mesh("Bird body", body.geometry(), frame);
    const armGeometry = armSurface.geometry(), handGeometry = handSurface.geometry();
    for (const side of [1, -1]) {
        const label = side > 0 ? "Left" : "Right";
        const wing = new THREE.Group(); wing.name = `${label} wing`; wing.scale.x = side; frame.add(wing);
        // Rotation about z lifts the wing, about y sweeps it back, and about x turns its front edge down.
        const shoulder = joint(`${label} shoulder`, [shoulderX, shoulderY, zAt(shoulderD)], [0, -forward || 0, rad(p.glideAngle)], [
            [2, beat, 0, beat * 0.12], [0, twist, half, 0], [1, beat * 0.1 * fold, upstroke, beat * 0.1 * fold]]);
        // On the upstroke the outer wing bends down and folds back, a little after the inner wing.
        const wrist = joint(`${label} wrist`, [armLength, 0, 0], [0, forward + sweep, -rad(p.wristDroop) || 0], [
            [2, -bend, upstroke + late, -bend * 0.75], [1, bend * 0.9, upstroke + late, bend * 0.9], [0, twist * 0.5, half, 0]]);
        wing.add(shoulder); shoulder.add(wrist);
        mesh(`${label} inner wing`, armGeometry, shoulder); mesh(`${label} outer wing`, handGeometry, wrist);
    }

    // The space that the wings move through, for a camera that must keep the bird in view.
    root.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(root), sweepBounds = bounds.clone();
    for (const beats of [0, 0.5, 0.8]) {
        poseVehicleSpinners(joints, 0, true, {beats}); root.updateMatrixWorld(true);
        sweepBounds.union(new THREE.Box3().setFromObject(root));
    }
    poseVehicleSpinners(joints, 0, false); root.updateMatrixWorld(true);
    return {root, propellers: [], waves: joints, bounds, sweepBounds, stillPose: {beats: 0.12},
        stats: {size: bounds.getSize(new THREE.Vector3()), wingArea, bodyLength}};
}
