//var matLineWhiteThin = makeMatLine(0xFFFFFF, 0.75);
import {disposeMatLine, makeMatLine} from "../MatLines";
import {setRenderOne, Sit} from "../Globals";
import {getLOSFolder} from "../LOSFrustumMenu";
import {DebugSphere, dispose, intersectSurface} from "../threeExt";
import {par} from "../par";
import {metersFromMiles} from "../utils";
import {CNode3DGroup} from "./CNode3DGroup";
import {getLocalUpVector} from "../SphericalMath";
import {ECEFToLLA_radii} from "../LLA-ECEF-ENU";
import {degrees} from "../mathUtils";
import {meanSeaLevelOffset} from "../EGM96Geoid";
import {t} from "../i18n";
import {viewMenuKey} from "../ViewUIBarMenus";

import {LineGeometry} from "../SceneLineGeometry";
import {Line2} from "three/addons/lines/Line2.js";
import {Group} from "three";
import * as LAYER from "../LayerMasks";

const matLineGreyThin = makeMatLine(0x404040, 0.50);

// Often every line of sight is the same line: a fixed camera aimed by fixed
// angles sees along one line in every frame (an allsky camera, a tripod). Then a
// single line is drawn, and it follows the camera in real time (update), so a
// drag of the look view moves it at once. The full set, one camera evaluation
// per line, takes hundreds of ms in a long sitch, which is why a look-view drag
// recalculates it only when the drag pauses (CameraControls CASCADE_PAUSE_MS).
// recalculate() decides from SINGLE_PROBES evenly spaced lines, then checks the
// rest in short background slices; if any differs, the full set is drawn.
const SINGLE_PROBES = 17;
const SAME_POSITION_M = 0.01;
const SAME_HEADING_RAD = 1e-7;
const VERIFY_SLICE_MS = 8;

function sameLOS(a, b) {
    return a.position.distanceTo(b.position) < SAME_POSITION_M && a.heading.angleTo(b.heading) < SAME_HEADING_RAD;
}
const matLineWhite = makeMatLine(0xffffff, 1);
// CNodeDisplayLOS display the Lines Of Sight
// inputs.LOS is a per-frame node that returns values of:
//  .position = Vector3 start of the LOS
//  .heading = Vector3, unit vector direction
// clipSeaLevel = flag if to stop the LOS at sea level. Default = true, currently only FLIR1 sets it to false
// highlightLines = object keyed on frame nubmers that need a different color
// spacing = how many frames between each LOS to display

// what gets displayed is all the LOS between frame 0 and the last frame
// unless we use A/B frames to limit the display

// "Sea level" means MEAN sea level — the geoid — not the WGS84 ellipsoid. The two differ by
// the geoid undulation N, which is about -35 m off Malibu and ranges roughly -105..+85 m
// worldwide, so intersecting the bare ellipsoid left every downward LOS terminating that far
// above the water (here it stopped 24 m above the visible ground, hanging in mid-air).
//
// N varies slowly with position — metres per hundred kilometres — so this converges fast:
// intersect the ellipsoid for a first guess, look N up there, then re-intersect a surface
// raised by N. One refinement is already sub-metre; the second is cheap insurance for a long
// shallow ray whose first guess lands far from its final point.
//
// meanSeaLevelOffset is synchronous and needs the EGM96 grid, which SituationSetupFromData
// awaits before any node is built, so it is safe to call from here.
function intersectMeanSeaLevel(A, fwd) {
    let hit = intersectSurface(A, fwd)
    if (!hit) return null
    for (let i = 0; i < 2; i++) {
        // ECEFToLLA_radii returns RADIANS (the name is about which radii it uses, not its
        // output units) while meanSeaLevelOffset takes degrees — it clamps latitude to +-90,
        // so radians sail through and silently look up the wrong side of the planet.
        const [lat, lon] = ECEFToLLA_radii(hit.x, hit.y, hit.z)
        const refined = intersectSurface(A, fwd, meanSeaLevelOffset(degrees(lat), degrees(lon)))
        // A ray that grazes the ellipsoid can miss the slightly raised or lowered surface.
        // Keep the last good hit rather than dropping the clip entirely.
        if (!refined) break
        hit = refined
    }
    return hit
}

