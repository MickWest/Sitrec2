// Creating timed data and then tracks from pre-parsed track files
// should be agnostic to the source of the data (KML/ADSB, CSV, KLVS, etc)
import {CNodeScale} from "./nodes/CNodeScale";
import {showConfirm, showChoice} from "./showError";
import {CNodeGUIValue, CNodeGUIFlag} from "./nodes/CNodeGUIValue";
import {CNodeConstant} from "./nodes/CNode";
import * as LAYER from "./LayerMasks";
import {Color, Vector3} from "three";
import {getFileExtension, scaleF2M} from "./utils";
import {getEnv} from "./envUtils";
import {
    FileManager,
    GlobalDateTimeNode,
    Globals,
    guiMenus,
    NodeMan,
    setRenderOne,
    setSitchEstablished,
    Sit,
    TrackManager
} from "./Globals";
import {CNodeDisplayTrack} from "./nodes/CNodeDisplayTrack";
import {CManager} from "./CManager";
import {CNodeControllerMatrix, CNodeControllerTrackPosition} from "./nodes/CNodeControllerVarious";
import {MISB} from "./MISBUtils";
import {EventManager} from "./CEventManager";
// Removed mathjs import - using native JavaScript Number.isFinite or typeof checks
import {CNodeMISBDataTrack, makeLOSNodeFromTrackAngles, removeLOSNodeColumnNodes} from "./nodes/CNodeMISBData";
import {CNodeTrackFromMISB} from "./nodes/CNodeTrackFromMISB";
import {CNodeLazyMISBFlightTrack} from "./nodes/CNodeLazyMISBFlightTrack";
import {assert} from "./assert";
import {getLocalSouthVector, getLocalUpVector, pointOnSphereBelow} from "./SphericalMath";
import {closestIntersectionTime, trackBoundingBox} from "./trackUtils";
import {collectLOSGroundPoints, collectTrackPoints, computeTrackFraming}
    from "./CameraFraming";
import {intersectSurface} from "./threeExt";
import {CNode3DObject, ModelFiles} from "./nodes/CNode3DObject";
import {radiusIsOnlyDimension} from "./nodes/CNode3DObjectGeometry";
import {CNodeTrackGUI} from "./nodes/CNodeControllerTrackGUI";
import {CGeoJSON} from "./geoJSONUtils";
import {CNodeSmoothedPositionTrack} from "./nodes/CNodeSmoothedPositionTrack";
import {CNodeSplineEditor} from "./nodes/CNodeSplineEdit";

// Marker-sphere radius a newly imported track gets, in metres.
//
// Sized for the widely-spaced tracks a user normally drops — an airliner 30 km
// away needs a marker you can see at all. It is far too big for a set of
// candidate reconstructions of ONE object, which is what "Global Radius Resize"
// in the Objects menu exists to fix.
export const DEFAULT_TRACK_SPHERE_RADIUS_M = 40;

/**
 * Resize every SPHERE in the Objects menu to this radius, in metres.
 *
 * Spheres only. A model (an aircraft GLB) has no radius and is scaled by its
 * model length, and a box or a cylinder has dimensions this control does not
 * describe — silently rewriting one of those would be a surprise, so they are
 * left alone.
 *
 * In place, via geometryParams + rebuild(). Recreating the node would drop the
 * controllers that tie it to its track.
 *
 * @param radiusM  the new radius
 * @param filter   optional (id, node) => boolean, to scope the change. The
 *                 file-handoff path uses it to touch only the objects it just
 *                 created and leave the rest of the scene alone.
 */
export function resizeAllObjectSpheres(radiusM, filter = null) {
    if (!Number.isFinite(radiusM) || radiusM <= 0) return 0;
    let changed = 0;
    forEachRadiusObject((id, node) => {
        if (filter && !filter(id, node)) return;
        node.geometryParams.radius = radiusM;
        node.rebuild();
        changed++;
    });
    if (changed) setRenderOne(true);
    return changed;
}

/**
 * Visit every object in the Objects menu whose ONLY dimension is a radius.
 *
 * Not just spheres: an icosahedron, an octahedron, a circle and an ellipsoid
 * are all fully described by one radius, so setting it scales them completely.
 * A capsule or a torus is not — each has a second length, and rewriting only
 * the radius would deform it rather than resize it. radiusIsOnlyDimension
 * makes that judgement from the geometry table itself, so a shape added later
 * is classified without anyone remembering to update a list here.
 *
 * Models are excluded outright: a GLB has no radius and is scaled by its model
 * length, so a radius written onto one would do nothing while appearing to.
 */
function forEachRadiusObject(fn) {
    NodeMan.iterate((id, node) => {
        if (!(node instanceof CNode3DObject)) return;
        if (node.modelOrGeometry !== "geometry") return;
        if (node.geometryParams?.radius === undefined) return;
        if (!radiusIsOnlyDimension(node.common?.geometry ?? "sphere")) return;
        fn(id, node);
    });
}

/**
 * Is this imported track GROUND TRUTH?
 *
 * Two ways to know, because two kinds of file carry truth. A BOT interchange
 * file knows structurally which of its sub-tracks is the answer key and says so
 * (CTrackFileBOT.trackIsTruth). A plain CSV cannot, so a name is the only
 * signal it has — which is why the traverse handoff calls its file `truth.csv`
 * and the BOT importer suffixes its sub-track "(Truth)".
 *
 * The name test is deliberately narrow: a whole name of "truth", or a trailing
 * "(Truth)". It will not fire on "ground_truth_study.csv", which is a file
 * ABOUT truth rather than a truth track.
 */
function isTruthTrack(trackOb, shortName = null) {
    // NAME FIRST, and that ordering is not cosmetic: the marker is built while
    // the track is still being assembled, before the source file has been
    // registered with FileManager, so the structural test below silently
    // returns nothing at the only moment it is asked. The name is in hand.
    const name = String(shortName ?? trackOb?.menuText ?? "").trim();
    if (/^truth$/i.test(name) || /\(truth\)$/i.test(name)) return true;
    const file = FileManager.get(trackOb?.trackFileName, false);
    return !!file?.trackIsTruth?.(trackOb?.trackIndex);
}

/**
 * Point "Global Radius Resize" at the LARGEST radius currently in the scene,
 * WITHOUT resizing anything.
 *
 * The control has to show a number, and a stale one is worse than useless: a
 * slider reading 40 beside a scene of 1 m markers invites the reader to nudge
 * it and watch everything jump. So it follows the scene as objects arrive.
 *
 * IT MUST NOT ACT WHILE DOING SO. Writing the value through the normal path
 * would fire the onChange and resize every OTHER object down to the new
 * reading — so importing one small object would silently shrink an entire
 * scene that the user had already sized by hand. setValue's `ignoreOnChange`
 * writes the display quietly; only a drag or a click on the control resizes.
 *
 * The LARGEST rather than the mean or the newest, because it is the one that
 * sets the scale the reader is looking at, and because dragging down from it
 * reaches every other radius on the way.
 */
export function syncGlobalSphereResize() {
    const control = NodeMan.get("globalSphereResize", false);
    if (!control) return;
    let max = null;
    forEachRadiusObject((id, node) => {
        const r = node.geometryParams.radius;
        if (Number.isFinite(r) && (max === null || r > max)) max = r;
    });
    if (max === null) return;                 // nothing resizable: leave the reading alone
    if (max === control.value) return;        // already right; do not touch the GUI
    control.setValue(max, true);              // true = quietly, no onChange
}
import {CTrackFile} from "./TrackFiles/CTrackFile";
import {CTrackFileSonde} from "./TrackFiles/CTrackFileSonde";
import {CNodeDisplayBalloonSphere} from "./nodes/CNodeDisplayBalloonSphere";
import {CNodeSondeColor} from "./nodes/CNodeSondeColor";
import {CNodeDisplaySondeWind} from "./nodes/CNodeDisplaySondeWind";
import {CNodeAtmosphericProfile} from "./nodes/CNodeAtmosphericProfile";
import {detectRocketLikeTrack} from "./trackHeuristics";
import {hasOtherTrackSourceReference, shouldPreserveAnglesHeading} from "./trackSourceUtils";
import {extractTrackPreviewInfo, showMultiTrackLoadDialog, getCameraFilterState} from "./TrackFilterDialog";
import {t} from "./i18n";
import {CNodeBalloonTrack} from "./nodes/CNodeBalloonTrack";

function disposeDirectTrackDependentControllers(trackNode) {
    if (!trackNode?.outputs?.length) {
        return;
    }

    // Controllers that read from a track may own helper nodes of their own
    // (for example ObjectTilt creates an internal smoothed track). Dispose
    // those controllers before severing the track so their helpers do not get
    // left behind with orphaned inputs.
    const controllerIDs = [...new Set(
        trackNode.outputs
            .filter(outputNode => outputNode?.isController)
            .map(outputNode => outputNode.id)
    )];

    for (const controllerID of controllerIDs) {
        if (NodeMan.exists(controllerID)) {
            NodeMan.unlinkDisposeRemove(controllerID);
        }
    }
}


class CMetaTrack {
    constructor(trackFileName, trackDataNode, trackNode, trackIndex = 0) {
        this.trackNode = trackNode;
        this.trackDataNode = trackDataNode;
        this.trackFileName = trackFileName;
        this.trackIndex = trackIndex;
        this.isSynthetic = false; // Flag to identify synthetic tracks
    }

    // Imported tracks build a cluster of helper nodes with deterministic ids
    // (smoothing controls, LOS helpers, display tracks, object controllers, etc).
    // This teardown path removes that whole cluster so the same callsign/shortName
    // can be imported again without colliding with stale node ids.
    dispose() {
        // Track teardown historically mixed node ids and node objects. Normalizing
        // everything through this helper keeps the cleanup order readable while
        // always calling NodeMan with the id shape unlinkDisposeRemove expects.
        const unlinkManagedNode = (nodeOrId) => {
            if (!nodeOrId) return;
            const id = typeof nodeOrId === "object" ? nodeOrId.id : nodeOrId;
            if (id) {
                NodeMan.unlinkDisposeRemove(id);
            }
        };

        // Remove the menu folder
       // guiMenus.contents.removeFolder(this.guiFolder);
        this.guiFolder.destroy();

        const shortName = this.trackNode.shortName;
        
        // Remove the short name from the used names set
        TrackManager.usedShortNames.delete(shortName);


// TODO
        // OTHER DROP TAGETS
        // RESTORE SELECTIONS ON DROP IF A TRACK IS RE-LOADED
        // (currently it restets it to the first selection, fixed target)

        if (Sit.dropTargets !== undefined && Sit.dropTargets["track"] !== undefined) {
            const dropTargets = Sit.dropTargets["track"]
            for (let dropTargetSwitch of dropTargets) {


                // if it ends with a - and a number, then we delete that part
                const match = dropTargetSwitch.match(/-(\d+)$/);
                if (match !== null) {
                    dropTargetSwitch = dropTargetSwitch.substring(0, dropTargetSwitch.length - match[0].length);
                }


                if (NodeMan.exists(dropTargetSwitch)) {
//                    console.log("Removing track ", shortName, " from drop target: ", dropTargetSwitch)
                    const switchNode = NodeMan.get(dropTargetSwitch);
                    switchNode.removeOption(shortName)
                }
            }
        }



        // dispose data nodes before track nodes, as the track nodes have data nodes as inputs
        // OH, BUT THEY LINK FORWARD AND BACKWARDS.... SO WE NEED TO UNLINK THEM FIRST
        // BUT NOT ANYTHING ELSE, AS WE STILL WANT TO CHECK FOR UNANTICIPATED LINKS
        // trackNode and centerNode will also have the _unsmoothed versions as input, so need to delete those first
        // they will be in the "source" input object

        unlinkManagedNode(this.trackNode.inputs.source);
        if (this.centerNode) {
            unlinkManagedNode(this.centerNode.inputs.source);
        }

        // a bit messy, should keep track of nodes some other way
        unlinkManagedNode(this.trackID + "_smoothValue");
        unlinkManagedNode(this.trackID + "_tensionValue");
        unlinkManagedNode(this.trackID + "_intervalsValue");
        unlinkManagedNode(this.trackID + "_polyOrderValue");
        unlinkManagedNode(this.trackID + "_edgeOrderValue");
        unlinkManagedNode(this.trackID + "_fitWindowValue");
        unlinkManagedNode(this.trackID + "_sourceAltMeters");

        unlinkManagedNode(this.trackDataNode);
        unlinkManagedNode(this.trackNode);
        unlinkManagedNode(this.centerDataNode);
        unlinkManagedNode(this.centerNode);
        unlinkManagedNode(this.trackDisplayDataNode);
        unlinkManagedNode(this.trackDisplayNode);
        unlinkManagedNode(this.displayCenterDataNode);
        unlinkManagedNode(this.displayCenterNode);
        unlinkManagedNode(this.displayTargetSphere);
        unlinkManagedNode(this.displayCenterSphere);
        unlinkManagedNode(this.gui);

        unlinkManagedNode(this.anglesNode);
        unlinkManagedNode(this.anglesController);
        removeLOSNodeColumnNodes(this.trackID);

        // Sonde-track extras. makeMotionTrack adds these for tracks
        // sourced from CTrackFileSonde (UWYO / IGRA2 imports + nearby-
        // balloon auto-fetch); they're undefined on non-sonde tracks.
        // Without this cleanup, removing a sonde track leaves four
        // orphans behind in NodeMan — atmosphericProfile_<sn>,
        // <sn>_windArrows, colorData_<sn>, colorTrack_<sn> — which then
        // collide as "adding <id> twice to a CManager" the next time the
        // same station is re-imported (e.g. a refresh-driven sounding
        // relocation, or a manual re-import after Remove track).
        unlinkManagedNode(this.atmosphericProfile);
        for (const id of [
            `${shortName}_windArrows`,
            `colorData_${shortName}`,
            `colorTrack_${shortName}`,
        ]) {
            if (NodeMan.exists(id)) NodeMan.unlinkDisposeRemove(id);
        }

        // more limited pruning
        NodeMan.pruneUnusedControllers();
        NodeMan.pruneUnusedFlagged();

        // DON"T DO THIS
        //NodeMan.pruneUnusedConstants();

    }


    show(visible=true) {

        if (this.displayCenterDataNode) {
            this.displayCenterDataNode.show(visible);
        }
        if (this.displayCenterNode) {
            this.displayCenterNode.show(visible);
        }
        if (this.displayTargetSphere) {
            this.displayTargetSphere.show(visible);
        }
        if (this.displayCenterSphere) {
            this.displayCenterSphere.show(visible);
        }

    }

}



// Default track-colour palette. Shared by the initial assignment in addTracks
// and the deterministic reassignment in reassignTrackColors().
//
// Every entry is a LIGHT tint (each channel floored well above black) so it
// reads clearly against the dark 3D background. Pure yellow (1,1,0) and pure
// white (1,1,1) are intentionally omitted — they're the traverse and
// sonde-track colours respectively.
//
// Ordering matters: tracks are coloured by rank, so palette[0], palette[1]…
// go to the first, second… track. The list is arranged so CONSECUTIVE entries
// are far apart in hue, keeping a typical few-track scene maximally distinct.
const TRACK_PALETTE = [
    new Color(1.0, 0.5,  0.5),   // salmon / red
    new Color(0.5, 1.0,  0.5),   // green
    new Color(0.6, 0.6,  1.0),   // periwinkle / blue
    new Color(1.0, 0.5,  1.0),   // magenta / pink
    new Color(0.5, 1.0,  1.0),   // cyan
    new Color(1.0, 1.0,  0.5),   // light yellow
    new Color(0.7, 0.5,  1.0),   // violet
    new Color(1.0, 0.7,  0.4),   // orange
    new Color(0.4, 1.0,  0.7),   // spring green / mint
    new Color(1.0, 0.5,  0.75),  // rose
    new Color(0.45, 0.75, 1.0),  // azure / sky blue
    new Color(0.75, 1.0,  0.45), // lime / chartreuse
    new Color(0.85, 0.5,  1.0),  // purple
    new Color(1.0, 0.85, 0.5),   // amber / gold
    new Color(0.4, 1.0,  0.85),  // teal
    new Color(0.55, 0.65, 1.0),  // cornflower
];

class CTrackManager extends CManager {

    constructor() {
        super();
        this.usedShortNames = new Set(); // Track all used short names for uniqueness
    }

    // Next auto colour for a track that is created directly by the user rather
    // than imported — balloons and synthetic (spline) tracks. These aren't part
    // of the shortName-ranked reassignment below (their colour lives in a
    // per-track colour node, and they're created one at a time by an explicit
    // click, so there's no async-ordering problem to solve), but they should
    // still step through TRACK_PALETTE rather than all sharing one default
    // colour — the old defaults were a fixed orange for balloons and pure
    // yellow for synthetic tracks.
    nextPaletteColor() {
        let n = 0;
        this.iterate((id, t) => {
            if (t.paletteColored || t.isBalloon || t.isSynthetic) n++;
        });
        return TRACK_PALETTE[n % TRACK_PALETTE.length].clone();
    }

