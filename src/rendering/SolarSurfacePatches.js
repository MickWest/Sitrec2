import {BufferAttribute, BufferGeometry, Group, Matrix3, Mesh, Vector3} from "three";
import {surfaceHeatingFlux, surfaceTemperatureForFlux} from "../../tools/thermal/solarSurface.js";

// Refines an owned thermal copy of the triangles; retains visible materials. At most 33 thermal draws:
// one exact zero-flux band plus 32 equally spaced combined-heat-flux bands.
// Area-weighted mean heat in each band preserves total supplied surface power.
// Preserve the source's planar surface while resolving body-axis heat gradients.
// The cap is explicit: never silently return an under-resolved thermal mesh.
export function refineAxialThermalGeometry(source, {maxAxialSpanFraction = .1, maxTriangles = 32768} = {}) {
    if (!(maxAxialSpanFraction > 0) || !Number.isInteger(maxTriangles) || maxTriangles < 1)
        throw new RangeError("Invalid thermal refinement bounds");
    const attributes = Object.entries(source.attributes);
    const position = source.attributes.position;
    let minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < position.count; i++) {
        minZ = Math.min(minZ, position.getZ(i)); maxZ = Math.max(maxZ, position.getZ(i));
    }
    const spanLimit = (maxZ - minZ) / 2 * maxAxialSpanFraction;
    const index = source.index, count = index?.count ?? position.count;
    let triangleCount = count / 3;
    if (triangleCount > maxTriangles) throw new RangeError("Thermal refinement triangle cap exceeded");
    const output = Object.fromEntries(attributes.map(([name]) => [name, []]));
    const vertex = id => Object.fromEntries(attributes.map(([name, attr]) => [name,
        Array.from({length: attr.itemSize}, (_, c) => attr.getComponent(id, c))]));
    const midpoint = (a, b) => {
        const result = Object.fromEntries(attributes.map(([name]) => [name, a[name].map((v, c) => (v + b[name][c]) / 2)]));
        if (result.normal) {
            const length = Math.hypot(...result.normal);
            if (length > 0) result.normal = result.normal.map(v => v / length);
        }
        return result;
    };
    for (let i = 0; i < count; i += 3) {
        const pending = [[0, 1, 2].map(j => vertex(index ? index.getX(i + j) : i + j))];
        while (pending.length) {
            const triangle = pending.pop();
            const spans = triangle.map((v, j) => Math.abs(v.position[2] - triangle[(j + 1) % 3].position[2]));
            const largest = Math.max(...spans);
            if (largest > spanLimit * (1 + 1e-12)) {
                if (++triangleCount > maxTriangles) throw new RangeError("Thermal refinement triangle cap exceeded");
                const edge = spans.indexOf(largest);
                const a = triangle[edge], b = triangle[(edge + 1) % 3], c = triangle[(edge + 2) % 3];
                const mid = midpoint(a, b);
                pending.push([a, mid, c], [mid, b, c]);
            } else {
                for (const v of triangle) for (const [name] of attributes) output[name].push(...v[name]);
            }
        }
    }
    const geometry = new BufferGeometry();
    for (const [name, attr] of attributes)
        geometry.setAttribute(name, new BufferAttribute(new Float32Array(output[name]), attr.itemSize));
    geometry.computeBoundingBox();
    return geometry;
}

export class SolarSurfacePatches {
    constructor(source) {
        this.source = source;
        this.geometry = refineAxialThermalGeometry(source.geometry);
        this.group = new Group();
        this.group.name = "Estimated solar surface";
        this.group.visible = false;
        this.bands = [];
        for (let i = 0; i <= 32; i++) {
            const geometry = new BufferGeometry();
            for (const [name, attribute] of Object.entries(this.geometry.attributes)) geometry.setAttribute(name, attribute);
            geometry.setIndex(new BufferAttribute(new Uint32Array(this.geometry.attributes.position.count), 1));
            const mesh = new Mesh(geometry, source.material);
            mesh.userData.solarSurfacePatch = true;
            mesh.layers.mask = source.layers.mask;
            this.group.add(mesh);
            this.bands.push(mesh);
        }
        source.parent.add(this.group);
    }
    update(settings, sunWorld, sunVisible) {
        const source = this.source;
        source.updateWorldMatrix(true, false);
        this.group.position.copy(source.position);
        this.group.quaternion.copy(source.quaternion);
        this.group.scale.copy(source.scale);
        const normalMatrix = new Matrix3().getNormalMatrix(source.matrixWorld);
        const volumeScale = Math.abs(new Matrix3().setFromMatrix4(source.matrixWorld).determinant());
        const p = this.geometry.attributes.position, index = this.geometry.index;
        const bounds = this.geometry.boundingBox, midZ = (bounds.min.z + bounds.max.z) / 2;
        const halfLength = (bounds.max.z - bounds.min.z) / 2;
        const maxFlux = settings.solarAbsorptivity * settings.solarIrradianceWm2 + (settings.internalHeatFluxWm2 ?? 0);
        const lists = Array.from({length: 33}, () => []);
        const areas = new Float64Array(33), powers = new Float64Array(33);
        const a = new Vector3(), b = new Vector3(), c = new Vector3();
        for (let i = 0; i < (index?.count ?? p.count); i += 3) {
            const ids = [0, 1, 2].map(j => index ? index.getX(i + j) : i + j);
            a.fromBufferAttribute(p, ids[0]); b.fromBufferAttribute(p, ids[1]); c.fromBufferAttribute(p, ids[2]);
            const axial = halfLength > 0 ? ((a.z + b.z + c.z) / 3 - midZ) / halfLength : 0;
            const n = b.sub(a).cross(c.sub(a)).applyMatrix3(normalMatrix);
            const area = n.length() * volumeScale / 2;
            n.normalize();
            const cosine = sunVisible ? Math.max(0, Math.min(1, n.dot(sunWorld))) : 0;
            const flux = surfaceHeatingFlux(settings, cosine, axial);
            const band = flux > 0 ? Math.min(32, 1 + Math.floor(flux / maxFlux * 32)) : 0;
            lists[band].push(...ids);
            areas[band] += area;
            powers[band] += area * flux;
        }
        this.bands.forEach((mesh, i) => {
            mesh.geometry.index.array.set(lists[i]);
            mesh.geometry.index.needsUpdate = true;
            mesh.geometry.setDrawRange(0, lists[i].length);
            mesh.visible = lists[i].length > 0;
            mesh.layers.mask = source.layers.mask;
            mesh.material = source.material;
            mesh.userData.thermal = {temperatureK: surfaceTemperatureForFlux(settings, areas[i] > 0 ? powers[i] / areas[i] : 0),
                emissivity: settings.emissivityMWIR};
        });
        this.heatingReport = {areaM2: areas.reduce((a,b) => a+b, 0), suppliedPowerW: powers.reduce((a,b) => a+b, 0),
            triangleCount: p.count / 3, maxAxialSpanFraction: .1, bandAreaM2: Array.from(areas), bandPowerW: Array.from(powers)};
        this.group.updateMatrixWorld(true);
    }
    show() { this.wasVisible = this.source.visible; this.source.visible = false; this.group.visible = this.wasVisible; }
    hide() { if (this.wasVisible !== undefined) this.source.visible = this.wasVisible; this.wasVisible = undefined; this.group.visible = false; }
    dispose() {
        this.hide();
        this.group.removeFromParent();
        this.bands.forEach(mesh => mesh.geometry.dispose());
        this.geometry.dispose();
        // Only the material belongs to the original mesh.
    }
}
