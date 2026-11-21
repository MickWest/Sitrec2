import {Vector3} from 'three';
import {getEQJToECEFMatrix, getGeocentricBodyPositionECEF} from '../CelestialMath';
import {findNightView} from './StarNightView';

const DEG = Math.PI / 180;
const DAY = 86400000;
// Search regions, not default observer coordinates. The coarse mainland outlines
// keep the regional search near land; a finer search then improves the winning pose.
const REGIONS = [
    {name: 'United States', polygons: [
        [[-124, 42], [-124, 48], [-117, 49], [-95, 49], [-89, 47], [-83, 45], [-82, 42],
            [-70, 45], [-68, 45], [-71, 41], [-75, 39], [-81, 25], [-82, 25], [-85, 30],
            [-97, 26], [-104, 29], [-111, 31], [-117, 33]],
    ]},
    {name: 'Europe', polygons: [
        [[-9, 37], [-9, 43], [-2, 43], [0, 46], [-4, 48], [2, 51], [7, 54],
            [15, 54], [24, 60], [30, 59], [30, 46], [23, 40], [19, 44], [12, 46], [8, 43], [3, 42], [0, 38]],
        [[-5, 51], [-5, 55], [-2, 58], [0, 53], [1, 51]],
        [[6, 58], [10, 63], [18, 68], [24, 68], [20, 60], [12, 56]],
    ]},
];