    // Deterministic, order-INDEPENDENT track-colour assignment.
    //
    // Imported tracks are created in async load-completion order (each file calls
    // addTracks as it finishes parsing), so ANY creation-order index — size() or a
    // running counter — assigns palette colours in a run-to-run-varying order,
    // rotating the whole palette and recolouring every track. That produced the
    // intermittent visual-regression failures on multi-track sitches (e.g. Potomac)
    // and run-to-run colour flicker for users.
    //
    // Fix: rank the palette-coloured tracks by their STABLE shortName and assign
    // TRACK_PALETTE[rank]. Same set of tracks -> same colours every load, regardless
    // of which file finished first. Only tracks we auto-coloured from the palette are
    // touched (paletteColored), so sonde tracks and user/serialised colours are left
    // alone. Called at the end of addTracks (before the cascade recalc) so the
    // colour CNodeConstants are updated before the geometry rebuilds.
    reassignTrackColors() {
        const palette = [];
        this.iterate((id, t) => {
            if (t.paletteColored && t.shortName) palette.push(t);
        });
        palette.sort((a, b) => (a.shortName < b.shortName ? -1 : a.shortName > b.shortName ? 1 : 0));
        palette.forEach((t, rank) => {
            const col = TRACK_PALETTE[rank % TRACK_PALETTE.length];
            t.trackColor = col;
            const drop = col.clone().multiplyScalar(0.75);
            // Colours are fed to the display tracks via these CNodeConstants; update
            // them (and the baked dropColor on the display nodes) so the end-of-
            // addTracks recalculateAllRootFirst() rebuilds the line geometry colours.
            const cd = NodeMan.get("colorData_" + t.shortName, false);
            const ct = NodeMan.get("colorTrack_" + t.shortName, false);
            if (cd) cd.value = new Color(col);
            if (ct) ct.value = new Color(col);
            if (t.trackDisplayDataNode) t.trackDisplayDataNode.dropColor = drop;
            if (t.trackDisplayNode) t.trackDisplayNode.dropColor = drop;
        });
    }

    // Tracks whose underlying MISB array has at least one valid
    // WindSpeed entry — these can drive the wind GUI's per-track
    // source option ("Track: <shortName>"). Returns one entry per
    // track-with-wind: { trackID, trackDataId, shortName }.
    tracksWithWind() {
        const out = [];
        this.iterate((trackID, trackOb) => {
            const td = trackOb?.trackDataNode;
            const misb = td?.misb;
            if (!Array.isArray(misb) || misb.length === 0) return;
            // A single valid WindSpeed cell is enough to call this a
            // wind-bearing track — patchColumn will fill the rest at
            // track-build time.
            for (let i = 0; i < misb.length; i++) {
                const v = misb[i]?.[MISB.WindSpeed];
                if (typeof v === "number" && !isNaN(v)) {
                    out.push({
                        trackID,
                        trackDataId: td.id,
                        shortName: trackOb.menuText
                            ?? td.shortName
                            ?? trackID,
                    });
                    break;
                }
            }
        });
        return out;
    }

    // Fire the "tracksChanged" event whenever the set of imported tracks
    // shifts. The wind GUI listens so it can rebuild its source dropdowns
    // (track-bearing-wind options come and go with imports/removals).
    notifyTracksChanged() {
        // Spheres arrive and leave with tracks, so this is where the Global
        // Radius Resize reading is brought up to date. Quietly — see the note
        // on syncGlobalSphereResize about why it must not act.
        syncGlobalSphereResize();
        EventManager.dispatchEvent("tracksChanged", this);
    }


// given a source file id:
// first create a CNodeTimedData from whatever type of data it is (KML, SRT, etc)
// the create a track node from that
// Note, the track node might be recalculated, as it depends on the global start time
//
// sourceFile = the input, either a KLM file, or one already in MISB array format
// if it's a kml file we will first make a MISB array
// dataID = the id of the intermediate CNodeMISBDataTrack
    makeMISBDataTrack(sourceFile, dataID, trackIndex = 0) {
        const fileInfo = FileManager.getInfo(sourceFile);
        const ext = getFileExtension(fileInfo.filename);

        let misb = null;
        const trackFile = FileManager.get(sourceFile);

        if (trackFile instanceof CTrackFile) {
            misb = trackFile.toMISB(trackIndex);
        } else if (ext === "json" || ext === "geojson") {
            // ".geojson" as well as ".json": it is the format's own standard extension,
            // and the file picker has always offered it, but this dispatch recognised
            // only "json" — so a file named the standard way reached the assert below
            // instead of the GeoJSON reader.
            const geo = new CGeoJSON();
            geo.json = trackFile;
            misb = geo.toMISB(trackIndex);
        } else {
            assert(0, "Unknown file type: " + fileInfo.filename);
        }

        if (!misb) {
            console.warn("makeMISBDataTrack: No data in file:", sourceFile);
            return false;
        }

        if (misb.length <= 1) {
            console.warn("makeMISBDataTrack: Insufficient data in file:", sourceFile, " misb length:", misb.length);
            return false;
        }

        new CNodeMISBDataTrack({
            id: dataID,
            misb: misb,
            exportable: true,
            trackFile: trackFile, // pass trackFile for relative-time metadata (trackStartTime feature)
            // HAE sources (e.g. STANAG cs="WGS_84") report ellipsoidal altitude; flag it so
            // the pipeline skips the MSL->HAE geoid add. Default false keeps MSL sources as-is.
            altitudeIsHAE: (trackFile instanceof CTrackFile) && trackFile.isAltitudeHAE(trackIndex),
        });

        return true;
    }

    makeTrackFromMISBData(sourceFile, dataID, trackID, columns, guiFolder = null, trackIndex = 0) {
        const fileInfo = FileManager.getInfo(sourceFile);
        const frameRelativeTime = (fileInfo.dataType === "CUSTOM_FLL");

        // The synthetic "Open in Sitrec" airplane flight uses a lazily-interpolated
        // track that stores only the sparse MISB samples (≤1200) and interpolates
        // the camera on demand, instead of baking a per-global-frame array (and
        // then re-smoothing it). Gated strictly by isAppFlight so no other track
        // path changes.
        if (fileInfo.isAppFlight) {
            return new CNodeLazyMISBFlightTrack({
                id: trackID,
                misb: dataID,
                columns: columns,
                exportable: true,
            });
        }

        // right now we only smooth the track if it's a custom situation
        // otherwise we just use the raw interpolated data
        if (Sit.name !== "custom") {
            return new CNodeTrackFromMISB({
                id: trackID,
                misb: dataID,
                columns: columns,
                exportable: true,
            });
        }

        // we want to smooth the track
        // so first create an unsmoothed node (same as above, but with a different id)
        const unsmoothed = new CNodeTrackFromMISB({
            id: trackID + "_unsmoothed",
            misb: dataID,
            columns: columns,
            exportable: true,
            pruneIfUnused: true,
            frameRelativeTime: frameRelativeTime,
        });

        new CNodeGUIValue({
            id: trackID + "_smoothValue",
            value: 0,
            start: 0,
            end: 200,
            step: 1,
            desc: "Smoothing window",
        }, guiFolder);

        new CNodeGUIValue({
            id: trackID + "_tensionValue",
            value: 0.5,
            start: 0,
            end: 1,
            step: 0.01,
            desc: "Catmull Tension",
        }, guiFolder);

        new CNodeGUIValue({
            id: trackID + "_intervalsValue",
            value: 10,
            start: 2,
            end: 100,
            step: 1,
            desc: "Catmull Intervals",
        }, guiFolder);

        new CNodeGUIValue({
            id: trackID + "_polyOrderValue",
            value: 3,
            start: 1,
            end: 5,
            step: 1,
            desc: "SavGol Poly Order",
        }, guiFolder);

        new CNodeGUIValue({
            id: trackID + "_edgeOrderValue",
            value: 2,
            start: 1,
            end: 5,
            step: 1,
            desc: "Edge Fit Order",
        }, guiFolder);

        new CNodeGUIValue({
            id: trackID + "_fitWindowValue",
            value: 100,
            start: 3,
            end: 400,
            step: 1,
            desc: "Edge Fit Window",
        }, guiFolder);

        // Center / supplementary tracks (trackIndex !== 0) are target reference
        // points, not flight paths — smoothing introduces lag relative to the
        // raw KLV positions, which shows up as drift in look-view alignment.
        // Default them to "none" so they pass through the unsmoothed positions.
        const defaultMethod = trackIndex === 0 ? "spline" : "none";

        return new CNodeSmoothedPositionTrack({
            id: trackID,
            source: trackID + "_unsmoothed",
            dataTrack: dataID,
            method: defaultMethod,
            window: trackID + "_smoothValue",
            tension: trackID + "_tensionValue",
            intervals: trackID + "_intervalsValue",
            polyOrder: trackID + "_polyOrderValue",
            edgeOrder: trackID + "_edgeOrderValue",
            fitWindow: trackID + "_fitWindowValue",
            isDynamicSmoothing: true,
            guiFolder: guiFolder,
            copyData: true,
            exportable: false,
        });
    }

