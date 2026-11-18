import {videoSkyProjection, projectSkyPoint} from "../VideoSkyProjection";
import {ConstellationLabelLayout} from "../ConstellationLabelLayout";
import {DEEP_SKY_OBJECTS, PLEIADES, PLEIADES_STARS, deepSkyCategory, groupPleiades} from "../DeepSkyObjects";
import {SIMULATED_SATELLITE_COLOR} from "../SatelliteSimulation";
// CNodeDisplaySkyOverlay takes a CNodeCanvas derived node, CNodeDisplayNightSky and a camera
// and displays star names on an overlay
import {CNodeViewUI} from "./CNodeViewUI";
import {FileManager, GlobalDateTimeNode, Globals, guiShowHide, NodeMan, setRenderOne, Sit} from "../Globals";
import {applyAnnualAberration, getStarDirectionECEF, raDec2Celestial} from "../CelestialMath";
import {applyRefractionECI, refractionUniforms, refractionOptsFromUniforms} from "../atmosphere/refraction";
import {wgs84} from "../LLA-ECEF-ENU";
import {intersectSphere2, V3} from "../threeUtils";
import {MathUtils, Ray, Raycaster, Sphere} from "three";
import {calculateAltitude} from "../threeExt";
import {getHUDColor} from "../HUDColor";
import {viewControlLabel, viewMenuKey} from "../ViewUIBarMenus";
import {renderedRect, withDisplayedCamera} from "../ViewUtils";
import {fisheye, fisheyeProjectVector, isFisheyeCamera} from "../FisheyeProjection";
import {isPanoramicCamera, panoramic, panoramicProjectVector} from "../PanoramicCamera";
import {labelPixelOffset} from "../LabelOffsets";
import {drawHorizonCompassRibbon, horizonCompassFrame} from "../HorizonCompassRibbon";
import {perViewLayerMask} from "../LayerMasks";
import {liftWorldPoint} from "../atmosphere/terrestrialRefraction";
import {isMeasurementOccluded} from "../MeasurementGeometry";

// World-space Vector3 → NDC through whatever projection the view is actually
// rendering: the fisheye twin when the fisheye applies to this camera,
// otherwise the camera's own (pinhole) projection. Mutates and returns pos,
// like Vector3.project, so labels land on the rendered dots in both modes.
function projectForCamera(pos, camera) {
    if (projectSkyPoint(pos, camera)) return pos;
    if (!panoramicProjectVector(pos, camera) && !fisheyeProjectVector(pos, camera)) pos.project(camera);
    return pos;
}

// The text a satellite label is drawn with. Cached on the record because the Label List
// filter needs it for every visible satellite, every frame, and satData runs to ~11,000
// entries. Safe to cache: loading a new TLE/OMM file builds fresh satData objects.
function satelliteLabelText(sat) {
    if (sat.labelText === undefined) {
        sat.labelText = sat.name.replace("0 STARLINK", "SL").replace("STARLINK", "SL").replace(/\s+$/, '');
    }
    return sat.labelText;
}

// The names a satellite answers to in the Label List: the text drawn on screen, plus the
// catalog name behind it with any TLE line-0 marker stripped. Keeping the STARLINK/SL
// equivalence HERE, on the satellite, is what lets "STARLINK-1234" find a label reading
// "SL-1234" without the filter having to invent a broader "SL-" prefix - which would also
// catch the unrelated "SL-16 R/B" Zenit rocket bodies in mixed catalogues. Cached for the
// same reason as labelText.
function satelliteLabelNames(sat) {
    if (sat.labelNames === undefined) {
        const catalogName = sat.name.replace(/^0\s+/, '').replace(/\s+$/, '');
        const labelText = satelliteLabelText(sat);
        sat.labelNames = catalogName === labelText ? [labelText] : [labelText, catalogName];
    }
    return sat.labelNames;
}

const registeredLabels = new Set();

export function registerLabel3D(label) {
    registeredLabels.add(label);
}

export function unregisterLabel3D(label) {
    registeredLabels.delete(label);
}

// Scope geometry visibility to the actual draw. Restore it even on render failure,
// so one camera cannot hide another camera's measurements or stop their updates.
export function withVisibleMeasurements(camera, render) {
    const observer = camera.getWorldPosition(V3());
    const hidden = [];
    for (const label of registeredLabels) {
        if (label.group?.visible && isMeasurementOccluded(label, observer)) {
            hidden.push(label.group);
            label.group.visible = false;
        }
    }
    try {
        return render();
    } finally {
        for (const group of hidden) group.visible = true;
    }
}

export class CNodeDisplaySkyOverlay extends CNodeViewUI {

