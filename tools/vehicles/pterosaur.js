import {Bone, BufferGeometry, Color, DataTexture, Float32BufferAttribute, LinearFilter, LinearMipmapLinearFilter, MathUtils, Skeleton, SkinnedMesh, SRGBColorSpace, Uint16BufferAttribute, Vector3} from "three";

const {lerp, smoothstep} = MathUtils;
const V = (x, y, z) => new Vector3(x, y, z);

// Stations of the living outline, from the jaw tip to the shoulders. Width and
// depth vary independently: the nape rises behind the orbit, the throat tucks
// under the jaw, and the narrow cervical column flares into the pectoral region.
export function pterosaurProfile(bill, head, neck, radius, headRadius, billWidth, billDepth, headY) {
    const skull = (d, y, w, top, throat) => [d * head, headY + y * headRadius, headRadius * w,
        headRadius * top, headRadius * throat, Math.max(0, d)];
    const cervical = (t, y, w, top, throat) => [head + t * neck, y * radius,
        w * radius, top * radius, throat * radius, 1 + t];
    return [
        ...[[1, .018], [.96, .11], [.78, .32], [.52, .51], [.25, .72], [0, 1]].map(([t, s]) =>
            [-bill * t, headY - headRadius * (.20 + .30 * t), billWidth * s, billDepth * s * .54, billDepth * s * .39, 0]),
        skull(.21, -.08, .65, .66, .48), skull(.49, .05, .86, .91, .60),
        skull(.68, .12, .91, 1, .62), skull(.83, .16, .77, .89, .50),
        skull(1, .17, .50, .60, .34),
        cervical(.18, headY / radius + .04, .32, .36, .27),
        cervical(.44, headY / radius * .77, .245, .28, .24),
        cervical(.68, headY / radius * .48, .30, .36, .30),
        cervical(.85, headY / radius * .32, .41, .47, .40),
        cervical(1, .25, .58, .58, .54),
    ];
}

// Flesh covers the skull openings. Model the external nostril and the orbital
// rim, with the eye seated in the cheek rather than standing free of the head.
export function pterosaurFace(body, tint, head, centerY, width, top, zAt) {
    const eyeD = head * .62, eye = head * .097;
    const eyelid = tint.headColor.clone().lerp(tint.bodyColor, .42);
    const iris = tint.billColor.clone().lerp(new Color(0xbb803c), .68);
    const radii = [0, .35, .42, .48, .66, .76, .83, .90, 1.04, 1.23];
    for (const side of [-1, 1]) {
        // Lay the almond-shaped eyelids on the curved cheek. Only the cornea
        // and the upper lid rise slightly above the surrounding skin.
        const socket = radii.map(r => Array.from({length: 18}, (_, i) => {
            const angle = i * Math.PI / 9, sin = Math.sin(angle), cos = Math.cos(angle);
            const d = eyeD + eye * r * cos * 1.23;
            const y = centerY(eyeD) + top(eyeD) * .26 + eye * r * sin * (1 - .24 * cos ** 2);
            const h = (y - centerY(d)) / top(d);
            const cheek = width(d) * Math.sqrt(Math.max(0, 1 - h * h));
            const cornea = .18 * Math.max(0, 1 - (r / .86) ** 2);
            const lid = .13 * Math.exp(-((r - .93) ** 2) / .019) * (.65 + .35 * sin);
            return V(side * (cheek + eye * (.02 + cornea + lid)), y, zAt(d));
        }));
        body.grid(socket, (row, column) => {
            const r = radii[row], upper = Math.sin(column * Math.PI / 9);
            if (r <= .42) return tint.eyeColor;
            if (r < .76) return iris;
            if (r < .90) return tint.eyeColor.clone().lerp(eyelid, .28);
            return eyelid.clone().lerp(tint.headColor, .38 + .24 * upper);
        }, {wrap: true, blend: true, facing: V(side, 0, 0)});
        const d = head * .12;
        const nostril = V(side * width(d) * .965, centerY(d) + top(d) * .23, zAt(d));
        body.ball(nostril, V(head * .009, head * .020, head * .047), tint.eyeColor, 4, 8);
    }
}