    makeTrackFromDataFile(sourceFile, dataID, trackID, columns, trackIndex = 0, guiFolder = null) {
        if (!this.makeMISBDataTrack(sourceFile, dataID, trackIndex)) {
            return false;
        }

        return this.makeTrackFromMISBData(sourceFile, dataID, trackID, columns, guiFolder, trackIndex);
    }


// tracks = array of filenames of files that have been loaded and that
// we want to make tracks from
    async addTracks(trackFiles, removeDuplicates = false, sphereMask = LAYER.MASK_HELPERS, options = {}) {

        let settingSitchEstablished = false;
        const showDialog = options.showDialog !== false && !Globals.deserializing;
        const syncTime = options.syncTime !== false;

        // Tracks that centerOnTrack decided the view is allowed to move for. Collected
        // here rather than acted on there because framing a camera+target pair needs
        // BOTH tracks, and centerOnTrack runs once per track as each one is built.
        // See frameLoadedTracks() at the end of this method.
        this.pendingFramingTracks = [];

        console.log("-----------------------------------------------------")
        console.log("addTracks called with ", trackFiles)
        console.log("-----------------------------------------------------")

        // GLOBAL SPHERE RESIZE.
        //
        // This replaces "Target Sphere size ft", which was wired to nothing:
        // it fed a `sizeTargetScaled` node whose only consumer had been
        // commented out (see the `size: "sizeTargetScaled"` line further down),
        // so moving it changed nothing on screen. It now does what its position
        // in the Objects menu implies and resizes the objects that are there.
        //
        // Metres, not feet, and radius rather than diameter — matching the
        // `radius:` a track's marker sphere is created with, so the number in
        // this control and the number in the object's own Radius field agree.
        if (!NodeMan.exists("globalSphereResize")) {
            new CNodeGUIValue({
                id: "globalSphereResize",
                value: DEFAULT_TRACK_SPHERE_RADIUS_M,
                start: 0.01,
                end: 100,
                step: 0.01,
                desc: "Global Radius Resize",
                tip: "Resize every object in the Objects menu whose only dimension is a radius "
                    + "— spheres, icosahedrons, circles and the like — to this radius, in metres. "
                    + "Shapes with a second length (capsule, cone, torus) and models are left alone.",
                onChange: (v) => resizeAllObjectSpheres(v),
            }, guiMenus.objects)
        }

        // Pre-scan: for files with 3+ independently-selectable tracks, show selection dialog
        const selectedIndicesMap = new Map(); // filename -> Set<number>

        // If pre-selected track indices are provided (e.g. from saved sitch), use them directly
        if (options.selectedTracks) {
            for (const trackFileName of trackFiles) {
                selectedIndicesMap.set(trackFileName, new Set(options.selectedTracks));
            }
        } else if (showDialog) {
            // Is a camera line-of-sight already loaded? A MISB/KLV track with sensor
            // angles builds an angles/LOS controller (trackOb.anglesController), i.e. a
            // camera that defines where it is looking. If so, an incoming file's
            // platform/ground reference tracks are redundant with it.
            let cameraLOSLoaded = false;
            this.iterate((k, t) => { if (t.anglesController || t.anglesNode) cameraLOSLoaded = true; });

            // The index of a file's target-role track (STANAG dynamics/pos), or -1.
            const targetTrackIndex = (f) => {
                if (typeof f.trackRoleHint !== "function") return -1;
                for (let i = 0; i < f.getTrackCount(); i++) {
                    if (f.trackRoleHint(i) === "target") return i;
                }
                return -1;
            };

            for (const trackFileName of trackFiles) {
                const file = FileManager.get(trackFileName);
                if (file instanceof CTrackFile) {
                    // Gate on the import track count (independent tracks), not getTrackCount():
                    // a STANAG file's Platform/dynamics/Ground sub-tracks are one logical unit
                    // that loads together, so its 2-3 sub-tracks must not trigger the picker.
                    const trackCount = file.getTrackCount();
                    const tIdx = targetTrackIndex(file);
                    if (file.getImportTrackCount() >= 3) {
                        // Build preview info for all tracks
                        const previewInfos = [];
                        for (let i = 0; i < trackCount; i++) {
                            const info = extractTrackPreviewInfo(file, i, trackFileName);
                            if (info) previewInfos.push(info);
                        }
                        if (previewInfos.length >= 3) {
                            const {hasFrustum, cameraPosition} = getCameraFilterState();
                            const selected = await showMultiTrackLoadDialog(previewInfos, hasFrustum, cameraPosition);
                            if (selected === null) {
                                // User cancelled — skip this file entirely
                                selectedIndicesMap.set(trackFileName, new Set());
                                continue;
                            }
                            selectedIndicesMap.set(trackFileName, new Set(selected));
                        }
                    } else if (cameraLOSLoaded && tIdx >= 0 && trackCount >= 2
                        && file.hasRedundantLOSReferenceTracks?.() === true) {
                        // A STANAG-style file (has a target track plus platform/ground
                        // reference tracks) loaded while a camera LOS already exists: offer
                        // to load just the target, since the platform/ground tracks duplicate
                        // the existing camera's line of sight. Dismiss/Escape defaults to
                        // "all" (load everything), so nothing surprising happens on cancel.
                        const choice = await showChoice(
                            "A camera track with line-of-sight data is already loaded.\n\n" +
                            "This track file also contains platform and ground reference tracks. " +
                            "Load only the tracked target, or all of its tracks?",
                            {
                                title: "Load STANAG Track",
                                cancelValue: "all",
                                options: [
                                    {label: "Target track only", value: "target", primary: true,
                                     description: "Load just the tracked target — the platform and ground tracks are redundant with the loaded camera line of sight"},
                                    {label: "Load all tracks", value: "all",
                                     description: "Load the target, platform, and ground tracks"},
                                ],
                            }
                        );
                        if (choice === "target") {
                            selectedIndicesMap.set(trackFileName, new Set([tIdx]));
                        }
                        // "all" (or dismiss) → leave unset → load every sub-track
                    }
                }
            }
        }

        for (const trackFileName of trackFiles) {
            ////////////////////////////////////////////////////


            // an individual file might have multiple tracks
            // for example the ADSB-Exchange files can have an array of tracks
            // to handle this we pass in an index to the parsing function

            const selectedSet = selectedIndicesMap.get(trackFileName);
            // Optional stable-name metadata restored from custom sitch files.
            // This prevents ID drift when the same source is parsed by different classes
            // across save/load boundaries (e.g. NITF-derived track first as CTrackFileNITF,
            // then reloaded from converted CSV as CTrackFileMISB).
            const configuredShortNames = options.shortNamesByFile?.[trackFileName]
                ?? options.shortNames?.[trackFileName]
                ?? options.shortNames;

            let moreTracks = true;
            let trackIndex = 0;
            // Whether this file has already re-timed the sitch. See the sync block
            // below: it must fire on the first track actually LOADED, which is not
            // necessarily index 0 once the multi-track picker has filtered.
            let syncedFromThisFile = false;
            while (moreTracks) {

                console.log("------------------------------------")
                console.log("Adding track index = ", trackIndex)
                console.log("------------------------------------")

                // most of the time there's only one track in a file
                // the exception is the ADSB-Exchange files, which have an array of tracks
                // the parsing for that will decide if there are more tracks
                moreTracks = false;


                const __ret = this.findShortName(trackFileName, trackIndex, moreTracks, configuredShortNames);
                let shortName = __ret.shortName;
                moreTracks = __ret.moreTracks;

                // Skip tracks not selected by the user in the multi-track dialog
                if (selectedSet && !selectedSet.has(trackIndex)) {
                    trackIndex++;
                    continue;
                }

                const trackDataID = "TrackData_" + shortName;
                const trackID = "Track_" + shortName;
                let hasFOV = false;
                console.log("Creating track with trackID", shortName, "in addTracks")




                // removeDuplicates will be true if it's, for example, loaded via drag-and-drop
                // where the user might drag in the same file(s) twice
                // so if it exists, we call disposeRemove to free any buffers, and remove it from the manager
                // so then we can just reload it again
                let trackColor = null; // Declare trackColor variable
                if (removeDuplicates) {
                    // iterate over the tracks and find if there is one that has the same filename
                    // in trackFileName
                    TrackManager.iterate((key, trackOb) => {
                        if (trackOb.trackID === trackID) {

                            trackColor = trackOb.trackColor; // keep the color of the existing track

                            // remove it from the track manager
                            TrackManager.disposeRemove(key);

                        }
                    })
                }

                // Show the clean display name (e.g. "elevated_track (Platform)") in the
                // Contents menu, not the internal node id ("Track_elevated_track…").
                // getFolder() still resolves the folder by its node id via _lookupId, so
                // the CNodeDisplayTrack lookup (menu.getFolder(track.id)) keeps working.
                const guiFolder = guiMenus.contents.addFolder(shortName);
                guiFolder._lookupId = trackID;
                // just use the default MISB Columns, so no columns are specified
                //const success = this.makeTrackFromDataFile(trackFileName, trackDataID, trackID, undefined, trackIndex, guiFolder);

                const success = this.makeMISBDataTrack(trackFileName, trackDataID, trackIndex);

                if (success) {
                    FileManager.getInfo(trackFileName).usedAsTrackSource = true;

                    // add to the "Sync Time to" menu
                    GlobalDateTimeNode.addSyncToTrack(trackDataID);
                    // and call it to sync the time. Note we do this BEFORE we create the actual tracks
                    // to ensure we have the correct start time, and hence we can get good track positions for use
                    // with determining the initial terrain
                    // Sync ONCE per file, on the first track actually loaded — not on
                    // supplementary tracks after it, and not when the caller suppresses
                    // it (e.g. legacy sitch setup with an explicit startTime).
                    //
                    // This used to test trackIndex === 0, which silently skipped the
                    // sync whenever the multi-track picker deselected the first track.
                    // The sitch timeline then stayed wherever it already was while the
                    // loaded tracks kept their own timestamps, so every track was
                    // resampled far outside its own time range and the extrapolated
                    // positions landed thousands of km from the site — a wrecked import
                    // with no error anywhere. Supplementary tracks share their primary's
                    // timeline, so syncing on one when the primary is absent gives the
                    // same answer the primary would have.
                    // Sonde (radiosonde) tracks are reference WIND data — fetching a
                    // sounding must never re-time the sitch to the balloon launch
                    // (same exemption as auto-select/centering further down).
                    const loadedFileForSync = FileManager.get(trackFileName);
                    const isSondeForSync = !!(loadedFileForSync
                        && loadedFileForSync.isSondeTrack
                        && loadedFileForSync.isSondeTrack());
                    if (syncTime && !Globals.sitchEstablished && !syncedFromThisFile && !isSondeForSync) {
                        // Some formats are a whole recording rather than a clip of one
                        // (STANAG, BOT), so fit the sitch to the track's full length as
                        // well as its start. Duration FIRST: it changes Sit.frames and
                        // rebuilds, so doing it before the start-time sync leaves that
                        // cascade — the one the comment above needs for good initial
                        // terrain positions — as the last word.
                        //
                        if (loadedFileForSync?.syncsSitchDuration?.()) {
                            // Bounded HERE, in the automatic path, not inside
                            // syncDurationToTrack: the "Sync Duration to" menu is a
                            // deliberate click on a track the user chose and still syncs
                            // to any length. This runs unattended on whatever was
                            // dropped, and a day at 30 fps is already 2.6M frames — every
                            // per-frame array in the graph is sized from Sit.frames, so a
                            // track with a broken timestamp (a row left at the Unix epoch
                            // spans decades) would take the tab out. Skipping leaves the
                            // timeline where it was; the track still loads either way.
                            const durationNode = NodeMan.get(trackDataID, false);
                            const spanMs = durationNode?.getTrackEndTime
                                ? durationNode.getTrackEndTime() - durationNode.getTrackStartTime()
                                : 0;
                            if (spanMs > 24 * 3600 * 1000) {
                                console.warn(`TrackManager: ${trackDataID} spans `
                                    + `${(spanMs / 3600000).toFixed(1)} hours — not sizing the `
                                    + `sitch to it automatically. Check the track's timestamps, `
                                    + `or use "Sync Duration to" in the Time menu.`);
                            } else {
                                GlobalDateTimeNode.syncDurationToTrack(trackDataID);
                            }
                        }
                        GlobalDateTimeNode.syncStartTimeTrack();
                        syncedFromThisFile = true;
                    }

                    this.makeTrackFromMISBData(trackFileName, trackDataID, trackID, undefined, guiFolder, trackIndex);

                    const trackNode = NodeMan.get(trackID);
                    const trackDataNode = NodeMan.get(trackDataID);
                    // this has the original data in common MISB format, regardless of the data type
                    // actual MISB (and possibly other CSV inputs) might have a center track
                    //
                    const misb = trackDataNode.misb;

                    // Create the track object
                    const trackOb = TrackManager.add(trackID, new CMetaTrack(trackFileName, trackDataNode, trackNode, trackIndex));
                    trackOb.trackID = trackID;
                    trackOb.menuText = shortName;
                    trackNode.shortName = shortName;
                    trackDataNode.shortName = shortName;

                    // track folder in Contents menu
                    trackOb.guiFolder = guiFolder;


                    const dummy = {
                        removeTrack : async () => {
                            if (await showConfirm(`Remove track "${shortName}"?`, {title: "Remove Track"})) {
                                TrackManager.disposeRemove(trackID);
                            }
                        },
                        createSpline : () => {
                            const frames = trackNode.frames;
                            if (frames < 2) return;
                            const newShortName = shortName + "_sp";
                            let exists = false;
                            TrackManager.iterate((k, t) => { if (t.menuText === newShortName) exists = true; });
                            if (exists) return;
                            const numPoints = 10;
                            const initialPoints = [];
                            for (let i = 0; i < numPoints; i++) {
                                const frame = Math.floor(i * (frames - 1) / (numPoints - 1));
                                const pos = trackNode.p(frame);
                                initialPoints.push([frame, pos.x, pos.y, pos.z]);
                            }
                            trackOb.guiFolder.close();
                            const newTrackOb = TrackManager.addSyntheticTrack({
                                name: newShortName,
                                shortName: newShortName,
                                initialPoints: initialPoints,
                                curveType: "chordal",
                                editMode: true,
                            });
                            if (newTrackOb && newTrackOb.guiFolder) {
                                newTrackOb.guiFolder.open();
                            }
                        }
                    }

                    trackOb.guiFolder.add(dummy, "removeTrack").name(t("trackManager.removeTrack"));

                    if (trackNode.frames >= 2) {
                        const splineName = shortName + "_sp";
                        let splineExists = false;
                        TrackManager.iterate((k, t) => { if (t.menuText === splineName) splineExists = true; });
                        if (!splineExists) {
                            trackOb.guiFolder.add(dummy, "createSpline").name(t("trackManager.createSpline"));
                        }
                    }

                    // For relative-time tracks, add GUI field to override start time
                    trackDataNode.setupTrackStartTimeGUI(trackOb.guiFolder);

                    // Ambiguous-altitude sources (e.g. the client-specific truth_alt
                    // CSV column, which has no units label) default to feet. This
                    // switch reinterprets the source values as meters, re-deriving
                    // the track from the retained raw rows via toMISB().
                    const loadedTrackFile = FileManager.get(trackFileName);
                    if (loadedTrackFile instanceof CTrackFile
                        && loadedTrackFile.hasAmbiguousAltitudeUnits(trackIndex)) {
                        const altUnitsFlag = new CNodeGUIFlag({
                            id: trackID + "_sourceAltMeters",
                            value: loadedTrackFile.getSourceAltitudeMeters(trackIndex),
                            desc: "Source Altitude is Meters",
                            tip: "The source file doesn't label the altitude units for this track. " +
                                "Off = feet (default). On = meters. " +
                                "Toggling rebuilds the track from the original source values.",
                            onChange: () => {
                                loadedTrackFile.setSourceAltitudeMeters(trackIndex, altUnitsFlag.value);
                                const newMisb = loadedTrackFile.toMISB(trackIndex);
                                if (newMisb) {
                                    trackDataNode.misb = newMisb;
                                    trackDataNode.recalculateCascade();
                                }
                            },
                        }, trackOb.guiFolder);
                    }

                    // how many tracks are there now?
                    const trackNumber = TrackManager.size();
                    const trackColors = TRACK_PALETTE;

                    // Sonde (radiosonde) tracks are reference data only — they
                    // should never auto-select as camera/target/angle tracks or
                    // recenter the main view. Same rationale as dropping wind
                    // grids: the sonde feeds the wind field, nothing more.
                    // Cached on trackOb so makeMotionTrack reads the same flag
                    // without re-probing FileManager.
                    const loadedTrackFileForKind = FileManager.get(trackFileName);
                    const isSondeTrack = !!(loadedTrackFileForKind
                        && loadedTrackFileForKind.isSondeTrack
                        && loadedTrackFileForKind.isSondeTrack());
                    trackOb.isSondeTrack = isSondeTrack;

                    if (trackColor === null) {
                        // Sonde tracks get white by default to distinguish from aircraft
                        if (isSondeTrack) {
                            trackColor = new Color(1, 1, 1);
                        } else {
                            // Provisional colour only. Tracks are created in async
                            // load-completion order, so any creation-order index
                            // (size() here) is run-to-run unstable. reassignTrackColors()
                            // at the end of addTracks overrides this with a deterministic,
                            // order-independent colour ranked by shortName. We mark the
                            // track paletteColored so only auto-coloured tracks (not sonde
                            // or user/serialised colours) get reassigned.
                            // trackNumber is size() AFTER this track was added
                            // (TrackManager.add above), so it's 1-based here. Subtract
                            // 1 so the first track gets palette index 0 — matching the
                            // 0-based rank used by reassignTrackColors().
                            trackColor = trackColors[(trackNumber - 1) % trackColors.length];
                            trackOb.paletteColored = true;
                        }
                    }
                    // make dropcolor be the same as the track color bur reduced in brightness to 75%
                    const dropColor = trackColor.clone().multiplyScalar(0.75);

                    trackOb.trackColor = trackColor;
                    trackOb.shortName = shortName;

                    let hasAngles = false;
                    if (!isSondeTrack) {
                        hasAngles = this.updateDropTargets(trackNumber, shortName, trackID, trackDataID, trackNode, hasFOV, trackOb);
                    }

                    this.makeMotionTrack(trackOb, shortName, trackColor, dropColor, trackID);

                    if (!isSondeTrack) {
                        this.centerOnTrack(shortName, trackNumber, trackOb, hasAngles, trackIndex);
                    }

                    // if there's more than one track loaded, flag to set setSitchEstablished(true) after the track is processed.
                    // Sonde tracks don't establish the sitch — they're reference wind
                    // data, and marking the sitch established here would stop the NEXT
                    // real (aircraft/target) track import from setting time/location.
                    if (trackNumber > 0 && !isSondeTrack) {
                        settingSitchEstablished = true;
                    }


                    trackOb.gui = new CNodeTrackGUI({
                        id: trackID + "_GUI",
                        metaTrack: trackOb,
                    })

                    // For primary tracks (not center tracks), check for spurious data points
                    // and offer to enable filtering. Done after all nodes are set up so
                    // recalculateCascade works correctly.
                    // Only prompt for manually imported/drag-and-drop files, not when
                    // loading from a saved sitch. For saved sitches, filterEnabled is
                    // restored via deserialization.
                    if (trackIndex === 0 && !Globals.deserializing) {
                        const trackFile = FileManager.get(trackFileName);
                        const rocketDetection = detectRocketLikeTrack(trackFileName, trackDataNode.misb, trackFile);

                        if (rocketDetection.isRocketLike) {
                            console.log(
                                `Skipping initial bad-point g-force check for rocket-like track "${shortName}" (${rocketDetection.reason})`
                            );
                        } else {
                            const maxG = trackDataNode.getMaxGForce();
                            if (maxG > trackDataNode.filterMaxG) {
                                const enableFilter = () => {
                                    trackDataNode.filterEnabled = true;
                                    trackDataNode.recalculateCascade();
                                };
                                // In regression mode or MCP mode, auto-enable the filter to avoid
                                // blocking headless Playwright or MCP with a dialog.
                                if (Globals.regression || window._mcpDebug) {
                                    enableFilter();
                                } else {
                                    // Non-blocking custom dialog: enabling the filter later is safe
                                    // (recalculateCascade re-derives from the same source data).
                                    showConfirm(
                                        `Bad points in track data "${shortName}". Max g-force: ${maxG.toFixed(1)}g. Enable Bad Data Filter?`,
                                        {title: "Bad Data Filter"}
                                    ).then(enable => { if (enable) enableFilter(); });
                                }
                            }
                        }
                    }
                } else {
                    // if we failed to make the track, then remove the folder
                    // (nothing will have been added to it)
                    guiFolder.destroy();
                }

                trackIndex++;
            }


        } // and go to the next track

        if (settingSitchEstablished) {
            setSitchEstablished(true);
        }

        // Make auto-assigned track colours deterministic (order-independent) BEFORE
        // the cascade recalc, so the rebuilt line geometry picks up the stable colours.
        this.reassignTrackColors();

        // we've loaded some tracks, and set stuff up, so ensure everything is calculated
        NodeMan.recalculateAllRootFirst()

        // Now the tracks all exist and are calculated, put the view where the whole
        // import can be seen at once. Must come after the recalc: it reads track
        // positions, and before the recalc a lazily-built track has none.
        this.frameLoadedTracks();

        setRenderOne(true);

        // Notify listeners that the imported-track set has changed.
        // Wind GUI uses this to re-add / re-order "Track: <shortName>"
        // options on its source dropdowns when a track with WindSpeed/
        // WindDirection columns shows up.
        this.notifyTracksChanged();
    }


