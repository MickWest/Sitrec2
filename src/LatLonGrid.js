// Show > Lat/Lon Grid in Main / Look: a latitude/longitude graticule drawn over the whole globe.
//
// Drawn with NO depth test, so terrain, buildings and the globe itself never hide it — but a
// line on the FAR side of the Earth is not drawn. That cull is done per fragment, against the
// WGS84 ellipsoid: a point P on the surface is visible from camera C when (C − P) points out of
// the tangent plane at P, i.e. dot(n, C − P) > 0, where n is the ellipsoid normal
// (x/a², y/a², z/b²). The cut therefore falls exactly on the horizon rather than at a vertex.
//
// Same per-view pattern as labels and pins: two Globals flags, one controller each in the Show
// menu, each mirrored into its own view's header menu (and header icon) via .shareAs().

import {BufferGeometry, Float32BufferAttribute, LineSegments, ShaderMaterial, Vector3} from "three";
import * as LAYER from "./LayerMasks";
import {Globals, guiShowHide, setRenderOne} from "./Globals";
import {GlobalScene} from "./LocalFrame";
import {LLAToECEFInto} from "./LLA-ECEF-ENU";
import {viewMenuKey} from "./ViewUIBarMenus";
import {t} from "./i18n";

const GRID_STEP_DEG = 10;       // spacing of both parallels and meridians
const SAMPLE_STEP_DEG = 1;      // segment length along each line, so it follows the curve
const GRID_COLOR = [0.55, 0.85, 1.0];
const GRID_ALPHA = 0.45;        // ordinary lines
const PRIME_ALPHA = 0.9;        // equator and prime meridian stand out

let gridLines = null;

// One LineSegments holding every parallel and meridian. Each vertex carries an alpha, so the
// equator and prime meridian can be brighter without a second draw call.
function buildGridGeometry() {
    const positions = [];
    const alphas = [];
    const p = new Vector3();
    const pushPoint = (lat, lon, alpha) => {
        LLAToECEFInto(lat, lon, 0, p);
        positions.push(p.x, p.y, p.z);
        alphas.push(alpha);
    };
    const pushSegment = (lat0, lon0, lat1, lon1, alpha) => {
        pushPoint(lat0, lon0, alpha);
        pushPoint(lat1, lon1, alpha);
    };

    // Parallels, excluding the poles themselves (a zero-length circle).
    for (let lat = -90 + GRID_STEP_DEG; lat < 90; lat += GRID_STEP_DEG) {
        const alpha = lat === 0 ? PRIME_ALPHA : GRID_ALPHA;
        for (let lon = -180; lon < 180; lon += SAMPLE_STEP_DEG) {
            pushSegment(lat, lon, lat, lon + SAMPLE_STEP_DEG, alpha);
        }
    }
    // Meridians, pole to pole.
    for (let lon = -180; lon < 180; lon += GRID_STEP_DEG) {
        const alpha = lon === 0 ? PRIME_ALPHA : GRID_ALPHA;
        for (let lat = -90; lat < 90; lat += SAMPLE_STEP_DEG) {
            pushSegment(lat, lon, lat + SAMPLE_STEP_DEG, lon, alpha);
        }
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
    geometry.setAttribute("alpha", new Float32BufferAttribute(alphas, 1));
    return geometry;
}

function makeGridMaterial() {
    const a = Globals.equatorRadius, b = Globals.polarRadius;
    return new ShaderMaterial({
        uniforms: {
            color: {value: new Vector3(...GRID_COLOR)},
            // 1/a² and 1/b², pre-scaled by a² so the normal stays O(1) in float32.
            normalScale: {value: new Vector3(1, 1, (a * a) / (b * b))},
        },
        vertexShader: /* glsl */`
            attribute float alpha;
            varying float vAlpha;
            varying vec3 vWorld;
            void main() {
                vAlpha = alpha;
                vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
                // Through modelViewMatrix (built in double precision on the CPU), NOT
                // projectionMatrix * viewMatrix * world: GLSL would multiply the two matrices
                // first, and clip z and w would then each round separately against ~6e6 m
                // coordinates. With the look view's near/far range that error is larger than
                // the gap between a nearby line and the far plane, so the line gets clipped.
                gl_Position = projectionMatrix * (modelViewMatrix * vec4(position, 1.0));
            }`,
        fragmentShader: /* glsl */`
            uniform vec3 color;
            uniform vec3 normalScale;
            varying float vAlpha;
            varying vec3 vWorld;
            void main() {
                // Ellipsoid normal at this point; drop it if the camera is behind that tangent plane.
                vec3 n = vWorld * normalScale;
                if (dot(n, cameraPosition - vWorld) < 0.0) discard;
                gl_FragColor = vec4(color, vAlpha);
            }`,
        transparent: true,
        depthTest: false,
        depthWrite: false,
    });
}

export function refreshLatLonGridVisibility() {
    if (!gridLines) return;
    const mask = LAYER.perViewLayerMask(Globals.showLatLonGridMain, Globals.showLatLonGridLook);
    gridLines.layers.mask = mask;
    gridLines.visible = mask !== 0;
}

// Called once per sitch, beside setupMeasurementUI. The Show-menu rows are destroyed with the
// rest of the sitch's menus (menuBar.destroy), so they are rebuilt here every time.
export function setupLatLonGrid() {
    removeLatLonGrid();

    // Off by default in both views; a saved sitch restores its own values afterwards
    // (CustomManagerSerialize globalsNeeded) and then calls refreshLatLonGridVisibility.
    Globals.showLatLonGridMain = false;
    Globals.showLatLonGridLook = false;

    gridLines = new LineSegments(buildGridGeometry(), makeGridMaterial());
    gridLines.userData.radii = [Globals.equatorRadius, Globals.polarRadius];
    // The Earth model can change after setup (a sitch's own setting, or Terrain > Use
    // Ellipsoid), which moves every vertex and the culling normal. Checked on each draw,
    // which costs two compares; a rebuild is ~25k LLA→ECEF conversions.
    gridLines.onBeforeRender = function () {
        const [a, b] = this.userData.radii;
        if (a === Globals.equatorRadius && b === Globals.polarRadius) return;
        this.geometry.dispose();
        this.geometry = buildGridGeometry();
        this.material.dispose();
        this.material = makeGridMaterial();
        this.userData.radii = [Globals.equatorRadius, Globals.polarRadius];
    };
    gridLines.name = "LatLonGrid";
    gridLines.frustumCulled = false;
    gridLines.renderOrder = 1000;       // no depth test, so draw after the scene it sits over
    GlobalScene.add(gridLines);
    refreshLatLonGridVisibility();

    const onChange = () => {
        refreshLatLonGridVisibility();
        setRenderOne(true);
    };
    guiShowHide.add(Globals, "showLatLonGridMain").name(t("latLonGrid.inMain.label"))
        .tooltip(t("latLonGrid.inMain.tooltip")).listen().onChange(onChange)
        .shareAs(viewMenuKey("mainView", "latLonGrid"));
    guiShowHide.add(Globals, "showLatLonGridLook").name(t("latLonGrid.inLook.label"))
        .tooltip(t("latLonGrid.inLook.tooltip")).listen().onChange(onChange)
        .shareAs(viewMenuKey("lookView", "latLonGrid"));
}

export function removeLatLonGrid() {
    if (!gridLines) return;
    gridLines.parent?.remove(gridLines);
    gridLines.geometry.dispose();
    gridLines.material.dispose();
    gridLines = null;
}