    constructor(v) {
        super(v);
        this.addInput("startTime", GlobalDateTimeNode)

        this.nightSky = v.nightSky;
        this.isVideo = this.overlayView.id === "video";
        // A template can start with Video hidden. Parent visibility is handled
        // by ViewMan; the overlay must be ready when the first image reveals it.
        if (this.isVideo) this.visible = true;

        this.showStarNames = false;
        this.onlyLabelPlanets = false;

        const gui = v.gui ?? guiShowHide;

        if (this.overlayView.id === "lookView") {
            this.syncVideoZoom = true;
        }

        // These two are per-view by construction — there is one sky overlay per 3D view — so the
        // Show ▸ Celestial rows have to name the view. Composed rather than translated because
        // the set of views is not known up front; viewControlLabel keeps them to the same
        // "<Thing> in Main" / "<Thing> in Look" shape as every other per-view row. The header
        // menus mirror the same controllers and drop the suffix, since the menu names the view.
        const starNames = gui.add(this, "showStarNames").asListCheckbox().onChange(() => {
            this.onlyPlanetsController?.enable(this.showStarNames);
            setRenderOne(true);
        }).name(viewControlLabel(this.overlayView.id, "Star/Planet Names"))
            .tooltip("Show name labels in this view for the named stars, and for the Sun, Moon and planets.\nStars fainter than Celestial > Stars and Planets > Star Magnitude Limit get no label.").listen();
        this.addSimpleSerial("showStarNames");
        starNames.shareAs(viewMenuKey(this.overlayView.id, "starNames"))
            .asViewCheckbox(this.overlayView.id, "Star/Planet Names");

        const onlyPlanets = this.onlyPlanetsController = gui.add(this, "onlyLabelPlanets").asListCheckbox().onChange(() => {
            setRenderOne(true);
        }).name(viewControlLabel(this.overlayView.id, "Planets Only"))
            .tooltip("Restrict Star/Planet Names to the Sun, Moon and planets in this view. Enable Star/Planet Names first.").listen();
        onlyPlanets.enable(this.showStarNames);
        this.addSimpleSerial("onlyLabelPlanets");
        onlyPlanets.shareAs(viewMenuKey(this.overlayView.id, "onlyPlanets"))
            .asViewCheckbox(this.overlayView.id, "Planets Only");

    }

    modDeserialize(v) {
        super.modDeserialize(v);
        this.onlyPlanetsController?.enable(this.showStarNames);
    }

    // The host view's camera, read LIVE rather than captured at construction.
    // CNodeView3D.camera is itself a getter onto cameraNode.camera, so a stored
    // copy goes stale the moment the camera node swaps its camera — and the
    // projection would then disagree with the Earth-occlusion tests below, which
    // read the camera POSITION through this same handle.
    get camera() {
        return this.isVideo ? NodeMan.get("lookView", false)?.camera : this.overlayView.camera;
    }

    // A projection-only copy of the camera the host view was actually RENDERED with.
    //
    // `live` comes from withDisplayedCamera(), i.e. it has been through
    // prepareCameraForLOD() and carries every display-only transform the render
    // applies: the fovCoverage widening, Match Video Aspect's fov+aspect rewrite,
    // the video-pan asymmetric frustum in projectionMatrix.elements[8]/[9], the
    // y-compress in elements[5], the camera-tweak rotation and the display lookAt.
    //
    // Camera.copy() carries projectionMatrix/projectionMatrixInverse across, and we
    // must NOT call updateProjectionMatrix() on the copy: rebuilding from fov/aspect
    // /zoom would silently discard the pan and y-compress patches, which are written
    // straight into the matrix and cannot be reproduced from those three numbers.
    //
    // atOrigin moves the copy to the world origin for the celestial sphere, which is
    // rendered in GlobalNightSkyScene with the camera there; the projection is
    // untouched, only the view matrix changes.
    displayedCamera(live, atOrigin = false) {
        const camera = live.clone();
        // The fisheye gate compares camera IDENTITY against the live look
        // camera; a clone would silently fail it and put every label back on
        // the pinhole projection while the dots render fisheye. Tag the copy
        // so isFisheyeCamera can unwrap it.
        camera._panoramaProxyFor = live._panoramaProxyFor ?? live;
        camera._fisheyeProxyFor = live._fisheyeProxyFor ?? live;
        camera._videoSky = live._videoSky;
        if (atOrigin) {
            camera.position.set(0, 0, 0);
            camera.updateMatrix();
            camera.matrixWorld.copy(camera.matrix);
            camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
        }
        return camera;
    }

    // NDC -> canvas pixels, through the rectangle the 3D actually fills.
    //
    // That is NOT the whole overlay: with Match Video Aspect on, CNodeView3D
    // letterboxes by resizing and centring the 3D canvas ELEMENT inside the shared
    // div, so NDC +-1 spans only part of this overlay's pixel space. Mapping over the
    // full div instead stretched every label radially from the pane centre by
    // videoAspect/viewAspect — measured at 1.1626, up to 56 px out at the edges.
    // Same mapping as projectToCanvas() in FitSurfacePick.js.
    labelXY(ndc) {
        if (this._videoProjection) return this._videoProjection.labelXY(ndc);
        const r = this._renderedRect;
        return [r.x + (ndc.x + 1) * 0.5 * r.w, r.y + (1 - ndc.y) * 0.5 * r.h];
    }