    makeMotionTrack(trackOb, shortName, trackColor, dropColor, trackID) {
        // Check if this is a sonde track for display customization. Caller
        // sets trackOb.isSondeTrack; fall back to probing FileManager if this
        // method is invoked from a path that doesn't stamp the flag.
        const motionTrackFile = FileManager.get(trackOb.trackFileName);
        const isSonde = trackOb.isSondeTrack
            ?? (motionTrackFile && motionTrackFile.isSondeTrack && motionTrackFile.isSondeTrack());

        // For sonde tracks, use temperature-gradient coloring instead of constant white
        if (isSonde) {
            var misbLength = FileManager.get(trackOb.trackFileName).getTrajectory(0).length;
            new CNodeSondeColor({
                id: "colorData_" + shortName,
                inputs: { dataTrack: "TrackData_" + shortName },
                colorMode: "temperature",
                totalFrames: misbLength, // full-data display iterates over MISB entries
            });
            new CNodeSondeColor({
                id: "colorTrack_" + shortName,
                inputs: { dataTrack: "TrackData_" + shortName },
                colorMode: "temperature",
                totalFrames: Sit.frames, // sitch-duration display iterates over Sit.frames
            });
        } else {
            new CNodeConstant({
                id: "colorData_" + shortName,
                value: new Color(trackColor),
                pruneIfUnused: true,
            });
            new CNodeConstant({
                id: "colorTrack_" + shortName,
                value: new Color(trackColor),
                pruneIfUnused: true,
            });
        }

        // diplay the full track data as imported
        trackOb.trackDisplayDataNode = new CNodeDisplayTrack({
            id: "TrackDisplayData_" + shortName,
            track: "TrackData_" + shortName,
            color: "colorData_" + shortName,
            dropColor: dropColor,

            width: 0.5,
            //  toGround: 1, // spacing for lines to ground
            extendToGround: isSonde, // balloon tracks show wall to ground
            ignoreAB: true,
            layers: LAYER.MASK_HELPERS,
            skipGUI: true,
            trackDisplayStep: 1, // display every point in the track, as this is original data

        })
        // sparse raw-data display: track input is the frames-invariant data
        // node, ignoreAB skips the Sit.aFrame/bFrame coloring, so a sitch
        // frame-count change can't alter its geometry — updateSitFramesChanged
        // may skip it (the AB-colored TrackDisplay_ node below must NOT be
        // skipped: changedFrames clamps Sit.bFrame)
        trackOb.trackDisplayDataNode.framesInvariant = true;

        // Display the shorter segment of the track that matches the Sitch duration
        // (slightly brighter than the full-data track but same thinness)
        trackOb.trackDisplayNode = new CNodeDisplayTrack({
            id: "TrackDisplay_" + shortName,
            track: "Track_" + shortName,
            dataTrack: "TrackData_" + shortName,
            dataTrackDisplay: "TrackDisplayData_" + shortName,
            color: "colorTrack_" + shortName,
            width: 1,
            //  toGround: 1, // spacing for lines to ground
            extendToGround: isSonde, // balloon tracks show wall to ground
            ignoreAB: true,
            layers: LAYER.MASK_HELPERS,
            trackDisplayStep: 10, // display every 10th point in the track as this is per-frame

        })

        // link back to here as the visiblity menue is hooked up to TrackDisplay_<shortName>
        trackOb.trackDisplayNode.metaTrack = trackOb;


        //    trackOb.displayTargetSphere = new CNodeDisplayTargetSphere({
        //        id: trackOb.shortName+"_ob",
        //        inputs: {
        //            track: trackOb.trackNode,
        // //           size: "sizeTargetScaled",
        //        },
        //        color: [1, 0, 1],
        //        layers: sphereMask,
        //        wireframe: true,
        //
        //    })


        const sphereId = trackOb.menuText ?? shortName;

        // GROUND TRUTH FIRST, ahead of the supplementary branch below.
        //
        // A BOT scenario's truth IS a supplementary sub-track — sensor is
        // primary — so without this it took the small invisible reference
        // sphere and the answer key was drawn as nothing at all. It is the one
        // track in the scene that must never be confused with a fitted
        // candidate, so it gets a shape and a colour of its own: a lime
        // icosahedron, unmistakable at a glance and still a single-radius
        // solid, so it stays the same size as the spheres and moves with
        // Global Radius Resize.
        const isTruth = isTruthTrack(trackOb, shortName);

        // Sonde tracks get a pressure-scaling balloon sphere
        if (isTruth) {
            trackOb.displayTargetSphere = new CNode3DObject({
                id: sphereId + "_ob",
                // `geometry`, not `object`. addParams reads the constructor
                // props by PARAMETER NAME, and the parameter is called
                // geometry — so the `object:` the other branches here pass has
                // never done anything. It went unnoticed because every one of
                // them wanted "sphere", which is also the default.
                geometry: "icosahedron",
                radius: DEFAULT_TRACK_SPHERE_RADIUS_M,
                material: "phong",
                color: "#32CD32",
                label: shortName,
            });
        } else if (isSonde) {
            trackOb.displayTargetSphere = new CNodeDisplayBalloonSphere({
                id: sphereId + "_ob",
                inputs: {
                    track: trackID,
                },
                color: "white",
                baseDiameter: 1.5, // 1.5m launch diameter, typical radiosonde
                layers: LAYER.MASK_TARGET,
                label: shortName,
            });
        } else if (trackOb.trackIndex !== 0
                   && FileManager.get(trackOb.trackFileName)?.isSupplementaryTrack?.(trackOb.trackIndex)) {
            // Center / supplementary tracks (e.g. MISB FrameCenter): the
            // platform model belongs on the primary track, so give the center
            // a small invisible reference sphere instead of duplicating it.
            // Multi-aircraft files (KML, ASTERIX PCAP) override
            // isSupplementaryTrack to keep each track visible.
            trackOb.displayTargetSphere = new CNode3DObject({
                id: sphereId + "_ob",
                geometry: "sphere",
                radius: 2,
                material: "phong",     // as the other auto track markers
                color: trackColor,
                label: shortName,
                visible: false,
            });
        } else if (getEnv("DEFAULT_PLATFORM_MODEL", process.env.DEFAULT_PLATFORM_MODEL) && trackOb.trackFileName.endsWith(".klv")) {

            // check if in the ModelFiles object, and use it if available
            if (ModelFiles[getEnv("DEFAULT_PLATFORM_MODEL", process.env.DEFAULT_PLATFORM_MODEL)]) {
                trackOb.displayTargetSphere = new CNode3DObject({
                    id: sphereId + "_ob",
                    model: getEnv("DEFAULT_PLATFORM_MODEL", process.env.DEFAULT_PLATFORM_MODEL),

                    label: shortName,
                })
            }
        }

        // if we didn't make a model or balloon, then we use a default marker
        if (!trackOb.displayTargetSphere)
        {
            trackOb.displayTargetSphere = new CNode3DObject({
                id: sphereId + "_ob",
                geometry: "sphere",
                radius: DEFAULT_TRACK_SPHERE_RADIUS_M,
                // Phong rather than the lambert default: these markers are
                // untextured solids, and a lambert sphere reads as a flat disc
                // from most angles because nothing on it catches a highlight.
                // A specular term is what makes it legible as a 3-D body, which
                // matters most for exactly the case these markers exist for —
                // several of them close together at different depths.
                material: "phong",
                color: trackColor,
                label: shortName,

            });
        }

        trackOb.displayTargetSphere.addController("TrackPosition", {
            //   id: trackOb.shortName+"_controller",
            sourceTrack: trackID,
        });

        // Sonde tracks don't need banking tilt — they float vertically
        if (!isSonde) {
            const tiltDef = {
                track: trackID,
                tiltType: "banking",
                guiFolder: trackOb.displayTargetSphere.gui,
            }
            const maybeWind = NodeMan.get("targetWind", false);
            if (maybeWind) {
                tiltDef.wind = maybeWind;
            }

            trackOb.displayTargetSphere.addController("ObjectTilt", tiltDef);
        }

        // Wind arrows along sonde tracks showing wind direction/speed at each level
        if (isSonde) {
            trackOb.windArrows = new CNodeDisplaySondeWind({
                id: shortName + "_windArrows",
                inputs: {
                    dataTrack: "TrackData_" + shortName,
                },
                arrowScale: 200, // 200m per m/s
                arrowColor: 0xffff00, // yellow
                visible: false, // hidden by default
            });

            // Atmospheric profile node for altitude-interpolated data lookup
            const sonde0 = motionTrackFile.getSondeData(0);
            const rawSrc = sonde0?.source ?? "";
            const normSource = rawSrc.startsWith("uwyo") ? "uwyo"
                : rawSrc === "igra2" ? "igra2"
                : "manual";
            trackOb.atmosphericProfile = new CNodeAtmosphericProfile({
                id: "atmosphericProfile_" + shortName,
                inputs: {
                    dataTrack: "TrackData_" + shortName,
                },
                stationId: sonde0?.station?.id ?? "",
                stationName: sonde0?.station?.name ?? "",
                source: normSource,
            });
        }
    }

    /**
     * Point the main view at everything this import just loaded.
     *
     * centerOnTrack() moves the camera once per track, so with two tracks the second
     * one's framing simply replaces the first's and one of them is left off screen.
     * This runs once, after all of them exist, and fits them together — the platform
     * on the left, the target on the right, looking down at 15-30 degrees. See
     * CameraFraming.js for the fit itself.
     *
     * Deliberately narrow about which imports it reframes:
     *
     *  - one track, or a file that DECLARES which track is the camera and which is
     *    the target (BOT scenarios, STANAG), is reframed;
     *  - anything else keeps whatever centerOnTrack() and the closest-approach
     *    re-timing left behind. A drop of several aircraft tracks has no
     *    platform/target reading to honour, and fitting all of them at once would
     *    pull the view back off the encounter that re-timing just found.
     */
    frameLoadedTracks() {
        const candidates = (this.pendingFramingTracks ?? []).filter(t => !t.isSondeTrack);
        this.pendingFramingTracks = [];
        if (candidates.length === 0) return;
        if (!NodeMan.exists("mainCamera") || !NodeMan.exists("mainView")) return;

        const roleOf = (trackOb) => {
            const file = FileManager.get(trackOb.trackFileName, false);
            return file?.trackRoleHint ? file.trackRoleHint(trackOb.trackIndex) : null;
        };
        const cameraTracks = candidates.filter(t => roleOf(t) === "camera");
        const targetTracks = candidates.filter(t => roleOf(t) === "target");

        let leftTrack = null;
        let rightTrack = null;
        if (cameraTracks.length === 1 && targetTracks.length === 1) {
            leftTrack = cameraTracks[0];
            rightTrack = targetTracks[0];
        } else if (candidates.length === 1) {
            leftTrack = candidates[0];
        } else {
            return;
        }

        const leftPoints = collectTrackPoints(leftTrack.trackDataNode);
        const targetPoints = rightTrack ? collectTrackPoints(rightTrack.trackDataNode) : [];
        // WHERE THE SIGHTLINES LAND, framed alongside the target rather than
        // instead of it. The subject of a sensor file is the fan of sightlines,
        // and the platform and the target are only its two ends — framing just
        // those cuts the fan off. Added to the right-hand set, not substituted
        // for it: the target normally sits ON the ray between the two, so the
        // ground contains it, but a target ABOVE the sightline's ground hit
        // would fall out of frame if the target's own points stopped counting.
        // collectLOSGroundPoints returns nothing when the ground is too far to
        // be worth it, or when the sightlines never reach it at all.
        const groundPoints = collectLOSGroundPoints(
            leftTrack.anglesNode, targetPoints, intersectSurface);
        const rightPoints = targetPoints.concat(groundPoints);
        if (leftPoints.length === 0 && rightPoints.length === 0) return;

        const mainView = NodeMan.get("mainView");
        const mainCameraNode = NodeMan.get("mainCamera");
        const mainCamera = mainCameraNode.camera;

        // Up at the middle of what we are framing, not at the camera: it is the scene
        // that has to sit level in frame.
        const middle = leftPoints.concat(rightPoints)
            .reduce((sum, p) => sum.add(p), new Vector3())
            .multiplyScalar(1 / (leftPoints.length + rightPoints.length));

        const framingOptions = {
            tanH: Math.tan(mainView.getHFOV() / 2),
            tanV: Math.tan(mainCamera.fov * Math.PI / 360),
            near: mainCamera.near,
        };
        let framing = computeTrackFraming(leftPoints, rightPoints, getLocalUpVector(middle), framingOptions);
        if (!framing) return;

        // The fit measures its look-down angle against up at the SCENE, but the angle
        // that has to land in the 15-30 degree band is the one at the CAMERA — that is
        // the depression the view reads out, and the two are different vectors once
        // the camera is far enough away for the Earth to have curved between them. A
        // 90 km airliner track already puts the camera a degree out. Refitting once
        // with up taken where the camera actually ended up closes almost all of that;
        // what is left is second order and far below a degree.
        const refined = computeTrackFraming(leftPoints, rightPoints,
            getLocalUpVector(framing.position), framingOptions);
        if (refined) framing = refined;

        mainCamera.position.copy(framing.position);
        mainCamera.up.copy(framing.up);
        mainCamera.lookAt(framing.position.clone().add(framing.forward));

        // Store as the default pose for this import, so resetCamera() comes back here.
        mainCameraNode.snapshotCamera();
    }

    centerOnTrack(shortName, trackNumber, trackOb, hasAngles, trackIndex = 0) {
//        console.log("Considering setup options for track: ", shortName, " number ", trackNumber)
//        console.log("Sit.centerOnLoadedTracks: ", Sit.centerOnLoadedTracks, " Globals.dontAutoZoom: ", Globals.dontAutoZoom, " Globals.sitchEstablished: ", Globals.sitchEstablished)


        // Auto-center for tracks that define their own camera (e.g., NITF with geolocation)
        const trackFile = FileManager.get(trackOb.trackFileName);
        const forceCenter = trackFile && trackFile.autoSelectAsCamera;

        if (Sit.centerOnLoadedTracks && (!Globals.dontAutoZoom || forceCenter) && (!Globals.sitchEstablished || forceCenter)) {


//            console.log("Centering on loaded track ", shortName)

            // Register for the whole-import framing pass. What follows still runs: it
            // is the per-track fallback for imports frameLoadedTracks() declines to
            // reframe (three or more tracks with no declared camera/target roles), and
            // it is what the closest-approach re-timing below adjusts.
            this.pendingFramingTracks.push(trackOb);

            // maybe adjust the main view camera to look at the center of the track
            const mainCameraNode = NodeMan.get("mainCamera");
            const mainCamera = mainCameraNode.camera;
            const mainView = NodeMan.get("mainView");
            const bbox = trackBoundingBox(trackOb.trackDataNode);
//                    console.log(`Track ${shortName} bounding box: ${bbox.min.x}, ${bbox.min.y}, ${bbox.min.z} to ${bbox.max.x}, ${bbox.max.y}, ${bbox.max.z}`)
            const center = bbox.min.clone().add(bbox.max).multiplyScalar(0.5);
            // get point on sphere
            const ground = pointOnSphereBelow(center);
            // what's the length of the diagonal of the bounding box?
            const diagonal = bbox.max.clone().sub(bbox.min).length();

            const hfov = mainView.getHFOV();

            // Check if this is a high-altitude/orbital track (e.g., satellite at >10km)
            const trackAltitude = center.clone().sub(ground).length();

            if (trackAltitude > 10000) {
                // Orbital track: center on the midpoint of the line from satellite to ground,
                // and back the camera far enough to see the entire line
                const midpoint = center.clone().add(ground).multiplyScalar(0.5);
                const up = getLocalUpVector(midpoint);
                const south = getLocalSouthVector(midpoint);

                // Camera distance: far enough to fit the full satellite-to-ground line in view
                const cameraDistance = (trackAltitude / 2) / Math.tan(hfov / 2) * 1.1;

                // Position camera to the south at midpoint height, looking at the midpoint
                const cameraTarget = midpoint.clone().add(south.clone().multiplyScalar(cameraDistance));
                mainCamera.position.copy(cameraTarget);
                mainCamera.up.copy(up);
                mainCamera.lookAt(midpoint);
            } else {
                // Standard track: position camera above and south of the ground point
                const cameraHeight = Math.max(
                    (diagonal * 1.25) / (2 * Math.tan(hfov / 2)),
                    1000 // minimum 1km
                );
                const up = getLocalUpVector(ground);
                const cameraTarget = ground.clone().add(up.clone().multiplyScalar(cameraHeight));
                const south = getLocalSouthVector(ground);
                cameraTarget.add(south.clone().multiplyScalar(cameraHeight));
                mainCamera.position.copy(cameraTarget);
                mainCamera.up.copy(up);
                mainCamera.lookAt(ground);
            }

            // since we've set the camera default postion for this track, store it
            // so calling mainCameraNode.resetCamera() will use these new values

            mainCameraNode.snapshotCamera();


            // // first get LLA versions of the ECEF values cameraTarget and ground
            // const cameraTargetLLA = ECEFToLLAVD_radii(cameraTarget);
            // const groundLLA = ECEFToLLAVD_radii(ground);
            // // then store them in the mainCamera node
            // mainCameraNode.startPosLLA = cameraTargetLLA;
            // mainCameraNode.lookAtLLA = groundLLA;


            // If this is not the first track, then find the time of the closest intersection.
            // Skip for supplementary tracks (e.g. MISB FrameCenter) where index>0 is a
            // co-located reference, not a distinct flight. The track file decides; KML
            // overrides to say every track is distinct, so multi-aircraft KML drops
            // trigger CPA against track 0.
            const track0 = TrackManager.getByIndex(0);
            const trackFile = FileManager.get(trackOb.trackFileName);
            // Ask the CPA question directly rather than inferring it from
            // isSupplementaryTrack. The default answer is still "any primary track",
            // but a file whose primaries are separate RECORDINGS rather than
            // co-observed flights answers false — they stay primary (visible, with
            // their platform models) while never re-timing the sitch to a closest
            // approach that has no physical meaning.
            const cpaCandidate = trackFile
                ? trackFile.cpaCandidate(trackIndex)
                : trackIndex === 0;
            if (track0 !== trackOb && cpaCandidate) {
                let time = closestIntersectionTime(track0.trackDataNode, trackOb.trackDataNode);
//                console.log("Closest intersection time: ", time);

                // we want this in the middle, so subtract half the Sit.frames

                //    time -= Math.floor(Sit.frames*Sit.fps*1000);

                GlobalDateTimeNode.setStartDateTime(time);
                GlobalDateTimeNode.recalculateCascade();

                // Reposition the camera at the CPA: above the midpoint of the two
                // tracks, looking down at it. Without this, the camera is left at
                // wherever the just-loaded track's bbox put it — which can be hundreds
                // of km from the CPA for geographically separated flights.
                if (Sit.centerOnLoadedTracks && (!Globals.dontAutoZoom || forceCenter) && (!Globals.sitchEstablished || forceCenter)) {
                    const p0 = track0.trackDataNode.getPositionAtTime(time);
                    const p1 = trackOb.trackDataNode.getPositionAtTime(time);
                    if (p0 && p1) {
                        const cpaMidpoint = p0.clone().add(p1).multiplyScalar(0.5);
                        const cpaGround = pointOnSphereBelow(cpaMidpoint);
                        const cpaSeparation = p0.distanceTo(p1);
                        const cpaAltitude = cpaMidpoint.clone().sub(cpaGround).length();
                        const hfovCPA = mainView.getHFOV();
                        // Frame both aircraft plus a margin; minimum 1 km so we never
                        // get a useless tight-zoom at exact-overlap CPAs.
                        const frameSize = Math.max(cpaSeparation * 2.5, cpaAltitude * 1.4, 1000);
                        const cameraHeight = frameSize / (2 * Math.tan(hfovCPA / 2));
                        const upCPA = getLocalUpVector(cpaGround);
                        const southCPA = getLocalSouthVector(cpaGround);
                        const cpaCamPos = cpaMidpoint.clone()
                            .add(upCPA.clone().multiplyScalar(cameraHeight * 0.5))
                            .add(southCPA.clone().multiplyScalar(cameraHeight));
                        mainCamera.position.copy(cpaCamPos);
                        mainCamera.up.copy(upCPA);
                        mainCamera.lookAt(cpaMidpoint);
                        mainCameraNode.snapshotCamera();
                    }
                }

                setRenderOne(true);

                // and make the 2nd track the target track if we have a targetTrackSwitch
                if (NodeMan.exists("targetTrackSwitch")) {
                    // console.log("Setting Target Track to ", trackOb.menuText, " and Camera Track to ", track0.menuText)
                    // const targetTrackSwitch = NodeMan.get("targetTrackSwitch");
                    // targetTrackSwitch.selectOption(trackOb.menuText);
                    //
                    // // and make the camera track switch use the other track.
                    // const cameraTrackSwitch = NodeMan.get("cameraTrackSwitch");
                    // cameraTrackSwitch.selectOption(track0.menuText);
                    //
                    // // and set the traverse mode to target object
                    // const traverseModeSwitch = NodeMan.get("LOSTraverseSelectTrack");
                    // traverseModeSwitch.selectOption("Target Object");
                    //
                    // // second track, so we assume we want to focus on this target
                    // // so we are setting the "Camera Heading"  to "To Target" (from "Use Angles")
                    // const headingSwitch = NodeMan.get("CameraLOSController", true);
                    // if (headingSwitch) {
                    //     headingSwitch.selectOption("To Target");
                    // }


                }

                // and since we have an intersection, zoomTo it if there's a TerrainModel
                if (NodeMan.exists("terrainUI")) {
                    let terrainUINode = NodeMan.get("terrainUI")
                    terrainUINode.zoomToTrack(trackOb.trackNode);
                }


            } else {
                // this is the first track loaded, or a supplementary track (like center track)
                // so just center on this track
                if (NodeMan.exists("terrainUI")) {
                    let terrainUINode = NodeMan.get("terrainUI")
                    terrainUINode.zoomToTrack(trackOb.trackNode);
                }

                // if it's a simple track with no angles (i.e. not MISB)
                // then switch to "Manual" for the camera heading
                // which will use the PTZ control as no angles track will be loaded yet
                // ("Manual" is the flattened "Use Angles" + "Manual PTZ".)
                // Only do this for the very first track (trackNumber === 1), not for
                // subsequent tracks from multi-track files like STANAG.
                // BUT skip it when this first track was itself auto-assigned as the target
                // (e.g. a STANAG file whose primary dynamics/pos track IS the target):
                // updateDropTargets already set the heading to "To Target", and forcing
                // "Manual" here would clobber it.
                const targetSwitch = NodeMan.get("targetTrackSwitch", false);
                const firstTrackIsTarget = targetSwitch && targetSwitch.choice === shortName;
                if (!hasAngles && trackNumber === 1 && !firstTrackIsTarget) {
                    console.log("FIRST TRACK LOADED, setting camera heading to Manual")
                    const headingSwitch = NodeMan.get("CameraLOSController", true);
                    if (headingSwitch) {
                        headingSwitch.selectOption("Manual");
                    }
                }

            }

        }
    }