export class CNodeDisplayLOS extends CNode3DGroup {
    constructor(v) {
        v.layers ??= LAYER.MASK_HELPERS;
        super(v);

        this.input("LOS")
        this.optionalInputs(["traverse"])

        this.clipSeaLevel = v.clipSeaLevel ?? true;
        this.highlightLines = v.highlightLines ?? {};
        this.LOSLengthMiles = v.LOSLength ?? 200;
        this.spacing = v.spacing ?? 30;
        this.maxLines = v.maxLines ?? 1000;

        let color = 0x808080;
        // at this point v.color will be a node, so we need to get the value
        if (v.color !== undefined) {
            color = v.color.getValue();
        }

        this.material = makeMatLine(color, v.width ?? 0.75)

        this.Jet_LOS3D = [] // see below

        // extra lines and spheres for debugging
        this.displayFineDetail = false
        this.showCurrentLOS = v.showCurrentLOS ?? false
        this.currentLOSGeometry = null
        this.currentLOSLine = null
        this.currentLOSGroup = new Group()
        this.currentLOSGroup.name = `${this.id}_currentLOS`
        this.currentLOSGroup.layers.mask = v.layers
        this.currentLOSGroup.visible = this.showCurrentLOS
        this.container.add(this.currentLOSGroup)
        this.simpleSerials.push("showCurrentLOS")

        // Thin out the displayed LOS: 0 = show all (no-op), n = show only
        // every 2^n-th of the normally displayed lines (n=3 → every 8th).
        this.hideSomeLOS = v.hideSomeLOS ?? 0;
        this.simpleSerials.push("hideSomeLOS")

        this.recalculate()

        const gui = getLOSFolder();
        // The folder is shared by every LOS display in the sitch, but it can have only one title
        // checkbox: the first display's. A later display's rows stay usable, since that
        // checkbox is not their switch. The main view's header items follow the same display
        // (a later shareAs would take them over), so the title checkbox and the header's
        // "Lines of Sight" (and the "o" key, which also goes to the last display that asks for
        // it) always switch the same lines.
        const ownsFolder = !gui._folderToggle;
        const losHider = this.showHider(t("showHiders.linesOfSight.label"), ownsFolder ? "o" : undefined,
            t("showHiders.linesOfSight.tooltip"), gui);
        if (ownsFolder) losHider.shareAs(viewMenuKey("mainView", "los")).asFolderToggle();
        else losHider.keepLiveWhenFolderOff();
        const hideSome = gui.add(this, "hideSomeLOS", 0, 10, 1)
            .name(t("showHiders.hideSomeLOS.label", {defaultValue: "Hide Some LOS"}))
            .tooltip(t("showHiders.hideSomeLOS.tooltip", {defaultValue:
                "Thin out the displayed lines of sight: 0 shows all, n shows only every 2ⁿ-th line (3 = every 8th)"}))
            .listen()
            .onChange(() => {
                this.recalculate();
                setRenderOne(true);
            });
        if (!ownsFolder) hideSome.keepLiveWhenFolderOff();
        // Current LOS is drawn on the container, not in this.group, so it shows even while the
        // lines of sight are hidden: it keeps working when the folder is off.
        const currentLOS = gui.add(this, "showCurrentLOS")
            .name(t("showHiders.currentLOS.label", {defaultValue: "Current LOS"}))
            .tooltip(t("showHiders.currentLOS.tooltip", {defaultValue: "Show only the current frame's line of sight"}))
            .listen()
            .onChange((v) => {
                this.currentLOSGroup.visible = v;
                if (!v) this.clearCurrentLOS();
                setRenderOne(true);
            })
            .keepLiveWhenFolderOff();
        if (ownsFolder) currentLOS.shareAs(viewMenuKey("mainView", "currentLos"));
    }

    // we update the positions of the spheres every frame
    // because they get added AFTER the display node has been recalculated
    update() {

       // this.recalculate();
       // return;

        this.updateCurrentLOS(par.frame);
        this.updateSingleLOS(par.frame);

        if (this.in.traverse)
            for (var f = 0; f < this.in.LOS.frames; f++) {

                // one per second (assume 30 fps), plus arbitary lines to highlight
                if (this.isFineDetail(f) || f % this.spacing === 0 || this.highlightLines[f] !== undefined) {

                    var traverse = this.in.traverse.v(f)
                    if (traverse.position) {
                        if (this.isFineDetail(f))
                            DebugSphere("LOSInteresect" + this.detailFrameName(f), traverse.position, 0.2, 0xff0000)
                        else
                            DebugSphere("LOSInteresect" + f, traverse.position, 0.1, 0xff0000)
                    }


                }
            }
    }