    get showSatelliteNames() {
        const isLookView = this.overlayView.id === "lookView";
        const isMainView = this.overlayView.id === "mainView";
        return (isLookView && this.nightSky.satellites.showSatelliteNames)
            || (isMainView && this.nightSky.satellites.showSatelliteNamesMain);
    }

    get maxSatelliteLabels() {
        return this.nightSky.maxLabelsDisplayed;
    }

    // Shared by the 3D views, independently of the constellation line switch.
    get showConstellationNames() {
        if (this.isVideo) return !!this.nightSky.showConstellationNamesVideo;
        return !!(this.camera.layers.mask & perViewLayerMask(
            this.nightSky?.showConstellationNamesMain, this.nightSky?.showConstellationNamesLook));
    }

    get showHorizonCompassRibbon() {
        if (this.isVideo) return !!this.nightSky.showHorizonCompassRibbonVideo;
        return !!(this.camera.layers.mask & perViewLayerMask(
            this.nightSky?.showHorizonCompassRibbonMain, this.nightSky?.showHorizonCompassRibbonLook));
    }

    /**
     * The constellation labels, prepared once rather than per frame: 89 features whose names
     * and positions never change, against a draw that runs every rendered frame.
     *
     * Keyed on the DATA OBJECT, so a dataset that arrives after the first render - the file is
     * fetched with the asterism lines, and this overlay may well draw before it lands -
     * rebuilds the cache instead of leaving it empty for the session.
     */
    constellationLabels() {
        // Not `get(id)`: its default asserts on a missing key, and this runs per frame while
        // the file may still be in flight.
        const data = FileManager.get("constellations", false);
        if (!data?.features) return null;
        if (this._constellationLabelsFor !== data) {
            this._constellationLabelsFor = data;
            this._constellationLabels = data.features.map((f) => {
                // The label position the dataset ships, not a centroid computed from the
                // lines: a constellation is not convex, and the shipped point is placed where
                // the name reads well - inside the figure, clear of its own stars.
                const [raDeg, decDeg] = f.geometry.coordinates;
                const ra = MathUtils.degToRad(Number(raDeg));
                const dec = MathUtils.degToRad(Number(decDeg));
                // `name` is the IAU Latin name, diacritics and all - Boötes, Canis Major -
                // which is what a star chart is labelled with in any language. Deliberately
                // NOT the file's per-language fields: those translate the MEANING, so English
                // would read "Swan", "Crab" and "Air Pump" where an astronomer expects Cygnus,
                // Cancer and Antlia. 73 of the 89 differ that way.
                // Serpens has two separate label positions with the same catalog ID.
                return {id: `${f.id}:${raDeg}:${decDeg}`, name: f.properties.name, ra, dec, pos: raDec2Celestial(ra, dec, 100)};
            });
        }
        return this._constellationLabels;
    }

    get showDeepSkyObjects() {
        const suffix = this.isVideo ? "Video" : this.overlayView.id === "mainView" ? "Main" : "Look";
        return !!this.nightSky[`showDeepSkyObjects${suffix}`];
    }

    renderCanvas(frame) {
        super.renderCanvas(frame);
        const showStarNames = this.showStarNames && this.nightSky.showStars !== false;
        const showPoints = this.isVideo && this.nightSky.showStarsVideo && this.nightSky.showStars !== false;
        if (!(showStarNames || showPoints || this.showDeepSkyObjects || this.showSatelliteNames
            || this.showConstellationNames || this.showHorizonCompassRibbon
            || (!this.isVideo && registeredLabels.size))) return;

        this._videoProjection = this.isVideo ? videoSkyProjection(this.overlayView, frame) : null;
        if (this.isVideo && !this._videoProjection) return;
        this._renderedRect = this._videoProjection?.rect ?? renderedRect(this.overlayView, this.widthPx, this.heightPx);
        this._celestialLabelBoxes = [];
        const draw = live => {
            if (this.showHorizonCompassRibbon) this.renderHorizonCompassRibbon(live);
            if (!this.isVideo) this.renderLabels3D(frame, this.displayedCamera(live));
            // A photo can be registered correctly at an unknown place/time. Its annotations
            // describe the photographed sky, independently of the simulated ground/daylight.
            const earthSphere = this.isVideo ? null : new Sphere(V3(0, 0, 0), wgs84.POLAR_RADIUS);
            const actualCameraPosition = live.position;
            const date = this.in.startTime.dateNow;
            const sun = NodeMan.get("theSun", false);
            const starAlpha = this.isVideo || !sun ? 1
                : Math.max(0, 1 - sun.calculateSkyBrightness(actualCameraPosition, date));
            const skyOpacity = this.isVideo || !sun ? 0 : sun.calculateSkyOpacity(actualCameraPosition, date);
            const camera = this.displayedCamera(live, true);
            this.drawAtCelestialLabelOpacity(() => {
                this.ctx.font = `${this.nightSky.celestialLabelSize ?? 12}px Arial`;
                this.ctx.textAlign = "left";
                this.ctx.fillStyle = "#ffffff";
                this._groupPleiades = false;
                if (skyOpacity < 1 && (this.showDeepSkyObjects || (showStarNames && !this.onlyLabelPlanets))) {
                    this.renderDeepSkyObjects(camera, earthSphere, actualCameraPosition, date, showStarNames, starAlpha);
                }
                if (showStarNames) this.renderStarNames(camera, earthSphere, actualCameraPosition, date, starAlpha);
                if (showPoints) this.renderVideoPoints(camera, date);
                if (this.showSatelliteNames) this.renderSatelliteNames(this.displayedCamera(live), earthSphere, starAlpha);
                if (this.showConstellationNames && skyOpacity < 1) {
                    this.renderConstellationNames(camera, earthSphere, actualCameraPosition, date);
                }
            });
        };
        if (this._videoProjection) {
            this._videoProjection.begin(this.ctx, this.widthPx, this.heightPx);
            try { draw(this._videoProjection.camera); } finally { this.ctx.restore(); }
        } else withDisplayedCamera(this.overlayView, draw);
    }