    updateDropTargets(trackNumber, shortName, trackID, trackDataID, trackNode, hasFOV, trackOb) {
        let hasAngles = false;

        // Camera/target role hints from the source file (see CTrackFile.trackRoleHint).
        // A file that declares roles (e.g. STANAG: posHigh -> camera, posLow -> target)
        // replaces the load-order (-1/-2 suffix) auto-selection for the camera/target
        // switches; files without roles keep the ordinal behaviour unchanged.
        const roleFile = trackOb ? FileManager.get(trackOb.trackFileName) : null;
        const roleHint = roleFile?.trackRoleHint ? roleFile.trackRoleHint(trackOb.trackIndex) : null;
        let fileHasRoleHints = false;
        if (roleFile?.trackRoleHint && roleFile.getTrackCount) {
            const n = roleFile.getTrackCount();
            for (let i = 0; i < n; i++) {
                if (roleFile.trackRoleHint(i)) { fileHasRoleHints = true; break; }
            }
        }

        // The one track that may take over BOTH the camera position and the camera
        // heading: it carries the file's measured angles AND is the file's camera.
        //
        // Both halves are needed. anglesAreMeasurement is a property of the DATA, so
        // a file could hold more than one track answering true to it; the camera role
        // names the single track that drives the view. Keying the takeover off the
        // measurement flag alone lets a later track override an earlier one on load
        // order — position and heading stay consistent with each other, so nothing
        // looks wrong, you are just quietly flying the wrong one.
        const trackHasMeasuredAngles =
            roleFile?.anglesAreMeasurement?.(trackOb?.trackIndex) === true;

        // Which track from ANOTHER file currently holds a switch, if it holds that
        // role there. Used to tell a deliberate cross-file arrangement apart from an
        // accidental one produced by two files loading at once.
        const roleOwner = (switchId, role) => {
            const short = NodeMan.get(switchId, false)?.choice;
            const ob = short ? this.get("Track_" + short, false) : null;
            if (!ob || ob.trackFileName === trackOb.trackFileName) return null;
            return FileManager.get(ob.trackFileName)
                ?.trackRoleHint?.(ob.trackIndex) === role ? ob : null;
        };

        // A role-declaring file that supplies NO target of its own must not take the
        // camera from a file that already has a coherent camera+target pair loaded.
        //
        // Taking it would leave the camera on one scenario and the target on either
        // another scenario's object or the sitch's default fixedTarget — and
        // fixedTarget is not an absence, it is a real point (measured at 667 km from
        // the camera after a BOT import), so every range and altitude readout would
        // quietly describe it. Declining is the only outcome with no decoy in it: the
        // established pair survives, and this file's tracks and angles are still
        // offered for the user to select deliberately.
        const suppliesTarget = () => {
            const n = roleFile?.getTrackCount?.() ?? 0;
            for (let i = 0; i < n; i++) {
                if (roleFile.trackRoleHint?.(i) === "target") return true;
            }
            return false;
        };
        const coherentPairElsewhere = () => {
            const camOb = roleOwner("cameraTrackSwitch", "camera");
            if (!camOb) return false;
            const tgtShort = NodeMan.get("targetTrackSwitch", false)?.choice;
            const tgtOb = tgtShort ? this.get("Track_" + tgtShort, false) : null;
            return !!(tgtOb && tgtOb.trackFileName === camOb.trackFileName);
        };
        const mayTakeCamera = !fileHasRoleHints || suppliesTarget() || !coherentPairElsewhere();

        // The heading rides with the camera: if this file is not taking one it must
        // not take the other, or the sightlines come from a different platform than
        // the camera position.
        const isMeasuredCameraTrack =
            trackHasMeasuredAngles && roleHint === "camera" && mayTakeCamera;

        if (Sit.dropTargets !== undefined && Sit.dropTargets["track"] !== undefined) {
            const dropTargets = Sit.dropTargets["track"]
            for (let dropTargetSwitch of dropTargets) {

                // if it ends with a - and a number, then we extract that number, called "selectNumber

                // we set the selectNumber to the track number by default
                // which means that it will always be selected
                // unless the dropTarget has a number at the end
                // in which case it will be selected only that's the same as the track number
                let selectNumber = trackNumber;
                const match = dropTargetSwitch.match(/-(\d+)$/);
                if (match !== null) {
                    selectNumber = Number(match[1]);
                    // strip off the last part
                    dropTargetSwitch = dropTargetSwitch.substring(0, dropTargetSwitch.length - match[0].length);

                }

                if (NodeMan.exists(dropTargetSwitch)) {
                    const switchNode = NodeMan.get(dropTargetSwitch);

//                            console.log("Adding track ", trackID, "  to drop target: ", dropTargetSwitch)

                    if (Sit.dropAsController) {
                        // NOT USED IN CUSTOM SITUATION (or anything other than SitNightSky)
                        // backwards compatibility for SitNightSky
                        // which expects dropped tracks to create a controller
                        switchNode.addOption(shortName, new CNodeControllerTrackPosition({
                            id: "TrackController_" + trackID,
                            sourceTrack: trackID,
                        }))
                        // and select it
                        if (trackNumber === selectNumber) {
                            switchNode.selectOption(shortName)
                        }
                    } else {
                        // drag and drop default now just adds the data source track, not a controller
                        // this is more flexible, as the user can then add a controller if they want
                        switchNode.removeOption(shortName)
                        switchNode.addOption(shortName, NodeMan.get(trackID))

                        // Auto-selection. For the camera/target switches, a role-declaring
                        // file selects by role (camera track into cameraTrackSwitch, target
                        // track into targetTrackSwitch) and its roleless tracks select into
                        // neither; everything else uses the load-order selectNumber rule.
                        const isRoleSwitch = switchNode.id === "cameraTrackSwitch" || switchNode.id === "targetTrackSwitch";
                        let autoSelect;
                        if (isRoleSwitch && fileHasRoleHints) {
                            const wantedRole = switchNode.id === "cameraTrackSwitch" ? "camera" : "target";
                            autoSelect = roleHint === wantedRole;
                        } else {
                            autoSelect = trackNumber === selectNumber;
                        }

                        // A role-declaring file nominates BOTH a camera and a target,
                        // so its pair describes ONE scenario and must stay together.
                        // Drop two such files at once and their tracks interleave, so
                        // the last write to each switch can come from a DIFFERENT file
                        // — camera on one scenario, target on another's object. The
                        // display looks right (the heading still follows its own
                        // camera), but every range readout and the traverse analysis
                        // then measures a sensor against something it never saw.
                        //
                        // Two guards keep the ends together whatever the interleaving:
                        // don't claim the target while another file's camera holds the
                        // switch, and drop a foreign target the moment this file claims
                        // the camera. Both are limited to role-declaring files, so an
                        // ordinary two-file drop (jet from one, object from another)
                        // keeps its load-order pairing untouched.
                        const blockedByForeignCamera = fileHasRoleHints
                            && switchNode.id === "targetTrackSwitch"
                            && roleOwner("cameraTrackSwitch", "camera") !== null;
                        const blockedClaim = blockedByForeignCamera
                            || (switchNode.id === "cameraTrackSwitch" && !mayTakeCamera);
                        // Claiming the camera hands the target to THIS file's own target
                        // track when it has already loaded; when it has not arrived yet,
                        // a foreign nomination is merely dropped and the track claims the
                        // switch itself once processed. Both orders end matched — or with
                        // no target at all, when this file has none to give, which is the
                        // honest answer rather than another scenario's object.
                        const syncTargetToThisFile = () => {
                            if (!fileHasRoleHints) return;
                            const tgt = NodeMan.get("targetTrackSwitch", false);
                            if (!tgt) return;
                            let own = null;
                            this.iterate((k, t) => {
                                if (own || t.trackFileName !== trackOb.trackFileName) return;
                                if (FileManager.get(t.trackFileName)
                                    ?.trackRoleHint?.(t.trackIndex) === "target") own = t;
                            });
                            // Only ever hand the switch to a REAL matching track. There
                            // is no "no target" option to fall back on — fixedTarget is
                            // a real point in the sitch, hundreds of km away here — so
                            // when this file has no target loaded we leave the switch
                            // alone. mayTakeCamera is what stops that leaving a stale
                            // cross-file pair: a file with no target of its own never
                            // takes the camera from a coherent pair in the first place.
                            if (own?.shortName && tgt.inputs?.[own.shortName]) {
                                tgt.selectOptionQuietly(own.shortName);
                            }
                        };

                        // (Quietly, as we don't want to zoom to it yet)
                        if (autoSelect && !blockedClaim && !Globals.sitchEstablished) {
                            if (switchNode.id === "cameraTrackSwitch") syncTargetToThisFile();
                            switchNode.selectOptionQuietly(shortName)

                            // bit of a patch, this will be the second track, and we already set the
                            // camera to follow the first track and "Use Angles"
                            // but now we've added a target track, so we need to change the camera heading
                            // to "To Target" so the first track points at the second track.
                            // EXCEPTION: when the camera heading is the camera track's own recorded
                            // sensor angles and the arriving target is that track's derived Center_
                            // frame-center track (a MISB LOS export re-import), keep the measured
                            // angles — aiming at the smoothed Center track would reconstruct the
                            // sightlines FROM the target (circular) and discard the measurement,
                            // which silently ruins the traverse analysis.
                            if (switchNode.id === "targetTrackSwitch") {
                                const headingSwitch = NodeMan.get("CameraLOSController", true);
                                if (headingSwitch) {
                                    const camShort = NodeMan.get("cameraTrackSwitch", false)?.choice;
                                    const camTrackOb = camShort ? this.get("Track_" + camShort, false) : null;
                                    const keepAngles = shouldPreserveAnglesHeading({
                                        headingChoice: headingSwitch.choice,
                                        cameraShortName: camShort,
                                        arrivingShortName: shortName,
                                        sameSourceFile: !!(camTrackOb && trackOb
                                            && camTrackOb.trackFileName === trackOb.trackFileName),
                                        isSupplementary: !!(roleFile?.isSupplementaryTrack?.(trackOb?.trackIndex)),
                                    });
                                    if (keepAngles) {
                                        console.log("Target track " + shortName + " is the camera track's derived "
                                            + "Center track — keeping measured Camera Heading " + headingSwitch.choice);
                                    } else {
                                        headingSwitch.selectOption("To Target");
                                    }
                                }
                            }
                        }

                        // Symmetric with the camera takeover below: once this file's own
                        // camera track owns the camera switch, its target track takes the
                        // target switch even in an established sitch. Two files dropped
                        // together flip sitchEstablished partway through, so without this
                        // the pair can be left half-set — the camera claimed, the other
                        // file's target correctly dropped, and this track's own claim then
                        // skipped by the established gate, leaving no target at all.
                        if (switchNode.id === "targetTrackSwitch" && fileHasRoleHints
                            && roleHint === "target" && Globals.sitchEstablished) {
                            const camShortNow = NodeMan.get("cameraTrackSwitch", false)?.choice;
                            const camObNow = camShortNow ? this.get("Track_" + camShortNow, false) : null;
                            if (camObNow && camObNow.trackFileName === trackOb.trackFileName) {
                                switchNode.selectOptionQuietly(shortName);
                            }
                        }

                        // Track files like NITF that define their own camera should auto-select
                        // as the camera track, even after sitch is established
                        const autoTrackFile = FileManager.get(trackOb.trackFileName);
                        // A measured-angles track must take the camera POSITION as well as
                        // the heading. The two are one measurement: bearings are only
                        // meaningful from the platform that recorded them. Selecting the
                        // heading alone (which the angles block below does, even in an
                        // established sitch) would leave the camera sitting on whatever
                        // track was already chosen while pointing along this file's
                        // sightlines — a composite of two different sensors that
                        // corresponds to no real observation, and one that looks
                        // perfectly normal on screen.
                        if (switchNode.id === "cameraTrackSwitch"
                            && ((autoTrackFile && autoTrackFile.autoSelectAsCamera)
                                || isMeasuredCameraTrack)) {
                            // Same pairing rule as above: taking the camera invalidates
                            // a target nominated by a different role-declaring file.
                            syncTargetToThisFile();
                            switchNode.selectOption(shortName);
                        }
                    }


                    // // add to the "Sync Time to" menu
                    // GlobalDateTimeNode.addSyncToTrack(trackDataID);
                    // // and call it to sync the time
                    // // we don't need to recalculate from this track
                    // // as it's only just been loaded. ????????
                    // // Actually, we do, as the change in time will change the
                    // // position of the per-frame track segment and the display
                    // if (!Globals.sitchEstablished) {
                    //     GlobalDateTimeNode.syncStartTimeTrack();
                    //
                    //     // PROBLEM - at this point the track was calculated with the old time
                    //     // and the new time will change the position of the track
                    //
                    //     // it's all based on the trackDataNode
                    //    // trackOb.trackDataNode.checkDisplayOutputs = false;
                    //     trackOb.trackDataNode.recalculateCascade();
                    //
                    //     console.log("TrackManager: Updated trackDataNode for ", shortName, " with new time")
                    //
                    // }

                }
            }

            // If we are adding the track to a drop target
            // then also creat a Track Options menu for it, so the user can:
            // - change the color
            // - change the width
            // - toggle the display
            // - toggle distance and altitiude labels
            // - toggle the display of the target sphere
            // - edit the size of the target sphere
            // - toggle wireframe or solid
            // - change the sphere color
            // - toggle sunlight illumination
            // - add a model, like a 737, etc. Maybe even a custom local model?
            // - add a label

            // perhaps we need a track manager to keep track of all the tracks

            // HERE WE ARE!!!!
        }

        // if the track had FOV data, and there's an fov drop target, then add it
        //
        let value = trackNode.v(0);
        if (typeof value === "string") {
            value = Number(value);
        }

        if (typeof value === 'number' && !isNaN(value)) {
            hasFOV = true;
        } else if (value.misbRow !== undefined
            && value.misbRow[MISB.SensorVerticalFieldofView] !== null
            && value.misbRow[MISB.SensorVerticalFieldofView] !== undefined
            && !isNaN(Number(value.misbRow[MISB.SensorVerticalFieldofView]))) {
            hasFOV = true;
        } else if (value.vFOV !== undefined) {
            hasFOV = true;
        }


        if (hasFOV && Sit.dropTargets !== undefined && Sit.dropTargets["fov"] !== undefined) {
            const dropTargets = Sit.dropTargets["fov"]
            for (const dropTargetSwitch of dropTargets) {
                if (NodeMan.exists(dropTargetSwitch)) {
                    const switchNode = NodeMan.get(dropTargetSwitch);
                    switchNode.removeOption(trackID)
                    switchNode.addOption(trackID, NodeMan.get(trackID))
                    if (!Globals.sitchEstablished) {
                        switchNode.selectOption(trackID)
                    }
                }
            }
        }

        // same type of thing for heading angles
        if (value.misbRow !== undefined && typeof value.misbRow[MISB.PlatformPitchAngle] === 'number' && !isNaN(value.misbRow[MISB.PlatformPitchAngle])) {
            hasAngles = true;
        }

        //
        if (hasAngles && Sit.dropTargets !== undefined && Sit.dropTargets["angles"] !== undefined) {
            // 120 frames is a ~4 s window at the 30 fps of a typical MISB video, and
            // stays the default. A source whose angles must not be pre-filtered, or
            // whose tracks are shorter than the window (RollingAverage shrinks the
            // window symmetrically at the ends, so a 120-frame average over a
            // 61-frame track collapses its middle to the mean of the whole track),
            // overrides it via CTrackFile.anglesSmoothing.
            const anglesSmooth = roleFile?.anglesSmoothing
                ? roleFile.anglesSmoothing(trackOb.trackIndex) : 120;
            let data = {
                id: trackID + "_LOS",
                smooth: anglesSmooth, // maybe GUI this?
            }
            let anglesNode = makeLOSNodeFromTrackAngles(trackID, data);
            trackOb.anglesNode = anglesNode;
            let anglesID = "Angles_" + shortName;
            let anglesController = new CNodeControllerMatrix({
                id: anglesID,
                source: anglesNode,
            })
            trackOb.anglesController = anglesController;

            const lookCamera = NodeMan.get("lookCamera");
            lookCamera.addControllerNode(anglesController)
            // The per-track angles controller writes an ABSOLUTE camera pose
            // (quaternion.copy), and track imports always happen after
            // CustomManagerSetup attached the Tracking Wobble controller — so
            // without this, the wobble would land BEFORE the angles in the
            // apply order and be silently wiped every frame whenever a
            // "<name> angles" heading source is selected.
            lookCamera.moveControllerToEnd("trackingWobbleController");

            const dropTargets = Sit.dropTargets["angles"]
            const autoTrackFile = FileManager.get(trackOb.trackFileName);
            // A file whose angles ARE its measurement (a bearings-only interchange
            // file) must select them even into an established sitch. Adding the
            // option without selecting it leaves the heading on its previous value
            // — normally "To Target" — which aims the camera at the target track
            // and substitutes sightlines derived from the answer for the measured
            // ones, with nothing on screen to say so.
            // isMeasuredCameraTrack, not the bare measurement flag: the heading has
            // to follow the same single track the camera POSITION follows, or a
            // second scenario in the same file would supply the heading while the
            // first supplied the position.
            const forceAngles = (autoTrackFile && autoTrackFile.autoSelectAsCamera)
                || isMeasuredCameraTrack;
            // Display the per-track angle option as "<shortName> angles" rather than
            // the raw "Angles_<shortName>" key (which reads like a leaked variable).
            const anglesLabel = shortName + " angles";
            for (const dropTargetSwitch of dropTargets) {
                if (NodeMan.exists(dropTargetSwitch)) {
                    const switchNode = NodeMan.get(dropTargetSwitch);
                    switchNode.removeOption(anglesID)
                    switchNode.addOption(anglesID, NodeMan.get(anglesID), anglesLabel)
                    // The unestablished-sitch auto-select needs the same restriction
                    // as forceAngles. A file with several angle-bearing sub-tracks
                    // (two concatenated BOT scenarios) would otherwise let whichever
                    // loads LAST claim the heading, while the camera POSITION
                    // correctly follows the claiming track — pointing one scenario's
                    // bearings from another scenario's platform. Files whose angles
                    // are not a declared measurement keep the previous behaviour.
                    const anglesAutoOk = !trackHasMeasuredAngles || isMeasuredCameraTrack;
                    if (forceAngles || (!Globals.sitchEstablished && anglesAutoOk)) {
                        switchNode.selectOption(anglesID)
                    }
                }
            }
        }

        let hasWind = false;
        // and for wind speed and direction
        if (value.misbRow !== undefined && typeof value.misbRow[MISB.WindSpeed] === 'number' && !isNaN(value.misbRow[MISB.WindSpeed])) {
            hasWind = true;
        }

        if (hasWind && Sit.dropTargets !== undefined && Sit.dropTargets["wind"] !== undefined) {

            // TODO - make a wind data node from this track
            // shoudl return heading and speed

            const dropTargets = Sit.dropTargets["wind"]
            for (const dropTargetSwitch of dropTargets) {
                if (NodeMan.exists(dropTargetSwitch)) {

                    // THEN ADD IT TO THE DROP TARGET

                    // BUT WHAT ABOUT MANUAL WIND?
                    // WE"D NEED A WIND NODE THAT RETURNS MANUAL WIND
                    // So we need to add a manual wind node
                    // need to handlge local, and target wind, and the locking

                }
            }
        }
        return hasAngles;
    }

