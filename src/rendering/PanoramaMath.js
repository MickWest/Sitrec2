import {Frustum, Matrix4, PerspectiveCamera, Quaternion, Vector3} from "three";

const RAD = Math.PI / 180;
const direction = new Vector3();

// Equal pixels per degree on both axes. Fill the pane until the vertical span
// reaches both poles, then reduce the image height instead of stretching it.
export function panoramaFrame(hfov, width, height) {
    if (!(width > 0 && height > 0)) { width = 16; height = 9; }
    const aspect = Math.max(width / height, hfov / 180);
    return {width, height: width / aspect, vfov: hfov / aspect};
}

// Longitude and latitude are measured in the camera's frame. Unlike a
// cylindrical tangent mapping this remains finite at a vertical FOV of 180°.
export function panoramaDirection(x, y, hfov, vfov, target = new Vector3()) {
    const lon = x * hfov * RAD / 2;
    const lat = y * vfov * RAD / 2;
    return target.set(Math.sin(lon) * Math.cos(lat), Math.sin(lat), -Math.cos(lon) * Math.cos(lat));
}

export function panoramaProject(v, hfov, vfov) {
    const distance = v.length();
    const lon = Math.atan2(v.x, -v.z);
    const lat = Math.atan2(v.y, Math.hypot(v.x, v.z));
    return v.set(lon / (hfov * RAD / 2), lat / (vfov * RAD / 2), distance);
}

// A spherical cap's latitude and longitude bounds. This includes volumes
// crossing the rear seam and the poles, without admitting the whole sphere
// just because a panorama is wider than 180°.
export function panoramaIntersectsSphere(sphere, camera, hfov, vfov, margin = 1) {
    direction.copy(sphere.center).applyMatrix4(camera.matrixWorldInverse);
    const distance = direction.length();
    if (distance - sphere.radius > camera.far || distance + sphere.radius < camera.near) return false;
    if (distance <= sphere.radius) return true;
    const radius = Math.asin(Math.min(1, sphere.radius / distance));
    const lat = Math.atan2(direction.y, Math.hypot(direction.x, direction.z));
    if (Math.abs(lat) - radius > Math.min(Math.PI / 2, vfov * RAD / 2 * margin)) return false;
    if (hfov * margin >= 360 || Math.abs(lat) + radius >= Math.PI / 2) return true;
    const lonRadius = Math.asin(Math.min(1, Math.sin(radius) / Math.cos(lat)));
    return Math.abs(Math.atan2(direction.x, -direction.z)) - lonRadius <= hfov * RAD / 2 * margin;
}

// Actual output pixels per radian, not the old pinhole FOV or a full-sized
// viewport for every capture face. Longitude stretches near the poles; cap
// that singularity at one output pixel's angular extent.
export function panoramaPixelsPerRadian(sphere, camera, width, height, hfov, vfov) {
    direction.copy(sphere.center).applyMatrix4(camera.matrixWorldInverse);
    const cosLat = Math.hypot(direction.x, direction.z) / Math.max(direction.length(), 1e-9);
    return Math.max(width / (hfov * RAD * Math.max(cosLat, 1 / Math.max(width, 1))), height / (vfov * RAD));
}

