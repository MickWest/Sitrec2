import * as THREE from "three";
import {normalizeParameters, usesCanopy, usesAirlinerWindscreen} from "./parameters.js";

const rad = Math.PI / 180;
const mix = THREE.MathUtils.lerp;

// Match the triangles of a sampled mesh when placing a decal on its skin. Using
// the analytic curve instead can put small parts of the decal beneath the mesh.
function sampledPoint(rows, columns, geometry, u, v) {
    const i = Math.min(rows - 1, Math.floor(u * rows)), j = Math.min(columns - 1, Math.floor(v * columns));
    const a = u * rows - i, b = v * columns - j;
    const p = (i * (columns + 1) + j) * 3, q = p + (columns + 1) * 3, r = p + 3, s = q + 3;
    const position = geometry.attributes.position.array;
    return [0, 1, 2].map(k => a + b <= 1 ? position[p+k] * (1-a-b) + position[q+k] * a + position[r+k] * b :
        position[s+k] * (a+b-1) + position[q+k] * (1-b) + position[r+k] * (1-a));
}

function surface(rows, columns, point, reverse = false) {
    const positions = [], indices = [];
    for (let i = 0; i <= rows; i++) for (let j = 0; j <= columns; j++) positions.push(...point(i / rows, j / columns));
    for (let i = 0; i < rows; i++) for (let j = 0; j < columns; j++) {
        const a = i * (columns + 1) + j, b = a + columns + 1;
        if (reverse) indices.push(a, a + 1, b, a + 1, b + 1, b);
        else indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
}

/** An isolated, exportable aircraft: metres, +Y up, +Z nose, +X port. */
export function buildAircraft(input) {
    const p = normalizeParameters(input);
    const root = new THREE.Group();
    root.name = "Procedural aircraft";
    root.userData = {generator: "Sitrec Aircraft Designer", parameters: p, units: "metres", forward: "+Z", up: "+Y"};
    const material = (name, color, options = {}) => new THREE.MeshStandardMaterial({name, color, roughness: p.roughness, metalness: 0.12, ...options});
    const paint = material("Fuselage paint", p.bodyColor);
    const accent = material("Livery accent", p.accentColor, {side: THREE.DoubleSide});
    const referenceRed = p.livery === "british" ? material("Reference red", "#c52135", {side: THREE.DoubleSide}) : null;
    const wingPaint = material("Wing paint", p.wingColor);
    const nacelle = material("Nacelle paint", p.engineColor);
    const glass = material("Opaque blue glazing", "#18384e", {roughness: 0.18, metalness: 0.45, side: THREE.DoubleSide});
    const cabinGlass = material("Cabin glazing", "#14212d", {roughness: 0.48, metalness: 0.05, side: THREE.DoubleSide});
    const dark = material("Intakes and tires", "#18222c", {roughness: 0.85});
    const metal = material("Metal", "#a8b5c2", {metalness: 0.7, roughness: 0.32});
    const propellers = [];
    const R = p.diameter / 2, H = R * p.bodyHeight, L = p.length;

    function mesh(name, geometry, mat, parent = root) {
        const object = new THREE.Mesh(geometry, mat);
        object.name = name;
        parent.add(object);
        return object;
    }

    function ellipsoid(name, x, y, z, rx, ry, rz, mat, parent = root) {
        const object = mesh(name, new THREE.SphereGeometry(1, 16, 10), mat, parent);
        object.position.set(x, y, z); object.scale.set(rx, ry, rz);
        return object;
    }

    function rod(name, a, b, radius, mat, parent = root) {
        const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b), delta = end.clone().sub(start);
        const object = mesh(name, new THREE.CylinderGeometry(radius, radius, delta.length(), 8), mat, parent);
        object.position.copy(start.add(end).multiplyScalar(0.5));
        object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
        return object;
    }

    const airlinerNose = p.noseProfile === "airliner" || (p.noseProfile === "auto" && p.bodyStyle === "transport");
    // Width, half-height and centreline are independent. A lowered radome and
    // rising crown put the windshield on the front of the nose, not on its roof.
    const noseSections = [
        [0, 0.002, 0.004, -0.30], [0.04, 0.18, 0.17, -0.285],
        [0.15, 0.40, 0.37, -0.315], [0.31, 0.61, 0.60, -0.275],
        [0.40, 0.745, 0.75, -0.20], [0.58, 0.85, 0.90, -0.10],
        [0.77, 0.957, 0.98, -0.03], [1, 1, 1, 0],
    ];
    function bodySection(u) {
        const nose = p.noseLength / 100, tail = 1 - p.tailLength / 100;
        if (airlinerNose && u < nose) {
            const t = Math.max(0, u / nose);
            const i = Math.max(1, noseSections.findIndex(row => row[0] >= t));
            const a = noseSections[i - 1], b = noseSections[i], f = (t - a[0]) / (b[0] - a[0]);
            return {width: mix(a[1], b[1], f), height: mix(a[2], b[2], f), center: mix(a[3], b[3], f)};
        }
        let factor = 1;
        if (u < nose) factor = Math.pow(Math.sin(u / nose * Math.PI / 2), p.bodyStyle === "jet" ? 1.2 : 0.65);
        if (u > tail) factor = Math.pow(Math.cos((u - tail) / (1 - tail) * Math.PI / 2), 1.15);
        if (p.bodyStyle === "glider") factor *= mix(1, 0.38, Math.min(1, Math.max(0, (u - 0.35) * 4)));
        factor = Math.max(0.002, factor);
        return {width: factor, height: factor, center: u < nose ? -0.15 * (1 - factor) : 0.24 * (1 - factor)};
    }

    function bodyRadius(u) { return bodySection(u).width; }

    function crownRise(u) {
        return p.upperDeckRise * THREE.MathUtils.smoothstep(u, 0.015, 0.10) *
            (1 - THREE.MathUtils.smoothstep(u, p.upperDeckEnd / 100 - 0.10, p.upperDeckEnd / 100));
    }

    const bodyRows = 128, bodyColumns = 64;
    function bodyCurve(u, angle) {
        const section = bodySection(u);
        return [R * section.width * Math.cos(angle), H * section.center + H * section.height * Math.sin(angle) +
            crownRise(u) * Math.max(0, Math.sin(angle)) ** 3, L * (0.5 - u)];
    }
    function bodyPoint(u, angle, lift = 0) {
        if (!lift) return bodyCurve(u, angle);
        const theta = ((angle / (Math.PI * 2)) % 1 + 1) % 1;
        const point = sampledPoint(bodyRows, bodyColumns, body, u, theta);
        point[0] += lift * Math.cos(angle); point[1] += lift * Math.sin(angle);
        return point;
    }

    function sidePoint(u, y, side, lift = R * 0.006) {
        const section = bodySection(u), cy = H * section.center, ry = H * section.height;
        let normalizedY = THREE.MathUtils.clamp((y - cy) / ry, -0.995, 0.995);
        const rise = crownRise(u);
        if (rise > 0) for (let i = 0; i < 5; i++) {
            const upper = Math.max(0, normalizedY);
            normalizedY -= (ry * normalizedY + rise * upper ** 3 - (y - cy)) / (ry + 3 * rise * upper ** 2);
        }
        normalizedY = THREE.MathUtils.clamp(normalizedY, -0.995, 0.995);
        const angle = Math.asin(normalizedY);
        return bodyPoint(u, side > 0 ? angle : Math.PI - angle, lift);
    }

    function panel(name, corners, point, mat, parent = root, subdivisions = 8) {
        const geometry = surface(subdivisions, subdivisions, (u, v) => {
            const a = corners[0].map((n, i) => mix(n, corners[1][i], u));
            const b = corners[3].map((n, i) => mix(n, corners[2][i], u));
            return point(...a.map((n, i) => mix(n, b[i], v)));
        });
        return mesh(name, geometry, mat, parent);
    }

    const body = surface(bodyRows, bodyColumns, (u, v) => bodyPoint(u, v * Math.PI * 2));
    // Material bands follow the actual skin, so changing the body never detaches the livery.
    const paintIndices = [], accentIndices = [];
    for (let i = 0; i < bodyRows; i++) for (let j = 0; j < bodyColumns; j++) {
        const height = Math.sin((j + 0.5) / bodyColumns * Math.PI * 2);
        const colored = p.livery === "british" ? height < -0.53 : p.livery === "belly" ? height < -0.25 : p.livery === "stripe" && height > -0.15 && height < 0.13;
        const destination = colored ? accentIndices : paintIndices;
        for (let k = 0; k < 6; k++) destination.push(body.index.array[(i * bodyColumns + j) * 6 + k]);
    }
    body.setIndex([...paintIndices, ...accentIndices]);
    body.addGroup(0, paintIndices.length, 0);
    if (accentIndices.length) body.addGroup(paintIndices.length, accentIndices.length, 1);
    mesh("Fuselage", body, [paint, accent]);

    if (p.cockpit) {
        const nose = p.noseLength / 100;
        const center = nose * p.cockpitPosition / 100;
        const length = nose * p.cockpitLength / 100;
        const halfWidth = Math.asin(p.cockpitWidth / 100);
        const start = Math.max(0.008, center - length / 2), end = Math.min(0.95, center + length / 2);
        const canopy = usesCanopy(p);
        if (canopy) {
            // The perimeter follows the skin even while sliding along a tapered nose.
            // A raised surface avoids the old ellipsoid's exposed or buried edges.
            mesh("Cockpit canopy", surface(24, 24, (u, v) => {
                const point = bodyPoint(mix(start, end, u), Math.PI / 2 + (v * 2 - 1) * halfWidth, R * 0.012);
                point[1] += H * p.canopyHeight * Math.pow(Math.sin(Math.PI * u) * Math.sin(Math.PI * v), 0.8);
                return point;
            }), glass);
        } else if (usesAirlinerWindscreen(p)) {
            // One wraparound band, divided at shared edges into three panes per
            // side. Every edge uses the same nose coordinates and deformation,
            // so the front and side panes stay joined when a control changes.
            const angleAtLevel = (u, level) => {
                const section = bodySection(nose * u);
                return Math.asin(THREE.MathUtils.clamp((level - section.center) / section.height, -0.995, 0.995));
            };
            const stations = [
                {bottom: [0.35, Math.PI / 2], top: [0.49, Math.PI / 2], setback: 0},
                {bottom: [0.46, angleAtLevel(0.46, 0.37)], top: [0.56, angleAtLevel(0.56, 0.65)], setback: 0.55},
                {bottom: [0.68, angleAtLevel(0.68, 0.37)], top: [0.715, angleAtLevel(0.715, 0.65)], setback: 0.90},
                {bottom: [0.83, angleAtLevel(0.83, 0.44)], top: [0.835, angleAtLevel(0.835, 0.62)], setback: 1},
            ];
            if (p.cockpitStyle === "airliner4") stations.splice(2, 1);
            const shift = p.cockpitPosition / 100 - 0.60;
            const location = u => THREE.MathUtils.clamp(nose * (0.58 + (u - 0.58) * p.cockpitLength / 30 + shift), 0.008, 0.94);
            const paneMaterial = cabinGlass.clone(); paneMaterial.name = "Airliner windshield"; paneMaterial.roughness = 0.34;
            function bandCoordinate(station, height) {
                const t = 0.5 + (height - 0.5) * p.cockpitHeight;
                const u = mix(station.bottom[0], station.top[0], t) + (p.cockpitSetback - 12) / 100 * station.setback;
                const angle = mix(station.bottom[1], station.top[1], t);
                return [location(u), Math.PI / 2 - (Math.PI / 2 - angle) * p.cockpitWidth / 92];
            }
            const bandPoint = (coordinate, side, lift = R * 0.015) => bodyPoint(coordinate[0], side > 0 ? coordinate[1] : Math.PI - coordinate[1], lift);
            const lastPane = stations.length - 2;
            const mask = p.cockpitMask ? material("Cockpit surround", "#101820", {roughness: 0.65, side: THREE.DoubleSide}) : null;
            for (const side of [1, -1]) for (let pane = 0; pane <= lastPane; pane++) {
                if (mask) mesh(`Cockpit mask ${pane} ${side}`, surface(12, 12, (across, height) => {
                    const a = bandCoordinate(stations[pane], mix(-0.13, 1.13, height));
                    const b = bandCoordinate(stations[pane + 1], mix(-0.13, 1.13, height));
                    const t = across * (pane === lastPane ? 1.08 : 1);
                    return bandPoint(a.map((value, axis) => mix(value, b[axis], t)), side, R * 0.010);
                }), mask);
                mesh(`Windshield ${["front", "side", "aft"][pane]} ${side}`, surface(12, 12, (across, height) => {
                    const a = bandCoordinate(stations[pane], height), b = bandCoordinate(stations[pane + 1], height);
                    const start = bandPoint(a, side), end = bandPoint(b, side);
                    const distance = Math.hypot(...start.map((value, axis) => end[axis] - value));
                    // Trim only along pane joins, by half the requested pillar
                    // width. The top and bottom outline remain continuous.
                    const gap = Math.min(0.2, p.cockpitPillar / 200 / Math.max(0.01, distance));
                    const t = mix(gap, pane === lastPane ? 1 : 1 - gap, across);
                    return bandPoint(a.map((value, axis) => mix(value, b[axis], t)), side);
                }), paneMaterial);
            }
        } else {
            const paneAngle = halfWidth * 2 / p.cockpitPanes;
            const gap = Math.min(paneAngle * 0.35, p.cockpitPillar / 100 / (R * Math.max(0.15, bodyRadius(center))));
            for (let i = 0; i < p.cockpitPanes; i++) {
                const theta = -halfWidth + i * paneAngle + gap / 2;
                mesh(`Windshield ${i + 1}`, surface(8, 8, (u, v) => {
                    const angle = theta + (paneAngle - gap) * v;
                    const side = Math.abs(angle) / halfWidth;
                    const setback = nose * p.cockpitSetback / 100 * side ** 1.5;
                    const offset = (u - 0.5) * (end - start) * mix(1, 0.7, side) * p.cockpitHeight;
                    return bodyPoint(THREE.MathUtils.clamp((start + end) / 2 + offset + setback, 0.008, 0.95),
                        Math.PI / 2 + angle, R * 0.012);
                }), glass);
            }
        }
    }
    if (p.windows) {
        const start = p.windowStart / 100, end = p.windowEnd / 100;
        const spacing = (end - start) / Math.max(1, p.windowCount);
        const width = Math.min(p.windowWidth, spacing * L * 0.8);
        const doorCount = p.doorLayout === "five" ? 5 : 4;
        const exits = p.doorLayout === "overwing" ? [0.47, 0.505] :
            Array.from({length: doorCount}, (_, i) => mix(start - 0.025, end + 0.027, i / (doorCount - 1)));
        for (let i = 0; i < p.windowCount; i++) {
            const u = start + spacing * (i + 0.5);
            if (p.doors && exits.some(exit => Math.abs(u - exit) * L < (p.doorLayout === "overwing" ? 0.35 : 0.65))) continue;
            for (const side of [1, -1]) {
                const vertices = [...sidePoint(u, H * p.windowLevel, side, R * 0.02)], indices = [];
                for (let j = 0; j <= 24; j++) {
                    const a = j / 24 * Math.PI * 2, round = v => Math.sign(v) * Math.abs(v) ** 0.6;
                    vertices.push(...sidePoint(u + width / L * round(Math.cos(a)) / 2,
                        H * p.windowLevel + p.windowHeight * round(Math.sin(a)) / 2, side, R * 0.02));
                    if (j) indices.push(0, j, j + 1);
                }
                const geometry = new THREE.BufferGeometry();
                geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3)); geometry.setIndex(indices); geometry.computeVertexNormals();
                mesh(`Cabin window ${side} ${i + 1}`, geometry, cabinGlass);
            }
        }
    }
    if (p.windows && p.doubleDeck) {
        const start = p.upperWindowStart / 100, end = p.upperWindowEnd / 100;
        const spacing = Math.max(0, end - start) / p.upperWindowCount;
        if (spacing > 0) for (let i = 0; i < p.upperWindowCount; i++) for (const side of [1, -1]) {
            const u = start + spacing * (i + 0.5), y = H * p.upperWindowLevel + crownRise(u) * 0.8;
            const vertices = [...sidePoint(u, y, side, R * 0.02)], indices = [];
            for (let j = 0; j <= 24; j++) {
                const a = j / 24 * Math.PI * 2, round = v => Math.sign(v) * Math.abs(v) ** 0.6;
                vertices.push(...sidePoint(u + Math.min(p.windowWidth, spacing * L * 0.8) / L * round(Math.cos(a)) / 2,
                    y + p.windowHeight * round(Math.sin(a)) / 2, side, R * 0.02));
                if (j) indices.push(0, j, j + 1);
            }
            const geometry = new THREE.BufferGeometry(); geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
            geometry.setIndex(indices); geometry.computeVertexNormals(); mesh(`Upper window ${side} ${i + 1}`, geometry, cabinGlass);
        }
    }

    // Thin, surface-following strips export as ordinary mesh geometry. They also
    // keep door outlines and lettering independent of fonts and image textures.
    function skinStrokes(name, paths, width, side, mat) {
        const positions = [], indices = [];
        for (const path of paths) for (let i = 1; i < path.length; i++) {
            const a = path[i - 1], b = path[i];
            const dx = (b[0] - a[0]) * L, dy = b[1] - a[1], length = Math.hypot(dx, dy);
            if (length < 0.00001) continue;
            const du = -dy / length * width / (2 * L), dh = dx / length * width / 2;
            const start = positions.length / 3;
            for (const [u, y] of [[a[0]+du,a[1]+dh],[b[0]+du,b[1]+dh],[b[0]-du,b[1]-dh],[a[0]-du,a[1]-dh]])
                positions.push(...sidePoint(u, y, side, R * 0.018));
            indices.push(start,start+1,start+2,start,start+2,start+3);
        }
        const geometry = new THREE.BufferGeometry(); geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
        geometry.setIndex(indices); geometry.computeVertexNormals(); mesh(name, geometry, mat);
    }
    if (p.doors) {
        const seam = material("Door outlines", "#79858f", {roughness: 0.85, side: THREE.DoubleSide});
        const layouts = [
            ["Forward door", p.windowStart / 100 - 0.025, 0.86, 1.88, H * 0.05],
            ["Aft door", p.windowEnd / 100 + 0.027, 0.86, 1.88, H * 0.05],
            ["Forward overwing exit", 0.47, 0.62, 1.2, H * 0.24],
            ["Aft overwing exit", 0.505, 0.62, 1.2, H * 0.24],
        ];
        if (p.doorLayout !== "overwing") {
            const count = p.doorLayout === "five" ? 5 : 4;
            layouts.splice(0, layouts.length, ...Array.from({length: count}, (_, i) => [
                `Passenger door ${i + 1}`, mix(p.windowStart / 100 - 0.025, p.windowEnd / 100 + 0.027, i / (count - 1)),
                0.98, 1.92, H * p.windowLevel - 0.7,
            ]));
        }
        for (const side of [1, -1]) for (const [name, u, width, height, level] of layouts) {
            const outline = [];
            for (let i = 0; i <= 48; i++) {
                const a = i / 48 * Math.PI * 2, rounded = v => Math.sign(v) * Math.abs(v) ** 0.26;
                outline.push([u + width / (2 * L) * rounded(Math.cos(a)), level + height / 2 * rounded(Math.sin(a))]);
            }
            skinStrokes(`${name} outline ${side}`, [outline, [[u-0.1/L, level], [u+0.1/L, level]]], 0.018, side, seam);
            panel(`${name} window ${side}`, [[u-0.12/L,H*0.38-0.17],[u+0.12/L,H*0.38-0.17],
                [u+0.12/L,H*0.38+0.17],[u-0.12/L,H*0.38+0.17]], (u, y) => sidePoint(u,y,side,R*0.013), glass);
        }
    }
    if (p.livery === "british") {
        // A compact vector wordmark and flowing ribbons approximate the supplied
        // paint reference. This is a visual recreation, not airline artwork.
        const glyphs = {
            A: [[[0,0],[0.35,1],[0.7,0]],[[0.15,0.42],[0.55,0.42]]],
            B: [[[0,0],[0,1],[0.46,1],[0.65,0.85],[0.62,0.65],[0.43,0.52],[0,0.52]],[[0.43,0.52],[0.68,0.38],[0.68,0.15],[0.48,0],[0,0]]],
            H: [[[0,0],[0,1]],[[0.7,0],[0.7,1]],[[0,0.5],[0.7,0.5]]],
            I: [[[0.1,0],[0.6,0]],[[0.35,0],[0.35,1]],[[0.1,1],[0.6,1]]],
            R: [[[0,0],[0,1],[0.46,1],[0.67,0.83],[0.62,0.62],[0.4,0.5],[0,0.5]],[[0.38,0.5],[0.72,0]]],
            S: [[[0.68,0.88],[0.52,1],[0.2,1],[0.03,0.8],[0.12,0.58],[0.57,0.4],[0.68,0.2],[0.52,0],[0.15,0],[0,0.14]]],
            T: [[[0,1],[0.7,1]],[[0.35,1],[0.35,0]]],
            W: [[[0,1],[0.13,0],[0.37,0.68],[0.59,0],[0.72,1]]],
            Y: [[[0,1],[0.35,0.52],[0.7,1]],[[0.35,0.52],[0.35,0]]],
        };
        const text = "BRITISH AIRWAYS", height = p.diameter * 0.125, advance = height * 0.94;
        for (const side of [1, -1]) {
            const paths = [];
            for (let i = 0; i < text.length; i++) for (const path of glyphs[text[i]] ?? [])
                paths.push(path.map(([x,y]) => [0.275 + side * ((i - text.length/2) * advance + x * height) / L, H * -0.08 + y * height]));
            skinStrokes(`Airline wordmark ${side}`, paths, height * 0.10, side, accent);
            panel(`Forward red ribbon ${side}`, [[0.155,H*0.59],[0.17,H*0.69],[0.225,H*0.60],[0.22,H*0.53]],
                (u,y) => sidePoint(u,y,side,R*0.015), referenceRed);
            panel(`Forward blue ribbon ${side}`, [[0.16,H*0.51],[0.166,H*0.56],[0.205,H*0.46],[0.20,H*0.42]],
                (u,y) => sidePoint(u,y,side,R*0.015), accent);
        }
    }

    // Closed, cambered wing sections with explicit tip caps. No negative scales in exports.
    function chordFactor(s, taper, cranked = false) {
        if (!cranked) return mix(1, taper, s);
        return s < 0.34 ? mix(1, 0.65, s / 0.34) : mix(0.65, taper, (s - 0.34) / 0.66);
    }
    function foil(name, span, chord, taper, sweep, dihedral, thickness, twist, origin, mat, vertical = false, side = 1, cranked = false) {
        const point = (s, t) => {
            const theta = t * Math.PI * 2;
            const fraction = (1 - Math.cos(theta)) / 2;
            const c = chord * chordFactor(s, taper, cranked);
            const section = Math.sin(Math.PI * Math.pow(fraction, 0.7));
            const camber = vertical ? 0 : Math.sin(fraction * Math.PI) * c * 0.012;
            const dy = Math.sign(Math.sin(theta)) * section * c * thickness / 2 + camber;
            const dz = (0.25 - fraction) * c;
            const twistAngle = twist * s * rad;
            const y = Math.tan(dihedral * rad) * span * s + dy * Math.cos(twistAngle) - dz * Math.sin(twistAngle);
            const z = -Math.tan(sweep * rad) * span * s + (chord - c) / 4 + dz * Math.cos(twistAngle) + dy * Math.sin(twistAngle);
            return vertical ? [origin[0] - side * y, origin[1] + span * s, origin[2] + z]
                : [origin[0] + side * span * s, origin[1] + y, origin[2] + z];
        };
        const geometry = surface(10, 40, point, side < 0);
        // Close the tip with a fan whose winding matches the skin.
        const tip = [], indices = [];
        for (let i = 0; i <= 40; i++) tip.push(...point(1, i / 40));
        for (let i = 1; i < 39; i++) {
            if (side > 0) indices.push(0, i + 1, i); else indices.push(0, i, i + 1);
        }
        const cap = new THREE.BufferGeometry();
        cap.setAttribute("position", new THREE.Float32BufferAttribute(tip, 3)); cap.setIndex(indices); cap.computeVertexNormals();
        mesh(name, geometry, mat); mesh(`${name} tip`, cap, mat);
        return (u, v) => sampledPoint(10, 40, geometry, u, v);
    }

    const wingY = H * p.wingHeight, wingZ = L * (0.5 - p.wingPosition / 100);
    for (const side of [1, -1]) {
        foil(`Wing ${side}`, p.span / 2, p.rootChord, p.taper, p.sweep, p.dihedral, p.thickness / 100, p.twist, [0, wingY, wingZ], wingPaint, false, side, p.wingPlanform === "cranked");
        const tipY = wingY + Math.tan(p.dihedral * rad) * p.span / 2;
        const tipZ = wingZ - Math.tan(p.sweep * rad) * p.span / 2 + p.rootChord * (1 - p.taper) / 4;
        if (p.winglet > 0 && ["blended", "split"].includes(p.wingletStyle)) {
            const chord = p.rootChord * p.taper, width = p.winglet * Math.tan(p.wingletCant * rad);
            const point = (s, t) => {
                const c = chord * mix(1, 0.28, s), fraction = (1 - Math.cos(t * Math.PI * 2)) / 2;
                const thickness = Math.sign(Math.sin(t * Math.PI * 2)) * Math.sin(Math.PI * fraction ** 0.7) * c * 0.035;
                const dx = width * Math.cos(s * Math.PI / 2) * Math.PI / 2, dy = p.winglet * 1.5 * Math.sqrt(s);
                const norm = Math.max(0.0001, Math.hypot(dx, dy));
                return [side * (p.span / 2 + width * Math.sin(s * Math.PI / 2) - dy / norm * thickness),
                    tipY + p.winglet * s ** 1.5 + dx / norm * thickness,
                    tipZ + chord / 4 - c * fraction - p.winglet * 0.48 * s];
            };
            const geometry = surface(24, 32, point, side < 0);
            mesh(`Blended winglet ${side}`, geometry, p.livery === "british" ? paint : accent);
            if (p.livery === "british") {
                for (const [a, b, mat] of [[0.30, 0.43, accent], [0.62, 0.79, referenceRed]]) for (const face of [1, -1])
                    panel(`Winglet ribbon ${side}`, [[a, 0.03], [b, 0.03], [b + 0.08, 0.94], [a + 0.08, 0.94]],
                        (s, chord) => { const t = Math.acos(1 - 2 * chord) / (Math.PI * 2); const v = sampledPoint(24, 32, geometry, s, face > 0 ? t : 1 - t); v[0] -= side * face * 0.02; return v; }, mat, root, 20);
            }
        } else if (p.winglet > 0 && p.wingletStyle === "raked") {
            foil(`Raked tip ${side}`, p.winglet, p.rootChord * p.taper, 0.08, 55, p.dihedral + 3, 0.06, p.twist,
                [side * p.span / 2, tipY, tipZ], wingPaint, false, side);
        } else if (p.winglet > 0) foil(`Winglet ${side}`, p.winglet, p.rootChord * p.taper, 0.3, 24, -p.wingletCant, 0.06, 0,
            [side * p.span / 2, tipY, tipZ], p.livery === "solid" ? wingPaint : accent, true, side);
        if (p.winglet > 0 && ["split", "fence"].includes(p.wingletStyle)) {
            const height = p.winglet * 0.58, chord = p.rootChord * p.taper * 0.8;
            const cant = p.wingletStyle === "split" ? 34 : 0;
            mesh(`Lower winglet ${side}`, surface(10, 24, (s, t) => {
                const fraction = (1 - Math.cos(t * Math.PI * 2)) / 2, c = chord * mix(1, 0.18, s);
                const thickness = Math.sin(t * Math.PI * 2) * c * 0.035;
                return [side * (p.span / 2 + height * s * Math.tan(cant * rad) + thickness),
                    tipY - height * s, tipZ + chord / 4 - c * fraction - height * s * 0.6];
            }, side > 0), accent);
        }
        if (p.biplane) foil(`Upper wing ${side}`, p.span / 2, p.rootChord, p.taper, p.sweep, p.dihedral, p.thickness / 100, p.twist,
            [0, wingY + p.diameter * 1.2, wingZ + p.rootChord * 0.15], wingPaint, false, side);
        if (p.struts) {
            const x = p.span * 0.3, z = wingZ - Math.tan(p.sweep * rad) * x;
            rod(`Wing strut ${side}`, [side * R * 0.7, -H * 0.7, wingZ - p.rootChord * 0.15],
                [side * x, wingY + Math.tan(p.dihedral * rad) * x, z], R * 0.035, metal);
            if (p.biplane) rod(`Interplane strut ${side}`, [side * x, wingY, z], [side * x, wingY + p.diameter * 1.2, z], R * 0.04, metal);
        }
        if (p.navLights) {
            const lamp = material(side === 1 ? "Port red" : "Starboard green", side === 1 ? "#ff3b30" : "#25ed87", {
                emissive: side === 1 ? "#ff1808" : "#00bb44", emissiveIntensity: 0.8});
            ellipsoid(`Navigation lens ${side}`, side * (p.span / 2 - Math.max(0.035, R * 0.045)), tipY + p.rootChord * p.taper * 0.015, tipZ,
                Math.max(0.035, R * 0.045), Math.max(0.025, R * 0.035), Math.max(0.06, R * 0.09), lamp);
        }
    }

    const tailZ = L * (0.5 - p.tailPosition / 100), tailY = H * 0.38;
    const tailPaint = p.livery === "solid" || p.livery === "british" ? paint : accent;
    if (p.tailStyle !== "v") {
        const fins = p.tailStyle === "twin" ? [1, -1] : [1];
        for (const side of fins) {
            const fin = foil(`Vertical fin ${side}`, p.finHeight, p.finChord, 0.3, p.finSweep,
                fins.length === 2 ? -p.finCant : 0, 0.09, 0, [fins.length === 2 ? side * p.tailSpan * 0.25 : 0, tailY, tailZ], tailPaint, true, side);
            if (p.livery === "british") for (const face of [1, -1]) {
                for (const [a, b, mat] of [[0.10, 0.20, referenceRed], [0.30, 0.44, accent], [0.58, 0.82, referenceRed]]) {
                    panel(`Tail ribbon ${face}`, [[a, 0.01], [b, 0.01], [b - 0.09, 0.99], [a - 0.08, 0.99]], (s, chord) => {
                        const t = Math.acos(1 - 2 * chord) / (Math.PI * 2);
                        const v = fin(s + 0.035 * Math.sin(chord * Math.PI * 2), face > 0 ? t : 1 - t); v[0] -= side * face * 0.035; return v;
                    }, mat, root, 24);
                }
            }
        }
    }
    if (p.tailStyle !== "none") for (const side of [1, -1]) {
        const y = p.tailStyle === "t" ? tailY + p.finHeight : tailY;
        const z = p.tailStyle === "t" ? tailZ - Math.tan(p.finSweep * rad) * p.finHeight : tailZ;
        foil(`Tailplane ${side}`, p.tailSpan / 2, p.tailChord, 0.4, p.tailSweep, p.tailStyle === "v" ? 38 : 3,
            0.08, 0, [0, y, z], wingPaint, false, side);
    }
    if (p.canards) for (const side of [1, -1]) foil(`Canard ${side}`, p.canardSpan / 2, p.rootChord * 0.24, 0.35,
        22, 2, 0.07, 0, [0, H * 0.12, L * 0.21], wingPaint, false, side);

    function engine(x, y, z, index) {
        const group = new THREE.Group(); group.name = `Engine ${index + 1}`; group.position.set(x, y, z); root.add(group);
        const r = p.engineDiameter / 2, length = p.engineLength;
        const cross = (radius, angle, z) => [Math.cos(angle) * radius, Math.max(Math.sin(angle), -1 + p.engineFlatness) * radius, z];
        // A continuous lip with a dark recessed inlet and a visible fan.
        mesh("Nacelle", surface(20, 32, (u, v) => {
            const radius = r * (0.82 + 0.18 * Math.sin(Math.PI * u)) * (u > 0.75 ? mix(1, 0.7, (u - 0.75) * 4) : 1);
            return cross(radius, v * Math.PI * 2, length * (0.5 - u));
        }), nacelle, group);
        mesh("Intake rim", surface(10, 40, (u, v) => cross(r * (0.78 + 0.07 * Math.cos(u * Math.PI * 2)),
            v * Math.PI * 2, length / 2 + r * 0.07 * Math.sin(u * Math.PI * 2)), true), metal, group);
        mesh("Intake", surface(1, 40, (u, v) => cross(r * 0.745 * u, v * Math.PI * 2, length / 2 - r * 0.15)), dark, group);
        const nozzle = mesh("Exhaust", new THREE.CircleGeometry(r * 0.56, 24), dark, group); nozzle.position.z = -length / 2; nozzle.rotation.y = Math.PI;
        if (p.engineType === "jet") {
            ellipsoid("Fan hub", 0, 0, length / 2, r * 0.22, r * 0.22, r * 0.25, metal, group);
            for (let i = 0; i < 24; i++) {
                const blade = mesh("Fan blade", new THREE.BoxGeometry(r * 0.035, r * 0.52, r * 0.025), metal, group);
                const a = i / 24 * Math.PI * 2;
                blade.position.set(Math.sin(a) * r * 0.46, Math.cos(a) * r * 0.46, length / 2 - r * 0.12);
                blade.rotation.z = -a + 0.24;
            }
        } else {
            const prop = new THREE.Group(); prop.name = "Propeller"; prop.position.z = length / 2 + r * 0.22; group.add(prop); propellers.push(prop);
            ellipsoid("Spinner", 0, 0, 0, r * 0.43, r * 0.43, r * 0.7, paint, prop);
            for (let i = 0; i < p.propBlades; i++) {
                const a = i / p.propBlades * Math.PI * 2;
                const blade = ellipsoid("Propeller blade", -Math.sin(a) * p.propDiameter * 0.25, Math.cos(a) * p.propDiameter * 0.25, 0,
                    p.propDiameter * 0.035, p.propDiameter * 0.25, p.propDiameter * 0.014, dark, prop);
                blade.rotation.z = a;
            }
        }
    }

    if (p.engineType !== "none") {
        const count = p.engineCount, pairs = Math.floor(count / 2);
        let index = 0;
        for (let pair = 0; pair < pairs; pair++) for (const side of [1, -1]) {
            let x, y, z, attach;
            if (p.engineMount === "wing") {
                x = p.span / 2 * Math.min(0.9, p.engineSpacing / 100 + pair * 0.25);
                const chord = p.rootChord * chordFactor(x / (p.span / 2), p.taper, p.wingPlanform === "cranked");
                attach = [side * x, wingY + Math.tan(p.dihedral * rad) * x, wingZ - Math.tan(p.sweep * rad) * x + (p.rootChord - chord) / 4];
                y = attach[1] - p.engineDiameter * p.engineDrop;
                z = attach[2] + p.engineOffset;
            } else {
                x = R * (p.engineMount === "rear" ? 0.9 : 0.65) + p.engineDiameter * (0.58 + pair * 1.1);
                y = H * 0.05; z = p.engineMount === "rear" ? -L * 0.28 + p.engineOffset : L * 0.27 + p.engineOffset;
                attach = [side * R * bodyRadius(0.5 - z / L) * 0.8, y, z];
            }
            if (p.engineMount === "wing") {
                const shape = [[attach[1], attach[2] + p.engineLength * 0.2], [y + p.engineDiameter * 0.3, z + p.engineLength * 0.3],
                    [y + p.engineDiameter * 0.3, z - p.engineLength * 0.3], [attach[1], attach[2] - p.engineLength * 0.3]];
                const thickness = p.engineDiameter * 0.065, vertices = [];
                for (const dx of [-thickness, thickness]) for (const [py, pz] of shape) vertices.push(side * x + dx, py, pz);
                const geometry = new THREE.BufferGeometry(); geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
                geometry.setIndex([0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,1,2,6,1,6,5,2,3,7,2,7,6,3,0,4,3,4,7]);
                geometry.computeVertexNormals(); mesh(`Engine pylon ${index + 1}`, geometry, wingPaint);
            } else rod(`Engine pylon ${index + 1}`, attach, [side * x, y, z], Math.min(p.engineDiameter * 0.13, p.rootChord * 0.06), wingPaint);
            engine(side * x, y, z, index++);
        }
        if (count % 2) {
            const nose = p.engineMount === "nose";
            engine(0, nose ? -H * 0.08 : (count === 3 ? H * 0.85 : -H * 0.2),
                nose ? L / 2 - p.engineLength * 0.38 : -L * 0.4, index);
        }
    }

    if (p.gear) {
        const mainZ = p.gearStyle === "taildragger" ? wingZ + p.rootChord * 0.18 : wingZ - p.rootChord * 0.4;
        const wheelR = Math.max(0.12, Math.min(R * 0.28, p.gearHeight * 0.32));
        const bottom = -H - p.gearHeight;
        function gear(name, x, z, small = false) {
            const radius = wheelR * (small ? 0.65 : 1);
            rod(`${name} leg`, [x * 0.7, -H * bodyRadius(0.5 - z / L) * 0.75, z], [x, bottom, z], radius * 0.15, metal);
            const tire = mesh(`${name} tire`, new THREE.CylinderGeometry(radius, radius, radius * 0.65, 20), dark);
            tire.rotation.z = Math.PI / 2; tire.position.set(x, bottom, z);
            const hub = mesh(`${name} hub`, new THREE.CylinderGeometry(radius * 0.45, radius * 0.45, radius * 0.68, 16), metal);
            hub.rotation.z = Math.PI / 2; hub.position.copy(tire.position);
        }
        gear("Port main gear", Math.max(R * 1.15, p.span * 0.085), mainZ);
        gear("Starboard main gear", -Math.max(R * 1.15, p.span * 0.085), mainZ);
        gear(p.gearStyle === "taildragger" ? "Tail gear" : "Nose gear", 0, p.gearStyle === "taildragger" ? -L * 0.4 : L * 0.31, true);
    }

    root.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(root);
    const size = bounds.getSize(new THREE.Vector3());
    const wingBounds = new THREE.Box3();
    root.children.filter(object => /^(Wing |Winglet |Blended winglet |Lower winglet |Raked tip )/.test(object.name)).forEach(object => wingBounds.expandByObject(object));
    const wingspan = wingBounds.getSize(new THREE.Vector3()).x;
    let triangles = 0;
    root.traverse(object => { if (object.isMesh) triangles += (object.geometry.index?.count ?? object.geometry.attributes.position.count) / 3; });
    const area = p.span * p.rootChord / 2 * (p.wingPlanform === "cranked" ? 1.65 * 0.34 + (0.65 + p.taper) * 0.66 : 1 + p.taper);
    return {root, propellers, bounds, stats: {triangles, size, wingspan, area, aspectRatio: p.span ** 2 / area}};
}

export function disposeAircraft(root) {
    const geometries = new Set(), materials = new Set();
    root.traverse(object => {
        if (object.geometry) geometries.add(object.geometry);
        for (const mat of Array.isArray(object.material) ? object.material : [object.material]) if (mat) materials.add(mat);
    });
    geometries.forEach(geometry => geometry.dispose());
    materials.forEach(material => material.dispose());
    root.removeFromParent();
}
