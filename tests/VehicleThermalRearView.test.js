import {BackSide, DoubleSide, Vector3} from "three";
import {PRESETS} from "../tools/vehicles/vehicleParameters.js";
import {createVehicleRecipe} from "../tools/vehicles/recipe.js";
import {generateVehicle} from "../tools/vehicles/generator.js";
import {disposeVehicle} from "../tools/vehicles/vehicle.js";
import {withThermalVehicle} from "../tools/vehicles/thermalPreview.js";
import {inBandRadiance} from "../tools/thermal/radiometry.js";

// Calculated projected areas of an estimated separate-flow surrogate. The
// published A340-600 aircraft planning document establishes separate exhausts
// and external scale, not surveyed internal dimensions.
// Columns: 0° aft and 5° below the engine axis, m² per engine.
const referenceAreas = {
    turbofan_cavity: [.9293, .8393],
    turbofan_plug: [.5026, .5516],
    turbofan_core_nozzle: [.3592, .3933],
    turbofan_core_inner: [0, .0350],
    turbofan_fan_duct: [3.8920, 3.8423],
    turbofan_pylon_shield: [.0100, .0535],
};

function aircraft(id = "a340-600", changes = {}) {
    const preset = PRESETS.find(item => item.id === id);
    // Estimated climb reference, not an observed throttle setting.
    return generateVehicle(createVehicleRecipe({...preset.parameters,
        thermalAmbientK: 239.40, thermalMach: .82, thermalPower: .90, ...changes}, preset.name, id));
}

// Orthographic CPU depth buffer over actual transformed triangles. All visible
// aircraft meshes participate, including cold occluders. Each pixel contributes
// only its nearest surface, with the same material face culling as the renderer.
// No analytic nozzle-area formula or mesh metadata is used to assign coverage.
function projectedAreas(root, center, angleDeg, extent = 1.6, size = 1600, excludeCenters = []) {
    const angle = angleDeg * Math.PI / 180, sine = Math.sin(angle), cosine = Math.cos(angle);
    const step = 2 * extent / size, depth = new Float64Array(size * size).fill(-Infinity);
    const owner = new Int32Array(depth.length).fill(-1), meshes = [];
    const excluded = excludeCenters.map(origin => {
        const relative = origin.clone().sub(center);
        return [-relative.x, cosine * relative.y - sine * relative.z];
    });
    root.updateMatrixWorld(true);
    root.traverseVisible(mesh => {if (mesh.isMesh) meshes.push(mesh);});
    for (const [meshIndex, mesh] of meshes.entries()) {
        const position = mesh.geometry.attributes.position, index = mesh.geometry.index;
        const points = [], point = new Vector3();
        for (let vertex = 0; vertex < position.count; vertex++) {
            point.fromBufferAttribute(position, vertex).applyMatrix4(mesh.matrixWorld).sub(center);
            points.push([(-point.x + extent) / step,
                (cosine * point.y - sine * point.z + extent) / step,
                -sine * point.y - cosine * point.z]);
        }
        const count = index?.count ?? position.count;
        for (let triangle = 0; triangle < count; triangle += 3) {
            const [a, b, c] = [0, 1, 2].map(offset => points[index ? index.getX(triangle + offset) : triangle + offset]);
            const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
            const material = Array.isArray(mesh.material) ? mesh.material[
                mesh.geometry.groups.find(group => triangle >= group.start && triangle < group.start + group.count)?.materialIndex ?? 0] : mesh.material;
            if (!material.visible || Math.abs(area) < 1e-10 ||
                material.side !== DoubleSide && (material.side === BackSide ? area > 0 : area < 0)) continue;
            const minX = Math.max(0, Math.ceil(Math.min(a[0], b[0], c[0]) - .5));
            const maxX = Math.min(size - 1, Math.floor(Math.max(a[0], b[0], c[0]) - .5));
            const minY = Math.max(0, Math.ceil(Math.min(a[1], b[1], c[1]) - .5));
            const maxY = Math.min(size - 1, Math.floor(Math.max(a[1], b[1], c[1]) - .5));
            for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
                const u = ((b[0] - x - .5) * (c[1] - y - .5) - (b[1] - y - .5) * (c[0] - x - .5)) / area;
                const v = ((c[0] - x - .5) * (a[1] - y - .5) - (c[1] - y - .5) * (a[0] - x - .5)) / area;
                const w = 1 - u - v;
                if (u < 0 || v < 0 || w < 0) continue;
                const distance = u * a[2] + v * b[2] + w * c[2], pixel = y * size + x;
                if (distance > depth[pixel]) {depth[pixel] = distance; owner[pixel] = meshIndex;}
            }
        }
    }
    const areas = new Map();
    for (let pixel = 0; pixel < owner.length; pixel++) {
        const meshIndex = owner[pixel];
        if (meshIndex < 0) continue;
        const x = (pixel % size + .5) * step - extent, y = (Math.floor(pixel / size) + .5) * step - extent;
        if (excluded.some(([cx, cy]) => Math.abs(x - cx) < 1.6 && Math.abs(y - cy) < 1.6)) continue;
        areas.set(meshes[meshIndex], (areas.get(meshes[meshIndex]) ?? 0) + step * step);
    }
    return areas;
}

function zoneAreas(areas, engineIndex) {
    const zones = Object.fromEntries(Object.keys(referenceAreas).map(zone => [zone, 0]));
    for (const [mesh, area] of areas) if (mesh.userData.thermalEngineIndex === engineIndex && mesh.userData.thermal.zone in zones)
        zones[mesh.userData.thermal.zone] += area;
    return zones;
}

