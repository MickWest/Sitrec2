// Time > Show Time Zones: the time zones at the sitch time, drawn over the globe in the MAIN
// view only, as on an ordinary time zone map. Each zone has a color for its UTC offset at the
// Now Time, with daylight saving time, and a line runs where the offsets on its two sides
// differ. So in July a line runs around Arizona (UTC-7) inside Mountain time (UTC-6), and in
// January it does not. France and Germany have had the same clocks since 1980, so there is no
// line between them after that (from 1976 to 1979 France had summer time and Germany did not,
// and the map shows a line then). On land and at sea,
// where the zones are the 15-degree nautical bands. See data/timezones/README.md and
// scripts/buildTimeZoneBorders.js.
//
// The data (data/timezones/timezone-borders.bin.gz, about 250 KB, loaded by TimeZoneMapData.js)
// is fetched the first time it is needed, never at startup, and kept for the rest of the
// session. It has the map's zones by name (the "1970" set of timezone-boundary-builder: each
// zone has one history of offsets since 1970), and the browser gives each zone's offset at the
// Now Time (Intl), so the map is right for any date since 1970. syncMapToDate works out the
// colors, the lines and the label sides again when an offset changes, checked once per quarter
// hour of sitch time.
//
// FILL. Under the lines, each zone is colored at FILL_OPACITY; a zone between two whole hours
// (India, UTC+5:30) has diagonal stripes of the two colors. The geometry and the colors are in
// TimeZoneFill.js; the stripes are fixed on the screen, STRIPE_PERIOD_PX apart, so they keep
// their width at any zoom. The fill is drawn just before the lines, with no depth test and the
// same far-side cull.
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
// shrink toward the edge of the globe. The offset of the zone between two crossings comes from
// the faces on each side of each border line; its name comes from the map's zone at the label
// point (zonesAtPoint), as the Time Zone menu names it at the Now Time. A zone with no menu
// name (at sea: Etc/GMT+10) has the offset alone ("UTC-10"). The labels are drawn by the 2D
// overlay of the main view
// (registerLabel3D in CNodeDisplaySkyOverlay.js), which asks each label shouldRender() before
// it draws; the first ask in a frame works out the row for the main camera.
//
// Time zone borders: © OpenStreetMap contributors, timezone-boundary-builder (ODbL).

import {BufferAttribute, BufferGeometry, Color, DoubleSide, Float32BufferAttribute, Mesh, ShaderMaterial, Vector3} from "three";
import * as LAYER from "./LayerMasks";
import {GlobalDateTimeNode, Globals, markSitchDirty, NodeMan, setRenderOne} from "./Globals";
import {GlobalScene} from "./LocalFrame";
import {ECEFToLLAVD_radii, LLAToECEFInto} from "./LLA-ECEF-ENU";
import {SceneLineSegments} from "./SceneLines";
import {displayPixelScale, SceneLineMaterial} from "./SceneLineMaterial";
import {buildTimeZoneFill, densifySegment, fillStyles, ZONE_PALETTE, zoneMapAt} from "./TimeZoneFill";
import {ViewMan} from "./CViewManager";
import {showViewMessage} from "./ViewMessage";
import {registerLabel3D, unregisterLabel3D} from "./nodes/CNodeDisplaySkyOverlay";
import {formatUtcOffset, utcOffsetHoursInZone} from "./TimeZoneLookup";
import {loadTimeZoneMap, zonesAtPoint} from "./TimeZoneMapData";
import {t} from "./i18n";

const BORDER_COLOR = 0xffff00;      // yellow
const LABEL_COLOR = "#FFFF00";
const LABEL_SIZE_PX = 18;           // font size of a label that faces the camera
const LABEL_MIN_SIZE_PX = 8;        // smaller labels are not drawn
const LABEL_MIN_FACING = 0.25;      // cos of the angle from the surface normal to the camera
const LABEL_ROW_SAMPLES = 48;       // points tested along each zone's stretch of the row
const BORDER_WIDTH_PX = 1.5;        // display pixels, whatever the device pixel ratio
const FILL_OPACITY = 0.15;
const STRIPE_PERIOD_PX = 16;        // display pixels: one stripe of each color
const MAP_STEP_MS = 15 * 60 * 1000; // offsets are checked again each quarter hour of sitch time