    // Point names stay fixed to their objects. Their measured text bounds reserve
    // space for the constellation names, which are placed after all point names.
    drawCelestialPointLabel(text, x, y, opacity = 1) {
        this.ctx.fillText(text, x, y);
        if (!this._celestialLabelBoxes || this.ctx.globalAlpha === 0 || opacity === 0) return;
        const size = this.nightSky.celestialLabelSize ?? 12;
        const metrics = this.ctx.measureText(text);
        const ascent = metrics.actualBoundingBoxAscent ?? size;
        const descent = metrics.actualBoundingBoxDescent ?? 3;
        this._celestialLabelBoxes.push({x, y: y - ascent, w: metrics.width, h: ascent + descent});
    }

    celestialLabelRect() {
        const r = this._videoProjection?.clipRect ?? this._renderedRect;
        const x = Math.max(0, r.x), y = Math.max(0, r.y);
        return {x, y, w: Math.max(0, Math.min(this.widthPx ?? r.x + r.w, r.x + r.w) - x),
            h: Math.max(0, Math.min(this.heightPx ?? r.y + r.h, r.y + r.h) - y)};
    }

    projectCatalogPosition(ra, dec, camera, earthSphere, observer, date) {
        const pos = applyAnnualAberration(raDec2Celestial(ra, dec, 100), date);
        if (refractionUniforms.uRefractionEnabled.value > 0.5) {
            applyRefractionECI(pos, refractionUniforms.uZenithECI.value, refractionOptsFromUniforms());
        }
        pos.applyMatrix4(this.nightSky.celestialSphere.matrix);
        if (earthSphere && intersectSphere2(new Ray(observer, pos.clone().normalize()), earthSphere, V3(), V3())) return null;
        projectForCamera(pos, camera);
        if (!(pos.z > -1 && pos.z < 1) || !Number.isFinite(pos.x + pos.y)) return null;
        return {ndc: pos, xy: this.labelXY(pos)};
    }

