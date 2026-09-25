// Cloud field interchange format.
//
// A cloud field is a set of soft emitting spheres, fixed in a local frame that
// drifts with one wind. It is the data model behind CNodeCloudField: an import
// (this file), a generator or an editor only has to produce the object that
// normalizeCloudField returns, and the node renders it.
//
// JSON file (".json", detected by its "type"):
// {
//   "type": "SitrecCloudField",
//   "version": 1,
//   "name": "Gimbal reconstruction",               // optional
//   "frame": {                                      // local Cartesian frame, metres
//     "origin": {"lat": 28.6, "lon": -79.5, "alt": 7620},  // degrees, degrees, metres HAE
//     "headingDeg": 315                             // true bearing of local +y; +z is up
//   },
//   "wind": {"fromDeg": 240, "knots": 17, "epochFrame": 0},  // optional; drift of the whole field
//   "profile": "thinEmission",                      // optional; the only profile so far
//   "display": {"gain": 0.25, "minEmission": 0, "refraction": false},  // optional starting settings
//   "spheres": [[x, y, z, radius, emission], ...],  // metres, metres, metres, metres, unitless
//   "provenance": { ... }                           // optional, kept but not used
// }
//
// "thinEmission" is an optically thin emitter with density (1 - r^2/R^2)^(3/2).
// Its line integral along a ray that passes b from the centre is proportional to
// (1 - b^2/R^2)^2, and overlapping spheres add. There is no absorption.

export const CLOUD_FIELD_TYPE = "SitrecCloudField";
export const CLOUD_FIELD_VERSION = 1;
export const CLOUD_FIELD_PROFILES = ["thinEmission"];

export function isCloudFieldJSON(json) {
    return !!json && typeof json === "object" && json.type === CLOUD_FIELD_TYPE;
}

function finiteNumber(value, what) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`Cloud field: ${what} must be a finite number`);
    }
    return value;
}

// The node id must be the same when the file is dropped and when a saved sitch
// loads it again (both pass the FileManager id), and two different files must never
// share one id, or a reload would keep the wrong field and give it the other's
// settings. So every character outside [A-Za-z0-9-], "_" included, is escaped as
// _hh (or _uhhhhhh), which cannot collide.
export function cloudFieldNodeId(fileId) {
    // Nothing is stripped (not even ".json"): any stripping lets two names meet.
    const escaped = Array.from(fileId, ch => {
        if (/[A-Za-z0-9-]/.test(ch)) return ch;
        const code = ch.codePointAt(0);
        return code <= 0xff ? "_" + code.toString(16).padStart(2, "0") : "_u" + code.toString(16).padStart(6, "0");
    }).join("");
    return "CloudField_" + escaped;
}

/**
 * Validate a parsed cloud field file and pack it for rendering.
 * Throws an Error with a user-readable message if the file is not valid.
 * @returns {{name:string, origin:{lat:number,lon:number,alt:number}, headingDeg:number,
 *   wind:{fromDeg:number, knots:number, epochFrame:number}, profile:string,
 *   display:{gain:number, minEmission:number, refraction:boolean}, count:number,
 *   centers:Float32Array, radii:Float32Array, emissions:Float32Array,
 *   maxEmission:number, extentMeters:number, provenance:object|undefined}}
 */