function surfaceIntensity(areas) {
    let intensityWsr = 0;
    for (const [mesh, area] of areas) {
        const {temperatureK, emissivity} = mesh.userData.thermal;
        intensityWsr += area * emissivity * inBandRadiance(temperatureK, {minUm: 3, maxUm: 5}).energy;
    }
    return intensityWsr;
}

test.each([0, 5])("A340-600 per-engine rear areas at %i degrees below axis", angleDeg => {
    const model = aircraft(), column = angleDeg === 0 ? 0 : 1;
    try {
        withThermalVehicle(model, () => {
            for (const anchor of model.thermalAnchors) {
                const center = anchor.cavity.getWorldPosition(new Vector3());
                // The reference table is per unobstructed engine. Keep nozzle,
                // plug and nacelle occlusion here; test installation below.
                const areas = projectedAreas(anchor.parent, center, angleDeg);
                const zones = zoneAreas(areas, anchor.engineIndex);
                for (const [zone, expected] of Object.entries(referenceAreas)) {
                    if (expected[column] === 0) expect(zones[zone]).toBe(0);
                    else if (Math.abs(zones[zone] / expected[column] - 1) >= .05)
                        throw new Error(`${zone}, engine ${anchor.engineIndex}: ${zones[zone]} m², expected ${expected[column]} m² ±5%`);
                }
                // Check sampling convergence on the same mesh, including the
                // small end shield and newly exposed inner wall.
                if (anchor.engineIndex === 0) {
                    const finer = zoneAreas(projectedAreas(anchor.parent, center, angleDeg, 1.6, 3200), anchor.engineIndex);
                    for (const [zone, expected] of Object.entries(referenceAreas)) {
                        if (expected[column] === 0) expect(finer[zone]).toBe(0);
                        // A zone under 0.1 m² is a thin strip seen at 5° (the pylon heat shield): its
                        // edge pixels make the area jitter by about ±1.5% between 1600, 3200 and 6400
                        // samples, without steady convergence. Larger zones converge to well under 1%.
                        else expect(Math.abs(zones[zone] - finer[zone]) / expected[column]).toBeLessThan(expected[column] < .1 ? .03 : .02);
                    }
                }
            }
        });
    } finally {disposeVehicle(model.root);}
}, 30000);

test.each([0, 5])("A340-600 installed rear intensity at %i degrees includes airframe occlusion", angleDeg => {
    const model = aircraft(), column = angleDeg === 0 ? 0 : 1;
    try {
        withThermalVehicle(model, () => {
            const centers = model.thermalAnchors.map(anchor => anchor.cavity.getWorldPosition(new Vector3()));
            // Fine engine tiles plus the rest of the aircraft at coarser resolution;
            // exclude the fine tiles from the latter so no region emits twice.
            let intensityWsr = surfaceIntensity(projectedAreas(model.root, new Vector3(), angleDeg, 40, 800, centers));
            for (const [index, center] of centers.entries()) {
                const areas = projectedAreas(model.root, center, angleDeg);
                const zones = zoneAreas(areas, index);
                // Check installed hot parts as well as the unobstructed table.
                // The procedural wing masks part of the cool fan annulus.
                for (const [zone, expected] of Object.entries(referenceAreas)) {
                    if (zone === "turbofan_fan_duct") continue;
                    if (expected[column] === 0) expect(zones[zone]).toBe(0);
                    else if (Math.abs(zones[zone] / expected[column] - 1) >= .05)
                        throw new Error(`${zone}, installed engine ${index}: ${zones[zone]} m², expected ${expected[column]} m² ±5%`);
                }
                intensityWsr += surfaceIntensity(areas);
            }
            // Calculated conditional totals, W/sr: these include local gas transfer
            // and a 15 W/sr airframe allowance. The reference engine surfaces
            // alone give 6.94/6.57 kW/sr; the generated airframe adds its own
            // resolved surface contribution. No additive plume is invented.
            // The small net gas correction is within this 10% surface-only check.
            const expectedWsr = [6788.95, 6695.79][column];
            expect(Math.abs(intensityWsr / expectedWsr - 1)).toBeLessThan(.10);
        });
    } finally {disposeVehicle(model.root);}
}, 30000);

test("other turbofans scale the same thermal layout with nacelle diameter", () => {
    const reference = aircraft(), smaller = aircraft("a340-300");
    try {
        const referenceParts = reference.thermalAnchors[0].parts, smallParts = smaller.thermalAnchors[0].parts;
        const scale = smaller.recipe.parameters.engineDiameter / reference.recipe.parameters.engineDiameter;
        expect(smallParts).toHaveLength(referenceParts.length);
        for (const [index, part] of smallParts.entries()) {
            const large = referenceParts[index], positions = part.geometry.attributes.position, other = large.geometry.attributes.position;
            expect(part.userData.thermal.zone).toBe(large.userData.thermal.zone);
            expect(part.userData.thermalGeometry.status).toBe("estimated");
            expect(part.visible).toBe(false);
            expect(positions.count).toBe(other.count);
            for (let offset = 0; offset < positions.array.length; offset++)
                expect(positions.array[offset]).toBeCloseTo(other.array[offset] * scale, 6);
        }
    } finally {disposeVehicle(reference.root); disposeVehicle(smaller.root);}
});
