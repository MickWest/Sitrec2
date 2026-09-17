// Metadata sampled at the source frame actually sent to the video encoder.
import {GlobalDateTimeNode, NodeMan} from "./Globals";
import {par} from "./par";
import {ECEFToLLAVD_radii} from "./LLA-ECEF-ENU";
import {ensureGeoidLoaded, meanSeaLevelOffset} from "./EGM96Geoid";
import {encodeMISBLocalSet, MISB_TRUTH_MISSION} from "./MISBEncoder";
import {getCameraKMLPose} from "./ExportCameraKML";
import {raycastGroundElevationFast} from "./raycastGround";
const wrap = degrees => (degrees % 360 + 360) % 360;

function location(position) {
    if (!position || ![position.x, position.y, position.z].every(Number.isFinite)) return null;
    const lla = ECEFToLLAVD_radii(position);
    return [lla.x, lla.y, lla.z - meanSeaLevelOffset(lla.x, lla.y)];
}

// Keep UTF-8 text within ST 0601's 127-byte fields, including non-ASCII names.
function misbName(name) {
    let result = "";
    for (const character of String(name || "Sitrec")) {
        if (new TextEncoder().encode(result + character).length > 127) break;
        result += character;
    }
    return result;
}

export function buildMISBExportRecords({timestamp, pose, vfov, aspect, cameraName,
    targetPosition = null, truthPosition = null, truthName, groundPoint = null}) {
    const values = {
        2: timestamp, 3: "Sitrec", 4: misbName(cameraName),
        5: 0, 6: 0, 7: 0,
        13: pose.lat, 14: pose.lon, 15: pose.altMSL,
        16: 2 * Math.atan(Math.tan(vfov * Math.PI / 360) * aspect) * 180 / Math.PI,
        17: vfov, 18: wrap(pose.heading), 19: pose.tilt - 90, 20: wrap(pose.roll),
    };
    const target = location(targetPosition);
    if (target) {
        [values[40], values[41], values[42]] = target;
        values[21] = pose.position.distanceTo(targetPosition);
    }
    const ground = location(groundPoint);
    if (ground) [values[23], values[24], values[25]] = ground;
    const truth = location(truthPosition);
    // ST 0601 has one target location, not an independent truth field. Use a
    // separate position-only local set on its own TS PID, labelled as truth.
    // Do not put Sitrec's internal CSV extension indices onto the MISB wire.
    return {
        camera: {klv: encodeMISBLocalSet(values)},
        truth: truth ? {klv: encodeMISBLocalSet({
            2: timestamp, 3: MISB_TRUTH_MISSION, 4: misbName(truthName || "Truth"),
            13: truth[0], 14: truth[1], 15: truth[2],
        })} : null,
    };
}

function positionAt(track, frame) {
    try { return track?.p(frame) ?? null; } catch (_) { return null; }
}

export async function createMISBExportSampler({view = null, sourceVideo = false} = {}) {
    await ensureGeoidLoaded();
    const {resolveTruthTrack} = await import("./AnalyzeTraverse");
    view ??= NodeMan.get("lookView", false);
    const cameraNode = view?.cameraNode ?? NodeMan.get("lookCamera", false);
    if (!cameraNode?.camera || !GlobalDateTimeNode) {
        throw new Error("MISB TS export requires a camera and a start date.");
    }
    const target = NodeMan.get("targetTrackSwitch", false);
    const truth = resolveTruthTrack();
    return () => {
        const frame = par.frame;
        // Source-video rendering does not run the 3-D view's update loop.
        if (sourceVideo) cameraNode.update(frame);
        const pose = getCameraKMLPose(cameraNode, sourceVideo ? null : view);
        const camera = cameraNode.camera;
        return buildMISBExportRecords({
            timestamp: Math.round(GlobalDateTimeNode.frameToMS(frame) * 1000),
            pose,
            vfov: sourceVideo ? camera.fov : (camera.renderedFOV ?? camera.fov),
            aspect: sourceVideo ? (NodeMan.get("video", false)?.videoData?.videoWidth
                / NodeMan.get("video", false)?.videoData?.videoHeight || camera.aspect) : camera.aspect,
            cameraName: cameraNode.id,
            targetPosition: positionAt(target, frame),
            truthPosition: positionAt(truth?.trackNode, frame),
            truthName: truth?.label,
            groundPoint: raycastGroundElevationFast(pose.position, pose.forward),
        });
    };
}
