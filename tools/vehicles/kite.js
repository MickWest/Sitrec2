import * as THREE from "three";

// Editable visual kites in metres. +Y is up and +Z points into the wind, so the
// tails stream toward -Z. The origin is the tow point, where the flying line
// attaches. The flight values of a design are in kiteFlight.js.

const RAINBOW = ["#db3e36", "#f18d32", "#eed04b", "#43a867", "#298ccb", "#8456b5"];
const rad = THREE.MathUtils.degToRad;

export function buildKite(p) {
    const root = new THREE.Group(); root.name = "Procedural kite";
    const W = p.width, H = p.height, D = p.depth, shape = p.kiteShape, large = Math.max(W, H);
    const colors = p.kitePattern === "rainbow" ? RAINBOW : p.kitePattern === "panels" ? [p.bodyColor, p.accentColor] : [p.bodyColor];
    const fabric = (name, color) => new THREE.MeshStandardMaterial({name, color, metalness: p.metalness, roughness: p.roughness,
        side: THREE.DoubleSide, transparent: p.opacity < 1, opacity: p.opacity});
    const sailMaterials = colors.map((color, index) => fabric(`Kite fabric ${index + 1}`, color));
    const tailColors = p.kitePattern === "rainbow" ? RAINBOW : p.kitePattern === "panels" ? [p.tailColor, p.accentColor] : [p.tailColor];
    const tailMaterials = tailColors.map((color, index) => fabric(`Kite tail ${index + 1}`, color));
    const sparMaterial = new THREE.MeshStandardMaterial({name: "Kite spar", color: "#2b2f33", roughness: 0.6});
    const lineMaterial = new THREE.MeshStandardMaterial({name: "Bridle line", color: "#d8d8d0", roughness: 0.8});
    const sparRadius = THREE.MathUtils.clamp(large * 0.004, 0.002, 0.03);
    const lineRadius = THREE.MathUtils.clamp(large * 0.0012, 0.0008, 0.012);

    // The sail frame: x is across the kite, z runs from the tail edge to the nose,
    // and y is the side away from the wind. It is tilted nose-up to the flying attitude.
    const sail = new THREE.Group(); sail.name = "Kite sail"; sail.rotation.x = -rad(p.flyingAngle); root.add(sail);
    const material = index => sailMaterials[index % sailMaterials.length];

    function mesh(name, geometry, meshMaterial, parent = sail) {
        const part = new THREE.Mesh(geometry, meshMaterial); part.name = name; parent.add(part); return part;
    }
    // Flat panels from lists of corner points. Each panel is a fan from its first corner.
    function panels(name, list) {
        const batches = sailMaterials.map(() => []);
        for (const [materialIndex, ...corners] of list)
            for (let corner = 1; corner < corners.length - 1; corner++)
                batches[materialIndex % sailMaterials.length].push(...corners[0], ...corners[corner], ...corners[corner + 1]);
        const positions = [], geometry = new THREE.BufferGeometry();
        batches.forEach((batch, index) => {
            if (batch.length) {geometry.addGroup(positions.length / 3, batch.length / 3, index); positions.push(...batch);}
        });
        geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3)); geometry.computeVertexNormals();
        return mesh(name, geometry, sailMaterials);
    }
    // A smooth surface from a function of two parameters, colored by column.
    function surface(name, point, rows, columns, colorOf) {
        const positions = [], indices = [], batches = sailMaterials.map(() => []), geometry = new THREE.BufferGeometry();
        for (let row = 0; row <= rows; row++) for (let column = 0; column <= columns; column++) positions.push(...point(row / rows, column / columns));
        for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
            const a = row * (columns + 1) + column, b = a + columns + 1;
            batches[colorOf((column + 0.5) / columns) % sailMaterials.length].push(a, b, a + 1, a + 1, b, b + 1);
        }
        batches.forEach((batch, index) => {if (batch.length) {geometry.addGroup(indices.length, batch.length, index); indices.push(...batch);}});
        geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3)); geometry.setIndex(indices); geometry.computeVertexNormals();
        return mesh(name, geometry, sailMaterials);
    }
    function rod(name, a, b, radius, rodMaterial, parent = sail) {
        const start = new THREE.Vector3(...a), delta = new THREE.Vector3(...b).sub(start);
        const part = mesh(name, new THREE.CylinderGeometry(radius, radius, delta.length(), 6), rodMaterial, parent);
        part.position.copy(start).addScaledVector(delta, 0.5);
        part.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
        return part;
    }
    const spar = (a, b) => rod("Kite spar", a, b, sparRadius, sparMaterial);
    const mix = (a, b, t) => a.map((value, axis) => value + (b[axis] - value) * t);

    // Each shape gives its tow point, the points its bridle lines start from, and
    // a function for the tail attachment points, all in the sail frame.
    let tow, bridlePoints, tailPoint;
    // The pitch and yaw that turn a tail from straight downwind: a fan across the kite, unless the shape gives its own.
    let tailAim = (index, count) => [0, count > 1 ? (index / (count - 1) - 0.5) * rad(p.tailSpread) : 0];
    const tipRise = Math.tan(rad(p.bow)) * W / 2;       // a bowed kite's tips sweep away from the wind
    const along = (a, b) => (index, count) => mix(a, b, count > 1 ? index / (count - 1) : 0.5);

    if (shape === "delta") {
        const nose = [0, 0, H / 2], left = [W / 2, tipRise, -H / 2], right = [-W / 2, tipRise, -H / 2], rear = [0, 0, -H * 0.28];
        const midLeft = mix(rear, left, 0.5), midRight = mix(rear, right, 0.5), keel = [0, -H * 0.28, H * 0.05];
        panels("Kite sail panels", [[1, nose, rear, midLeft], [0, nose, midLeft, left], [1, nose, midRight, rear], [0, nose, right, midRight],
            [1, [0, 0, H * 0.25], [0, 0, -H * 0.2], keel]]);
        spar(nose, rear); spar(nose, left); spar(nose, right); spar(mix(nose, left, 0.55), mix(nose, right, 0.55));
        tow = keel; bridlePoints = [];
        tailPoint = (index, count) => count === 1 ? rear : count === 2 ? [left, right][index] :
            index * 2 < count - 1 ? mix(right, rear, index * 2 / (count - 1)) : mix(rear, left, index * 2 / (count - 1) - 1);
    } else if (shape === "rokkaku") {
        const shoulder = H * 0.22, nose = [0, 0, H / 2], tail = [0, 0, -H / 2], upper = [0, 0, H / 2 - shoulder], lower = [0, 0, -H / 2 + shoulder];
        const corner = (side, z) => [side * W / 2, tipRise, z];
        panels("Kite sail panels", [-1, 1].flatMap(side => {
            const first = side > 0 ? 0 : 1;
            return [[first, nose, upper, corner(side, upper[2])], [first + 1, upper, lower, corner(side, lower[2]), corner(side, upper[2])],
                [first, lower, tail, corner(side, lower[2])]];
        }));
        spar(nose, tail);
        for (const centre of [upper, lower]) for (const side of [-1, 1]) spar(centre, corner(side, centre[2]));
        tow = [0, -H * 0.42, H * 0.06];
        bridlePoints = [upper, lower].flatMap(centre => [-1, 1].map(side => mix(centre, corner(side, centre[2]), 0.5)));
        tailPoint = () => tail;
    } else if (shape === "sled") {
        const x = W * 0.26, arch = tipRise * 0.5, top = H / 2, bottom = -H / 2, flapBottom = bottom + H * 0.15;
        panels("Kite sail panels", [[0, [x, 0, top], [x, 0, bottom], [0, arch, bottom], [0, arch, top]],
            [0, [-x, 0, top], [0, arch, top], [0, arch, bottom], [-x, 0, bottom]],
            ...[-1, 1].map(side => [1, [side * x, 0, top], [side * W / 2, -W * 0.18, H * 0.1], [side * x, 0, flapBottom]])]);
        for (const side of [-1, 1]) spar([side * x, 0, top], [side * x, 0, bottom]);
        tow = [0, -W * 0.7, H * 0.15]; bridlePoints = [-1, 1].map(side => [side * W / 2, -W * 0.18, H * 0.1]);
        tailPoint = along([-x, 0, bottom], [x, 0, bottom]);
    } else if (shape === "box") {
        const half = W / 2, cell = H * 0.32, corners = [[half, 0], [0, half], [-half, 0], [0, -half]];
        const list = [];
        for (const [cellIndex, [front, back]] of [[H / 2, H / 2 - cell], [-H / 2 + cell, -H / 2]].entries())
            corners.forEach(([x, y], index) => {
                const [nextX, nextY] = corners[(index + 1) % 4];
                list.push([cellIndex + index, [x, y, front], [x, y, back], [nextX, nextY, back], [nextX, nextY, front]]);
            });
        panels("Kite sail panels", list);
        for (const [x, y] of corners) spar([x, y, H / 2], [x, y, -H / 2]);
        for (const z of [H / 2 - cell / 2, -H / 2 + cell / 2]) {spar([half, 0, z], [-half, 0, z]); spar([0, half, z], [0, -half, z]);}
        tow = [0, -half - H * 0.3, H * 0.2]; bridlePoints = [[0, -half, H / 2 - cell / 2], [0, -half, -H / 2 + cell / 2]];
        tailPoint = () => [0, -half, -H / 2];
    } else if (shape === "parafoil") {
        // A ram-air wing: an upper and a lower skin, open at the front, with the cells bulging between the ribs.
        const cells = p.cellCount, arc = rad(p.bow), radius = arc > 0.01 ? W / 2 / Math.sin(arc) : 0;
        const across = v => {                       // v from -1 to 1 across the span; the tips curve down
            const angle = v * arc;
            return radius ? [radius * Math.sin(angle), radius * (Math.cos(angle) - 1)] : [v * W / 2, 0];
        };
        const thickness = u => D * Math.pow(1 - u, 0.8) * (0.55 + 0.45 * Math.min(1, u / 0.25));
        const skin = side => (u, column) => {
            const v = column * 2 - 1, [x, y] = across(v), bulge = 1 + 0.18 * Math.abs(Math.sin(Math.PI * cells * column));
            return [x, y + (side > 0 ? 0.75 * bulge : -0.25) * thickness(u), H / 2 - u * H];
        };
        const cellOf = column => Math.min(cells - 1, Math.floor(column * cells));
        surface("Kite upper skin", skin(1), 12, cells * 6, cellOf);
        surface("Kite lower skin", skin(-1), 12, cells * 6, cellOf);
        const inlet = new THREE.MeshStandardMaterial({name: "Cell openings", color: "#1c2126", roughness: 0.9, side: THREE.DoubleSide});
        const strip = [], ribs = [];
        for (let column = 0; column < cells * 6; column++) {
            const a = column / (cells * 6), b = (column + 1) / (cells * 6);
            strip.push(...skin(1)(0, a), ...skin(-1)(0, a), ...skin(1)(0, b), ...skin(1)(0, b), ...skin(-1)(0, a), ...skin(-1)(0, b));
        }
        for (const column of [0, 1]) for (let row = 0; row < 12; row++) {
            const a = row / 12, b = (row + 1) / 12;
            ribs.push(...skin(1)(a, column), ...skin(-1)(a, column), ...skin(1)(b, column), ...skin(1)(b, column), ...skin(-1)(a, column), ...skin(-1)(b, column));
        }
        for (const [name, positions, partMaterial] of [["Cell openings", strip, inlet], ["Kite tip ribs", ribs, material(0)]]) {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3)); geometry.computeVertexNormals();
            mesh(name, geometry, partMaterial);
        }
        tow = [0, -W * 0.75, H * 0.2]; bridlePoints = [];
        for (let rib = 0; rib <= cells; rib += Math.max(1, Math.round(cells / 4)))
            for (const u of [0.12, 0.6]) bridlePoints.push(skin(-1)(u, rib / cells));
        tailPoint = (index, count) => skin(-1)(1, count > 1 ? 0.15 + 0.7 * index / (count - 1) : 0.5);
    } else if (shape === "octopus") {
        // A ram-air head: a wide dome with a blunt front, where the cells open to the wind, which
        // narrows to the rear rim where the tentacles attach. The underside is flatter than the top.
        const cells = 6, widest = 0.35;
        const girth = u => u < widest ? 1 - 0.3 * Math.pow((widest - u) / widest, 2) : 1 - 0.5 * Math.pow((u - widest) / (1 - widest), 1.6);
        const head = (u, column) => {
            const angle = column * Math.PI * 2, size = girth(u), x = Math.cos(angle), y = Math.sin(angle);
            const ribs = y > 0 ? 1 + 0.07 * Math.abs(Math.sin(Math.PI * cells * (x + 1) / 2)) : 0.55;     // the cells bulge between their ribs
            return [x * W / 2 * size, y * D / 2 * size * (1 - 0.35 * u) * ribs, H / 2 - u * H];
        };
        surface("Kite head", head, 24, 48, column => Math.floor(column * 8));
        const cap = (name, u, capMaterial) => {
            const positions = [], [, , z] = head(u, 0);
            for (let column = 0; column < 48; column++) positions.push(0, 0, z, ...head(u, column / 48), ...head(u, (column + 1) / 48));
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3)); geometry.computeVertexNormals();
            return mesh(name, geometry, capMaterial);
        };
        cap("Kite head rear", 1, material(0));
        // The open front: the pale lining of the cells, with a dark rib between each pair.
        const lining = new THREE.MeshStandardMaterial({name: "Cell openings", color: "#e9e9e4", roughness: 0.9, side: THREE.DoubleSide});
        cap("Cell openings", 0, lining);
        const front = girth(0);
        for (let rib = 1; rib < cells; rib++) {
            const x = (rib / cells * 2 - 1) * W / 2 * front, reach = Math.sqrt(Math.max(0, 1 - Math.pow(x / (W / 2 * front), 2)));
            rod("Cell rib", [x, -D / 2 * front * 0.55 * reach, H / 2 + sparRadius], [x, D / 2 * front * reach, H / 2 + sparRadius],
                Math.max(sparRadius * 2, W * 0.012), material(0));
        }
        if (p.eyes) {
            // Large eyes low on the sides, near the tentacles, so that they show from below.
            const white = new THREE.MeshStandardMaterial({name: "Kite eye", color: "#f4f4ee", roughness: 0.6});
            const rimMaterial = new THREE.MeshStandardMaterial({name: "Kite eye rim", color: p.accentColor, roughness: 0.6});
            const pupil = new THREE.MeshStandardMaterial({name: "Kite eye pupil", color: "#14161a", roughness: 0.6});
            for (const column of [0.94, 0.56]) {
                const centre = new THREE.Vector3(...head(0.66, column));
                const outward = new THREE.Vector3(centre.x / (W * W), centre.y / (D * D * 0.3), 0).normalize();
                for (const [name, size, lift, eyeMaterial] of [["Kite eye rim", 0.135, 0, rimMaterial], ["Kite eye", 0.112, 0.012, white], ["Kite eye pupil", 0.052, 0.028, pupil]]) {
                    const disc = mesh(name, new THREE.SphereGeometry(W * size, 20, 12), eyeMaterial);
                    disc.scale.z = 0.22;
                    disc.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), outward);
                    disc.position.copy(centre).addScaledVector(outward, W * lift);
                    if (name === "Kite eye pupil") disc.position.z -= W * 0.025;
                }
            }
        }
        tow = [0, -H * 0.85, H * 0.55];
        bridlePoints = [0.08, 0.4].flatMap(u => [0.58, 0.66, 0.75, 0.84, 0.92].map(column => head(u, column)));
        // The tentacles attach around the rim and lean away from the axis, so each one is apart from the others.
        const around = (index, count) => (index + 0.5) / count * Math.PI * 2;
        tailPoint = (index, count) => {
            const [x, y, z] = head(1, around(index, count) / (Math.PI * 2));
            return [x * 0.72, y * 0.72, z];
        };
        tailAim = (index, count) => [Math.sin(around(index, count)) * rad(p.tailSpread) / 2, -Math.cos(around(index, count)) * rad(p.tailSpread) / 2];
    } else {
        // Diamond: a spine and one cross spar.
        const cross = H / 2 - H * 0.27, nose = [0, 0, H / 2], tail = [0, 0, -H / 2], centre = [0, 0, cross];
        const left = [W / 2, tipRise, cross], right = [-W / 2, tipRise, cross];
        panels("Kite sail panels", [[0, nose, centre, left], [1, nose, right, centre], [1, centre, tail, left], [0, centre, right, tail]]);
        spar(nose, tail); spar(centre, left); spar(centre, right);
        tow = [0, -H * 0.32, cross - H * 0.05]; bridlePoints = [mix(nose, centre, 0.45), mix(centre, tail, 0.55)];
        tailPoint = (index, count) => [(count > 1 ? index / (count - 1) - 0.5 : 0) * p.tailWidth * 1.5 * (count - 1), 0, -H / 2];
    }

    if (p.bridle) for (const point of bridlePoints) rod("Bridle line", point, tow, lineRadius, lineMaterial);
    // Put the tow point on the origin.
    sail.position.copy(new THREE.Vector3(...tow).applyEuler(sail.rotation)).negate();

    // Tails are chains of short joints, so that a wave can run along them. They
    // are in the root frame: they stream downwind, not along the tilted sail.
    const waves = [], tube = p.tailStyle === "tube", joints = tube ? 24 : 14;
    const stepLength = p.tailLength / joints, sizeAt = fraction => p.tailWidth * (1 - (1 - p.tailTaper / 100) * Math.pow(fraction, tube ? 1.4 : 1));
    const jointGeometry = Array.from({length: joints}, (_, joint) => {
        const start = sizeAt(joint / joints), end = sizeAt((joint + 1) / joints);
        if (tube) {
            // Each tube overlaps the one before it, to hide the bend at the joint.
            const length = stepLength * 1.12;
            return new THREE.CylinderGeometry(start / 2, end / 2, length, 8, 1, true).rotateX(Math.PI / 2).translate(0, 0, length / 2 - stepLength);
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.Float32BufferAttribute([start / 2, 0, 0, -start / 2, 0, 0, end / 2, 0, -stepLength,
            end / 2, 0, -stepLength, -start / 2, 0, 0, -end / 2, 0, -stepLength], 3));
        geometry.computeVertexNormals(); return geometry;
    });
    const tipGeometry = tube ? new THREE.SphereGeometry(sizeAt(1) / 2, 8, 6) : null;
    // An octopus has a row of colored spots under each tentacle.
    const spots = shape === "octopus" && tube && p.eyes;
    const spotGeometry = spots ? new THREE.SphereGeometry(1, 10, 8) : null;
    const spotMaterial = spots ? new THREE.MeshStandardMaterial({name: "Kite spots", color: p.accentColor, roughness: 0.6}) : null;
    const waveLength = p.waveLength / 100 * p.tailLength;       // metres of tail for one wave
    const airPerCycle = waveLength / (p.waveSpeed / 100);         // metres of passing air for one cycle
    const swing = rad(p.tailMotion / 100 * 10) * 16 / joints;     // joint angle of the wave at the tip
    const droop = rad(p.tailDroop);
    sail.updateMatrix();
    for (let tail = 0; tail < p.tailCount; tail++) {
        const tailMaterial = tailMaterials[tail % tailMaterials.length];
        const [aimPitch, aimYaw] = tailAim(tail, p.tailCount);
        let parent = root;
        for (let joint = 0; joint < joints; joint++) {
            const link = new THREE.Group(); link.name = `Tail ${tail + 1} joint ${joint + 1}`;
            // The tail leaves the kite at the droop angle, and then sags by as much again along its length.
            const sag = joint === 0 ? droop : droop / (joints - 1), rest = [-sag, 0, 0];
            if (joint === 0) {
                link.position.copy(new THREE.Vector3(...tailPoint(tail, p.tailCount)).applyMatrix4(sail.matrix));
                link.scale.setScalar(1 - 0.18 * ((tail * 0.618) % 1));      // the tails differ in length
                rest[0] += aimPitch; rest[1] = aimYaw;
            } else {
                link.position.set(0, 0, -stepLength);
                if (!tube) rest[2] = 0.4;           // a ribbon twists, so it is never edge-on along its whole length
            }
            mesh("Kite tail", jointGeometry[joint], tailMaterial, link);
            if (tipGeometry && joint === joints - 1) mesh("Kite tail", tipGeometry, tailMaterial, link).position.z = -stepLength;
            if (spots && joint % 3 === 1 && joint < joints - 4) {
                const radius = sizeAt((joint + 0.5) / joints) / 2, spot = mesh("Kite spot", spotGeometry, spotMaterial, link);
                spot.scale.set(radius * 0.55, radius * 0.2, radius * 0.75); spot.position.set(0, -radius * 0.95, -stepLength / 2);
            }
            // A wave that travels to the tip and grows on the way. The slower terms
            // make each tail move in its own way. Terms are [axis, angle, lag, rate].
            const along = joint / joints, angle = swing * (0.25 + 1.25 * along * along);
            const lag = Math.PI * 2 * joint * stepLength / waveLength + tail * 2.4;
            link.userData.vehicleWave = {airPerCycle, rest, droop: sag,
                terms: [[0, angle, lag, 1], [1, angle * 0.8, lag + 1.3 + tail, 0.83],
                    [0, angle * 0.6, lag * 0.6 + tail * 1.7, 0.47], [1, angle * 0.6, lag * 0.5 + tail * 0.9, 0.39]]};
            link.rotation.set(...rest);
            parent.add(link); parent = link; waves.push(link);
        }
    }
    root.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(root);
    return {root, propellers: [], waves, bounds, stats: {size: bounds.getSize(new THREE.Vector3())}};
}
