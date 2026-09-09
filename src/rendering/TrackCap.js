import {ShapeUtils, Vector2, Vector3} from "three";

// Ear clipping in a local tangent plane handles concave geographic footprints.
// Keep source indices, including for a closed ring with a repeated endpoint.
export function triangulateTrackCap(points, up) {
    if (points.length < 3) return [];
    const origin = points[0];
    const normal = up.clone().normalize();
    const east = new Vector3().crossVectors(Math.abs(normal.y) < .9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0), normal).normalize();
    const north = new Vector3().crossVectors(normal, east);
    const delta = new Vector3();
    const contour = [], indices = [];
    points.forEach((point, index) => {
        delta.copy(point).sub(origin);
        const projected = new Vector2(delta.dot(east), delta.dot(north));
        if (!contour.length || projected.distanceToSquared(contour.at(-1)) > 1e-10) {
            contour.push(projected); indices.push(index);
        }
    });
    if (contour.length > 1 && contour[0].distanceToSquared(contour.at(-1)) < 1e-10) {
        contour.pop(); indices.pop();
    }
    return ShapeUtils.triangulateShape(contour, []).map(triangle => triangle.map(i => indices[i]));
}