    renderDeepSkyObjects(camera, earthSphere, observer, date, showStarNames, alpha) {
        const sky = this.nightSky, ctx = this.ctx;
        const radians = Math.PI / 180;
        const project = (ra, dec) => this.projectCatalogPosition(ra * radians, dec * radians, camera, earthSphere, observer, date);
        const marker = object => {
            const center = project(object.ra, object.dec);
            if (!center || Math.abs(center.ndc.x) > 1 || Math.abs(center.ndc.y) > 1) return null;
            const radiusDeg = object === PLEIADES ? 1.1 : Math.max(0.02, parseFloat(object.size) / 120);
            const edge = project(object.ra, Math.min(89.99, object.dec + radiusDeg));
            const radius = edge ? Math.hypot(edge.xy[0] - center.xy[0], edge.xy[1] - center.xy[1]) : 4;
            return {x: center.xy[0], y: center.xy[1], radius: Math.max(4, radius)};
        };
        const pleiadesMarker = marker(PLEIADES);
        this._groupPleiades = !!(showStarNames && !this.onlyLabelPlanets && pleiadesMarker
            && groupPleiades(pleiadesMarker.radius * 2, sky.groupPleiades !== false)
            && (!sky.labelListPrefixes || sky.labelPassesAny(["Pleiades", "M45", "M 45"])));
        const boxes = [];
        ctx.save();
        ctx.globalAlpha *= alpha;
        for (const object of DEEP_SKY_OBJECTS) {
            const grouped = object === PLEIADES && this._groupPleiades;
            const category = deepSkyCategory(object);
            if (!grouped && (!this.showDeepSkyObjects || sky[`deepSky${category}`] === false
                || object.mag > (sky.deepSkyMagnitude ?? 10.5))) continue;
            const name = object === PLEIADES ? "Pleiades" : object.name;
            if (!grouped && sky.labelListPrefixes && !sky.labelPassesAny([name, object.id, object.name])) continue;
            const point = object === PLEIADES ? pleiadesMarker : marker(object);
            if (!point) continue;
            const {x, y, radius} = point;
            const labelX = x + radius + 5, labelY = y + 4;
            const width = ctx.measureText(name).width, height = sky.celestialLabelSize ?? 12;
            const box = [labelX, labelY - height, labelX + width, labelY + 2];
            if (!grouped && boxes.some(b => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
            boxes.push(box);
            ctx.strokeStyle = ctx.fillStyle = category === "Galaxies" ? "#efaa99" : category === "Clusters" ? "#e7d28c" : "#9fd4ca";
            ctx.lineWidth = 0.7;
            ctx.setLineDash(category === "Clusters" ? [2, 3] : []);
            ctx.beginPath();
            ctx.ellipse(x, y, radius, category === "Galaxies" ? Math.max(3, radius * 0.55) : radius, 0, 0, 2 * Math.PI);
            ctx.stroke();
            this.drawCelestialPointLabel(name, labelX, labelY);
        }
        ctx.restore();
    }

    renderVideoPoints(camera, date) {
        const field = this.nightSky.starField, ctx = this.ctx;
        ctx.save();
        ctx.fillStyle = "#ffffff";
        for (let i = 0; i < field.getStarCount(); i++) {
            const magnitude = field.getStarMagnitude(i);
            if (magnitude > Sit.starLimit) continue;
            const point = this.projectCatalogPosition(field.getStarRA(i), field.getStarDEC(i), camera, null, camera.position, date);
            if (!point || Math.abs(point.ndc.x) > 1 || Math.abs(point.ndc.y) > 1) continue;
            ctx.beginPath();
            ctx.arc(...point.xy, Math.max(0.5, (5 - magnitude) * 0.3), 0, 2 * Math.PI);
            ctx.fill();
        }
        for (const planet of Object.values(this.nightSky.planets.planetSprites)) {
            const pos = planet.equatorial.clone().applyMatrix4(this.nightSky.celestialSphere.matrix);
            projectForCamera(pos, camera);
            if (pos.z < -1 || pos.z > 1 || Math.abs(pos.x) > 1 || Math.abs(pos.y) > 1) continue;
            ctx.fillStyle = planet.color;
            ctx.beginPath(); ctx.arc(...this.labelXY(pos), 2, 0, 2 * Math.PI); ctx.fill();
        }
        ctx.restore();
    }

    // Run a draw of the constellation, star, planet or satellite names at Show > Celestial >
    // Labels > Label Opacity. The canvas multiplies every fill by globalAlpha, so the opacity
    // combines with the twilight fade that the names carry in their fill color, and it
    // applies to a color of any form. At 1 the draw is the same as with no opacity control.
    // At 0 the draw still runs and paints nothing: the satellite pass also records which
    // satellites the look view sees (sat.visibleInLook), and Label Look Visible Only and the
    // satellite arrows read that.
    drawAtCelestialLabelOpacity(draw) {
        const alphaBefore = this.ctx.globalAlpha;
        this.ctx.globalAlpha = alphaBefore * (this.nightSky.celestialLabelOpacity ?? 1);
        draw();
        this.ctx.globalAlpha = alphaBefore;
    }

    renderHorizonCompassRibbon(live) {
        const frame = horizonCompassFrame(live.position, Globals.equatorRadius, Globals.polarRadius);
        const camera = this.displayedCamera(live, true);
        const pos = V3();
        const forward = camera.getWorldDirection(V3());
        const nonlinear = isFisheyeCamera(camera) || isPanoramicCamera(camera);
        // Sky directions have no depth. Place them between the camera's clip
        // planes so the label projection also works with a distant main camera.
        const distance = Math.sqrt(camera.near * camera.far);
        const project = direction => {
            if (!nonlinear && direction.dot(forward) <= 0) return null;
            projectForCamera(pos.copy(direction).multiplyScalar(distance), camera);
            if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || pos.z < -1 || pos.z > 1) return null;
            const [x, y] = this.labelXY(pos);
            return {x, y};
        };
        const rect = this._renderedRect;
        const panorama = isPanoramicCamera(camera);
        // A zoom-dependent angular scale, independent of camera heading and
        // roll, keeps the selected tick/label bearings stable while dragging.
        let pixelsPerDegree;
        if (panorama) {
            pixelsPerDegree = rect.w / panoramic.hfov;
        } else if (isFisheyeCamera(camera)) {
            pixelsPerDegree = 0.7 * rect.h * fisheye.circlePct / 100 / fisheye.fov;
        } else {
            const m = camera.projectionMatrix.elements;
            pixelsPerDegree = Math.min(Math.abs(m[0]) * rect.w, Math.abs(m[5]) * rect.h) * Math.PI / 360;
        }
        drawHorizonCompassRibbon(this.ctx, frame, project, rect, {
            wrap: panorama,
            opacity: this.nightSky.horizonCompassOpacity,
            textSize: this.nightSky.horizonCompassTextSize,
            showCardinals: this.nightSky.showHorizonCompassCardinals,
            showDegrees: this.nightSky.showHorizonCompassHeadings,
            pixelsPerDegree,
        });
    }

    /**
     * Constellation names use the same projection, refraction and occlusion as
     * the asterism lines, with their own visibility switch.
     */
    renderConstellationNames(camera, earthSphere, actualCameraPosition, date) {
        const labels = this.constellationLabels();
        if (!labels) return;

        // Region names can shift locally to remain readable; point names stay fixed.
        const fontSize = (this.nightSky.celestialLabelSize ?? 12) * 4 / 3;
        this.ctx.font = `${fontSize}px Arial`;
        this.ctx.textAlign = 'center';
        // The grey of the asterism lines (0x808080), lifted enough to hold up as text, so a name
        // reads as belonging to the figure it sits in and stays quieter than the white star
        // names drawn over it.
        //
        // Deliberately NOT faded by sky brightness the way the star and satellite labels are.
        // The constellation LINES carry no fade of their own - addConstellationLines gives them
        // a plain LineBasicMaterial - they are simply drawn or not drawn, so a name that dimmed
        // through twilight would be doing something its own figure never does. The "or not
        // drawn" half is the caller's skyOpacity gate; both halves are needed, and checking only
        // the material (as an earlier version of this comment did) misses the render-level skip
        // entirely.
        this.ctx.fillStyle = "#a8a8a8";

        // The line material has refraction installed on it (installRefractionOnMaterial in
        // addConstellationLines), so the lines are bent in the shader. The names have to be bent
        // by the same amount or they part from their figures near the horizon, where the bend is
        // most of half a degree.
        const refractApplies = refractionUniforms.uRefractionEnabled.value > 0.5;
        const refractOpts = refractApplies ? refractionOptsFromUniforms() : null;

        const target0 = V3();
        const target1 = V3();
        const candidates = [];
        for (const c of labels) {
            // Cloned because applyRefractionECI, applyMatrix4 and project all mutate, and the
            // cached position has to survive for the next frame.
            const pos = c.pos.clone();
            if (refractApplies) {
                applyRefractionECI(pos, refractionUniforms.uZenithECI.value, refractOpts);
            }

            // Occluded on the APPARENT sightline, for the same reason the star labels are: a
            // constellation refracted into view from below the horizon has its lines drawn, and
            // testing the true direction would suppress the name off a figure you can see.
            const direction = refractApplies
                ? pos.clone().applyMatrix4(this.nightSky.celestialSphere.matrix).normalize()
                : getStarDirectionECEF(c.ra, c.dec, date);
            const ray = new Ray(actualCameraPosition, direction);
            if (earthSphere && intersectSphere2(ray, earthSphere, target0, target1)) continue;

            pos.applyMatrix4(this.nightSky.celestialSphere.matrix);
            projectForCamera(pos, camera);

            if (pos.z > -1 && pos.z < 1) {
                const [x, y] = this.labelXY(pos);
                const metrics = this.ctx.measureText(c.name);
                const ascent = metrics.actualBoundingBoxAscent ?? fontSize;
                const descent = metrics.actualBoundingBoxDescent ?? 3;
                candidates.push({id: c.id ?? c.name, name: c.name, x, y: y + (descent - ascent) / 2,
                    w: metrics.width, h: ascent + descent, baseline: (ascent - descent) / 2});
            }
        }

        this._constellationLayout ??= new ConstellationLabelLayout();
        for (const label of this._constellationLayout.place(candidates, this.celestialLabelRect(), this._celestialLabelBoxes)) {
            this.ctx.fillText(label.name, label.x, label.y + label.baseline);
        }

        this.ctx.textAlign = 'left';
    }

    renderStarNames(camera, earthSphere, actualCameraPosition, date, starAlpha = 1) {
        const alphaHex = Math.floor(starAlpha * 255).toString(16).padStart(2, '0');

        // Show > Celestial > Labels > Name Filter. Hoisted out of the loops: null means the box is
        // empty, which is the usual case and then costs one comparison per label.
        const labelList = this.nightSky.labelListPrefixes;

        if (!this.onlyLabelPlanets) {
            this.ctx.fillStyle = "#ffffff" + alphaHex;
            const refractApplies = refractionUniforms.uRefractionEnabled.value > 0.5;
            const refractOpts = refractApplies ? refractionOptsFromUniforms() : null;
            for (var HR in this.nightSky.starField.commonNames) {
                const n = HR - 1

                const starName = this.nightSky.starField.commonNames[HR]
                if (this._groupPleiades && PLEIADES_STARS.has(starName)) continue;
                if (labelList && !this.nightSky.labelPasses(starName)) {
                    continue
                }

                const mag = this.nightSky.starField.getStarMagnitude(n)
                if (mag > Sit.starLimit) {
                    continue
                }

                const ra = this.nightSky.starField.getStarRA(n)
                const dec = this.nightSky.starField.getStarDEC(n)

                const pos = applyAnnualAberration(raDec2Celestial(ra, dec, 100), date)
                if (refractApplies) {
                    applyRefractionECI(pos, refractionUniforms.uZenithECI.value, refractOpts);
                }

                // Earth-occlude using the *apparent* sightline so a star
                // refracted into view from below the horizon doesn't get
                // its label suppressed while the rendered dot is visible.
                const starDirection = refractApplies
                    ? pos.clone().applyMatrix4(this.nightSky.celestialSphere.matrix).normalize()
                    : getStarDirectionECEF(ra, dec, date)

                const ray = new Ray(actualCameraPosition, starDirection)
                const target0 = V3()
                const target1 = V3()
                if (earthSphere && intersectSphere2(ray, earthSphere, target0, target1)) {
                    continue
                }
                pos.applyMatrix4(this.nightSky.celestialSphere.matrix)
                projectForCamera(pos, camera)

                if (pos.z > -1 && pos.z < 1 && pos.x >= -1 && pos.x <= 1 && pos.y >= -1 && pos.y <= 1) {
                    const [x, y] = this.labelXY(pos);
                    this.drawCelestialPointLabel(starName, x + 5, y - 5, starAlpha)
                }
            }
        }

        for (const [name, planet] of Object.entries(this.nightSky.planets.planetSprites)) {
            if (labelList && !this.nightSky.labelPasses(name)) continue;

            const pos = planet.equatorial.clone()
            pos.applyMatrix4(this.nightSky.celestialSphere.matrix)
            projectForCamera(pos, camera)

            // Apply alpha to the planet's own color
            const c = planet.color;
            const alphaColor = c.length === 7 ? c + alphaHex : c;
            this.ctx.strokeStyle = alphaColor;
            this.ctx.fillStyle = alphaColor;

            if (pos.z > -1 && pos.z < 1 && pos.x >= -1 && pos.x <= 1 && pos.y >= -1 && pos.y <= 1) {
                const [x, y] = this.labelXY(pos);
                this.drawCelestialPointLabel(name, x + 5, y - 5, starAlpha)
            }
        }
    }

    renderSatelliteNames(camera, earthSphere, starAlpha = 1) {
        const satellites = this.nightSky.satellites;
        if (!satellites.renderTLEData) return;

        const isLookView = this.overlayView.id === "lookView";
        const isMainView = this.overlayView.id === "mainView";

        const cameraPos = this.camera.position;
        const satData = satellites.renderTLEData.satData;
        const numSats = satData.length;

        const labelList = this.nightSky.labelListPrefixes;

        const raycaster = new Raycaster();
        const hitPoint = V3();
        const hitPoint2 = V3();
        const arrowRangeSq = (satellites.arrowRange * 1000) ** 2;

        const candidates = [];

        if (isLookView) {
            for (let i = 0; i < numSats; i++) {
                satData[i].visibleInLook = false;
            }
        }
        
        for (let i = 0; i < numSats; i++) {
            const sat = satData[i];
            if (!sat.visible || sat.invalidPosition) continue;

            // Hide co-located satellites (docked to the camera satellite) in look view
            if (isLookView && sat.hiddenInLookView) continue;

            if (satellites.labelFlares && !sat.isFlaring) continue;
            if (satellites.labelLit && !sat.isLit) continue;
            if (isMainView && satellites.labelLookVisible && !sat.visibleInLook) continue;

            // Tested here, with the other label filters, so a name that is filtered out
            // also skips the projection and Earth-occlusion work below.
            if (labelList && !this.nightSky.labelPassesAny(satelliteLabelNames(sat))) continue;

            // arrowRange is a physical-range filter, so use the geometric
            // satellite position. Screen projection and Earth-occlusion use
            // the apparent position so the label tracks the rendered dot
            // when refraction lifts a sub-horizon satellite into view.
            const satRender = sat.ecefApparent || sat.ecef;
            const distSq = sat.ecef.distanceToSquared(cameraPos);
            if (!sat.userFiltered && distSq >= arrowRangeSq) continue;

            // Behind-the-camera-plane rejection is a PINHOLE concept: a fisheye
            // field past 180° legitimately images that sky (the projection twin
            // parks anything past its cull cap outside the z window instead).
            const viewPos = satRender.clone().applyMatrix4(camera.matrixWorldInverse);
            if (viewPos.z >= 0 && !isFisheyeCamera(camera) && !isPanoramicCamera(camera)) continue;

            const satScreenPos = projectForCamera(satRender.clone(), camera);
            if (satScreenPos.z < -1 || satScreenPos.z > 1) continue;
            const isInsideFrustum = satScreenPos.x >= -1 && satScreenPos.x <= 1 &&
                satScreenPos.y >= -1 && satScreenPos.y <= 1;

            if (!isInsideFrustum) {
                if (satScreenPos.x < -1) {
                    const [pixelX] = this.labelXY(satScreenPos);
                    const offscreenPixels = -pixelX;
                    if (offscreenPixels > 30 * 16) {
                        continue;
                    }
                } else {
                    continue;
                }
            }

            const camToSat = satRender.clone().sub(cameraPos);
            const distToSat = camToSat.length();
            raycaster.set(cameraPos, camToSat.normalize());
            const isOccluded = intersectSphere2(raycaster.ray, earthSphere, hitPoint, hitPoint2)
                && hitPoint.distanceTo(cameraPos) < distToSat;
            if (isOccluded) continue;

            if (isLookView && isInsideFrustum) {
                sat.visibleInLook = true;
            }

            candidates.push({ index: i, distSq, screenPos: satScreenPos });
        }

        candidates.sort((a, b) => a.distSq - b.distSq);
        
        const alphaHex = Math.floor(starAlpha * 255).toString(16).padStart(2, '0');
        this.ctx.fillStyle = "#ffffff" + alphaHex;

        const maxLabels = this.maxSatelliteLabels;
        for (let i = 0; i < candidates.length && i < maxLabels; i++) {
            const sat = satData[candidates[i].index];
            const screenPos = candidates[i].screenPos;

            const [x, y] = this.labelXY(screenPos);

            this.ctx.fillStyle = (sat.simulated ? SIMULATED_SATELLITE_COLOR : "#ffffff") + alphaHex;
            this.drawCelestialPointLabel(satelliteLabelText(sat), x + 5, y - 5, starAlpha)
        }
    }

    renderLabels3D(frame, camera) {
        if (registeredLabels.size === 0) return;

        const viewLayerMask = this.camera.layers.mask;
        const observer = camera.getWorldPosition(V3());

        for (const label of registeredLabels) {
            if (!label.group || !label.group.visible) continue;
            if (!(label.groupNode.group.layers.mask & viewLayerMask)) continue;
            if (!(label.layerMask & viewLayerMask)) continue;
            if (!label.shouldRender(viewLayerMask)) continue;
            if (isMeasurementOccluded(label, observer)) continue;

            // Call preRender to ensure textPosition is calculated for THIS view
            // (view-dependent for negative-length arrows that use pixelsToMeters)
            if (label.preRender) {
                label.preRender(this.overlayView);
            }

            // The overlay's projection camera is a copy. Use the host camera
            // for its ray table, so finite labels follow the same pre-depth
            // projection as their anchors and arrows.
            const rayContext = this.overlayView.camera?._rayGeometryPass?.geometryContext();
            if (rayContext) {
                const rel = label.textPosition.clone().sub(rayContext.observer);
                const up = rel.dot(rayContext.zenith);
                const distances = rayContext.rayTable.distances;
                if (rel.lengthSq() - up * up > distances[distances.length - 1] ** 2) continue;
            }
            const screenPos = projectForCamera(liftWorldPoint(rayContext, label.textPosition), camera);
            if (screenPos.z < -1 || screenPos.z > 1) continue;
            if (screenPos.x < -1.5 || screenPos.x > 1.5
                || screenPos.y < -1.5 || screenPos.y > 1.5) continue;

            const altitude = calculateAltitude(label.textPosition);
            let transparency = 1;
            if (altitude < 0) {
                const fadeDepth = 25000;
                if (altitude < -fadeDepth) {
                    transparency = 0;
                } else {
                    transparency = 1 + altitude / fadeDepth;
                }
            }
            if (transparency <= 0) continue;

            const textAlign = label.textAlign || 'left';
            let [x, y] = this.labelXY(screenPos);

            // label.offset is applied here in 2D rather than by nudging the 3D
            // position through offsetScreenPixels() and re-projecting. That round
            // trip only worked when the projection it used matched the one the label
            // is drawn with, which stops being true as soon as the view is letterboxed.
            //
            // The 0.5 keeps the on-screen result identical to what it has always been:
            // offsetScreenPixels() steps NDC by pixels/widthPx, and NDC spans 2, not 1,
            // so every offsetX/offsetY has in practice always moved a label by HALF its
            // nominal pixels. Those values are node-definition data and reach us from
            // saved sitches, so they are taken as they have always behaved rather than
            // reinterpreted — correcting the factor here would move every existing label.
            if (label.offset) {
                const offset = labelPixelOffset(label);
                x += offset.x;
                y -= offset.y;
            }

            if (textAlign === 'left') {
                x -= 5;
                y += 5;
            }

            const fontSize = label.size || 12;
            this.ctx.font = (label.fontWeight ? label.fontWeight + ' ' : '') + Math.floor(fontSize) + 'px Arial';
            this.ctx.textAlign = textAlign;
            
            const alpha = Math.floor(transparency * 255).toString(16).padStart(2, '0');
            const color = label.useHUDColor ? getHUDColor(transparency) : (label.color || '#FFFFFF');
            this.ctx.fillStyle = label.useHUDColor
                ? color
                : color.length === 7 ? color + alpha : color;
            
            const lines = label.text.split('\n');
            const lineHeight = fontSize * 1.2;
            const totalHeight = lines.length * lineHeight;
            let startY = y - totalHeight / 2 + lineHeight / 2;
            
            for (const line of lines) {
                if (label.strokeWidth && label.strokeColor) {
                    this.ctx.strokeStyle = label.strokeColor;
                    this.ctx.lineWidth = label.strokeWidth;
                    this.ctx.strokeText(line, x, startY);
                }
                this.ctx.fillText(line, x, startY);
                startY += lineHeight;
            }
        }
    }
}