export function pterosaurLegs(body, p, tint, radius, hipZ, tailZ) {
    const L = p.length, tucked = p.legs !== "trailing", foot = L * (tucked ? .045 : .066);
    const ankle = V(Math.min(tucked ? radius * .71 : .16 * L, .32 * p.wingspan * p.armFraction / 100),
        -radius * (tucked ? .35 : .6), tailZ + foot - (tucked ? 0 : L * p.legLength / 100));
    const hip = V(radius * .48, -radius * .16, hipZ);
    const knee = V(tucked ? radius : ankle.x * .92, -radius * .39, lerp(hipZ, ankle.z, .37));
    const web = tint.legColor.clone().lerp(tint.underwingColor, .36);
    for (const side of [-1, 1]) {
        const thigh = V(side * hip.x, hip.y, hip.z), shin = V(side * knee.x, knee.y, knee.z);
        const heel = V(side * ankle.x, ankle.y, ankle.z);
        // One continuous thigh, knee and calf. Bury the broad end in the
        // haunch and blend the rings around the bent knee before the ankle.
        const centers = [thigh.clone().multiply(new Vector3(.45, 1, 1)),
            thigh, thigh.clone().lerp(shin, .37), thigh.clone().lerp(shin, .78), shin,
            shin.clone().lerp(heel, .16), shin.clone().lerp(heel, .38), shin.clone().lerp(heel, .75), heel];
        const widths = [.26, .33, .29, .19, .16, .14, .145, .084, .060];
        const limb = centers.map((center, i) => {
            const axis = centers[Math.min(centers.length - 1, i + 1)].clone().sub(centers[Math.max(0, i - 1)]).normalize();
            const across = V(0, 1, 0).cross(axis).normalize(), up = axis.clone().cross(across);
            return Array.from({length: 12}, (_, j) => {
                const a = 2 * Math.PI * j / 12, r = widths[i] * radius;
                return center.clone().addScaledVector(across, r * Math.cos(a)).addScaledVector(up, r * .83 * Math.sin(a));
            });
        });
        const thighTint = tint.bellyColor.clone().lerp(tint.bodyColor, .32);
        body.grid(limb, row => thighTint.clone().lerp(tint.legColor, smoothstep(row, 0, 7)),
            {wrap: true, blend: true, center: shin});
        const toes = [-.30, -.12, .09, .28].map((s, i) => heel.clone().add(V(side * foot * s, -.13 * foot,
            -foot * [.70, .94, 1, .80][i])));
        for (let i = 0; i < toes.length; i++) {
            const joint = heel.clone().lerp(toes[i], .77); joint.y += foot * .06;
            body.rod(heel, joint, foot * .036, tint.legColor, 5, foot * .021);
            body.rod(joint, toes[i], foot * .021, tint.billColor, 5, 0);
        }
        const rows = [.12, .49].map(t => toes.map(toe => heel.clone().lerp(toe, t)));
        body.grid(rows, () => web, {facing: V(0, 1, 0)});
        body.grid(rows, () => web, {facing: V(0, -1, 0)});
        // Each small hind membrane follows the inside of its own leg. The
        // concave free edges leave a cleft behind the pelvis between the feet.
        const rump = V(side * radius * .17, 0, lerp(hipZ, tailZ, .88));
        const hollow = shin.clone().lerp(rump, .32);
        const hind = Array.from({length: 9}, (_, i) => {
            const t = i / 8;
            const inner = rump.clone().lerp(hollow, t).lerp(hollow.clone().lerp(heel, t), t);
            const outer = t <= .38 ? thigh.clone().lerp(shin, t / .38) : shin.clone().lerp(heel, (t - .38) / .62);
            return [inner, outer];
        });
        body.grid(hind, () => web, {facing: V(0, 1, 0)});
        body.grid(hind, () => web, {facing: V(0, -1, 0)});
    }
    return {hip, knee, ankle};
}

// A smooth outline through the spanwise landmarks. The slopes use the actual
// separation of neighbouring joints so a swept fingertip stays narrow.
function wingEdge(points, x) {
    const i = points.findIndex((point, j) => j > 0 && point.x >= x);
    if (i < 1) return points.at(-1).clone();
    const a = points[i - 1], b = points[i], dx = b.x - a.x;
    const t = MathUtils.clamp((x - a.x) / dx, 0, 1);
    const prev = points[Math.max(0, i - 2)], next = points[Math.min(points.length - 1, i + 1)];
    const slope = (b.z - a.z) / dx;
    const startSlope = (b.z - prev.z) / (b.x - prev.x), endSlope = (next.z - a.z) / (next.x - a.x);
    const z = lerp(a.z, b.z, t) + dx * t * (1 - t) * ((1 - t) * (startSlope - slope) + t * (slope - endSlope));
    return V(x, lerp(a.y, b.y, t), z);
}