export function normalizeCloudField(json) {
    if (!isCloudFieldJSON(json)) {
        throw new Error(`Cloud field: "type" must be "${CLOUD_FIELD_TYPE}"`);
    }
    const version = json.version ?? CLOUD_FIELD_VERSION;
    if (version > CLOUD_FIELD_VERSION) {
        throw new Error(`Cloud field: version ${version} is newer than this Sitrec supports (${CLOUD_FIELD_VERSION})`);
    }

    const origin = json.frame?.origin;
    if (!origin) throw new Error("Cloud field: frame.origin is missing");
    const lat = finiteNumber(origin.lat, "frame.origin.lat");
    const lon = finiteNumber(origin.lon, "frame.origin.lon");
    const alt = finiteNumber(origin.alt ?? 0, "frame.origin.alt");
    if (Math.abs(lat) > 90) throw new Error("Cloud field: frame.origin.lat is out of range");
    const headingDeg = finiteNumber(json.frame.headingDeg ?? 0, "frame.headingDeg");

    const profile = json.profile ?? "thinEmission";
    if (!CLOUD_FIELD_PROFILES.includes(profile)) {
        throw new Error(`Cloud field: unknown profile "${profile}"`);
    }

    const wind = {
        fromDeg: finiteNumber(json.wind?.fromDeg ?? 0, "wind.fromDeg"),
        knots: finiteNumber(json.wind?.knots ?? 0, "wind.knots"),
        epochFrame: finiteNumber(json.wind?.epochFrame ?? 0, "wind.epochFrame"),
    };

    const display = {
        gain: finiteNumber(json.display?.gain ?? 1, "display.gain"),
        minEmission: finiteNumber(json.display?.minEmission ?? 0, "display.minEmission"),
        // false for a field whose positions are already apparent (fitted to video),
        // true for true positions that Sitrec should bend like everything else.
        refraction: json.display?.refraction ?? true,
    };
    if (typeof display.refraction !== "boolean") throw new Error("Cloud field: display.refraction must be true or false");

    const rows = json.spheres;
    if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error("Cloud field: spheres must be a non-empty array");
    }
    const count = rows.length;
    const centers = new Float32Array(count * 3);
    const radii = new Float32Array(count);
    const emissions = new Float32Array(count);
    let maxEmission = 0;
    let extentMeters = 0;
    for (let i = 0; i < count; i++) {
        const sphere = rows[i];
        if (!Array.isArray(sphere) || sphere.length < 5) {
            throw new Error(`Cloud field: sphere ${i} must be [x, y, z, radius, emission]`);
        }
        const [x, y, z, radius, emission] = sphere;
        if (![x, y, z, radius, emission].every(Number.isFinite) || radius <= 0 || emission < 0) {
            throw new Error(`Cloud field: sphere ${i} has an invalid value`);
        }
        centers[i * 3] = x;
        centers[i * 3 + 1] = y;
        centers[i * 3 + 2] = z;
        radii[i] = radius;
        emissions[i] = emission;
        if (emission > maxEmission) maxEmission = emission;
        const reach = Math.hypot(x, y, z) + radius;
        if (reach > extentMeters) extentMeters = reach;
    }

    return {
        name: typeof json.name === "string" && json.name ? json.name : "Cloud field",
        origin: {lat, lon, alt},
        headingDeg,
        wind,
        profile,
        display,
        count,
        centers,
        radii,
        emissions,
        maxEmission,
        extentMeters,
        provenance: json.provenance,
    };
}

/**
 * East, north and up unit vectors in ECEF at a geodetic latitude and longitude (degrees).
 * Built from the angles, not from a position, so it is defined at the poles too:
 * there the longitude sets which way "north" and "east" point.
 */
export function localENU(latDeg, lonDeg) {
    const lat = latDeg * Math.PI / 180;
    const lon = lonDeg * Math.PI / 180;
    const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
    const sinLon = Math.sin(lon), cosLon = Math.cos(lon);
    return {
        east: [-sinLon, cosLon, 0],
        north: [-sinLat * cosLon, -sinLat * sinLon, cosLat],
        up: [cosLat * cosLon, cosLat * sinLon, sinLat],
    };
}

/**
 * Unit vectors of the local frame, as [east, north] components of local +x and +y.
 * Local +y points to true bearing headingDeg; local +x is 90 degrees clockwise from it.
 */
export function localAxesEN(headingDeg) {
    const h = headingDeg * Math.PI / 180;
    return {
        x: {east: Math.cos(h), north: -Math.sin(h)},
        y: {east: Math.sin(h), north: Math.cos(h)},
    };
}

/**
 * Horizontal wind velocity in metres per second, as east/north components.
 * fromDeg is the direction the wind comes FROM, so the air moves towards fromDeg + 180.
 */
export function windVelocityEN(fromDeg, knots) {
    const speed = knots * 1852 / 3600;
    const towards = (fromDeg + 180) * Math.PI / 180;
    return {east: speed * Math.sin(towards), north: speed * Math.cos(towards)};
}