    isFineDetail(f) {
        return this.displayFineDetail && Math.abs(f - par.frame) < 30
    }

    detailFrameName(f) {
        return "" + (f - par.frame)
    }

    getLineEndpoints(f) {
        var los = this.in.LOS.v(f)
        var A = los.position.clone();
        var fwd = los.heading.clone();
        var B = A.clone()

        const scale = metersFromMiles(this.LOSLengthMiles)
        fwd.multiplyScalar(scale)
        B.add(fwd)

        if (this.clipSeaLevel && fwd.dot(getLocalUpVector(A)) < 0) {
            // intersecting with a plane is no good with larger scales
            // especially when a sitch is setup with large tiles
            // as the "level" plane diverges significantly from the globe
            // so we get intersection with the globe
            const seaLevelPoint = intersectMeanSeaLevel(A, fwd)
            if (seaLevelPoint) {
                B = seaLevelPoint
            }
        }

        return {A, B};
    }

    clearCurrentLOS() {
        if (this.currentLOSLine) {
            this.currentLOSGroup.remove(this.currentLOSLine)
            this.currentLOSLine = null
        }
        if (this.currentLOSGeometry) {
            dispose(this.currentLOSGeometry)
            this.currentLOSGeometry = null
        }
    }

    updateCurrentLOS(f) {
        this.currentLOSGroup.visible = this.showCurrentLOS;
        if (!this.showCurrentLOS) return;

        this.clearCurrentLOS();

        const {A, B} = this.getLineEndpoints(f);
        const mid = A.clone().add(B).multiplyScalar(0.5);

        A.sub(mid);
        B.sub(mid);
        const points = [A.x, A.y, A.z, B.x, B.y, B.z]

        this.currentLOSGeometry = new LineGeometry();
        this.currentLOSGeometry.setPositions(points);
        this.currentLOSGroup.layers.mask = this.group.layers.mask;
        this.currentLOSLine = new Line2(this.currentLOSGeometry, matLineWhite);
        this.currentLOSLine.position.set(mid.x, mid.y, mid.z);
        this.currentLOSLine.layers.mask = this.currentLOSGroup.layers.mask;
        this.currentLOSGroup.add(this.currentLOSLine);
    }

    // The frames whose line of sight is drawn.
    shownFrames() {
        let spacing = this.spacing;
        let frames = this.in.LOS.frames;

        // limit the number of lines to display
        // if we have more than maxLines, then we need to space them out
        // maxLines default is 1000, so anything over 1000 seconds (at 30 fps) will be spaced out

        const numLines = frames/spacing;
        if (numLines > this.maxLines) {
            spacing = Math.floor(frames/this.maxLines);
        }

        // "Hide Some LOS": keep only every 2^n-th of the lines that would
        // normally display (0 = no-op). Highlighted lines are kept regardless.
        if (this.hideSomeLOS > 0) {
            spacing *= Math.pow(2, Math.round(this.hideSomeLOS));
        }

        const shown = [];
        for (let f = 0; f < frames; f++) {
            // one per second (assume 30 fps), plus arbitary lines to highlight
            if (this.isFineDetail(f) || f % spacing === 0 || this.highlightLines[f] !== undefined) shown.push(f);
        }
        return shown;
    }

    removeLines() {
        this.cancelVerify();
        this.single = null;
        // Jet_LOS is an array of structures of line + geometry
        // for all the radiating LOS (like LOSX)
        this.Jet_LOS3D.forEach((item) => {
            this.group.remove(item.line)
            dispose(item.geometry)
        })
        this.Jet_LOS3D = []
    }

