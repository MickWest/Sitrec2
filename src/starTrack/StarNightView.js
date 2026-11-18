import {Vector3} from "three";
import {getEQJToECEFMatrix, getGeocentricBodyPositionECEF} from "../CelestialMath";

// Maximize the lowest field altitude while keeping the Sun below astronomical
// twilight. These are viewing coordinates, never an estimate of the photo's origin.
export function findNightView(directions, date, allowDateChange = false) {
    if (!directions.length || !Number.isFinite(date?.getTime())) return null;
    const nightDot = Math.sin(-18 * Math.PI / 180);
    const centre = directions.reduce((sum, d) => sum.add(d), new Vector3()).normalize();
    let best = null;
    const offsets = [0];
    if (allowDateChange) for (let day = 1; day <= 183; day++) offsets.push(day, -day);
    for (const offset of offsets) {
        const candidateDate = new Date(date.getTime() + offset * 86400000);
        const matrix = getEQJToECEFMatrix(candidateDate);
        const field = directions.map(d => d.clone().transformDirection(matrix));
        const target = centre.clone().transformDirection(matrix);
        const sun = getGeocentricBodyPositionECEF("Sun", candidateDate).normalize();
        const tangent = target.clone().addScaledVector(sun, -target.dot(sun));
        if (tangent.lengthSq() < 1e-12) tangent.set(0, 0, 1).cross(sun);
        tangent.normalize();
        const side = new Vector3().crossVectors(sun, tangent).normalize();
        const candidates = [sun.clone().negate()];
        if (target.dot(sun) <= nightDot) candidates.push(target);
        // Sample the night hemisphere. The boundary is included because it is
        // the optimal place when the field is close to the Sun.
        for (let altitude = 18; altitude < 90; altitude += 6) {
            const a = altitude * Math.PI / 180;
            for (let bearing = 0; bearing < 360; bearing += 5) {
                const b = bearing * Math.PI / 180;
                candidates.push(sun.clone().multiplyScalar(-Math.sin(a))
                    .addScaledVector(tangent, Math.cos(a) * Math.cos(b))
                    .addScaledVector(side, Math.cos(a) * Math.sin(b)));
            }
        }
        for (const up of candidates) {
            const minimum = Math.min(...field.map(d => d.dot(up)));
            if (!best || minimum > best.minimum) {
                best = {date: candidateDate, minimum, latitude: Math.asin(up.z) * 180 / Math.PI,
                    longitude: Math.atan2(up.y, up.x) * 180 / Math.PI,
                    minAltitude: Math.asin(minimum) * 180 / Math.PI,
                    sunAltitude: Math.asin(sun.dot(up)) * 180 / Math.PI};
            }
        }
        // Prefer the original date, then the nearest date offering a clear field.
        if (best?.minAltitude >= 15) return best;
    }
    return best;
}