    findShortName(trackFileName, trackIndex, moreTracks, configuredShortNames = undefined) {
        // try to find the flight number as a shorter name
        // For check for format like: FlightAware_DAL2158_KCHS_KBOS_20230218.kml
        let shortName = trackFileName
        if (trackIndex > 0) {
            // additional tracks will have a _1, _2, etc added to the name
            // in case the short name (i.e the plane's tail number) is not found
            shortName += "_" + trackIndex;
        }
        let found = false;


        // Check first if the parse file is a CTrackFile,

        const file = FileManager.get(trackFileName);
        // When present, prefer serialized shortName metadata over parser-derived naming.
        // Parser-derived names can change with file type/format conversions, which would
        // otherwise change node IDs and orphan saved mods.
        const preferredShortName = configuredShortNames?.[trackIndex]
            ?? configuredShortNames?.[String(trackIndex)];
        if (file instanceof CTrackFile) {
            if (preferredShortName !== undefined && preferredShortName !== null && preferredShortName !== "") {
                shortName = preferredShortName;
            } else {
                shortName = file.getShortName(trackIndex, trackFileName);
            }
            if (file.hasMoreTracks(trackIndex)) {
                moreTracks = true;
            }
            found = !!shortName;
        }

        const ext = getFileExtension(trackFileName);
        if (!found && ext === "json") {
            const geo = new CGeoJSON();
            geo.json = file;
            shortName = geo.shortTrackIDForIndex(trackIndex);
            found = true;

            if (trackIndex < geo.countTracks() - 1) {
                moreTracks = true;
            }
        }

        if (!found) {
            const match = trackFileName.match(/FlightAware_([A-Z0-9]+)_/);
            if (match !== null) {
                shortName = match[1];
            } else {
                const match2 = trackFileName.match(/([A-Z0-9]+)-track-/);
                if (match2 !== null) {
                    shortName = match2[1];
                } else {
                    const match3 = trackFileName.match(/([A-Z0-9]+)-[0-9a-f]+\.kml/);
                    if (match3 !== null) {
                        shortName = match3[1];
                    } else {
                        shortName = trackFileName.replace(/\.[^/.]+$/, "");
                    }
                }
            }
        }


        // if the short name is a number string, then prepend a #
        // for backwards compatibility, do not do this for loaded sitches prior to 2.9.2
        // but do do it if we are not deserializing
        if ((!Globals.deserializing || Globals.exportTagNumber >= 2009003)
            && !isNaN(Number(shortName))) {
            console.warn("Track short name is numeric only, prepending # to make it a valid name: ", shortName);
            shortName = "#" + shortName;
        }

        // Ensure uniqueness by adding _1, _2, etc. if duplicate
        let uniqueShortName = shortName;
        let counter = 1;
        while (this.usedShortNames.has(uniqueShortName)) {
            uniqueShortName = shortName + "_" + counter;
            counter++;
        }

        // Store the unique short name
        this.usedShortNames.add(uniqueShortName);

        return {shortName: uniqueShortName, moreTracks};
    }

    // Centralized removal for both imported and synthetic tracks.
    // Besides disposing the track nodes themselves, this also:
    // - removes the track from the "Sync Time to" menu
    // - drops the backing FileManager entry when no imported track still uses it
    // - resets sitchEstablished when the last track goes away, so the next first
    //   imported track can once again establish time/location automatically
    disposeRemove(id) {
        if (id === undefined) {
            return;
        }

        const trackID = typeof id === "object" ? id.id : id;
        if (!this.exists(trackID)) {
            return;
        }

        const trackOb = this.get(trackID);
        const trackFileName = trackOb?.trackFileName;
        const syncTrackID = trackOb?.trackDataNode?.id;

        if (syncTrackID && GlobalDateTimeNode?.removeSyncToTrack) {
            GlobalDateTimeNode.removeSyncToTrack(syncTrackID);
        }

        if (trackOb?.isSynthetic) {
            this.disposeSyntheticTrack(trackID);
        } else if (trackOb?.isBalloon) {
            this.disposeBalloonTrack(trackID);
        } else {
            super.disposeRemove(trackID);
        }

        // Remove the source file only when this was the final imported track using it.
        // Multi-track files like ADS-B Exchange KMLs share one FileManager entry, so
        // deleting that entry too early would break the remaining tracks from the file.
        if (trackFileName && !hasOtherTrackSourceReference(this, trackFileName)) {
            if (FileManager.exists(trackFileName)) {
                FileManager.disposeRemove(trackFileName);
            }
            if (Sit.loadedFiles) {
                delete Sit.loadedFiles[trackFileName];
            }
            if (FileManager.loadedFilesMetadata) {
                delete FileManager.loadedFilesMetadata[trackFileName];
            }
        }

        if (this.size() === 0) {
            setSitchEstablished(false);
        }

        // The imported-track set just shrank; notify listeners (wind GUI)
        // so any "Track: <shortName>" source options pointing at this
        // track get pruned.
        this.notifyTracksChanged();
    }

