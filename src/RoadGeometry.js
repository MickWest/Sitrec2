import {BufferAttribute, Matrix4, Vector3} from "three";

// A separate geometry lets disabling a road, deleting its track, and unloading a
// tile restore the exact source mesh. Tree edits can restore this layer first.
const edits = new WeakMap();
export function restoreRoadGeometry(mesh) {
    const edit = edits.get(mesh);
    if (!edit) return;
    if (mesh.geometry === edit.geometry) mesh.geometry = edit.original;
    edit.geometry.dispose();
    edits.delete(mesh);
}

export function originalRoadGeometry(mesh) {
    const edit = edits.get(mesh);
    return edit && mesh.geometry === edit.geometry ? edit.original : mesh.geometry;
}

export function hasRoadGeometry(mesh) {
    return edits.get(mesh)?.geometry === mesh.geometry;
}

export function smoothRoadGeometry(mesh, profiles, maxEdge = 2) {
    restoreRoadGeometry(mesh);
    const original = mesh.geometry;
    if (!original?.attributes.position || !profiles.length) return false;
    mesh.updateWorldMatrix(true, false);
    const vertices = [];
    const pos = original.attributes.position;
    const relevant = point => profiles.some(profile => {
        const hit = profile.at(point);
        return hit && hit.distance < profile.width && Math.abs(hit.z - hit.raw) < 6;
    });
    let touched = false;
    for (let i = 0; i < pos.count; i++) {
        const world = new Vector3().fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
        vertices.push(world);
        if (relevant(world)) touched = true;
    }
    const indices = original.index ? Array.from(original.index.array) : vertices.map((_, i) => i);
    // A narrow strip can cross a triangle without containing any of its vertices.
    if (!touched) {
        for (let i = 0; i < indices.length && !touched; i += 3) {
            const center = vertices[indices[i]].clone().add(vertices[indices[i + 1]]).add(vertices[indices[i + 2]]).multiplyScalar(1 / 3);
            touched = relevant(center);
        }
    }
    if (!touched) return false;

    const attributes = Object.fromEntries(Object.entries(original.attributes).map(([name, attribute]) => [name, {
        source: attribute,
        values: Array.from({length: attribute.count * attribute.itemSize}, (_, i) => {
            const vertex = Math.floor(i / attribute.itemSize), component = i % attribute.itemSize;
            return attribute.isInterleavedBufferAttribute
                ? attribute.data.array[vertex * attribute.data.stride + attribute.offset + component]
                : attribute.array[i];
        }),
    }]));
    const pointKey = p => `${p.x.toFixed(4)},${p.y.toFixed(4)},${p.z.toFixed(4)}`;
    const vertexKeys = vertices.map(pointKey);
    const addVertex = ids => {
        const index = vertices.length;
        const point = new Vector3();
        for (const id of ids) point.add(vertices[id]);
        vertices.push(point.multiplyScalar(1 / ids.length));
        vertexKeys.push(pointKey(point));
        for (const {source, values} of Object.values(attributes)) {
            for (let c = 0; c < source.itemSize; c++) {
                values.push(ids.reduce((sum, id) => sum + values[id * source.itemSize + c], 0) / ids.length);
            }
        }
        return index;
    };
    let triangles = [];
    for (let i = 0; i < indices.length; i += 3) {
        const group = original.groups.find(g => i >= g.start && i < g.start + g.count);
        triangles.push({ids: indices.slice(i, i + 3), material: group?.materialIndex ?? 0});
    }
    const edgeKey = (a, b) => a < b ? `${a},${b}` : `${b},${a}`;
    const geometricEdge = (a, b) => vertexKeys[a] < vertexKeys[b]
        ? `${vertexKeys[a]}/${vertexKeys[b]}` : `${vertexKeys[b]}/${vertexKeys[a]}`;
    // Shared edges are split once and used by BOTH adjoining faces. Interpolate
    // UVs and every other vertex attribute; never leave T-junctions in the strip.
    for (let pass = 0; pass < 6 && triangles.length < 200000; pass++) {
        const split = new Set();
        for (const {ids} of triangles) {
            const center = vertices[ids[0]].clone().add(vertices[ids[1]]).add(vertices[ids[2]]).multiplyScalar(1 / 3);
            if (!relevant(center) && !ids.some(i => relevant(vertices[i]))) continue;
            for (let j = 0; j < 3; j++) {
                const a = ids[j], b = ids[(j + 1) % 3];
                if (vertices[a].distanceToSquared(vertices[b]) > maxEdge ** 2) split.add(geometricEdge(a, b));
            }
        }
        if (!split.size) break;
        const next = [];
        const midpoints = new Map();
        for (const triangle of triangles) {
            const {ids, material} = triangle;
            const boundary = [];
            for (let j = 0; j < 3; j++) {
                boundary.push(ids[j]);
                const a = ids[j], b = ids[(j + 1) % 3];
                if (split.has(geometricEdge(a, b))) {
                    // Non-indexed meshes and UV seams duplicate positions. Split
                    // both sides, but keep their separate interpolated attributes.
                    const key = edgeKey(a, b);
                    if (!midpoints.has(key)) midpoints.set(key, addVertex([a, b]));
                    boundary.push(midpoints.get(key));
                }
            }
            if (boundary.length === 3) { next.push(triangle); continue; }
            const center = addVertex(ids);
            for (let j = 0; j < boundary.length; j++) next.push({ids: [boundary[j], boundary[(j + 1) % boundary.length], center], material});
        }
        triangles = next;
    }
    const inverse = new Matrix4().copy(mesh.matrixWorld).invert();
    for (let i = 0; i < vertices.length; i++) {
        const point = vertices[i];
        let chosen = null;
        for (const profile of profiles) {
            const hit = profile.at(point);
            if (!hit || hit.distance >= profile.width || Math.abs(hit.z - hit.raw) >= 6) continue;
            if (!chosen || hit.distance < chosen.hit.distance) chosen = {profile, hit};
        }
        if (chosen) {
            const {profile, hit} = chosen;
            const t = Math.max(0, Math.min(1, (profile.width - hit.distance) / (profile.width / 2)));
            const feather = t * t * (3 - 2 * t);
            point.addScaledVector(profile.up, (hit.height - hit.z) * feather);
        }
        point.applyMatrix4(inverse);
        const values = attributes.position.values;
        values[i * 3] = point.x; values[i * 3 + 1] = point.y; values[i * 3 + 2] = point.z;
    }
    const geometry = original.clone();
    for (const [name, {source, values}] of Object.entries(attributes)) {
        const ArrayType = (source.isInterleavedBufferAttribute ? source.data.array : source.array).constructor;
        geometry.setAttribute(name, new BufferAttribute(new ArrayType(values), source.itemSize, source.normalized));
    }
    geometry.setIndex(triangles.flatMap(t => t.ids));
    geometry.clearGroups();
    let start = 0;
    for (let i = 0; i < triangles.length; i++) {
        if (i === triangles.length - 1 || triangles[i + 1].material !== triangles[i].material) {
            geometry.addGroup(start * 3, (i + 1 - start) * 3, triangles[i].material);
            start = i + 1;
        }
    }
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    mesh.geometry = geometry;
    edits.set(mesh, {original, geometry});
    return true;
}
