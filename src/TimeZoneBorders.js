// Time > Show Time Zones: the borders between time zones, drawn over the globe in the MAIN
// view only, as on an ordinary time zone map: a line marks a change of STANDARD UTC offset
// (the offset without daylight saving time), on land and at sea, where the zones are the
// 15-degree nautical bands. Arizona and New Mexico are both UTC-7 standard, so no line runs
// between them. See data/timezones/README.md and scripts/buildTimeZoneBorders.js.
//
// The data (data/timezones/timezone-borders.bin.gz, about 120 KB) is fetched the first time
// the checkbox is turned on, never at startup, and kept for the rest of the session.
//
// The lines are 1.5 display pixels wide. A plain WebGL line is always 1 px in Chrome (it
// ignores linewidth), so they are Sitrec's screen-space fat lines (SceneLineSegments with
// SceneLineMaterial, as the wind field uses). Like the Lat/Lon grid (LatLonGrid.js) they have
// no depth test, so terrain does not hide them, and the far side of the Earth is culled per
// fragment: a surface point P is visible from camera C when dot(n, C - P) > 0, where n is
// the ellipsoid normal (x/a², y/a², z/b²).
//
// LABELS. A row of labels ("PDT" over "UTC-7") runs along the parallel through the point at
// the centre of the screen. The borders cut that parallel into zones; each zone gets one label
// in the middle of the part of it that is on screen, so the zone that faces the camera has its
// label in its middle, close to the screen centre. A label's size is the cosine of the angle
// between the surface normal and the direction to the camera, times LABEL_SIZE_PX, so labels
// shrink toward the edge of the globe. The zone between two crossings comes from the standard
// offsets stored on each side of each border line; its name comes from tz-lookup at the label
// point, for the date of the sitch, when that zone has the same standard offset (on land).
// Otherwise (at sea, or where the browser's rules are older than the lines) the label is the
// standard offset alone ("UTC-10"). The labels are drawn by the 2D overlay of the main view
// (registerLabel3D in CNodeDisplaySkyOverlay.js), which asks each label shouldRender() before
// it draws; the first ask in a frame works out the row for the main camera.
//
// Time zone borders: © OpenStreetMap contributors, timezone-boundary-builder (ODbL).

import {BufferGeometry, Float32BufferAttribute, Vector3} from "three";
import * as LAYER from "./LayerMasks";
import {GlobalDateTimeNode, Globals, markSitchDirty, NodeMan, setRenderOne} from "./Globals";
import {GlobalScene} from "./LocalFrame";
import {ECEFToLLAVD_radii, LLAToECEFInto} from "./LLA-ECEF-ENU";
import {SceneLineSegments} from "./SceneLines";
import {SceneLineMaterial} from "./SceneLineMaterial";
import {SITREC_APP} from "./configUtils";
import {ViewMan} from "./CViewManager";
import {showViewMessage} from "./ViewMessage";
import {registerLabel3D, unregisterLabel3D} from "./nodes/CNodeDisplaySkyOverlay";
import {formatUtcOffset, lookupTimeZoneIfLoaded, preloadTimeZoneLookup, standardOffsetHoursInZone} from "./TimeZoneLookup";
import {t} from "./i18n";

const BORDERS_FILE = "data/timezones/timezone-borders.bin.gz";
const BORDER_COLOR = 0xffff00;      // yellow
const LABEL_COLOR = "#FFFF00";
const LABEL_SIZE_PX = 18;           // font size of a label that faces the camera
const LABEL_MIN_SIZE_PX = 8;        // smaller labels are not drawn
const LABEL_MIN_FACING = 0.25;      // cos of the angle from the surface normal to the camera
const LABEL_ROW_SAMPLES = 48;       // points tested along each zone's stretch of the row
const BORDER_WIDTH_PX = 1.5;        // display pixels, whatever the device pixel ratio
// A border can run straight for a long way (the Western Australia border is a meridian for
// 1,500 km). A straight ECEF line between two far points cuts under the curve of the Earth,
// so long segments are split into pieces of at most this many degrees.
const MAX_SEGMENT_DEG = 0.5;
const UNITS_PER_DEG = 1e4;      // must match scripts/buildTimeZoneBorders.js
const UNKNOWN_SIDE = 127;       // quarter hours: that side has no single offset (as there)

