// SitrecPhotoBackdrop: a picture of the background around a camera that only turns, laid out in
// azimuth and elevation. Column 0 of the image is azMin and the last column azMax; row 0 is elMax
// and the last row elMin; both are linear in degrees. Azimuth is clockwise from true north and
// elevation is above the local horizontal at the camera, the same convention as Camera Heading ▸
// Custom Az/El, so a picture built from registered photos lines up with the camera that took them.
// An optional second image, "terrainMask" (same size; white = ground, black = sky), marks the
// ground, which can hide objects beyond "range" meters. It is a separate image rather than the
// photo's alpha because a browser may drop the color of fully transparent pixels.
// An optional "coverageMask" (same size; white = photographed) marks which pixels came from a
// photo; the main view draws only those, so the unphotographed rest is not a solid wall.
//
// {
//   "type": "SitrecPhotoBackdrop", "version": 1, "name": "...",
//   "image": "data:image/png;base64,...",
//   "terrainMask": "data:image/png;base64,...",                  // optional
//   "coverageMask": "data:image/png;base64,...",                 // optional
//   "origin": {"lat": 33.5, "lon": -106.1, "altMSL": 1429.5},   // where the camera stood
//   "azMin": 75.7, "azMax": 87.7, "elMin": 1.95, "elMax": 4.65,  // degrees
//   "range": 15000,                                              // meters, optional
//   "fillColor": "#8c8c8c"                                       // optional, behind everything
// }

export const PHOTO_BACKDROP_TYPE = "SitrecPhotoBackdrop";
export const PHOTO_BACKDROP_VERSION = 1;
export const PHOTO_BACKDROP_DEFAULT_RANGE = 15000;

// Tessellation of the picture: a grid of 0.1 degree cells, finer than any visible bend, for a
// picture of up to MAX_GRID_CELLS cells (about 51 x 51 degrees). A larger picture gets a square
// grid of about MAX_GRID_CELLS cells: a 360 x 90 degree panorama gets 0.35 degree cells, whose
// rows are at most 0.00013 degrees from their true elevation. At least 8 x 4 cells.
const GRID_STEP_DEG = 0.1;
const MAX_GRID_CELLS = 512 * 512;

export function photoBackdropGridSize(azSpan, elSpan) {
    const step = Math.max(GRID_STEP_DEG, Math.sqrt(azSpan * elSpan / MAX_GRID_CELLS));
    return {nx: Math.max(8, Math.ceil(azSpan / step)), ny: Math.max(4, Math.ceil(elSpan / step))};
}

export function isPhotoBackdropJSON(json) {
    return !!json && typeof json === "object" && json.type === PHOTO_BACKDROP_TYPE;
}

function finite(value, what) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`Photo backdrop: ${what} must be a finite number`);
    }
    return value;
}

/**
 * Validate a parsed photo backdrop file. Returns a clean copy; throws an Error with a
 * user-readable message if the file is not valid.
 */
export function normalizePhotoBackdrop(json) {
    if (!isPhotoBackdropJSON(json)) throw new Error(`Photo backdrop: "type" must be "${PHOTO_BACKDROP_TYPE}"`);
    if (json.version !== PHOTO_BACKDROP_VERSION) {
        throw new Error(`Photo backdrop: version ${json.version} is not supported (expected ${PHOTO_BACKDROP_VERSION})`);
    }
    if (typeof json.image !== "string" || !/^data:image\/(png|jpeg|webp);base64,/.test(json.image)) {
        throw new Error("Photo backdrop: \"image\" must be a PNG, JPEG or WebP data URL");
    }
    if (json.terrainMask !== undefined && (typeof json.terrainMask !== "string"
        || !/^data:image\/(png|jpeg|webp);base64,/.test(json.terrainMask))) {
        throw new Error("Photo backdrop: \"terrainMask\" must be a PNG, JPEG or WebP data URL");
    }
    if (json.coverageMask !== undefined && (typeof json.coverageMask !== "string"
        || !/^data:image\/(png|jpeg|webp);base64,/.test(json.coverageMask))) {
        throw new Error("Photo backdrop: \"coverageMask\" must be a PNG, JPEG or WebP data URL");
    }
    const origin = json.origin ?? {};
    const lat = finite(origin.lat, "origin.lat");
    const lon = finite(origin.lon, "origin.lon");
    const altMSL = finite(origin.altMSL, "origin.altMSL");
    if (lat < -90 || lat > 90) throw new Error("Photo backdrop: origin.lat must be between -90 and 90");
    const azMin = finite(json.azMin, "azMin");
    const azMax = finite(json.azMax, "azMax");
    const elMin = finite(json.elMin, "elMin");
    const elMax = finite(json.elMax, "elMax");
    if (!(azMax > azMin) || azMax - azMin > 360) throw new Error("Photo backdrop: azMax must be above azMin, by at most 360");
    if (!(elMax > elMin) || elMin < -90 || elMax > 90) throw new Error("Photo backdrop: elMin and elMax must rise within -90 to 90");
    const range = json.range === undefined ? PHOTO_BACKDROP_DEFAULT_RANGE : finite(json.range, "range");
    if (!(range > 0)) throw new Error("Photo backdrop: range must be above zero");
    if (json.fillColor !== undefined && !/^#[0-9a-fA-F]{6}$/.test(json.fillColor)) {
        throw new Error("Photo backdrop: fillColor must look like #rrggbb");
    }
    return {
        name: typeof json.name === "string" && json.name ? json.name : "Photo Backdrop",
        image: json.image,
        terrainMask: json.terrainMask ?? null,
        coverageMask: json.coverageMask ?? null,
        origin: {lat, lon, altMSL},
        azMin, azMax, elMin, elMax, range,
        fillColor: json.fillColor ?? null,
    };
}

// The node id must be the same when the file is dropped and when a saved sitch loads it
// again (both pass the FileManager id), and two different files must not share one.
export function photoBackdropNodeId(fileId) {
    const escaped = Array.from(fileId, ch => {
        if (/[A-Za-z0-9-]/.test(ch)) return ch;
        const code = ch.codePointAt(0);
        return code <= 0xff ? "_" + code.toString(16).padStart(2, "0") : "_u" + code.toString(16).padStart(6, "0");
    }).join("");
    return "PhotoBackdrop_" + escaped;
}