    recalculate() {

        // console.log("recalculate LOS, this.in.LOS.frames = "+this.in.LOS.frames+
        // "this.in.LOS.id = "+this.in.LOS.id+ " Sit.frames = "+Sit.frames);

        this.removeLines();
        const shown = this.shownFrames();

        // One line for all? Probe evenly spaced lines first (see SINGLE_PROBES).
        // Highlighted lines and the fine-detail debug view keep the full set.
        if (shown.length > SINGLE_PROBES && !this.displayFineDetail
            && Object.keys(this.highlightLines).length === 0) {
            const los = this.in.LOS;
            const first = los.v(shown[0]);
            let same = true;
            for (let k = 1; k < SINGLE_PROBES && same; k++) {
                same = sameLOS(los.v(shown[Math.round(k * (shown.length - 1) / (SINGLE_PROBES - 1))]), first);
            }
            if (same) {
                this.single = {position: first.position.clone(), heading: first.heading.clone()};
                // drawn in the active range's colour when any of it is in the range
                this.addLine(shown.find(f => f >= Sit.aFrame && f <= Sit.bFrame) ?? shown[0]);
                this.propagateLayerMask();
                this.verifySingle(shown);
                return;
            }
        }
        this.addLines(shown);
    }

    // The full set of lines.
    addLines(shown) {
        for (const f of shown) this.addLine(f);
        this.propagateLayerMask();
    }

    addLine(f) {
        const {A, B} = this.getLineEndpoints(f)
        const mid = A.clone().add(B).multiplyScalar(0.5);
        A.sub(mid);
        B.sub(mid);
        const lineOb = {}
        lineOb.geometry = new LineGeometry()
        lineOb.geometry.setPositions([A.x, A.y, A.z, B.x, B.y, B.z])

        let color = this.material // matLineWhiteThin;

        // we can be passed in an array of lines to highlight
        if (this.highlightLines[f] !== undefined)
            color = this.highlightLines[f]

        // dim out things outside the active range
        if (f < Sit.aFrame || f > Sit.bFrame) {
            color = matLineGreyThin;
        }

        lineOb.line = new Line2(lineOb.geometry, color)
        lineOb.line.position.set(mid.x, mid.y, mid.z)
        this.Jet_LOS3D.push(lineOb)
        this.group.add(lineOb.line)
    }

    // Check the lines the probe skipped, a slice at a time. Any that differs means
    // the camera moves during the sitch: draw them all. Each slice first takes the
    // first line again: if THAT changed, the camera was moved (a drag), which says
    // nothing about the sitch, so the check stops; the recalculation that follows
    // the move starts a new one.
    verifySingle(shown) {
        let i = 1;
        const step = () => {
            this.verifyTimer = null;
            if (!this.single) return;
            const reference = this.in.LOS.v(shown[0]);
            if (!sameLOS(reference, this.single)) return;
            const end = performance.now() + VERIFY_SLICE_MS;
            for (; i < shown.length && performance.now() < end; i++) {
                if (!sameLOS(this.in.LOS.v(shown[i]), reference)) {
                    this.removeLines();
                    this.addLines(shown);
                    setRenderOne(true);
                    return;
                }
            }
            if (i < shown.length) this.verifyTimer = setTimeout(step, 0);
        };
        this.verifyTimer = setTimeout(step, 0);
    }

    cancelVerify() {
        clearTimeout(this.verifyTimer);
        this.verifyTimer = null;
    }

    // With a single line, follow the camera every frame: one camera evaluation.
    // A change stops the background check; the recalculation that follows the
    // change (at once, or when a drag pauses) starts a new one.
    updateSingleLOS(f) {
        if (!this.single) return;
        const los = this.in.LOS.v(f);
        if (sameLOS(los, this.single)) return;
        this.cancelVerify();
        this.single = {position: los.position.clone(), heading: los.heading.clone()};
        const item = this.Jet_LOS3D[0];
        if (!item) return;
        const {A, B} = this.getLineEndpoints(f);
        const mid = A.clone().add(B).multiplyScalar(0.5);
        A.sub(mid);
        B.sub(mid);
        item.geometry.setPositions([A.x, A.y, A.z, B.x, B.y, B.z]);
        item.line.position.set(mid.x, mid.y, mid.z);
        item.line.updateMatrixWorld();
    }

    dispose() {
        this.cancelVerify();
        this.single = null;
        for (const item of this.Jet_LOS3D) {
            this.group.remove(item.line);
            item.geometry.dispose();
        }
        this.Jet_LOS3D = [];
        disposeMatLine(this.material);
        this.clearCurrentLOS();
        if (this.currentLOSGroup) {
            this.container.remove(this.currentLOSGroup);
        }
        super.dispose();
    }
}