let bordersPromise = null;      // the decoded file, loaded once per session
let borderLines = null;         // the SceneLineSegments in the scene, made once per sitch
let loadingGeneration = null;   // the sitch a load is running for

// The "TZB3" format of scripts/buildTimeZoneBorders.js (read its header), as
// {counts: Uint32Array (points in each line), lonLat: Float64Array (lon, lat in degrees),
//  left, right: Float64Array (standard offset in hours on each side, facing along the line;
//  NaN where unknown)}.
export function decodeTimeZoneBorders(buffer) {
    const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const name = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (name !== "TZB3") throw new Error(`not a time zone border file (starts "${name}")`);
    const lineCount = view.getUint32(4, true);
    const pointCount = view.getUint32(8, true);

    let offset = 12;
    const readVarint = () => {
        let value = 0, shift = 0, byte;
        do {
            if (offset >= bytes.byteLength) throw new Error("time zone border file is too short");
            byte = bytes[offset++];
            value += (byte & 0x7f) * 2 ** shift;      // not <<, which overflows past 31 bits
            shift += 7;
        } while (byte & 0x80);
        return value;
    };
    const readSigned = () => {
        const value = readVarint();
        return value % 2 === 0 ? value / 2 : -(value + 1) / 2;    // undo the zigzag
    };
    const sideHours = quarters => (quarters === UNKNOWN_SIDE ? NaN : quarters / 4);

    const counts = new Uint32Array(lineCount);
    const left = new Float64Array(lineCount);
    const right = new Float64Array(lineCount);
    const lonLat = new Float64Array(2 * pointCount);
    let k = 0;
    for (let i = 0; i < lineCount; i++) {
        const count = readVarint();
        counts[i] = count;
        left[i] = sideHours(readSigned());
        right[i] = sideHours(readSigned());
        if (k + 2 * count > lonLat.length) throw new Error("time zone border file has too many points");
        let lon = 0, lat = 0;
        for (let j = 0; j < count; j++) {
            lon += readSigned();        // the first point is absolute (lon starts at 0), then differences
            lat += readSigned();
            lonLat[k++] = lon / UNITS_PER_DEG;
            lonLat[k++] = lat / UNITS_PER_DEG;
        }
    }
    if (k !== lonLat.length || offset !== bytes.byteLength) {
        throw new Error("time zone border file has the wrong length");
    }
    return {counts, lonLat, left, right};
}

async function gunzip(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    // A server can send the file already decoded (Content-Encoding: gzip); only a gzip
    // stream starts with 1f 8b.
    if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return arrayBuffer;
    const stream = new Response(bytes).body.pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).arrayBuffer();
}

function loadBorders() {
    if (!bordersPromise) {
        bordersPromise = fetch(SITREC_APP + BORDERS_FILE)
            .then(response => {
                if (!response.ok) throw new Error(`HTTP ${response.status} for ${BORDERS_FILE}`);
                return response.arrayBuffer();
            })
            .then(gunzip)
            .then(decodeTimeZoneBorders)
            .catch(error => {
                bordersPromise = null;      // let a later try fetch again
                throw error;
            });
    }
    return bordersPromise;
}

