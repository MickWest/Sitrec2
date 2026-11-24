import {ecefToGeodetic} from "../GeodesyMath";
import {meanSeaLevelOffsetFromGrid} from "../EGM96GeoidMath";
import {mercatorX, mercatorY} from "../WaterMaskMath";

// Positions retain their source precision. Matrices already combine each
// instance transform with the mesh's world transform. No live Three.js
// objects or buffers are needed by this calculation.
export async function projectInundationMesh(input, {rect, size, equatorRadius, polarRadius, geoid}, checkpoint) {
    const {positions, matrices} = input;
    const projected = [], lla = new Float64Array(3);
    for (const m of matrices) {
        const vertices = new Float32Array(positions.length);
        let minHeight = Infinity, maxHeight = -Infinity;
        for (let i = 0; i < positions.length; i += 3) {
            const x = positions[i], y = positions[i + 1], z = positions[i + 2];
            // Match Vector3.applyMatrix4's operation order, including w.
            const w = 1 / (m[3] * x + m[7] * y + m[11] * z + m[15]);
            const X = (m[0] * x + m[4] * y + m[8] * z + m[12]) * w;
            const Y = (m[1] * x + m[5] * y + m[9] * z + m[13]) * w;
            const Z = (m[2] * x + m[6] * y + m[10] * z + m[14]) * w;
            ecefToGeodetic(X, Y, Z, equatorRadius, polarRadius, lla);
            const lat = lla[0] * 180 / Math.PI, lon = lla[1] * 180 / Math.PI;
            let u = mercatorX(lon) - rect.u0;
            u -= Math.round(u - rect.du / 2);
            vertices[i] = u / rect.du * size - 0.5;
            vertices[i + 1] = (mercatorY(lat) - rect.v0) / rect.du * size - 0.5;
            const h = lla[2] - meanSeaLevelOffsetFromGrid(geoid, lat, lon);
            vertices[i + 2] = h;
            minHeight = Math.min(minHeight, h);
            maxHeight = Math.max(maxHeight, h);
            if (checkpoint && (i / 3) % 8192 === 8191) await checkpoint();
        }
        projected.push({vertices, minHeight, maxHeight});
        if (checkpoint) await checkpoint();
    }
    return projected;
}