// Figure 1 in Elgin, Hone & Frey (2011) guides the wing outline. Each section
// passes over the arm or the wing finger. The same skin covers both sides of
// that ridge and extends inward along the flank, thigh and shin to the ankle.
export function pterosaurWing(p, tint, shoulder, leg, surface, wingTint) {
    const {hip, knee, ankle} = leg;
    const half = p.wingspan / 2, span = half - shoulder.x, arm = p.armFraction / 100;
    const chord = p.wingspan * p.wingChord / 100;
    const wrist = shoulder.clone().add(V(span * arm, chord * .043, chord * .25));
    const elbow = shoulder.clone().lerp(wrist, .37).add(V(0, -chord * .035, -chord * .22));
    const carpus = shoulder.clone().lerp(wrist, .75);
    const tip = V(half, shoulder.y - .06 * chord, wrist.z - Math.tan(MathUtils.degToRad(p.wristSweep)) * (half - wrist.x));
    const digits = [0, .36, .67, .88, 1].map(t => wrist.clone().lerp(tip, t)
        .add(V(0, .032 * chord * Math.sin(t * Math.PI), .16 * chord * Math.sin(t * Math.PI))));
    const radius = Math.min(chord * .045, span * .024);
    const hand = surface();
    for (const s of [-1, 0, 1]) {
        const knuckle = wrist.clone().add(V(s * radius * 1.45, radius * .57, radius * (2.7 - .55 * Math.abs(s))));
        const nail = knuckle.clone().add(V(s * radius * .77, -radius * .74, radius * 1.10));
        hand.rod(wrist, knuckle, radius * .26, tint.legColor, 5, radius * .15);
        hand.rod(knuckle, nail, radius * .15, tint.billColor, 5, 0);
    }

    const bones = [shoulder, elbow, carpus, ...digits];
    const leading = [shoulder.clone().add(V(0, 0, chord * .10)),
        shoulder.clone().lerp(wrist, .50).add(V(0, 0, .14 * chord)), ...digits];
    const trailing = [ankle, V(lerp(ankle.x, wrist.x, .19), ankle.y * .6, lerp(ankle.z, wrist.z - chord * .79, .56)),
        V(lerp(ankle.x, wrist.x, .52), shoulder.y * .33, lerp(ankle.z, wrist.z - chord * .79, .85)),
        V(wrist.x, wrist.y, wrist.z - chord * .79),
        ...digits.slice(1).map((point, i) => point.clone().add(V(0, 0, -chord * [.57, .35, .15, .007][i])))];
    const rows = [...new Set([...Array.from({length: 29}, (_, i) => i / 28), arm, arm * .37])].sort((a, b) => a - b);
    // More samples near the wing finger resolve its round leading edge.
    const aftSections = [0, .025, .062, .12, .20, .32, .46, .61, .74, .85, .94, 1];
    const foreSections = [0, .27, .62], cols = foreSections.length + aftSections.length;
    const positions = [], colors = [], uvs = [], indices = [], boneIndices = [], weights = [];
    let area = 0, lastChord = 0;
    for (let face = 0; face < 2; face++) {
        for (const [i, t] of rows.entries()) {
            const x = shoulder.x + span * t;
            const spar = wingEdge(bones, x), front = wingEdge(leading, x);
            const rear = wingEdge(trailing, lerp(ankle.x, half, t));
            const boneRadius = radius * (1 - t) * (1.22 - .65 * smoothstep(t, 0, arm));
            front.z = Math.max(front.z, spar.z + boneRadius);
            const sectionChord = front.z - rear.z;
            if (!face && i) area += (sectionChord + lastChord) * .5 * span * (t - rows[i - 1]);
            lastChord = sectionChord;
            const pectoral = 1 - smoothstep(t, 0, .16);
            for (let j = 0; j < cols; j++) {
                const fore = j < foreSections.length;
                const s = fore ? foreSections[j] : aftSections[j - foreSections.length];
                const v = fore ? front.clone().lerp(spar, s) : spar.clone().lerp(rear, s);
                const u = MathUtils.clamp((front.z - v.z) / Math.max(sectionChord, .001 * chord), 0, 1);
                const arch = Math.sin(Math.PI * u);
                // At the root, follow the leg itself. This fixes the trailing corner
                // in the body frame throughout both the upstroke and downstroke.
                if (!fore && pectoral > 0) {
                    const inner = s < .5 ? shoulder.clone().lerp(hip, s * 2) :
                        s < .72 ? hip.clone().lerp(knee, (s - .5) / .22) : knee.clone().lerp(ankle, (s - .72) / .28);
                    const straight = shoulder.clone().lerp(ankle, s);
                    v.addScaledVector(inner.sub(straight), pectoral);
                }
                const behindBone = s * spar.distanceTo(rear);
                const ridge = fore ? Math.sqrt(1 - (1 - s) ** 2) :
                    Math.exp(-((behindBone / Math.max(boneRadius * 2.3, .001 * chord)) ** 2));
                const depth = boneRadius * ridge + sectionChord * .008 * arch;
                v.y += (face ? -depth : depth) + sectionChord * arch * (.060 - .025 * t) * (1 - pectoral);
                positions.push(v.x, v.y, v.z);
                uvs.push(t, u);
                const armWeight = smoothstep(t, 0, lerp(.075, .27, u));
                const outerWeight = smoothstep(t, arm - .075, arm + .095);
                boneIndices.push(0, 1, 2, 0);
                weights.push(1 - armWeight, armWeight * (1 - outerWeight), armWeight * outerWeight, 0);
                const color = wingTint(!face, t, u).clone();
                color.lerp(tint.bodyColor, .22 * ridge + .18 * smoothstep(u, .8, 1) + .24 * smoothstep(t, .72, 1));
                colors.push(color.r, color.g, color.b);
                if (i && j) {
                    const k = positions.length / 3 - 1, a = k - cols - 1, b = k - 1, c = k - cols;
                    if (face) indices.push(a, c, b, c, k, b);
                    else indices.push(a, b, c, c, b, k);
                }
            }
        }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
    geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
    geometry.setAttribute("skinIndex", new Uint16BufferAttribute(boneIndices, 4));
    geometry.setAttribute("skinWeight", new Float32BufferAttribute(weights, 4));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return {geometry, wrist, handGeometry: hand.geometry().translate(-wrist.x, -wrist.y, -wrist.z), area};
}

// Deterministic surface detail at close range. Mipmaps fade the grain when the
// whole animal occupies only a few pixels. Both maps travel in the exported GLB.
const pigmentMaps = new Map();
export function pterosaurMaterial(base, membrane = false) {
    const width = 256, height = 128;
    if (!pigmentMaps.has(membrane)) {
        const data = new Uint8Array(width * height * 4);
        function lattice(x, y) {
            let n = Math.imul(x + 391, 374761393) + Math.imul(y + 37, 668265263);
            n = Math.imul(n ^ n >>> 13, 1274126177);
            return ((n ^ n >>> 16) >>> 0) / 4294967296;
        }
        function grain(x, y) {
            const a = Math.floor(x), b = Math.floor(y);
            const fx = smoothstep(x - a, 0, 1), fy = smoothstep(y - b, 0, 1);
            return lerp(lerp(lattice(a, b), lattice(a + 1, b), fx), lerp(lattice(a, b + 1), lattice(a + 1, b + 1), fx), fy);
        }
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
            const t = x / (width - 1), u = y / (height - 1);
            const cloudy = grain(9 * t + u, 5 * u), fine = grain(52 * t, 32 * u);
            const phase = 2 * Math.PI * (37 * t + u * (2.5 - 6 * t) + .49 * grain(13 * t, 4 * u));
            const fiber = ((1 + Math.cos(phase)) * .5) ** 4;
            const tone = membrane ? 217 + 25 * cloudy + 14 * fine - 17 * fiber * Math.sin(Math.PI * u) :
                218 + 16 * cloudy + 13 * fine + 8 * lattice(x, y);
            const offset = (y * width + x) * 4;
            data[offset] = tone;
            data[offset + 1] = tone - 2;
            data[offset + 2] = tone - 4;
            data[offset + 3] = 255;
        }
        data.fill(255, 0, 4);  // neutral sample for the eyes and feet, which have their own colors
        pigmentMaps.set(membrane, data);
    }
    const map = new DataTexture(pigmentMaps.get(membrane), width, height);
    map.name = membrane ? "Wing membrane fibers" : "Mottled skin";
    map.colorSpace = SRGBColorSpace;
    map.magFilter = LinearFilter;
    map.minFilter = LinearMipmapLinearFilter;
    map.generateMipmaps = true;
    map.needsUpdate = true;
    const material = base.clone();
    material.name = map.name;
    material.map = map;
    return material;
}

export function bindWingMembrane(wing, arm, hand, geometry, material, label) {
    const root = new Bone(); root.name = label + " wing root"; wing.add(root); root.add(arm);
    const skin = new SkinnedMesh(geometry, material); skin.name = label + " flight membrane"; wing.add(skin);
    wing.updateWorldMatrix(true, true);
    skin.bind(new Skeleton([root,arm,hand]));
    skin.frustumCulled = false;
}