// Every border as line segments (pairs of ECEF points), the source for SceneLineSegments.
function buildBorderGeometry({counts, lonLat}) {
    const positions = [];
    const p = new Vector3();
    const pushPoint = (lat, lon) => {
        LLAToECEFInto(lat, lon, 0, p);
        positions.push(p.x, p.y, p.z);
    };
    let k = 0;
    for (const count of counts) {
        for (let j = 0; j < count; j++, k += 2) {
            if (j === 0) continue;
            const lon0 = lonLat[k - 2], lat0 = lonLat[k - 1], lat1 = lonLat[k + 1];
            // Across the 180-degree meridian (179.9 to -179.9), go the short way.
            let lon1 = lonLat[k];
            if (lon1 - lon0 > 180) lon1 -= 360;
            else if (lon1 - lon0 < -180) lon1 += 360;
            const span = Math.max(Math.abs(lon1 - lon0), Math.abs(lat1 - lat0));
            const steps = Math.max(1, Math.ceil(span / MAX_SEGMENT_DEG));
            for (let s = 0; s < steps; s++) {
                const f0 = s / steps, f1 = (s + 1) / steps;
                pushPoint(lat0 + (lat1 - lat0) * f0, lon0 + (lon1 - lon0) * f0);
                pushPoint(lat0 + (lat1 - lat0) * f1, lon0 + (lon1 - lon0) * f1);
            }
        }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
    return geometry;
}

// 1/a² and 1/b² for the ellipsoid normal, pre-scaled by a² so it stays O(1) in float32.
function ellipsoidNormalScale(target) {
    const a = Globals.equatorRadius, b = Globals.polarRadius;
    return target.set(1, 1, (a * a) / (b * b));
}

function replaceOnce(text, anchor, replacement) {
    if (!text.includes(anchor)) throw new Error(`Time zone border shader: anchor "${anchor}" not found`);
    return text.replace(anchor, replacement);
}

// SceneLineMaterial, plus the far-side cull. "// scene line attributes" is the hook that
// SceneLineMaterial leaves for custom line shaders (CNodeDisplayWindField uses it too);
// lineVertexFraction there is this vertex's place along the original segment.
function makeBorderMaterial() {
    const material = new SceneLineMaterial({
        color: BORDER_COLOR, linewidth: BORDER_WIDTH_PX, depthTest: false, toneMapped: false,
    });
    material.uniforms.normalScale = {value: ellipsoidNormalScale(new Vector3())};
    material.vertexShader = replaceOnce(material.vertexShader,
        "void main() {", "varying vec3 vSurfacePoint;\nvoid main() {");
    material.vertexShader = replaceOnce(material.vertexShader, "// scene line attributes", `
        vSurfacePoint = (modelMatrix * vec4(mix(instanceStart, instanceEnd, lineVertexFraction), 1.0)).xyz;
        // scene line attributes`);
    material.fragmentShader = replaceOnce(material.fragmentShader, "void main() {", `
        uniform vec3 normalScale;
        varying vec3 vSurfacePoint;
        void main() {
            // On the far side of the Earth: the camera is behind the tangent plane here.
            if (dot(vSurfacePoint * normalScale, cameraPosition - vSurfacePoint) < 0.0) discard;`);
    return material;
}

function makeBorderLines(borders) {
    const lines = new SceneLineSegments(buildBorderGeometry(borders), makeBorderMaterial());
    lines.userData.radii = [Globals.equatorRadius, Globals.polarRadius];
    // The Earth model can change after setup (Terrain > Use Ellipsoid), which moves every
    // vertex and the culling normal. LineSegments2 has its own onBeforeRender (it sets the
    // viewport), so it is wrapped, not replaced.
    const lineSegmentsOnBeforeRender = lines.onBeforeRender;
    lines.onBeforeRender = function (...args) {
        const [a, b] = this.userData.radii;
        if (a !== Globals.equatorRadius || b !== Globals.polarRadius) {
            this.sourceGeometry.dispose();
            this.sourceGeometry = buildBorderGeometry(borders);
            this.syncGeometry();
            ellipsoidNormalScale(this.material.uniforms.normalScale.value);
            this.userData.radii = [Globals.equatorRadius, Globals.polarRadius];
        }
        return lineSegmentsOnBeforeRender.apply(this, args);
    };
    lines.name = "TimeZoneBorders";
    lines.frustumCulled = false;
    lines.renderOrder = 1000;           // no depth test, so draw after the scene it sits over
    return lines;
}

// ------------------------------------------------------------------------------- labels

let borderData = null;          // the decoded file, for the crossings of the label row
let lookupReady = false;        // tz-lookup has loaded, so labels can name their zones
const labelPool = [];           // label objects registered with the main view's 2D overlay
let labelStateKey = null;       // the camera, date and data the labels were placed for
const labelTextCache = new Map();

const _camera = new Vector3(), _direction = new Vector3(), _point = new Vector3();
const _normal = new Vector3(), _toCamera = new Vector3(), _ndc = new Vector3();

function makeLabel() {
    const label = {
        // The overlay draws a label only while this group is visible in the view.
        group: borderLines,
        groupNode: {group: borderLines},
        layerMask: LAYER.MASK_HELPERS,
        textPosition: new Vector3(),
        text: "",
        size: LABEL_SIZE_PX,
        color: LABEL_COLOR,
        fontWeight: "bold",
        strokeColor: "#000000",
        strokeWidth: 3,
        textAlign: "center",
        active: false,
        shouldRender() {
            placeLabels();
            return this.active;
        },
    };
    registerLabel3D(label);
    labelPool.push(label);
    return label;
}

function removeLabels() {
    for (const label of labelPool) unregisterLabel3D(label);
    labelPool.length = 0;
    labelStateKey = null;
}

const wrap180 = degrees => ((((degrees + 180) % 360) + 360) % 360) - 180;

// The facing of a surface point: cos of the angle between its ellipsoid normal and the
// direction to the camera. 1 straight below the camera, 0 on the horizon, < 0 behind.
function facing(point, camera) {
    const a = Globals.equatorRadius, b = Globals.polarRadius;
    _normal.set(point.x / (a * a), point.y / (a * a), point.z / (b * b)).normalize();
    return _normal.dot(_toCamera.copy(camera).sub(point).normalize());
}

// The point at the centre of the screen, as [lat, lon] in degrees: where the view ray meets
// the ellipsoid or, when it misses, the surface point nearest to the ray. Worked in a space
// where the ellipsoid is a unit sphere.
function screenCentreLatLon(camera) {
    const a = Globals.equatorRadius, b = Globals.polarRadius;
    camera.getWorldPosition(_camera);
    camera.getWorldDirection(_direction);
    const ox = _camera.x / a, oy = _camera.y / a, oz = _camera.z / b;
    const dx = _direction.x / a, dy = _direction.y / a, dz = _direction.z / b;
    const dd = dx * dx + dy * dy + dz * dz;
    const od = ox * dx + oy * dy + oz * dz;
    const oo = ox * ox + oy * oy + oz * oz;
    const discriminant = od * od - dd * (oo - 1);
    let t = discriminant >= 0 ? (-od - Math.sqrt(discriminant)) / dd : -od / dd;
    if (t < 0) t = 0;   // looking away from the Earth: use the point below the camera
    const length = Math.hypot(ox + t * dx, oy + t * dy, oz + t * dz);
    _point.set((ox + t * dx) / length * a, (oy + t * dy) / length * a, (oz + t * dz) / length * b);
    const lla = ECEFToLLAVD_radii(_point);
    return [lla.x, lla.y];
}

// Where the borders cross the parallel at latC: [{d, west, east}], d the longitude east of
// lonC in -180..180, west and east the standard offsets on each side. Sorted by d.
function rowCrossings(latC, lonC) {
    const {counts, lonLat, left, right} = borderData;
    const crossings = [];
    let k = 0;
    for (let line = 0; line < counts.length; line++) {
        for (let j = 0; j < counts[line]; j++, k += 2) {
            if (j === 0) continue;
            const lat0 = lonLat[k - 1], lat1 = lonLat[k + 1];
            const north = lat1 > lat0;
            // Half-open, so a crossing exactly at a shared point counts once.
            if (north ? !(lat0 < latC && lat1 >= latC) : !(lat1 < latC && lat0 >= latC)) continue;
            const lon0 = lonLat[k - 2];
            let lon1 = lonLat[k];
            if (lon1 - lon0 > 180) lon1 -= 360;
            else if (lon1 - lon0 < -180) lon1 += 360;
            const lon = lon0 + (lon1 - lon0) * (latC - lat0) / (lat1 - lat0);
            // Facing along a line that runs north, its left side is the west.
            crossings.push({
                d: wrap180(lon - lonC),
                west: north ? left[line] : right[line],
                east: north ? right[line] : left[line],
            });
        }
    }
    return crossings.sort((p, q) => p.d - q.d);
}

// "PDT\nUTC-7" for the zone at a point and date, when tz-lookup's zone there has the
// standard offset of the border data; otherwise the standard offset alone.
function labelText(lat, lon, offset, date) {
    const zone = lookupReady ? lookupTimeZoneIfLoaded(lat, lon) : null;
    const cacheKey = `${zone}|${offset}|${Math.floor(date.getTime() / 3600000)}`;
    let text = labelTextCache.get(cacheKey);
    if (text === undefined) {
        text = null;
        if (zone) {
            const standard = standardOffsetHoursInZone(zone, date.getUTCFullYear());
            if (standard !== null && (!Number.isFinite(offset) || Math.abs(standard - offset) < 1e-6)) {
                text = GlobalDateTimeNode?.timeZoneLabelText?.(zone, date) ?? null;
            }
        }
        if (text === null && Number.isFinite(offset)) text = formatUtcOffset(offset);
        if (labelTextCache.size > 1000) labelTextCache.clear();
        labelTextCache.set(cacheKey, text);
    }
    return text;
}

// A label for the zone between longitudes lonA and lonB on the parallel latC: in the middle of
// the longest part of that stretch that is on screen and faces the camera, sized by its facing.
// null when that part is too small for the text.
function labelForZone(latC, lonA, lonB, offset, camera, date, widthPx, heightPx) {
    let bestStart = -1, bestEnd = -1, runStart = -1;
    for (let s = 0; s <= LABEL_ROW_SAMPLES; s++) {
        let visible = false;
        if (s < LABEL_ROW_SAMPLES) {
            const lon = lonA + (lonB - lonA) * (s + 0.5) / LABEL_ROW_SAMPLES;
            LLAToECEFInto(latC, lon, 0, _point);
            if (facing(_point, _camera) > LABEL_MIN_FACING) {
                _ndc.copy(_point).project(camera);
                visible = Math.abs(_ndc.x) < 0.92 && Math.abs(_ndc.y) < 0.92 && _ndc.z < 1;
            }
        }
        if (visible && runStart < 0) runStart = s;
        if (!visible && runStart >= 0) {
            if (s - runStart > bestEnd - bestStart) [bestStart, bestEnd] = [runStart, s];
            runStart = -1;
        }
    }
    if (bestStart < 0) return null;
    const lonAt = s => lonA + (lonB - lonA) * s / LABEL_ROW_SAMPLES;
    const lonMid = (lonAt(bestStart) + lonAt(bestEnd)) / 2;

    const position = new Vector3();
    LLAToECEFInto(latC, lonMid, 0, position);
    const size = LABEL_SIZE_PX * facing(position, _camera);
    if (size < LABEL_MIN_SIZE_PX) return null;

    const text = labelText(latC, wrap180(lonMid), offset, date);
    if (!text) return null;
    // The visible stretch must be wider on screen than the text.
    LLAToECEFInto(latC, lonAt(bestStart), 0, _point);
    const startNdc = _point.clone().project(camera);
    LLAToECEFInto(latC, lonAt(bestEnd), 0, _point);
    _ndc.copy(_point).project(camera);
    const stretchPx = Math.hypot((_ndc.x - startNdc.x) * widthPx / 2, (_ndc.y - startNdc.y) * heightPx / 2);
    const textPx = size * 0.62 * Math.max(...text.split("\n").map(line => line.length));
    if (stretchPx < textPx + 6) return null;
    return {position, text, size};
}

// The row of labels for a camera and date.
function labelRow(camera, date, widthPx, heightPx) {
    const [latC, lonC] = screenCentreLatLon(camera);   // also sets _camera
    const crossings = rowCrossings(latC, lonC);
    if (crossings.length < 2) return [];
    const row = [];
    for (let i = 0; i < crossings.length; i++) {
        const start = crossings[i];
        const end = crossings[(i + 1) % crossings.length];
        const dEnd = i + 1 < crossings.length ? end.d : end.d + 360;
        if (dEnd - start.d < 1e-6) continue;
        const offset = Number.isFinite(start.east) ? start.east : end.west;
        const label = labelForZone(latC, lonC + start.d, lonC + dEnd, offset, camera, date, widthPx, heightPx);
        if (label) row.push(label);
    }
    return row;
}

// Place the labels for the main camera, once for each change of camera, view size, date
// (to the hour) or data. Called from the labels' shouldRender, so only while they show.
function placeLabels() {
    if (!borderLines || !borderData) return;
    const camera = NodeMan.get("mainCamera", false)?.camera;
    const date = GlobalDateTimeNode?.dateNow;
    const view = ViewMan.get("mainView", false);
    if (!camera || !date || !view) {
        for (const label of labelPool) label.active = false;
        return;
    }
    const widthPx = view.widthPx || 1000, heightPx = view.heightPx || 800;
    camera.updateMatrixWorld();
    const stateKey = [camera.matrixWorld.elements.join(","), camera.projectionMatrix.elements.join(","),
        widthPx, heightPx, Math.floor(date.getTime() / 3600000), lookupReady, Globals.equatorRadius].join("|");
    if (stateKey === labelStateKey) return;
    labelStateKey = stateKey;

    const row = labelRow(camera, date, widthPx, heightPx);
    while (labelPool.length < row.length) makeLabel();
    row.forEach((item, i) => {
        const label = labelPool[i];
        label.textPosition.copy(item.position);
        label.text = item.text;
        label.size = item.size;
        label.active = true;
    });
    for (let i = row.length; i < labelPool.length; i++) labelPool[i].active = false;
}

// Show or hide the lines to match Globals.showTimeZones, loading the data the first time.
export function refreshTimeZoneBordersVisibility() {
    if (borderLines) {
        const mask = LAYER.perViewLayerMask(Globals.showTimeZones === true, false);
        borderLines.layers.mask = mask;
        borderLines.visible = mask !== 0;
        return;
    }
    if (!Globals.showTimeZones) return;

    const generation = Globals.loadGeneration;
    if (loadingGeneration === generation) return;
    loadingGeneration = generation;
    loadBorders()
        .then(borders => {
            // A different sitch loaded meanwhile: its own checkbox loads them again (cached).
            if (generation !== Globals.loadGeneration || borderLines) return;
            borderData = borders;
            borderLines = makeBorderLines(borders);
            GlobalScene.add(borderLines);
            // The overlay only asks labels that exist, so one is made now; the row adds more.
            makeLabel();
            if (!lookupReady) {
                preloadTimeZoneLookup()
                    .then(() => {
                        lookupReady = true;     // the labels can now name their zones
                        labelStateKey = null;
                        setRenderOne(true);
                    })
                    .catch(error => console.warn("Time zone labels: tz-lookup did not load:", error));
            }
            refreshTimeZoneBordersVisibility();
            setRenderOne(true);
        })
        .catch(error => {
            console.warn("Time zone borders did not load:", error);
            if (generation !== Globals.loadGeneration) return;
            Globals.showTimeZones = false;
            showViewMessage(ViewMan.get("mainView", false), t("dateTime.showTimeZones.loadFailed"));
        })
        .finally(() => {
            if (loadingGeneration === generation) loadingGeneration = null;
        });
}

// The checkbox, which CNodeDateTime adds directly under Set Time Zone from Camera Location.
// The Time menu is rebuilt for every sitch, so this runs once per sitch. It is off by
// default; a saved sitch restores its own value afterwards (CustomManagerSerialize).
export function addShowTimeZonesControl(folder) {
    removeTimeZoneBorders();
    Globals.showTimeZones = false;
    folder.add(Globals, "showTimeZones").name(t("dateTime.showTimeZones.label"))
        .tooltip(t("dateTime.showTimeZones.tooltip")).listen()
        .onChange(() => {
            refreshTimeZoneBordersVisibility();
            markSitchDirty();   // the setting is saved with the sitch
            setRenderOne(true);
        });
}

export function removeTimeZoneBorders() {
    removeLabels();
    if (!borderLines) return;
    borderLines.parent?.remove(borderLines);
    borderLines.sourceGeometry.dispose();
    borderLines.geometry.dispose();
    borderLines.material.dispose();
    borderLines = null;
}