// Capture only the cube-face rectangles touched by the angular window.
// The output shader selects faces by direction, so edges share an identical
// ray and even coarse triangles can never span the panorama's rear seam.
export function panoramaFaces(hfov, vfov) {
    const h = hfov * RAD / 2;
    const v = vfov * RAD / 2;
    const faces = [];
    const add = (forward, up, bounds) => {
        const right = new Vector3().crossVectors(forward, up);
        const rotation = new Matrix4().makeBasis(right, up, forward.clone().negate());
        faces.push({forward, up, right, quaternion: new Quaternion().setFromRotationMatrix(rotation), bounds});
    };
    for (const angle of [0, Math.PI / 2, -Math.PI / 2, Math.PI]) {
        let lo = Infinity, hi = -Infinity;
        for (const wrap of [-2 * Math.PI, 0, 2 * Math.PI]) {
            const a = Math.max(-h, angle + wrap - Math.PI / 4) - angle - wrap;
            const b = Math.min(h, angle + wrap + Math.PI / 4) - angle - wrap;
            if (b > a + 1e-10) { lo = Math.min(lo, a); hi = Math.max(hi, b); }
        }
        if (lo > hi) continue;
        const y = Math.min(1, Math.tan(v) / Math.cos(Math.max(Math.abs(lo), Math.abs(hi))));
        add(new Vector3(Math.sin(angle), 0, -Math.cos(angle)), new Vector3(0, 1, 0),
            [Math.tan(lo), Math.tan(hi), -y, y]);
    }
    // On the polar faces a latitude is a circle and a longitude is a radial
    // line. Extrema occur on the square's axes/corners, the angular edges,
    // or where the limiting latitude circle meets a square edge.
    const radius = 1 / Math.tan(v);
    const angles = [-h, h];
    const edge = Math.acos(Math.min(1, Math.tan(v)));
    for (let i = -4; i <= 4; i++) {
        angles.push(i * Math.PI / 4, i * Math.PI / 2 - edge, i * Math.PI / 2 + edge);
    }
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const a of angles) {
        if (a < -h - 1e-10 || a > h + 1e-10) continue;
        const outer = 1 / Math.max(Math.abs(Math.sin(a)), Math.abs(Math.cos(a)));
        if (radius > outer + 1e-10) continue;
        for (const r of [radius, outer]) {
            const x = r * Math.sin(a), y = -r * Math.cos(a);
            x0 = Math.min(x0, x); x1 = Math.max(x1, x);
            y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        }
    }
    if (x1 - x0 > 1e-10 && y1 - y0 > 1e-10) {
        add(new Vector3(0, 1, 0), new Vector3(0, 0, 1), [x0, x1, y0, y1]);
        add(new Vector3(0, -1, 0), new Vector3(0, 0, -1), [x0, x1, -y1, -y0]);
    }
    return faces;
}

export function panoramaFaceCamera(face, camera, target = new PerspectiveCamera()) {
    target.position.copy(camera.position);
    target.quaternion.copy(camera.quaternion).multiply(face.quaternion);
    target.layers.mask = camera.layers.mask;
    target.near = camera.near;
    target.far = camera.far;
    const [left, right, bottom, top] = face.bounds;
    // Keep fov/aspect consistent with the cropped projection for point sizes,
    // atmosphere and water reflections, including off-centre polar crops.
    target.fov = 2 * Math.atan((top - bottom) / 2) / RAD;
    target.aspect = (right - left) / (top - bottom);
    target.zoom = 1;
    target.view = {enabled: true, fullWidth: right - left, fullHeight: top - bottom,
        offsetX: (left + right) / 2, offsetY: -(bottom + top) / 2,
        width: right - left, height: top - bottom};
    target.updateProjectionMatrix();
    target.projectionMatrix.makePerspective(left * target.near, right * target.near,
        top * target.near, bottom * target.near, target.near, target.far);
    target.projectionMatrixInverse.copy(target.projectionMatrix).invert();
    target.updateMatrixWorld(true);
    return target;
}

export function panoramaFrusta(camera, hfov, vfov, localToWorld = new Matrix4()) {
    return panoramaFaces(hfov, vfov).map(face => {
        const capture = panoramaFaceCamera(face, camera);
        const projection = new Matrix4().multiplyMatrices(capture.projectionMatrix, capture.matrixWorldInverse).multiply(localToWorld);
        const frustum = new Frustum().setFromProjectionMatrix(projection);
        const inverse = projection.clone().invert();
        frustum.points = [];
        for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
            frustum.points.push(new Vector3(x, y, z).applyMatrix4(inverse));
        }
        return frustum;
    });
}