function inPolygon(lon, lat, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
        if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

const inRegion = (region, lat, lon) => region.polygons.some(p => inPolygon(lon, lat, p));
const upAt = (lat, lon) => new Vector3(Math.cos(lat * DEG) * Math.cos(lon * DEG),
    Math.cos(lat * DEG) * Math.sin(lon * DEG), Math.sin(lat * DEG));

function sites(region) {
    const points = region.polygons.flat();
    const minLat = Math.min(...points.map(p => p[1])), maxLat = Math.max(...points.map(p => p[1]));
    const minLon = Math.min(...points.map(p => p[0])), maxLon = Math.max(...points.map(p => p[0]));
    const result = [];
    for (let lat = minLat + 0.5; lat <= maxLat; lat += 2) {
        for (let lon = minLon + 0.5; lon <= maxLon; lon += 3) {
            if (inRegion(region, lat, lon)) result.push({latitude: lat, longitude: lon, up: upAt(lat, lon)});
        }
    }
    return result;
}

const raDecVector = ({raDeg, decDeg}) => new Vector3(Math.cos(decDeg * DEG) * Math.cos(raDeg * DEG),
    Math.cos(decDeg * DEG) * Math.sin(raDeg * DEG), Math.sin(decDeg * DEG));

// Include the frame edges, not just the optical axis: a high centre alone can
// still leave half a wide photograph below the ground.
export function solvedFieldDirections(pose, vfov, aspect = 1) {
    if (!pose?.centre || !pose?.above || !(vfov > 0 && vfov < 180) || !(aspect > 0)) return [];
    const center = raDecVector(pose.centre), up = raDecVector(pose.above);
    up.addScaledVector(center, -up.dot(center)).normalize();
    const right = new Vector3().crossVectors(center, up).normalize();
    const y = Math.tan(Math.min(160, vfov) * DEG / 2), x = y * aspect;
    const directions = [center];
    for (const a of [-1, 1]) for (const b of [-1, 1]) {
        directions.push(center.clone().addScaledVector(right, a * x).addScaledVector(up, b * y).normalize());
    }
    return directions;
}

/** J2000 directions of the identified stars, from entries with raDeg and decDeg. */
export function identifiedStarDirections(entries) {
    return [...(entries ?? [])].filter(e => Number.isFinite(e?.raDeg) && Number.isFinite(e?.decDeg)).map(raDecVector);
}

/** Choose a plausible viewing setup from solved J2000 sky directions. Stars alone
 * do not uniquely determine the photograph's position or date. Known inputs are
 * hard constraints; only missing inputs are searched. `stars` are the identified
 * stars: with a known location and no time, a field whose lower part never clears
 * the horizon still gets a dark time that puts these stars at least 10 degrees up. */
export function findTemplateNightView(directions, {date, location = null, timeKnown = false, stars = []} = {}) {
    const invalid = list => list.some(d => ![d.x, d.y, d.z].every(Number.isFinite) || d.lengthSq() < 0.5);
    if (!directions.length || !Number.isFinite(date?.getTime()) || invalid(directions) || invalid(stars)) return null;
    if (location && (!Number.isFinite(location.latitude) || !Number.isFinite(location.longitude)
        || Math.abs(location.latitude) > 90 || Math.abs(location.longitude) > 180)) return null;
    const minClearance = 10;
    const night = Math.sin(-18 * DEG);
    // Used only with a known location and no time. Without identified stars, the
    // frame centre stands in for them.
    const lowest = location && !timeKnown ? (stars.length ? stars : directions.slice(0, 1)) : [];
    const fields = new Map();
    const toECEF = (list, matrix) => list.map(d => d.clone().normalize().transformDirection(matrix));
    const fieldAt = instant => {
        const key = instant.getTime();
        if (!fields.has(key)) {
            const matrix = getEQJToECEFMatrix(instant);
            fields.set(key, {matrix, directions: toECEF(directions, matrix),
                sun: getGeocentricBodyPositionECEF('Sun', instant).normalize()});
        }
        return fields.get(key);
    };
    const minAltitude = (list, up) => Math.asin(Math.max(-1, Math.min(1, Math.min(...list.map(d => d.dot(up)))))) / DEG;
    // `which` is 'directions' for the whole frame, or 'lowest' for the identified stars.
    const evaluate = (point, instant, region, which = 'directions') => {
        const field = fieldAt(instant), sunDot = field.sun.dot(point.up);
        if (sunDot > night + 1e-10) return null;
        // The stars are converted only for a dark instant that the relaxed search tests.
        if (which === 'lowest') field.lowest ??= toECEF(lowest, field.matrix);
        const altitude = minAltitude(field[which], point.up);
        if (altitude < minClearance) return null;
        // Solar local hour avoids inventing a civil time zone for a search point.
        const hour = ((instant.getUTCHours() + instant.getUTCMinutes() / 60 + point.longitude / 15) % 24 + 24) % 24;
        const eveningDistance = Math.abs(((hour - 21 + 36) % 24) - 12);
        const result = {date: instant, latitude: point.latitude, longitude: point.longitude, region,
            minAltitude: altitude, sunAltitude: Math.asin(Math.max(-1, Math.min(1, sunDot))) / DEG,
            localSolarHour: hour, score: altitude - (timeKnown ? 0 : 3 * eveningDistance)};
        if (which === 'lowest') {
            result.fieldMinAltitude = minAltitude(field.directions, point.up);
            result.lowFrame = result.fieldMinAltitude < minClearance;
        }
        return result;
    };
    const regions = location ? [{name: 'Known location', fixed: true}] : REGIONS;
    const offsets = [0];
    if (!timeKnown) for (let d = 1; d <= 183; d++) offsets.push(d, -d);
    const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    const canRise = (p, list) => list.every(d => 90 - Math.abs(p.latitude - Math.asin(d.z / d.length()) / DEG) >= minClearance);
    for (const region of regions) {
        const candidates = location ? [{...location, up: upAt(location.latitude, location.longitude)}] : sites(region);
        // A circumpolar southern field cannot rise in either northern region.
        const strict = candidates.some(p => canRise(p, directions));
        const relaxed = lowest.length > 0 && candidates.some(p => canRise(p, lowest));
        if (!strict && !relaxed) continue;
        const refine = (coarse, which) => {
            let best = coarse;
            const minutes = timeKnown ? [0] : [-45, -30, -15, 0, 15, 30, 45];
            const refinements = location ? candidates : [];
            if (!location) for (let lat = coarse.latitude - 2; lat <= coarse.latitude + 2; lat += 0.5) {
                for (let lon = coarse.longitude - 3; lon <= coarse.longitude + 3; lon += 0.5) {
                    if (inRegion(region, lat, lon)) refinements.push({latitude: lat, longitude: lon, up: upAt(lat, lon)});
                }
            }
            for (const minute of minutes) for (const point of refinements) {
                const result = evaluate(point, new Date(+coarse.date + minute * 60000), region.name, which);
                if (result && result.score > best.score) best = result;
            }
            return best;
        };
        // The nearest day on which the identified stars are clear, used only if no
        // day clears the whole frame.
        let fallback = null;
        for (const offset of offsets) {
            let best = null, low = null;
            const times = timeKnown ? [date] : Array.from({length: 24}, (_, hour) => new Date(dayStart + offset * DAY + hour * 3600000));
            for (const instant of times) for (const point of candidates) {
                const result = strict && evaluate(point, instant, region.name);
                if (result && (!best || result.score > best.score)) best = result;
                const lowResult = relaxed && !fallback && evaluate(point, instant, region.name, 'lowest');
                if (lowResult && (!low || lowResult.score > low.score)) low = lowResult;
            }
            fallback ||= low;
            if (best) return refine(best, 'directions');
        }
        if (fallback) return refine(fallback, 'lowest');
    }
    if (location) return null; // A supplied location must never be replaced by a regional guess.
    const elsewhere = findNightView(directions, date, !timeKnown);
    return elsewhere?.minAltitude >= minClearance ? {...elsewhere, region: 'Elsewhere'} : null;
}
