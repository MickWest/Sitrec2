import {BufferGeometry, Float32BufferAttribute, Group, Mesh, Vector3} from "three";
import {ECEFToLLAVD_radii, LLAToECEF} from "../LLA-ECEF-ENU";
import {meanSeaLevelOffset} from "../EGM96Geoid";
import {Globals} from "../Globals";
import * as LAYER from "../LayerMasks";
import {createSeaLevelMaterial} from "./SeaLevelMaterial";

// A continuous surface: depth testing against the actual land/building mesh
// determines the waterline. No DEM samples or present-day shoreline mask can
// remove triangles which a raised sea needs to flood.
// 200 m cells keep the diagonal's curvature sag below 2 mm on Earth. Local
// coordinates also avoid the ~0.5 m quantisation of float32 ECEF vertices.
const CELL_METERS = 200;

export function seaLevelPoint(lat, lon, levelMeters = 0) {
    return LLAToECEF(lat, lon, meanSeaLevelOffset(lat, lon) + levelMeters);
}

export function seaLevelPlane(cameraPosition, levelMeters) {
    const lla = ECEFToLLAVD_radii(cameraPosition);
    const point = seaLevelPoint(lla.x, lla.y, levelMeters);
    const normal = LLAToECEF(lla.x, lla.y, 1).sub(LLAToECEF(lla.x, lla.y, 0)).normalize();
    return {point, normal, altitude: meanSeaLevelOffset(lla.x, lla.y) + levelMeters, hits: 0};
}

export class SeaLevelGeometry extends BufferGeometry {
    constructor(lat, lon, widthMeters) {
        super();
        this.origin = seaLevelPoint(lat, lon);
        const up = LLAToECEF(lat, lon, 1).sub(LLAToECEF(lat, lon, 0)).normalize();
        const east = new Vector3(-Math.sin(lon * Math.PI / 180), Math.cos(lon * Math.PI / 180), 0);
        const north = new Vector3().crossVectors(up, east);
        const segments = Math.ceil(widthMeters / CELL_METERS);
        const stride = segments + 1;
        const count = stride * stride;
        this.basePositions = new Float64Array(count * 3);
        const positions = new Float32Array(count * 3);
        const normals = new Float32Array(count * 3);
        const sample = new Vector3();

        for (let j = 0; j <= segments; j++) {
            for (let i = 0; i <= segments; i++) {
                // Project a tangent grid onto the datum. This remains regular
                // at the poles and across the date line, unlike a lon/lat grid.
                sample.copy(this.origin)
                    .addScaledVector(east, (i / segments - 0.5) * widthMeters)
                    .addScaledVector(north, (j / segments - 0.5) * widthMeters);
                const lla = ECEFToLLAVD_radii(sample);
                const point = seaLevelPoint(lla.x, lla.y);
                const normal = LLAToECEF(lla.x, lla.y, 1).sub(LLAToECEF(lla.x, lla.y, 0)).normalize();
                const offset = (j * stride + i) * 3;
                point.sub(this.origin).toArray(this.basePositions, offset);
                point.toArray(positions, offset);
                normal.toArray(normals, offset);
            }
        }
        const indices = [];
        for (let j = 0; j < segments; j++) {
            for (let i = 0; i < segments; i++) {
                const a = j * stride + i, b = a + 1, c = a + stride, d = c + 1;
                indices.push(a, b, c, b, d, c);
            }
        }
        this.setAttribute("position", new Float32BufferAttribute(positions, 3));
        this.setAttribute("normal", new Float32BufferAttribute(normals, 3));
        this.setIndex(indices);
        this.levelMeters = NaN;
        this.setLevel(0);
    }

    setLevel(levelMeters) {
        if (levelMeters === this.levelMeters) return;
        this.levelMeters = levelMeters;
        const positions = this.attributes.position.array;
        const normals = this.attributes.normal.array;
        for (let i = 0; i < positions.length; i++) {
            positions[i] = this.basePositions[i] + normals[i] * levelMeters;
        }
        this.attributes.position.needsUpdate = true;
        this.computeBoundingSphere();
        this.computeBoundingBox();
    }
}

export class SeaLevelSurface extends Group {
    constructor() {
        super();
        this.name = "Sea Level";
        this.layers.mask = LAYER.MASK_MAIN | LAYER.MASK_LOOK;
        this.material = createSeaLevelMaterial();
        this.mesh = null;
        this.levelMeters = 0;
    }

    updateSurface(lat, lon, widthMeters, levelMeters) {
        const center = seaLevelPoint(lat, lon);
        const earthKey = `${Globals.equatorRadius}:${Globals.polarRadius}`;
        // Retain the same mesh during ordinary camera motion and slider drags.
        // A large move recentres coverage under the look camera.
        if (!this.mesh || this.widthMeters !== widthMeters || this.earthKey !== earthKey
            || this.mesh.position.distanceTo(center) > widthMeters / 4) {
            this.mesh?.geometry.dispose();
            if (this.mesh) this.remove(this.mesh);
            const geometry = new SeaLevelGeometry(lat, lon, widthMeters);
            this.mesh = new Mesh(geometry, this.material);
            this.mesh.position.copy(geometry.origin);
            this.mesh.layers.mask = this.layers.mask;
            this.add(this.mesh);
            this.widthMeters = widthMeters;
            this.earthKey = earthKey;
        }
        this.levelMeters = levelMeters;
        this.mesh.geometry.setLevel(levelMeters);
    }

    setTransparency(enabled, percent) {
        const amount = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 50;
        const opacity = enabled ? 1 - amount / 100 : 1;
        const transparent = opacity < 1;
        if (this.material.transparent !== transparent) {
            this.material.transparent = transparent;
            this.material.needsUpdate = true;
        }
        this.material.opacity = opacity;
        // Depth-test against above-water geometry, but let submerged objects
        // remain visible through the surface instead of occluding their draws.
        this.material.depthWrite = !transparent;
    }

    reflectionPlane(cameraPosition) {
        return seaLevelPlane(cameraPosition, this.levelMeters);
    }

    dispose() {
        this.mesh?.geometry.dispose();
        this.material.dispose();
        this.clear();
    }
}
