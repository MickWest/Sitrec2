import {Matrix4, Vector2, Vector3} from "three";

// Forward ray tables can also project geometry BEFORE rasterization. Unlike a
// colour/depth warp, this lets the depth buffer resolve newly visible terrain.
// This inverse is single-valued: folded fans continue to use screen-space mode.
export const rayGeometryUniforms = {
    uRayGeometry: {value: 0},
    uRayTable: {value: null},
    uRayAngles: {value: new Vector2()},
    uRayTableSize: {value: new Vector2()},
    uRayDistance: {value: 1},
    uRayObserverHeight: {value: 0},
    uRayZenithView: {value: new Vector3(0, 1, 0)},
};

function rowSample(table, row, distance) {
    const sampleDistance = Math.min(distance, table.distances[table.width - 1]);
    const p = Math.sqrt(Math.max(0, sampleDistance) / table.distances[table.width - 1]) * (table.width - 1);
    const x = Math.min(table.width - 2, Math.floor(p)), f = p - x;
    const i = 4 * (row * table.width + x);
    const stop = table.data[i + 2];
    let offset = table.data[i] * (1 - f) + table.data[i + 4] * f;
    if (stop > table.distances[x] && stop < table.distances[x + 1] && sampleDistance <= stop) {
        // The next stored Y is frozen at impact, NOT at that column's nominal
        // distance. Interpolate to the actual impact endpoint instead.
        const angle = table.minAngle + (table.maxAngle - table.minAngle) * row / (table.rows - 1);
        const hitOffset = (table.data[i + 7] - table.height) / stop - Math.tan(angle);
        const t = (sampleDistance - table.distances[x]) / (stop - table.distances[x]);
        offset = table.data[i] * (1 - t) + hitOffset * t;
    }
    return {offset, stop};
}

/** CPU twin of the geometry vertex projection. Angles/ranges are SI. */
export function projectRayEndpoint(table, distance, vertical, {extendRange = false} = {}) {
    if (!table || !(distance > 0) || (!extendRange && distance > table.distances[table.width - 1])
        || table.diagnostics?.foldedPairs > 0) return null;
    const step = (table.maxAngle - table.minAngle) / (table.rows - 1);
    const searchDistance = Math.min(distance, table.distances[table.width - 1]);
    const tangent = vertical / distance;
    const sample = row => {
        const ray = rowSample(table, row, distance);
        const angle = table.minAngle + step * row;
        return {...ray, angle, endpoint: Math.tan(angle) + ray.offset};
    };
    let lo = 0, hi = table.rows - 1;
    while (hi - lo > 1) {
        const mid = Math.floor((hi + lo) / 2), ray = sample(mid);
        if (ray.stop < searchDistance || ray.endpoint < tangent) lo = mid;
        else hi = mid;
    }
    const a = sample(lo), b = sample(hi);
    let apparent;
    if (b.stop < searchDistance) return null;
    if (a.stop < searchDistance) apparent = tangent - b.offset;
    else if (tangent < a.endpoint) apparent = tangent - a.offset;
    else if (tangent > b.endpoint) apparent = tangent - b.offset;
    else {
        const t = (tangent - a.endpoint) / Math.max(1e-12, b.endpoint - a.endpoint);
        apparent = Math.tan(a.angle) * (1 - t) + Math.tan(b.angle) * t;
    }
    return {angle: Math.atan(apparent), vertical: apparent * distance,
        reached: distance <= table.distances[table.width - 1]
            && a.stop >= distance && tangent >= a.endpoint && tangent <= b.endpoint};
}

export function projectRayRelative(ctx, relative, target = new Vector3()) {
    target.copy(relative);
    const vertical = relative.dot(ctx.zenith);
    const distance = Math.sqrt(Math.max(0, relative.lengthSq() - vertical * vertical));
    // Continue the terminal-column displacement for vertices outside the
    // supported domain. Fragment clipping removes that part of the triangle;
    // returning identity here would stretch triangles across the range edge.
    const result = projectRayEndpoint(ctx.rayTable, distance, vertical, {extendRange: true});
    if (result) target.addScaledVector(ctx.zenith, result.vertical - vertical);
    return target;
}

