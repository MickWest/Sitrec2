import {InstancedInterleavedBuffer, InterleavedBufferAttribute} from "three";
import {LineGeometry as ThreeLineGeometry} from "three/addons/lines/LineGeometry.js";

// Adjacent capsules share a round join. Give each fragment to the closest
// segment so alpha coverage is applied once, even on densely sampled tracks.
export function updateLineJoins(geometry) {
    const start = geometry.attributes.instanceStart;
    const end = geometry.attributes.instanceEnd;
    const count = Math.min(geometry.instanceCount, start.count);
    const touches = (a, b) => start.getX(a) === end.getX(b)
        && start.getY(a) === end.getY(b) && start.getZ(a) === end.getZ(b);
    let hasJoins = false;
    for (let i = 0; i < count; i++) {
        if (count > 1 && touches(i, (i + count - 1) % count)) { hasJoins = true; break; }
    }
    if (!hasJoins) {
        // Keep an existing buffer for dynamic geometry, but disable its joins.
        const data = geometry.attributes.instanceLinePrevious?.data;
        if (data) { data.array.fill(0); data.needsUpdate = true; }
        return;
    }
    let data = geometry.attributes.instanceLinePrevious?.data;
    if (!data || data.count < count) {
        geometry.dispose();
        data = new InstancedInterleavedBuffer(new Float32Array(start.count * 8), 8, 1);
        data.setUsage(start.data.usage);
        geometry.setAttribute("instanceLinePrevious", new InterleavedBufferAttribute(data, 4, 0));
        geometry.setAttribute("instanceLineNext", new InterleavedBufferAttribute(data, 4, 4));
    }
    for (let i = 0; i < count; i++) {
        const previous = (i + count - 1) % count;
        const next = (i + 1) % count;
        const offset = i * 8;
        data.array[offset] = start.getX(previous);
        data.array[offset + 1] = start.getY(previous);
        data.array[offset + 2] = start.getZ(previous);
        data.array[offset + 3] = touches(i, previous) ? 1 : 0;
        data.array[offset + 4] = end.getX(next);
        data.array[offset + 5] = end.getY(next);
        data.array[offset + 6] = end.getZ(next);
        data.array[offset + 7] = touches(next, i) ? 1 : 0;
    }
    data.clearUpdateRanges();
    data.addUpdateRange(0, count * 8);
    data.needsUpdate = true;
}

export class LineGeometry extends ThreeLineGeometry {
    setPositions(positions) {
        if (this.attributes.instanceStart) this.dispose();
        super.setPositions(positions);
        updateLineJoins(this);
        return this;
    }
}
