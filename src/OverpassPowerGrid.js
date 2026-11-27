// A way selected by Overpass may extend far beyond the region. Keep the
// pieces inside each edge, including the partial spans at the boundary.
import {footprintBounds, metersPerDegreeAt} from "./GroundFootprint";
import {isSecureBuild} from "./configUtils";

// The user chooses the service before sending the footprint.
export const overpassServers = {
    "overpass-api.de": "https://overpass-api.de/api/interpreter",
    "overpass.private.coffee": "https://overpass.private.coffee/api/interpreter",
};

function signedSide(a, b, p) {
    return (b.lon - a.lon) * (p.lat - a.lat) - (b.lat - a.lat) * (p.lon - a.lon);
}

function clipSpan(a, b, polygon) {
    let first = 0, last = 1;
    for (let i = 0; i < polygon.length; i++) {
        const left = polygon[i], right = polygon[(i + 1) % polygon.length];
        const start = signedSide(left, right, a), end = signedSide(left, right, b);
        if (start < 0 && end < 0) return null;
        if (start < 0) first = Math.max(first, start / (start - end));
        if (end < 0) last = Math.min(last, start / (start - end));
        if (first >= last) return null;
    }
    // The network importer joins wires to supports by their exact coordinates.
    const at = t => {
        if (t === 0) return [a.lon, a.lat];
        if (t === 1) return [b.lon, b.lat];
        return [a.lon + t * (b.lon - a.lon), a.lat + t * (b.lat - a.lat)];
    };
    return [at(first), at(last)];
}

export function regionalPowerFeatures(elements, corners) {
    const features = [];
    const add = (properties, type, coordinates) => features.push({type: "Feature", properties, geometry: {type, coordinates}});
    const polygon = signedSide(...corners.slice(0, 3)) > 0 ? corners : corners.slice().reverse();
    for (const {type, tags, lon, lat, geometry} of elements) {
        if (type === "node" && (tags?.power === "tower" || tags?.power === "pole")) {
            add(tags, "Point", [lon, lat]); // The query selects tagged nodes inside the polygon.
        } else if (type === "way" && (tags?.power === "line" || tags?.power === "minor_line")) {
            let path = [];
            const finish = () => {
                if (path.length > 1) add(tags, "LineString", path);
                path = [];
            };
            for (let i = 1; i < (geometry?.length ?? 0); i++) {
                const a = geometry[i - 1], b = geometry[i];
                const span = a && b && clipSpan(a, b, polygon);
                if (!span) {
                    finish();
                    continue;
                }
                const [start, end] = span, previous = path.at(-1);
                if (!previous || previous[0] !== start[0] || previous[1] !== start[1]) {
                    finish();
                    path.push(start);
                }
                path.push(end);
            }
            finish();
        }
    }
    return {type: "FeatureCollection", attribution: "© OpenStreetMap contributors", features};
}

// No background queries or queued retries. Coordinate manual imports across
// regions, and across same-origin tabs when browser storage/locks are available.
let activeRequest = false;
const nextRequestAt = new Map();
const busyMessage = "Another power grid import is running. Wait for it to finish.";

function nextAllowed(server) {
    let time = nextRequestAt.get(server) ?? 0;
    try {
        time = Math.max(time, Number(globalThis.localStorage?.getItem("sitrec.overpass." + server)) || 0);
    } catch { /* Browser storage may be unavailable. */ }
    return time;
}

function holdRequestsUntil(server, time) {
    nextRequestAt.set(server, time);
    try {
        globalThis.localStorage?.setItem("sitrec.overpass." + server, String(time));
    } catch { /* The in-memory limit still applies. */ }
}

async function requestOverpass(server, query, signal) {
    const endpoint = overpassServers[server];
    const body = new URLSearchParams({data: query});
    // The GET link repeats the exact POST, including its region and resource limits.
    // Constructing or copying it does not contact the server.
    const manualDownload = (message, retryAt) => Object.assign(new Error(message), {
        downloadURL: endpoint + "?" + body.toString(), retryAt,
    });
    async function send() {
        if (activeRequest) throw new Error(busyMessage);
        const allowedAt = nextAllowed(server);
        const wait = Math.ceil((allowedAt - Date.now()) / 1000);
        if (wait > 0) throw manualDownload(`Please wait ${wait} s before querying this server again.`, allowedAt);
        activeRequest = true;
        let delay = 60000;
        holdRequestsUntil(server, Date.now() + 30000);
        try {
            const response = await fetch(endpoint, {
                method: "POST", body, credentials: "omit", referrerPolicy: "no-referrer", signal,
            });
            if (!response.ok) {
                const header = response.headers?.get("Retry-After");
                if (header) {
                    const retryMs = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
                    if (Number.isFinite(retryMs)) delay = Math.max(delay, retryMs);
                }
                if ([429, 502, 503, 504].includes(response.status)) {
                    throw manualDownload("Server busy. A manual download URL is available.", Date.now() + delay);
                }
                throw new Error("Overpass returned HTTP " + response.status + ".");
            }
            const result = await response.json();
            if (/timed out|server too busy|rate limit/i.test(result.remark ?? "")) {
                throw manualDownload("Overpass could not finish the request. A manual download URL is available.", Date.now() + delay);
            }
            if (result.remark || !Array.isArray(result.elements)) throw new Error("Overpass returned an incomplete result. Try a smaller region.");
            delay = 30000;
            return result.elements;
        } catch (error) {
            if (signal?.aborted) throw manualDownload("Overpass timed out.", Date.now() + delay);
            throw error;
        } finally {
            holdRequestsUntil(server, Date.now() + delay);
            activeRequest = false;
        }
    }

    const locks = globalThis.navigator?.locks;
    if (!locks) return send();
    return locks.request("sitrec-overpass-import", {ifAvailable: true}, lock => {
        if (!lock) throw new Error(busyMessage);
        return send();
    });
}

export async function fetchRegionPowerGrid(corners, signal, server = "overpass-api.de") {
    if (isSecureBuild) throw new Error("Online power grid import is unavailable in this build.");
    if (!Object.hasOwn(overpassServers, server)) throw new Error("Choose a listed Overpass server.");
    const {south, west, north, east} = footprintBounds(corners);
    if (corners.length !== 4 || !corners.every(p => Number.isFinite(p.lat) && Math.abs(p.lat) <= 90 &&
        Number.isFinite(p.lon) && Math.abs(p.lon) <= 180) || south >= north || west >= east || east - west >= 180) {
        throw new Error("Choose a region with four distinct corners on the same side of the date line.");
    }
    const metres = metersPerDegreeAt((north + south) / 2, (east + west) / 2);
    if ((north - south) * metres.lat > 25000 || (east - west) * metres.lon > 25000) {
        throw new Error("Resize the region so its north–south and east–west extents are each within 25 km.");
    }
    const polygon = corners.map(p => p.lat.toFixed(7) + " " + p.lon.toFixed(7)).join(" ");
    const bounds = [south, west, north, east].map(n => n.toFixed(7)).join(",");
    // A wire may cross the area with both ends outside. Request its geometry
    // before clipping, since "out geom(bbox)" can omit both those endpoints.
    const query = `[out:json][timeout:30][maxsize:67108864];
(
  node["power"~"^(tower|pole)$"](poly:"${polygon}");
  way["power"~"^(line|minor_line)$"](${bounds});
);
out body geom;`;
    const elements = await requestOverpass(server, query, signal);
    return regionalPowerFeatures(elements, corners);
}