export function unprojectRayRelative(ctx, relative, target = new Vector3()) {
    target.copy(relative);
    const y = relative.dot(ctx.zenith), d = Math.sqrt(Math.max(0, relative.lengthSq() - y * y));
    const table = ctx.rayTable;
    if (!(d > 0) || table.diagnostics?.foldedPairs > 0) return target;
    const searchDistance = Math.min(d, table.distances[table.width - 1]);
    let first = 0, last = table.rows - 1;
    if (rowSample(table, last, d).stop < searchDistance) return target;
    while (first < last) {
        const mid = Math.floor((first + last) / 2);
        if (rowSample(table, mid, d).stop < searchDistance) first = mid + 1;
        else last = mid;
    }
    const angle = Math.atan2(y, d);
    const row = (angle - table.minAngle) / (table.maxAngle - table.minAngle) * (table.rows - 1);
    // Invert the same constant-offset continuations used by forward geometry,
    // including a value rounded just below the first surviving launch ray.
    if (row <= first || row >= table.rows - 1) {
        const boundary = row <= first ? first : table.rows - 1;
        return target.addScaledVector(ctx.zenith, d * rowSample(table, boundary, d).offset);
    }
    const lo = Math.min(table.rows - 2, Math.floor(row));
    const step = (table.maxAngle - table.minAngle) / (table.rows - 1);
    const aAngle = table.minAngle + lo * step, bAngle = aAngle + step;
    // Forward projection interpolates launch slopes, not launch angles.
    const f = Math.max(0, Math.min(1,
        (Math.tan(angle) - Math.tan(aAngle)) / (Math.tan(bAngle) - Math.tan(aAngle))));
    const a = rowSample(table, lo, d), b = rowSample(table, lo + 1, d);
    return target.addScaledVector(ctx.zenith, d * (a.offset * (1 - f) + b.offset * f));
}

const inverseCamera = new Matrix4();
export function setRayGeometryUniforms(camera, ctx) {
    const u = rayGeometryUniforms;
    u.uRayGeometry.value = ctx ? 1 : 0;
    if (!ctx) return;
    const table = ctx.rayTable;
    u.uRayTable.value = ctx.texture;
    u.uRayAngles.value.set(table.minAngle, table.maxAngle);
    u.uRayTableSize.value.set(table.width, table.rows);
    u.uRayDistance.value = table.distances[table.width - 1];
    u.uRayObserverHeight.value = table.height;
    inverseCamera.copy(camera.matrixWorld).invert();
    u.uRayZenithView.value.copy(ctx.zenith).transformDirection(inverseCamera);
}

/** Bounds all live ray offsets in the relevant distance columns. */
export function rayGeometryLiftBounds(table, near, far) {
    const maximum = table.distances[table.width - 1];
    if (near > maximum) return null;
    if (!table.liftBounds) {
        const bounds = table.liftBounds = new Float32Array(table.width * 2);
        for (let x = 0; x < table.width; x++) {
            let min = 0, max = 0;
            for (let row = 0; row < table.rows; row++) {
                const i = 4 * (row * table.width + x);
                const stop = table.data[i + 2];
                let offset = table.data[i];
                if (stop < table.distances[x]) {
                    if (x === 0 || stop <= table.distances[x - 1]) continue;
                    // Bound the live part of this final interval, including
                    // its corrected impact endpoint, not the frozen column.
                    const angle = table.minAngle + (table.maxAngle - table.minAngle) * row / (table.rows - 1);
                    offset = (table.data[i + 3] - table.height) / stop - Math.tan(angle);
                }
                min = Math.min(min, -offset); max = Math.max(max, -offset);
            }
            bounds[2 * x] = min; bounds[2 * x + 1] = max;
        }
    }
    const first = Math.max(0, Math.floor(Math.sqrt(Math.max(0, near) / maximum) * (table.width - 1)) - 1);
    const last = Math.min(table.width - 1, Math.ceil(Math.sqrt(Math.min(maximum, far) / maximum) * (table.width - 1)) + 1);
    let min = 0, max = 0;
    for (let x = first; x <= last; x++) {
        min = Math.min(min, table.liftBounds[2 * x]); max = Math.max(max, table.liftBounds[2 * x + 1]);
    }
    return {min: min * far, max: max * far};
}