let borderLines = null;         // the SceneLineSegments in the scene, made once per sitch
let zoneFill = null;            // the Mesh of colored zones, made with the lines
let fillLonLat = null;          // the triangulated fill in longitude/latitude, made once per session
let loadingGeneration = null;   // the sitch a load is running for
let mapState = null;            // zoneMapAt for the Now Time: colors, lines and label sides
let mapStep = null;             // the quarter hour of sitch time mapState was checked for

// Every border arc as line segments (pairs of ECEF points), the source for SceneLineSegments.
// border (from zoneMapAt) says which arcs are borders at the Now Time; the others (along a
// pole, or with the same offsets on both sides then) only close the faces of the fill. Long segments are split (densifySegment), and the
// fill uses the same points, so a fill ends exactly on its line.
function buildBorderGeometry({counts, lonLat}, border) {
    const positions = [];
    const p = new Vector3();
    let previousLon = 0, previousLat = 0;
    const pushPiece = (lon, lat) => {
        LLAToECEFInto(previousLat, previousLon, 0, p);
        positions.push(p.x, p.y, p.z);
        LLAToECEFInto(lat, lon, 0, p);
        positions.push(p.x, p.y, p.z);
        previousLon = lon;
        previousLat = lat;
    };
    let k = 0;
    for (let line = 0; line < counts.length; line++) {
        for (let j = 0; j < counts[line]; j++, k += 2) {
            if (j === 0 || !border[line]) continue;
            previousLon = lonLat[k - 2];
            previousLat = lonLat[k - 1];
            densifySegment(previousLon, previousLat, lonLat[k], lonLat[k + 1], pushPiece);
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
    const lines = new SceneLineSegments(buildBorderGeometry(borders, mapState.border), makeBorderMaterial());
    lines.userData.radii = [Globals.equatorRadius, Globals.polarRadius];
    lines.userData.borderKey = mapState.borderKey;
    lines.name = "TimeZoneBorders";
    lines.frustumCulled = false;
    lines.renderOrder = 1000;           // no depth test, so draw after the scene it sits over
    return lines;
}

// Make the lines again when the Now Time crosses a change of offset that adds or removes a
// border, and when the Earth model changes (Terrain > Use Ellipsoid), which moves every vertex
// and the culling normal. Called from the scene hook (installSceneHook), never while an object
// draws: more borders than the buffer holds give the lines new buffers (syncGeometry).
function updateBorderLines() {
    const lines = borderLines;
    const [a, b] = lines.userData.radii;
    const radiiChanged = a !== Globals.equatorRadius || b !== Globals.polarRadius;
    if (!radiiChanged && lines.userData.borderKey === mapState.borderKey) return;
    lines.sourceGeometry.dispose();
    lines.sourceGeometry = buildBorderGeometry(borderData, mapState.border);
    lines.syncGeometry();
    ellipsoidNormalScale(lines.material.uniforms.normalScale.value);
    lines.userData.radii = [Globals.equatorRadius, Globals.polarRadius];
    lines.userData.borderKey = mapState.borderKey;
}

// Three calls scene.onBeforeRender BEFORE it collects the objects to draw and sends their
// changed buffers to the GPU; it calls an object's own onBeforeRender AFTER that. So the map is
// brought to the Now Time here. A change made in an object's onBeforeRender shows one frame
// late, and a NEW buffer made there is worse: that frame draws without it, and Three keeps the
// incomplete vertex state, so the lines stayed invisible after a move of the Month slider
// added borders. Installed once on each scene the lines go into (GlobalScene, made once per
// page load); a WeakSet does not keep a scene alive.
const hookedScenes = new WeakSet();

function installSceneHook(scene) {
    if (hookedScenes.has(scene)) return;
    hookedScenes.add(scene);
    const previous = scene.onBeforeRender;
    scene.onBeforeRender = function (...args) {
        if (typeof previous === "function") previous.apply(this, args);
        if (!borderLines?.visible || borderLines.parent !== this) return;
        syncMapToDate();
        updateBorderLines();
        if (zoneFill) updateZoneFill();
    };
}

// ----------------------------------------------------------------- the map at the Now Time

// Make mapState (zoneMapAt) right for the Now Time. The offsets are checked at the start of each
// quarter hour of sitch time, so a change shows at most 15 minutes of sitch time late (most
// changes are on a whole hour, and show at once), and the state is replaced
// only when an offset changed, so the lines, the colors and the labels are made again only then.
function syncMapToDate() {
    if (!borderData) return;
    const time = GlobalDateTimeNode?.dateNow?.getTime?.() ?? Date.now();
    const step = Math.floor(time / MAP_STEP_MS);
    if (mapState && (step === mapStep || !Number.isFinite(step))) return;
    mapStep = step;
    const state = zoneMapAt(borderData, new Date(Number.isFinite(step) ? step * MAP_STEP_MS : Date.now()));
    if (mapState && state.key === mapState.key) return;
    state.borderKey = state.border.join("");
    mapState = state;
    labelStateKey = null;
}

// --------------------------------------------------------------------------------- fill

// The fill mesh in ECEF, from the triangles in longitude/latitude (TimeZoneFill.js), with the
// colors of the Now Time.
function buildFillGeometry(fill) {
    const {lonLat, index} = fill;
    const positions = new Float32Array(lonLat.length / 2 * 3);
    const p = new Vector3();
    for (let i = 0, k = 0; i < lonLat.length; i += 2, k += 3) {
        LLAToECEFInto(lonLat[i + 1], lonLat[i], 0, p);
        positions[k] = p.x;
        positions[k + 1] = p.y;
        positions[k + 2] = p.z;
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(positions, 3));
    geometry.setAttribute("fillStyle", new BufferAttribute(fillStyles(fill, mapState.faceOffsets), 3));
    geometry.setIndex(new BufferAttribute(index, 1));
    return geometry;
}

// fillStyle is (a, b, fraction): palette indices, and the part of each stripe period in color b;
// a is -1 for a face with no known offset. The stripes run up to the right, fixed on the screen.
function makeFillMaterial() {
    return new ShaderMaterial({
        uniforms: {
            normalScale: {value: ellipsoidNormalScale(new Vector3())},
            palette: {value: ZONE_PALETTE.map(hex => new Color(hex))},
            opacity: {value: FILL_OPACITY},
            stripePeriod: {value: STRIPE_PERIOD_PX},
        },
        vertexShader: `
            attribute vec3 fillStyle;
            varying vec3 vFillStyle;
            varying vec3 vSurfacePoint;
            void main() {
                vFillStyle = fillStyle;
                vec4 world = modelMatrix * vec4(position, 1.0);
                vSurfacePoint = world.xyz;
                gl_Position = projectionMatrix * viewMatrix * world;
            }`,
        fragmentShader: `
            uniform vec3 normalScale;
            uniform vec3 palette[${ZONE_PALETTE.length}];
            uniform float opacity;
            uniform float stripePeriod;
            varying vec3 vFillStyle;
            varying vec3 vSurfacePoint;
            void main() {
                // On the far side of the Earth: the camera is behind the tangent plane here.
                if (dot(vSurfacePoint * normalScale, cameraPosition - vSurfacePoint) < 0.0) discard;
                if (vFillStyle.x < -0.5) discard;
                float stripe = fract((gl_FragCoord.x - gl_FragCoord.y) / stripePeriod);
                float index = stripe < vFillStyle.z ? vFillStyle.y : vFillStyle.x;
                gl_FragColor = vec4(palette[int(index + 0.5)], opacity);
                #include <colorspace_fragment>
            }`,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        side: DoubleSide,
    });
}

function makeZoneFill(borders) {
    if (!fillLonLat) fillLonLat = buildTimeZoneFill(borders);
    const mesh = new Mesh(buildFillGeometry(fillLonLat), makeFillMaterial());
    mesh.userData.radii = [Globals.equatorRadius, Globals.polarRadius];
    mesh.userData.mapKey = mapState.key;
    // Keep the stripes the same number of display pixels wide in any render target (an
    // exported video, a sensor view). A uniform can change while the object draws.
    mesh.onBeforeRender = function (renderer) {
        this.material.uniforms.stripePeriod.value = STRIPE_PERIOD_PX * displayPixelScale(renderer);
    };
    mesh.name = "TimeZoneFill";
    mesh.frustumCulled = false;
    mesh.renderOrder = 999;             // just before the lines
    return mesh;
}

// As for the lines (updateBorderLines, from the same scene hook): take the colors of the Now
// Time, and follow a change of the Earth model.
function updateZoneFill() {
    const mesh = zoneFill;
    const [a, b] = mesh.userData.radii;
    if (a !== Globals.equatorRadius || b !== Globals.polarRadius) {
        mesh.geometry.dispose();
        mesh.geometry = buildFillGeometry(fillLonLat);
        ellipsoidNormalScale(mesh.material.uniforms.normalScale.value);
        mesh.userData.radii = [Globals.equatorRadius, Globals.polarRadius];
    } else if (mesh.userData.mapKey !== mapState.key) {
        const style = mesh.geometry.getAttribute("fillStyle");
        fillStyles(fillLonLat, mapState.faceOffsets, style.array);
        style.needsUpdate = true;
    }
    mesh.userData.mapKey = mapState.key;
}

// ------------------------------------------------------------------------------- labels

let borderData = null;          // the decoded file, for the crossings of the label row
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
// lonC in -180..180, west and east the standard offsets on each side. Sorted by d. An arc that
// is not a border (the same zones on both sides) does not split a zone.
function rowCrossings(latC, lonC) {
    const {counts, lonLat} = borderData;
    const {left, right, border} = mapState;
    const crossings = [];
    let k = 0;
    for (let line = 0; line < counts.length; line++) {
        for (let j = 0; j < counts[line]; j++, k += 2) {
            if (j === 0 || !border[line]) continue;
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

// "PDT\nUTC-7" for the zone at a point and instant: the map's zone there that has the offset of
// the label then (where zones overlap, offset is NaN and the first zone names it). The offset
// alone when the zone has no name in the Time Zone menu, or the browser does not know it.
function labelText(lat, lon, offset, date) {
    const zones = zonesAtPoint(borderData, lat, lon);
    const zone = zones.find(name => {
        const now = utcOffsetHoursInZone(name, date);
        return now !== null && (!Number.isFinite(offset) || Math.abs(now - offset) < 1e-6);
    }) ?? null;
    const cacheKey = `${zone}|${offset}|${Math.floor(date.getTime() / MAP_STEP_MS)}`;
    let text = labelTextCache.get(cacheKey);
    if (text === undefined) {
        text = zone ? GlobalDateTimeNode?.timeZoneLabelText?.(zone, date) ?? null : null;
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

// Place the labels for the main camera, once for each change of camera, view size, Now Time
// (to the quarter hour), map state or data. Called from the labels' shouldRender, so only while
// they show.
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
    syncMapToDate();
    camera.updateMatrixWorld();
    const stateKey = [camera.matrixWorld.elements.join(","), camera.projectionMatrix.elements.join(","),
        widthPx, heightPx, Math.floor(date.getTime() / MAP_STEP_MS), mapState.key,
        Globals.equatorRadius].join("|");
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

// Show or hide the lines and the fill to match Globals.showTimeZones, loading the data the
// first time.
export function refreshTimeZoneBordersVisibility() {
    if (borderLines) {
        const mask = LAYER.perViewLayerMask(Globals.showTimeZones === true, false);
        for (const object of [borderLines, zoneFill]) {
            if (!object) continue;
            object.layers.mask = mask;
            object.visible = mask !== 0;
        }
        return;
    }
    if (!Globals.showTimeZones) return;

    const generation = Globals.loadGeneration;
    if (loadingGeneration === generation) return;
    loadingGeneration = generation;
    loadTimeZoneMap()
        .then(borders => {
            // A different sitch loaded meanwhile: its own checkbox loads them again (cached).
            if (generation !== Globals.loadGeneration || borderLines) return;
            borderData = borders;
            mapState = null;
            syncMapToDate();
            borderLines = makeBorderLines(borders);
            GlobalScene.add(borderLines);
            installSceneHook(GlobalScene);
            // The fill is extra: if it fails, the lines and labels still show.
            try {
                zoneFill = makeZoneFill(borders);
                GlobalScene.add(zoneFill);
            } catch (error) {
                console.warn("Time zone fill not made:", error);
            }
            // The overlay only asks labels that exist, so one is made now; the row adds more.
            makeLabel();
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
    if (zoneFill) {
        zoneFill.parent?.remove(zoneFill);
        zoneFill.geometry.dispose();
        zoneFill.material.dispose();
        zoneFill = null;
    }
    if (!borderLines) return;
    borderLines.parent?.remove(borderLines);
    borderLines.sourceGeometry.dispose();
    borderLines.geometry.dispose();
    borderLines.material.dispose();
    borderLines = null;
}
