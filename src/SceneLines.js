import {Box3, BufferGeometry, Sphere, Vector3} from "three";
import {LineSegments2} from "three/addons/lines/LineSegments2.js";
import {LineSegmentsGeometry} from "three/addons/lines/LineSegmentsGeometry.js";
import {SceneLineMaterial} from "./SceneLineMaterial";
import {updateLineJoins} from "./SceneLineGeometry";

// Adapt ordinary line buffers, including indexed and dynamic ones, to the
// shared screen-space stroke. Call syncGeometry after editing sourceGeometry.
// Capacity is retained across updates rather than allocating GPU buffers on
// every mouse move, aircraft poll, or simulation frame.
export class SceneLineSegments extends LineSegments2 {
    constructor(source = new BufferGeometry(), material = new SceneLineMaterial(), topology = "segments") {
        super(new LineSegmentsGeometry(), material);
        this.sourceGeometry = source;
        this.topology = topology;
        this.syncGeometry();
    }

    copy(source, recursive) {
        super.copy(source, recursive);
        this.sourceGeometry = source.sourceGeometry;
        this.topology = source.topology;
        return this;
    }

    syncGeometry() {
        const source = this.sourceGeometry;
        const position = source.getAttribute("position");
        const color = source.getAttribute("color");
        const index = source.index;
        const start = source.drawRange.start;
        const vertices = Math.max(0, Math.min(index?.count ?? position?.count ?? 0, start + source.drawRange.count) - start);
        const count = this.topology === "segments" ? Math.floor(vertices / 2)
            : vertices < 2 ? 0 : this.topology === "loop" ? vertices : vertices - 1;
        const geometry = this.geometry;
        let positions = geometry.getAttribute("instanceStart")?.data;
        let colors = geometry.getAttribute("instanceColorStart")?.data;
        if (!positions || positions.count < count || (color && !colors)) {
            // Release the old buffers before replacing attributes on growth.
            geometry.dispose();
            const capacity = Math.max(count, positions?.count * 2 || 1);
            geometry.setPositions(new Float32Array(capacity * 6));
            if (color) geometry.setColors(new Float32Array(capacity * 6));
            positions = geometry.getAttribute("instanceStart").data;
            colors = geometry.getAttribute("instanceColorStart")?.data;
            if (position) positions.setUsage(position.usage);
            if (color) colors.setUsage(color.usage);
        }
        const bounds = geometry.boundingBox ??= new Box3();
        bounds.makeEmpty();
        const point = new Vector3();
        const vertex = i => index ? index.getX(start + i) : start + i;
        for (let i = 0; i < count; i++) {
            const a = vertex(this.topology === "segments" ? 2 * i : i);
            const b = vertex(this.topology === "segments" ? 2 * i + 1 : (i + 1) % vertices);
            for (let axis = 0; axis < 3; axis++) {
                positions.array[i * 6 + axis] = position.getComponent(a, axis);
                positions.array[i * 6 + 3 + axis] = position.getComponent(b, axis);
                if (color) {
                    colors.array[i * 6 + axis] = color.getComponent(a, axis);
                    colors.array[i * 6 + 3 + axis] = color.getComponent(b, axis);
                }
            }
            bounds.expandByPoint(point.fromArray(positions.array, i * 6));
            bounds.expandByPoint(point.fromArray(positions.array, i * 6 + 3));
        }
        positions.clearUpdateRanges();
        positions.addUpdateRange(0, count * 6);
        positions.needsUpdate = true;
        if (color) {
            colors.clearUpdateRanges();
            colors.addUpdateRange(0, count * 6);
            colors.needsUpdate = true;
        }
        geometry.instanceCount = count;
        updateLineJoins(geometry);
        // Unused capacity must not drag the bounds back to the world origin.
        const sphere = geometry.boundingSphere ??= new Sphere();
        bounds.getBoundingSphere(sphere);
        if (count === 0) sphere.set(point.set(0, 0, 0), 0);
        return this;
    }
}

export class SceneLine extends SceneLineSegments {
    constructor(source, material) { super(source, material, "strip"); }
}

export class SceneLineLoop extends SceneLineSegments {
    constructor(source, material) { super(source, material, "loop"); }
}