// No hardware float filtering is required. Interpolate distance within ONE
// row; never blend a terminated ray with a live one before the inverse search.
export const RAY_GEOMETRY_GLSL = /* glsl */`
uniform float uRayGeometry, uRayDistance, uRayObserverHeight;
uniform sampler2D uRayTable;
uniform vec2 uRayAngles, uRayTableSize;
uniform vec3 uRayZenithView;
varying vec3 vRayGeometryPhysical;
vec2 sitrecRayRow(float row, float distance) {
    float x = sqrt(clamp(distance / uRayDistance, 0., 1.)) * (uRayTableSize.x - 1.);
    float left = min(floor(x), uRayTableSize.x - 2.);
    vec2 uv = (vec2(left, row) + 0.5) / uRayTableSize;
    vec4 a = texture2D(uRayTable, uv);
    vec4 b = texture2D(uRayTable, uv + vec2(1. / uRayTableSize.x, 0.));
    float offset = mix(a.r, b.r, x - left);
    float dx = uRayDistance / ((uRayTableSize.x - 1.) * (uRayTableSize.x - 1.));
    float d0 = left * left * dx, d1 = (left + 1.) * (left + 1.) * dx;
    float sampled = min(distance, uRayDistance);
    if (a.b > d0 && a.b < d1 && sampled <= a.b) {
        float angle = mix(uRayAngles.x, uRayAngles.y, row / (uRayTableSize.y - 1.));
        float hitOffset = (b.a - uRayObserverHeight) / a.b - tan(angle);
        offset = mix(a.r, hitOffset, (sampled - d0) / (a.b - d0));
    }
    return vec2(offset, a.b);
}
vec3 applyRayGeometry(vec3 position) {
    vRayGeometryPhysical = position;
    float y = dot(position, uRayZenithView);
    float distance = length(position - y * uRayZenithView);
    if (distance < 0.001) return position;
    float searchDistance = min(distance, uRayDistance);
    float tangent = y / distance;
    float stepAngle = (uRayAngles.y - uRayAngles.x) / (uRayTableSize.y - 1.);
    float lo = 0., hi = uRayTableSize.y - 1.;
    for (int i = 0; i < 12; i++) {
        if (hi - lo <= 1.) break;
        float mid = floor((lo + hi) * 0.5);
        vec2 ray = sitrecRayRow(mid, distance);
        float endpoint = tan(uRayAngles.x + stepAngle * mid) + ray.x;
        if (ray.y < searchDistance || endpoint < tangent) lo = mid;
        else hi = mid;
    }
    vec2 a = sitrecRayRow(lo, distance), b = sitrecRayRow(hi, distance);
    if (b.y < searchDistance) return position;
    float ta = tan(uRayAngles.x + stepAngle * lo), tb = tan(uRayAngles.x + stepAngle * hi);
    float ea = ta + a.x, eb = tb + b.x;
    float apparent = tangent - b.x;
    if (a.y >= searchDistance) {
        if (tangent < ea) apparent = tangent - a.x;
        else if (tangent > eb) apparent = tangent - b.x;
        else apparent = mix(ta, tb, clamp((tangent - ea) / max(1.e-12, eb - ea), 0., 1.));
    }
    // Below the surviving bracket, continue its displacement instead of
    // lifting all hidden terrain onto one artificial horizon. Nearer solid
    // geometry still resolves occlusion; this continuation is not a ray hit.
    return position + uRayZenithView * (distance * apparent - y);
}
`;

// Clip the physical horizontal domain after interpolation, so a triangle
// straddling the range boundary has no lifted/identity vertex discontinuity.
export function patchRayGeometryFragmentShader(source) {
    if (!source || source.includes("void sitrecClipRayRange")) return source;
    const declarations = /* glsl */`
uniform float uRayGeometry, uRayDistance;
uniform vec3 uRayZenithView;
varying vec3 vRayGeometryPhysical;
void sitrecClipRayRange() {
    if (uRayGeometry > 0.5) {
        vec3 horizontal = vRayGeometryPhysical - dot(vRayGeometryPhysical, uRayZenithView) * uRayZenithView;
        if (dot(horizontal, horizontal) > uRayDistance * uRayDistance) discard;
    }
}
`;
    const patched = source.replace(/void\s+main\s*\(\s*(?:void)?\s*\)\s*\{/, "$&\n sitrecClipRayRange();");
    return patched === source ? source : declarations + patched;
}