    /**
     * Add a synthetic (user-created) track to the TrackManager
     * @param {Object} options - Track creation options
     * @param {Vector3} options.startPoint - Starting point in ECEF coordinates
     * @param {string} options.name - Optional name for the track
     * @param {string} options.objectID - Optional 3D object to associate with track
     * @param {boolean} options.editMode - Whether to start in edit mode (default: true)
     * @param {string} options.curveType - Type of curve: "linear", "catmull", "chordal", "centripetal" (default: "chordal")
     * @param {number} options.color - Track color as hex (default: 0xffff00)
     * @param {number} options.lineWidth - Track line width (default: 1)
     * @param {number} options.startFrame - Frame number for the initial point (default: 0)
     * @param {boolean} options.showInLook - Whether the track should also render in the look view (default: false)
     * @returns {Object} The created track object
     */
    addSyntheticTrack(options) {
        const trackNumber = this.size();
        const name = options.name || `Track ${trackNumber + 1}`;
        const curveType = options.curveType || "chordal";
        const editMode = options.editMode !== undefined ? options.editMode : true;
        const colorHex = options.color;
        const lineWidth = options.lineWidth || 1;
        const startFrame = options.startFrame !== undefined ? options.startFrame : 0;
        const showInLook = !!options.showInLook;
        
        // Use provided shortName or generate unique short name for display (like "synth_01_d")
        const shortName = options.shortName || `synth_${String(trackNumber + 1).padStart(2, '0')}_d`;
        
        // Use provided IDs if available (for deserialization), otherwise generate new ones
        const trackID = options.trackID || `syntheticTrack_${Date.now()}`;
        const displayTrackID = options.displayTrackID || `syntheticTrackDisplay_${Date.now()}`;
        
        // Get the main view ID
        const viewID = "mainView";
        const view = NodeMan.get(viewID);
        if (!view) {
            console.error("TrackManager.addSyntheticTrack: No view found");
            return null;
        }
        
        const scene = view.scene;
        if (!scene) {
            console.error("TrackManager.addSyntheticTrack: View has no scene");
            return null;
        }

        // Claim the short name in the shared registry that the imported-track and
        // balloon-track paths uniquify against. disposeSyntheticTrack (and
        // CMetaTrack.dispose) already RELEASE it, so without this the pair was
        // one-sided: a KML or balloon loaded after a synthetic track could pick the
        // same short name and take over its drop-target switch options. Registered
        // here — after the early returns, before anything is built — so a failed
        // creation cannot leave an orphaned reservation. Covers every route in:
        // the Add Track menu, spline import, and deserialization of a saved sitch.
        this.usedShortNames.add(shortName);

        // Prepare initial points - CNodeSplineEditor expects [frame, x, y, z] format
        let initialPoints = [];
        if (options.initialPoints) {
            initialPoints = options.initialPoints;
        } else if (options.startPoint) {
            const sp = options.startPoint;
            initialPoints.push([startFrame, sp.x, sp.y, sp.z]);
        }
        
        // Smart fallback: Use linear interpolation if we don't have enough points for spline curves
        let effectiveCurveType = curveType;
        if (initialPoints.length < 4 && curveType !== "linear") {
            effectiveCurveType = "linear";
            console.log(`TrackManager: Using linear interpolation (only ${initialPoints.length} point(s), need 4 for ${curveType})`);
        }
        
        // Create GUI folder in Contents menu using the DISPLAY TRACK ID
        // This is important: CNodeDisplayTrack will look for a folder with this.in.track.id
        // So we create the folder with trackID, which is what the display track will reference
        // IMPORTANT: Don't change the folder title yet! getFolder() looks up by innerText,
        // so we need to keep it as trackID until after CNodeDisplayTrack finds it
        const guiFolder = guiMenus.contents.addFolder(trackID);
        
        // Create unsmoothed spline editor node (the raw data track)
        // Pass skipGUI: true to prevent it from creating its own GUI in physics menu
        const unsmoothedID = trackID + "_unsmoothed";
        const splineEditorNode = new CNodeSplineEditor({
            id: unsmoothedID,
            type: effectiveCurveType,
            scene: scene,
            camera: "mainCamera",
            view: viewID,
            // -1 means "track Sit.frames" (CNode sets useSitFrames), rather than
            // snapshotting the count that happened to be current at creation. A
            // hand-drawn track has to span the sitch: the normal order of work is
            // to draw or import a track and THEN load the video that sets the real
            // duration, and a snapshot would leave it stuck at the old length.
            frames: -1,
            initialPoints: initialPoints,
            // Synthetic tracks are created in current world coordinates (EUS/ECEF in current model),
            // not legacy local-tangent EUS from old sitches.
            legacyEUS: false,
            skipGUI: true, // Don't create GUI in physics menu
            pruneIfUnused: true,
        });
        
        splineEditorNode.menuText = name;
        const splineEditor = splineEditorNode.splineEditor;
        
        // Create smoothing window GUI control
        new CNodeGUIValue({
            id: trackID + "_smoothValue",
            value: 0,
            start: 0,
            end: 200,
            step: 1,
            desc: "Smoothing window",
        }, guiFolder);

        new CNodeGUIValue({
            id: trackID + "_tensionValue",
            value: 0.5,
            start: 0,
            end: 1,
            step: 0.01,
            desc: "Catmull Tension",
        }, guiFolder);

        new CNodeGUIValue({
            id: trackID + "_intervalsValue",
            value: 10,
            start: 2,
            end: 100,
            step: 1,
            desc: "Catmull Intervals",
        }, guiFolder);

        new CNodeGUIValue({
            id: trackID + "_polyOrderValue",
            value: 3,
            start: 1,
            end: 5,
            step: 1,
            desc: "SavGol Poly Order",
        }, guiFolder);

        new CNodeGUIValue({
            id: trackID + "_edgeOrderValue",
            value: 2,
            start: 1,
            end: 5,
            step: 1,
            desc: "Edge Fit Order",
        }, guiFolder);

        new CNodeGUIValue({
            id: trackID + "_fitWindowValue",
            value: 100,
            start: 3,
            end: 400,
            step: 1,
            desc: "Edge Fit Window",
        }, guiFolder);
        
        // Create smoothed track node that wraps the unsmoothed spline editor
        const smoothedTrackNode = new CNodeSmoothedPositionTrack({
            id: trackID,
            source: unsmoothedID,
            method: "movingPolyEdge",
            window: trackID + "_smoothValue",
            tension: trackID + "_tensionValue",
            intervals: trackID + "_intervalsValue",
            polyOrder: trackID + "_polyOrderValue",
            edgeOrder: trackID + "_edgeOrderValue",
            fitWindow: trackID + "_fitWindowValue",
            isDynamicSmoothing: true,
            guiFolder: guiFolder,
            copyData: false,
            exportable: false,
        });
        
        // Convert hex color to RGB array for display track. A serialised track
        // always carries its colour, so only a brand-new one falls through to
        // the auto palette — this used to default to pure yellow, which is the
        // traverse track's colour and is deliberately excluded from the palette.
        const trackColor = colorHex !== undefined
            ? new Color(
                ((colorHex >> 16) & 0xff) / 255,
                ((colorHex >> 8) & 0xff) / 255,
                (colorHex & 0xff) / 255
            )
            : this.nextPaletteColor();
        
        // Create display track for visualization
        // Don't use skipGUI - let it create its controls in the folder we just created
        // It will find the folder by looking up this.in.track.id (which is trackID)
        const displayTrack = new CNodeDisplayTrack({
            id: displayTrackID,
            track: trackID,
            color: new CNodeConstant({
                id: "colorSynthetic_" + trackID,
                value: trackColor,
                pruneIfUnused: true
            }),
            width: lineWidth,
            extendToGround: true, // Synthetic tracks extend to ground by default
            // A synthetic track is user-drawn, not video-derived analysis data,
            // so it must not be greyed outside Sit.aFrame/bFrame — same as
            // imported and balloon tracks. Without this a sitch whose bFrame
            // sits at 0 renders the whole track in the out-of-range colour,
            // making the Line Color picker look broken.
            ignoreAB: true,
            // skipGUI: false (default) - let it add controls to the folder
        });
        
        // NOW change the folder title to the short name
        // This must happen AFTER CNodeDisplayTrack has found the folder
        guiFolder.$title.innerText = shortName;
        
        // Create the track object - use smoothedTrackNode as the primary track node
        const trackOb = this.add(trackID, new CMetaTrack(null, smoothedTrackNode, smoothedTrackNode));
        trackOb.trackID = trackID;
        trackOb.menuText = shortName;
        trackOb.isSynthetic = true;
        trackOb.splineEditor = splineEditor;
        trackOb.splineEditorNode = splineEditorNode; // Keep reference to unsmoothed node
        trackOb.smoothedTrackNode = smoothedTrackNode; // Reference to smoothed wrapper
        trackOb.displayTrack = displayTrack;
        trackOb.displayTrackID = displayTrackID;
        trackOb.guiFolder = guiFolder;
        trackOb.trackColor = trackColor;
        trackOb.curveType = curveType;
        trackOb.editMode = editMode; // Store initial edit mode state
        trackOb.constantSpeed = false; // Default to time-based interpolation
        trackOb.extrapolateTrack = true; // Default to extrapolating beyond control points
        trackOb.objectID = options.objectID || null; // Store associated object ID
        
        splineEditorNode.shortName = shortName;
        smoothedTrackNode.shortName = shortName;
        
        // Add edit mode checkbox to the GUI folder (before display track controls)
        // This checkbox controls whether the track is in edit mode
        guiFolder.add(trackOb, 'editMode').name(t("trackManager.editTrack")).onChange((value) => {
            splineEditor.setEnable(value);
            
            // Set or clear the global editing track reference
            if (value) {
                // Disable edit mode on any other track that's currently being edited
                if (Globals.editingTrack && Globals.editingTrack !== trackOb) {
                    Globals.editingTrack.editMode = false;
                    Globals.editingTrack.splineEditor.setEnable(false);
                }
                Globals.editingTrack = trackOb;
                console.log(`Edit mode enabled for track: ${shortName}`);
            } else {
                if (Globals.editingTrack === trackOb) {
                    Globals.editingTrack = null;
                }
                console.log(`Edit mode disabled for track: ${shortName}`);
            }
        });
        
        // Sync constantSpeed from splineEditorNode (in case it was loaded from saved data)
        if (splineEditorNode.constantSpeed !== undefined) {
            trackOb.constantSpeed = splineEditorNode.constantSpeed;
        }
        
        // Sync extrapolateTrack from splineEditorNode (in case it was loaded from saved data)
        if (splineEditorNode.extrapolateTrack !== undefined) {
            trackOb.extrapolateTrack = splineEditorNode.extrapolateTrack;
        }
        
        // Add constant speed checkbox to the GUI folder
        // This checkbox controls whether the track uses constant speed interpolation
        guiFolder.add(trackOb, 'constantSpeed').name(t("trackManager.constantSpeed")).onChange((value) => {
            splineEditorNode.constantSpeed = value;
            splineEditorNode.recalculateCascade();
            console.log(`Constant speed ${value ? 'enabled' : 'disabled'} for track: ${shortName}`);
        });
        
        // Add extrapolate track checkbox to the GUI folder
        // This checkbox controls whether the track extrapolates beyond first/last control points
        guiFolder.add(trackOb, 'extrapolateTrack').name(t("trackManager.extrapolateTrack")).onChange((value) => {
            splineEditorNode.extrapolateTrack = value;
            splineEditorNode.recalculateCascade();
            console.log(`Extrapolate track ${value ? 'enabled' : 'disabled'} for track: ${shortName}`);
        });
        
        // Add curve type dropdown
        const curveTypeOptions = ['linear', 'catmull', 'centripetal', 'chordal'];
        guiFolder.add(trackOb, 'curveType', curveTypeOptions).name(t("trackManager.curveType")).onChange((value) => {
            splineEditorNode.setCurveType(value);
            console.log(`Curve type changed to ${value} for track: ${shortName}`);
        });
        
        // Same control the imported data tracks get from CNodeDisplayTrack (which
        // only builds it when there's a dataTrack input, so synthetic tracks never
        // saw one). Matched label, range and units; ordered before Alt Lock as there.
        trackOb.altitudeOffset = 0;
        new CNodeGUIValue({
            id: trackID + "_altitudeOffset",
            value: 0,
            start: -1000,
            end: 1000,
            step: 1,
            desc: "Alt offset",
            unitType: "small",
            onChange: (v) => {
                trackOb.altitudeOffset = v;
                splineEditorNode.setAltitudeOffset(v);
            },
            // NOT pruneIfUnused: this drives its track through an onChange callback
            // rather than a graph edge, so it has no inputs and no outputs and
            // pruneUnusedFlagged() (which runs whenever any track is removed) would
            // delete it — the control would vanish from a spline that still exists.
            // disposeSyntheticTrack removes it by name instead.
        }, guiFolder);

        trackOb.altitudeLock = -1;
        new CNodeGUIValue({
            id: trackID + "_altitudeLock",
            value: -1,
            start: -1,
            end: 1000,
            step: 1,
            desc: "Alt Lock (-1 = off)",
            unitType: "small",
            onChange: (v) => {
                trackOb.altitudeLock = v;
                splineEditorNode.setAltitudeLock(v);
            },
            elastic: true,
            elasticMin: 1000,
            elasticMax: 100000,
            // Same reason as Alt offset above — it was prunable, so removing any
            // other track silently deleted this spline's Alt Lock control.
        }, guiFolder);

        trackOb.altitudeLockAGL = true;
        guiFolder.add(trackOb, 'altitudeLockAGL').name(t("trackManager.altLockAGL")).listen().onChange((value) => {
            splineEditorNode.setAltitudeLockAGL(value);
        });
        
        // Set initial edit mode state
        if (editMode) {
            splineEditor.setEnable(true);
            Globals.editingTrack = trackOb;
        }

        // Show-in-look-view toggle. Synthetic tracks default to MASK_HELPERS
        // (main view only); enabling this adds the LOOK layer bit so the
        // displayTrack renders in the look view too.
        trackOb.showInLook = showInLook;
        if (showInLook) {
            displayTrack.setLayerBit(LAYER.LOOK, true);
        }
        guiFolder.add(trackOb, "showInLook").name(t("misc.showInLookView.label")).listen().onChange((value) => {
            displayTrack.setLayerBit(LAYER.LOOK, value);
            setRenderOne(true);
        });

        // Write the control points out as a droppable .spline.json. Lives on the
        // unsmoothed spline node (that's where the control points are), but is
        // surfaced here so it sits with the rest of the track's controls.
        guiFolder.add({
            exportSpline: () => splineEditorNode.exportSplineJSON()
        }, "exportSpline").name(t("trackManager.exportSpline"));

        // Add delete button to the folder
        const dummy = {
            deleteTrack: async () => {
                if (await showConfirm(`Delete synthetic track "${shortName}"?`, {title: "Delete Track"})) {
                    this.disposeSyntheticTrack(trackID);
                }
            }
        };
        guiFolder.add(dummy, "deleteTrack").name(t("trackManager.deleteTrack"));
        
        // Add to drop targets if configured
        if (Sit.dropTargets !== undefined && Sit.dropTargets["track"] !== undefined) {
            const dropTargets = Sit.dropTargets["track"];
            for (let dropTargetSwitch of dropTargets) {
                // Strip off any -number suffix
                const match = dropTargetSwitch.match(/-(\d+)$/);
                if (match !== null) {
                    dropTargetSwitch = dropTargetSwitch.substring(0, dropTargetSwitch.length - match[0].length);
                }
                
                if (NodeMan.exists(dropTargetSwitch)) {
                    const switchNode = NodeMan.get(dropTargetSwitch);
                    switchNode.removeOption(shortName);
                    switchNode.addOption(shortName, splineEditorNode);
                }
            }
        }
        
        // Associate with object if provided
        if (options.objectID) {
            const objectNode = NodeMan.get(options.objectID);
            if (objectNode) {
                // Add TrackPosition controller to follow the track
                objectNode.addController("TrackPosition", {
                    sourceTrack: trackID
                });

                // Add ObjectTilt controller to orient in direction of motion
                // NOTE: ObjectTilt creates internal CNodeSmoothedPositionTrack that must be cleaned up
                // When disposing this object, use: CustomMan.disposeObjectWithControllers(objectID)
                objectNode.addController("ObjectTilt", {
                    track: trackID,
                    tiltType: "banking",
                    guiFolder: objectNode.gui,
                });

                console.log(`Associated object ${options.objectID} with track ${trackID} and added controllers`);
            } else {
                console.warn(`Object ${options.objectID} not found`);
            }
        }
        
        // Enable edit mode if requested
        if (editMode) {
            splineEditor.setEnable(true);
        }
        
        console.log(`Created synthetic track: ${trackID} (${name})`);
        
        // Recalculate and render
        NodeMan.recalculateAllRootFirst();
        setRenderOne(true);
        
        return trackOb;
    }

    /**
     * Dispose a synthetic track
     * @param {string} trackID - ID of the track to delete
     */
    disposeSyntheticTrack(trackID) {
        const trackOb = this.get(trackID);
        if (!trackOb || !trackOb.isSynthetic) {
            console.warn(`Synthetic track ${trackID} not found`);
            return;
        }
        
        // Clear global editing track reference if this is the track being edited
        if (Globals.editingTrack === trackOb) {
            Globals.editingTrack = null;
        }

        this.usedShortNames.delete(trackOb.menuText);

        disposeDirectTrackDependentControllers(trackOb.smoothedTrackNode ?? NodeMan.get(trackID, false));
        
        // Disable edit mode first and dispose the spline editor
        if (trackOb.splineEditor) {
            trackOb.splineEditor.setEnable(false);
            // Dispose the spline editor to clean up the position indicator cone
            if (trackOb.splineEditor.dispose) {
                trackOb.splineEditor.dispose();
            }
        }
        
        // Remove from drop targets
        const shortName = trackOb.menuText;
        if (Sit.dropTargets !== undefined && Sit.dropTargets["track"] !== undefined) {
            const dropTargets = Sit.dropTargets["track"];
            for (let dropTargetSwitch of dropTargets) {
                const match = dropTargetSwitch.match(/-(\d+)$/);
                if (match !== null) {
                    dropTargetSwitch = dropTargetSwitch.substring(0, dropTargetSwitch.length - match[0].length);
                }
                
                if (NodeMan.exists(dropTargetSwitch)) {
                    const switchNode = NodeMan.get(dropTargetSwitch);
                    switchNode.removeOption(shortName);
                }
            }
        }
        
        // Remove GUI folder
        if (trackOb.guiFolder) {
            trackOb.guiFolder.destroy();
        }
        
        // Remove display track
        if (trackOb.displayTrackID) {
            NodeMan.unlinkDisposeRemove(trackOb.displayTrackID);
        }
        
        // Remove color constant
        NodeMan.unlinkDisposeRemove("colorSynthetic_" + trackID);
        
        // Remove smoothing-related nodes and altitude lock
        NodeMan.unlinkDisposeRemove(trackID + "_smoothValue"); // Smoothing window GUI value
        NodeMan.unlinkDisposeRemove(trackID + "_tensionValue"); // Catmull tension GUI value
        NodeMan.unlinkDisposeRemove(trackID + "_intervalsValue"); // Catmull intervals GUI value
        NodeMan.unlinkDisposeRemove(trackID + "_polyOrderValue"); // SavGol polynomial order GUI value
        NodeMan.unlinkDisposeRemove(trackID + "_edgeOrderValue"); // SavGol edge fit order GUI value
        NodeMan.unlinkDisposeRemove(trackID + "_fitWindowValue"); // SavGol edge fit window GUI value
        NodeMan.unlinkDisposeRemove(trackID + "_altitudeOffset"); // Altitude offset GUI value
        NodeMan.unlinkDisposeRemove(trackID + "_altitudeLock"); // Altitude lock GUI value
        NodeMan.unlinkDisposeRemove(trackID + "_unsmoothed"); // Unsmoothed spline editor
        NodeMan.unlinkDisposeRemove(trackID); // Smoothed track wrapper
        
        // Remove from manager
        this.remove(trackID);
        
        console.log(`Deleted synthetic track: ${trackID}`);
        
        // Full sitch teardown is already disposing the entire graph, so a
        // mid-dispose recalc only touches partially-unlinked nodes.
        if (!Globals.disposing) {
            NodeMan.recalculateAllRootFirst();
            setRenderOne(true);
        }
    }

    /**
     * Add a simulated balloon target track ("Add Balloon" in the ground
     * context menu). Unlike synthetic (keyframe) tracks, the balloon's
     * per-frame positions are computed by CNodeBalloonTrack from launch
     * parameters + the loaded wind — so it is NOT flagged isSynthetic
     * (the synthetic serialize/dispose paths assume a spline editor).
     * Persistence is generator-style instead: serializeBalloons() saves the
     * parameters, deserializeBalloons() recreates the same node ids before
     * the mods pass (the appFlight pattern in CustomManagerSerialize).
     *
     * @param {Object} options
     * @param {number} options.startLat - launch latitude (degrees)
     * @param {number} options.startLon - launch longitude (degrees)
     * @param {number} options.startAltitude - launch altitude (m MSL, default 0 = ground at click)
     * @param {number} options.launchDelay - seconds before launch (default 0)
     * @param {number} options.buoyancy - ascent rate m/s (default 5)
     * @param {number} options.windVariability - gust % (default 20)
     * @param {number} options.seed - PRNG seed (default 1)
     * @param {string} options.trackID/objectID/displayTrackID - preserved ids on deserialize
     * @param {number} options.color - track color hex (default orange)
     * @param {boolean} options.showInLook - also render in the look view
     * @returns {Object|null} The created CMetaTrack entry
     */
    addBalloonTrack(options) {
        const trackID = options.trackID || `balloonTrack_${Date.now()}`;
        const objectID = options.objectID || `balloonObject_${Date.now()}`;
        const displayTrackID = options.displayTrackID || `balloonTrackDisplay_${Date.now()}`;
        const lineWidth = options.lineWidth || 1;

        // unique short name: Balloon, Balloon_1, ...
        let shortName = options.shortName || "Balloon";
        let counter = 1;
        while (this.usedShortNames.has(shortName)) {
            shortName = (options.shortName || "Balloon") + "_" + counter;
            counter++;
        }
        this.usedShortNames.add(shortName);

        // GUI folder in Contents. Titled with the trackID first —
        // CNodeDisplayTrack locates it by the track node's id — then renamed
        // to the short name below.
        const guiFolder = guiMenus.contents.addFolder(trackID);

        // Launch parameters (persisted via the mods pass; ids are stable)
        new CNodeGUIValue({
            id: trackID + "_startAltitude",
            value: options.startAltitude ?? 0,
            start: 0, end: 10000, step: 1,
            desc: "Start Altitude (m MSL)",
            elastic: true, elasticMin: 1000, elasticMax: 40000,
            tip: "Launch altitude in meters MSL (defaults to the ground at the click point)",
        }, guiFolder);
        new CNodeGUIValue({
            id: trackID + "_launchDelay",
            value: options.launchDelay ?? 0,
            start: 0, end: 120, step: 0.1,
            desc: "Launch Delay (s)",
            tip: "Seconds after the sitch start before the balloon lifts off",
        }, guiFolder);
        new CNodeGUIValue({
            id: trackID + "_buoyancy",
            value: options.buoyancy ?? 5,
            start: -10, end: 20, step: 0.1,
            desc: "Buoyancy (m/s)",
            tip: "Steady ascent rate once launched (negative = descending)",
        }, guiFolder);
        new CNodeGUIValue({
            id: trackID + "_windVariability",
            value: options.windVariability ?? 20,
            start: 0, end: 100, step: 1,
            desc: "Wind Variability (%)",
            tip: "Random gustiness as a percentage of the local wind speed",
        }, guiFolder);
        new CNodeGUIValue({
            id: trackID + "_seed",
            value: options.seed ?? 1,
            start: 1, end: 9999, step: 1,
            desc: "Random Seed",
            tip: "Change for a different (but repeatable) flight path",
        }, guiFolder);

        const balloonNode = new CNodeBalloonTrack({
            id: trackID,
            startLat: options.startLat,
            startLon: options.startLon,
            startAltitude: trackID + "_startAltitude",
            launchDelay: trackID + "_launchDelay",
            buoyancy: trackID + "_buoyancy",
            windVariability: trackID + "_windVariability",
            seed: trackID + "_seed",
        });
        balloonNode.menuText = shortName;
        balloonNode.shortName = shortName;

        // A serialised / undo-redo balloon always carries its colour, so only a
        // freshly added one falls through to the auto palette. Previously this
        // defaulted to a fixed orange, so every balloon in a sitch came out the
        // same colour (and reinforced the overall orange bias).
        const trackColor = options.color !== undefined
            ? new Color(
                ((options.color >> 16) & 0xff) / 255,
                ((options.color >> 8) & 0xff) / 255,
                (options.color & 0xff) / 255
            )
            : this.nextPaletteColor();

        const displayTrack = new CNodeDisplayTrack({
            id: displayTrackID,
            track: trackID,
            color: new CNodeConstant({
                id: "colorBalloon_" + trackID,
                value: trackColor,
                pruneIfUnused: true
            }),
            width: lineWidth,
            extendToGround: true,
            // A balloon is a synthetic full-length track, not video-derived
            // analysis data, so it must not be greyed outside Sit.aFrame/bFrame
            // — same as imported tracks (see makeMotionTrack). Without this a
            // sitch with bFrame at 0 renders the whole balloon in the
            // out-of-range colour, making the Line Color picker look broken.
            ignoreAB: true,
        });

        // now the display track has found the folder, show the short name
        guiFolder.$title.innerText = shortName;

        // the balloon itself: a 0.5 m radius sphere riding the track
        const objectNode = new CNode3DObject({
            id: objectID,
            geometry: "sphere",
            radius: 0.5,
            color: 0xf0f0f0,
            material: "phong",
        });
        objectNode.addController("TrackPosition", {
            sourceTrack: trackID
        });

        const trackOb = this.add(trackID, new CMetaTrack(null, balloonNode, balloonNode));
        trackOb.trackID = trackID;
        trackOb.menuText = shortName;
        trackOb.isBalloon = true;
        trackOb.displayTrack = displayTrack;
        trackOb.displayTrackID = displayTrackID;
        trackOb.guiFolder = guiFolder;
        trackOb.trackColor = trackColor;
        trackOb.objectID = objectID;

        // Show-in-look-view toggle (same semantics as synthetic tracks)
        trackOb.showInLook = !!options.showInLook;
        if (trackOb.showInLook) {
            displayTrack.setLayerBit(LAYER.LOOK, true);
        }
        guiFolder.add(trackOb, "showInLook").name(t("misc.showInLookView.label")).listen().onChange((value) => {
            displayTrack.setLayerBit(LAYER.LOOK, value);
            setRenderOne(true);
        });

        const dummy = {
            deleteTrack: async () => {
                if (await showConfirm(`Delete balloon "${shortName}"?`, {title: "Delete Balloon"})) {
                    this.disposeRemove(trackID);
                }
            }
        };
        guiFolder.add(dummy, "deleteTrack").name(t("trackManager.deleteTrack"));

        // Register in the track drop-target switches (Camera/Target Track...)
        // so the camera can track the balloon — which also makes it the truth
        // source for the MISB CSV export.
        if (Sit.dropTargets !== undefined && Sit.dropTargets["track"] !== undefined) {
            const dropTargets = Sit.dropTargets["track"];
            for (let dropTargetSwitch of dropTargets) {
                const match = dropTargetSwitch.match(/-(\d+)$/);
                if (match !== null) {
                    dropTargetSwitch = dropTargetSwitch.substring(0, dropTargetSwitch.length - match[0].length);
                }
                if (NodeMan.exists(dropTargetSwitch)) {
                    const switchNode = NodeMan.get(dropTargetSwitch);
                    switchNode.removeOption(shortName);
                    switchNode.addOption(shortName, balloonNode);
                }
            }
        }

        console.log(`Created balloon track: ${trackID} (${shortName}) at ${options.startLat}, ${options.startLon}`);

        NodeMan.recalculateAllRootFirst();
        setRenderOne(true);
        this.notifyTracksChanged();

        return trackOb;
    }

    disposeBalloonTrack(trackID) {
        const trackOb = this.get(trackID);
        if (!trackOb || !trackOb.isBalloon) {
            console.warn(`Balloon track ${trackID} not found`);
            return;
        }

        this.usedShortNames.delete(trackOb.menuText);

        // the sphere's TrackPosition controller (and anything else riding the track)
        disposeDirectTrackDependentControllers(NodeMan.get(trackID, false));

        // remove from the track drop-target switches
        const shortName = trackOb.menuText;
        if (Sit.dropTargets !== undefined && Sit.dropTargets["track"] !== undefined) {
            const dropTargets = Sit.dropTargets["track"];
            for (let dropTargetSwitch of dropTargets) {
                const match = dropTargetSwitch.match(/-(\d+)$/);
                if (match !== null) {
                    dropTargetSwitch = dropTargetSwitch.substring(0, dropTargetSwitch.length - match[0].length);
                }
                if (NodeMan.exists(dropTargetSwitch)) {
                    NodeMan.get(dropTargetSwitch).removeOption(shortName);
                }
            }
        }

        if (trackOb.guiFolder) {
            trackOb.guiFolder.destroy();
        }

        if (trackOb.displayTrackID) {
            NodeMan.unlinkDisposeRemove(trackOb.displayTrackID);
        }
        NodeMan.unlinkDisposeRemove("colorBalloon_" + trackID);

        // the balloon sphere (unlike synthetic tracks, the object is intrinsic
        // to the balloon, so deleting the balloon deletes it too)
        if (trackOb.objectID) {
            NodeMan.unlinkDisposeRemove(trackOb.objectID);
        }

        NodeMan.unlinkDisposeRemove(trackID + "_startAltitude");
        NodeMan.unlinkDisposeRemove(trackID + "_launchDelay");
        NodeMan.unlinkDisposeRemove(trackID + "_buoyancy");
        NodeMan.unlinkDisposeRemove(trackID + "_windVariability");
        NodeMan.unlinkDisposeRemove(trackID + "_seed");
        NodeMan.unlinkDisposeRemove(trackID);

        this.remove(trackID);

        console.log(`Deleted balloon track: ${trackID}`);

        if (!Globals.disposing) {
            NodeMan.recalculateAllRootFirst();
            setRenderOne(true);
        }
    }

    /**
     * Serialize all balloon tracks: compact generator parameters, recreated
     * deterministically on load (deserializeBalloons) BEFORE the mods pass,
     * which then restores the GUI values by node id.
     */
    serializeBalloons() {
        const balloons = [];
        this.iterate((id, trackOb) => {
            if (!trackOb.isBalloon) return;
            const node = trackOb.trackNode;
            const paramValue = (suffix, fallback) => {
                const n = NodeMan.get(trackOb.trackID + suffix, false);
                return n ? n.value : fallback;
            };
            balloons.push({
                trackID: trackOb.trackID,
                displayTrackID: trackOb.displayTrackID,
                objectID: trackOb.objectID,
                shortName: trackOb.menuText,
                startLat: node.startLat,
                startLon: node.startLon,
                startAltitude: paramValue("_startAltitude", 0),
                launchDelay: paramValue("_launchDelay", 0),
                buoyancy: paramValue("_buoyancy", 5),
                windVariability: paramValue("_windVariability", 20),
                seed: paramValue("_seed", 1),
                showInLook: !!trackOb.showInLook,
                // width lives on the display node's "width" INPUT (edited by
                // the Line Width slider) — there is no .width property
                lineWidth: trackOb.displayTrack?.in?.width?.value ?? 1,
                color: trackOb.trackColor ?
                    (Math.round(trackOb.trackColor.r * 255) << 16) |
                    (Math.round(trackOb.trackColor.g * 255) << 8) |
                    Math.round(trackOb.trackColor.b * 255) : 0xffa040,
            });
        });
        return balloons;
    }

    deserializeBalloons(balloonsData) {
        if (!balloonsData || balloonsData.length === 0) {
            return;
        }
        for (const b of balloonsData) {
            try {
                this.addBalloonTrack(b);
            } catch (e) {
                console.error(`Failed to recreate balloon track ${b.trackID}:`, e);
            }
        }
    }

    /**
     * Serialize all synthetic tracks
     * This is called during the serialization process to save synthetic track metadata
     * @returns {Array} Array of synthetic track metadata objects
     */
    serialize() {
        const syntheticTracks = [];
        
        this.iterate((key, trackOb) => {
            if (trackOb.isSynthetic) {
                // Get the spline editor node to extract control points
                // The actual spline editor is in the _unsmoothed version
                const unsmoothedID = trackOb.trackID + "_unsmoothed";
                const splineEditorNode = NodeMan.get(unsmoothedID);
                
                // Extract positions from the spline editor
                let positions = [];
                if (splineEditorNode && splineEditorNode.splineEditor) {
                    const editor = splineEditorNode.splineEditor;
                    if (editor.positions && editor.frameNumbers) {
                        for (let i = 0; i < editor.positions.length; i++) {
                            const p = editor.positions[i];
                            positions.push([editor.frameNumbers[i], p.x, p.y, p.z]);
                        }
                    }
                }
                
                // If there's an associated object, save its properties
                let objectData = null;
                if (trackOb.objectID) {
                    const objectNode = NodeMan.get(trackOb.objectID);
                    if (objectNode) {
                        objectData = {
                            id: trackOb.objectID,
                            geometry: objectNode.common.geometry, // Get the geometry type string from common
                            radius: objectNode.geometryParams.radius, // Get radius from geometryParams
                            color: objectNode.color, // Color is stored directly
                            material: objectNode.common.material, // Get the material type string from common
                        };
                    }
                }
                
                let elevationCacheData = null;
                if (splineEditorNode && splineEditorNode.serializeElevationCache) {
                    elevationCacheData = splineEditorNode.serializeElevationCache();
                }

                const trackData = {
                    trackID: trackOb.trackID,
                    displayTrackID: trackOb.displayTrackID,
                    menuText: trackOb.menuText,
                    shortName: trackOb.trackNode?.shortName || trackOb.menuText,
                    curveType: trackOb.curveType,
                    editMode: trackOb.editMode,
                    constantSpeed: trackOb.constantSpeed,
                    extrapolateTrack: trackOb.extrapolateTrack,
                    showInLook: !!trackOb.showInLook,
                    altitudeLock: trackOb.altitudeLock,
                    altitudeLockAGL: trackOb.altitudeLockAGL,
                    color: trackOb.trackColor ? 
                        (Math.round(trackOb.trackColor.r * 255) << 16) |
                        (Math.round(trackOb.trackColor.g * 255) << 8) |
                        Math.round(trackOb.trackColor.b * 255) : 0xffff00,
                    lineWidth: trackOb.displayTrack?.width || 1,
                    positions: positions,
                    objectData: objectData,
                    elevationCache: elevationCacheData,
                };
                
                syntheticTracks.push(trackData);
                console.log(`Serialized synthetic track: ${trackOb.trackID}`);
            }
        });
        
        return syntheticTracks;
    }

    /**
     * Deserialize synthetic tracks
     * This is called early in the deserialization process to recreate synthetic tracks
     * BEFORE mods are applied to the nodes
     * @param {Array} syntheticTracksData - Array of synthetic track metadata objects
     */
    deserialize(syntheticTracksData) {
        if (!syntheticTracksData || syntheticTracksData.length === 0) {
            console.log("No synthetic tracks to deserialize");
            return;
        }
        
        console.log(`Deserializing ${syntheticTracksData.length} synthetic track(s)`);
        
        for (const trackData of syntheticTracksData) {
            try {
                // Extract the first position to use as startPoint
                // This ensures the track is created with at least one control point
                let startPoint = null;
                if (trackData.positions && trackData.positions.length > 0) {
                    const firstPos = trackData.positions[0];
                    // positions are in format [frame, x, y, z]
                    startPoint = {
                        x: firstPos[1],
                        y: firstPos[2],
                        z: firstPos[3]
                    };
                }
                
                // Recreate the associated 3D object if it exists
                // This must be done BEFORE creating the track so the object exists
                // when addSyntheticTrack tries to associate them
                if (trackData.objectData) {
                    const objData = trackData.objectData;
                    const objectNode = new CNode3DObject({
                        id: objData.id,
                        geometry: objData.geometry,
                        radius: objData.radius,
                        color: objData.color,
                        material: objData.material,
                        position: startPoint, // Initial position (will be overridden by track)
                    });
                    console.log(`Recreated 3D object: ${objData.id}`);
                }
                
                // Recreate the synthetic track with the saved parameters
                // Note: We pass editMode: false initially, as the actual edit mode
                // will be restored when mods are applied
                const options = {
                    name: trackData.menuText,
                    // MUST pass the saved shortName: switch options (orbitTargetSwitch,
                    // targetTrackSwitch, ...) and their saved choice mods are keyed by it.
                    // Without it addSyntheticTrack regenerates "synth_NN_d" from the current
                    // track count, which drifts when other tracks (e.g. sondes) load first.
                    // Fall back to menuText for older saves (they were kept identical).
                    shortName: trackData.shortName ?? trackData.menuText,
                    curveType: trackData.curveType,
                    editMode: false, // Will be restored by mods
                    color: trackData.color,
                    lineWidth: trackData.lineWidth,
                    showInLook: !!trackData.showInLook,
                    // Preserve the original IDs so mods can be applied correctly
                    trackID: trackData.trackID,
                    displayTrackID: trackData.displayTrackID,
                    // Pass the first position as startPoint to initialize the track
                    startPoint: startPoint,
                    // Pass the associated object ID if any
                    objectID: trackData.objectData?.id,
                };
                
                // Create the track
                const trackOb = this.addSyntheticTrack(options);
                
                // Verify the nodes were created and registered
                if (trackOb) {
                    console.log(`Created track with ID: ${trackOb.trackID}, exists in NodeMan: ${NodeMan.exists(trackOb.trackID)}`);
                    console.log(`Created display track with ID: ${trackOb.displayTrackID}, exists in NodeMan: ${NodeMan.exists(trackOb.displayTrackID)}`);
                }
                
                // Controllers (TrackPosition and ObjectTilt) are now added automatically by addSyntheticTrack
                
                if (trackOb && trackData.positions && trackData.positions.length > 1) {
                    // Restore ALL positions using the spline editor's load method
                    // This will replace the initial point we just created
                    // Note: The actual spline editor is the _unsmoothed node
                    const unsmoothedID = trackOb.trackID + "_unsmoothed";
                    const splineEditorNode = NodeMan.get(unsmoothedID);
                    if (splineEditorNode && splineEditorNode.splineEditor) {
                        // Use the load method which handles the positions array
                        splineEditorNode.splineEditor.load(trackData.positions);
                        splineEditorNode.recalculateCascade();
                    }
                }
                
                // Restore other properties that aren't handled by mods
                if (trackOb) {
                    trackOb.constantSpeed = trackData.constantSpeed ?? false;
                    trackOb.extrapolateTrack = trackData.extrapolateTrack ?? true;
                    trackOb.altitudeLock = trackData.altitudeLock ?? -1;
                    trackOb.altitudeLockAGL = trackData.altitudeLockAGL ?? true;
                    trackOb.curveType = trackData.curveType ?? 'chordal';
                    
                    // Update the spline editor node with these properties
                    // Note: The actual spline editor is the _unsmoothed node
                    const unsmoothedID = trackOb.trackID + "_unsmoothed";
                    const splineEditorNode = NodeMan.get(unsmoothedID);
                    if (splineEditorNode) {
                        splineEditorNode.constantSpeed = trackOb.constantSpeed;
                        splineEditorNode.extrapolateTrack = trackOb.extrapolateTrack;
                        // Set altitude lock directly without triggering recalculate
                        // The final recalculateAllRootFirst() will handle it
                        splineEditorNode.altitudeLock = trackOb.altitudeLock;
                        splineEditorNode.altitudeLockAGL = trackOb.altitudeLockAGL;
                        splineEditorNode.updateAltitudeLock();
                        // Update curve type
                        if (trackOb.curveType && typeof splineEditorNode.setCurveType === 'function') {
                            splineEditorNode.setCurveType(trackOb.curveType);
                        }
                        
                        // Update the GUI slider value if it exists
                        const altLockNode = NodeMan.get(trackOb.trackID + "_altitudeLock", false);
                        if (altLockNode) {
                            altLockNode.value = trackOb.altitudeLock;
                        }
                        
                        // Ensure edit mode is disabled after deserialization
                        // Transform controls should not be visible when loading a saved situation
                        splineEditorNode.enable = false;
                        if (splineEditorNode.splineEditor) {
                            splineEditorNode.splineEditor.setEnable(false);
                        }
                    }
                    
                    if (splineEditorNode && trackData.elevationCache) {
                        splineEditorNode.deserializeElevationCache(trackData.elevationCache);
                    }

                    if (splineEditorNode) {
                        splineEditorNode.recalculate();
                        splineEditorNode._needsRecalculate = false;
                        assert(splineEditorNode.frames === 0 || splineEditorNode.getValueFrame(0)?.position !== undefined,
                            "Spline editor node was recalculated but is not materialized");
                    }
                    if (trackOb.smoothedTrackNode) {
                        trackOb.smoothedTrackNode.recalculate();
                        trackOb.smoothedTrackNode._needsRecalculate = false;
                        assert(trackOb.smoothedTrackNode.frames === 0 || trackOb.smoothedTrackNode.getValueFrame(0)?.position !== undefined,
                            "Smoothed track node was recalculated but is not materialized");
                    }
                    if (trackOb.displayTrack) {
                        trackOb.displayTrack.recalculate();
                    }
                }
                
                console.log(`Deserialized synthetic track: ${trackData.trackID}`);
            } catch (error) {
                console.error(`Failed to deserialize synthetic track ${trackData.trackID}:`, error);
            }
        }
        
        // Recalculate everything after recreating all tracks
        NodeMan.recalculateAllRootFirst();
    }
}


export function addKMLMarkers(kml) {
    console.log(kml)
}

export const _TrackManager = new CTrackManager();
