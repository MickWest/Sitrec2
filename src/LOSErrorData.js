import {GlobalDateTimeNode, NodeMan, Sit} from "./Globals";
import {getLocalUpVector} from "./SphericalMath";
import {MISB} from "./MISBFields";
import {misbSightlineHeading} from "./MISBSightline";
import {angularResidual, cadence} from "./LOSErrorModel";
import {t} from "./i18n";

// The node that a switch (or a chain of switches) has selected.
export function selectedNode(node) {
    const seen = new Set();
    while (node?.getObject && !seen.has(node)) {
        seen.add(node);
        node = node.getObject();
    }
    return node;
}

// The MISB track node that a node's data comes from, searching its inputs.
function sourceTrack(node, seen = new Set()) {
    node = selectedNode(node);
    if (!node || seen.has(node)) return null;
    seen.add(node);
    if (node.in?.misb?.misb && node.timeArray) return node;
    for (const input of Object.values(node.in ?? {})) {
        const found = sourceTrack(input, seen);
        if (found) return found;
    }
    return null;
}

// True when a frame is inside the frames that the node's source data covers, or when the
// node has no such limit.
function withinData(node, frame) {
    const source = sourceTrack(node);
    const span = source?.getDataFrameSpan?.();
    return !span || (frame >= span.first && frame <= span.last);
}

const xyz = vector => [vector?.x, vector?.y, vector?.z];

// The MISB columns of the attitude angles that misbSightlineHeading uses.
const ANGLE_COLUMNS = {
    platformHeading: MISB.PlatformHeadingAngle,
    platformPitch: MISB.PlatformPitchAngle,
    platformRoll: MISB.PlatformRollAngle,
    sensorAz: MISB.SensorRelativeAzimuthAngle,
    sensorEl: MISB.SensorRelativeElevationAngle,
    sensorRoll: MISB.SensorRelativeRollAngle,
};

/** Capture relative angular errors against truth, without modifying the scene.
 * Recorded MISB LOS is evaluated at its ORIGINAL record timestamps with raw
 * attitude columns, rather than treating expanded display frames as data.
 * Other LOS sources use the scene grid, explicitly labelled as unverified. */
export function collectLOSErrorSamples({losNode, truthNode, frame0 = 0, frame1,
    scene = Sit, clock = GlobalDateTimeNode, originalHz = null, videoData = null}) {
    const los = selectedNode(losNode);
    const physicalHz = scene.fps / (scene.simSpeed ?? 1);
    if (!los || !truthNode) throw new Error(t("losErrorAnalysis.data.needInputs"));
    frame1 = frame1 ?? Math.min(los.frames, scene.frames) - 1;
    const track = los.in?.cameraTrack;
    const source = track && los.in?.sensorAz && los.in?.platformHeading ? sourceTrack(track) : null;
    const data = source?.in.misb;
    const samples = [];
    const geometry = [];
    const counts = {outsideCoverage: 0, invalidGeometry: 0, missingAttitude: 0, nonIncreasingTime: 0};
    const append = (frame, seconds, position, heading) => {
        if (!withinData(truthNode, frame) || !withinData(track ?? los, frame)) {
            counts.outsideCoverage++;
            return;
        }
        const target = truthNode.p(frame);
        const sensor = xyz(position);
        const targetXYZ = xyz(target);
        const up = position?.isVector3 ? xyz(getLocalUpVector(position)) : null;
        const error = up ? angularResidual(sensor, targetXYZ, xyz(heading), up) : null;
        if (!error) {
            counts.invalidGeometry++;
            return;
        }
        if (samples.length && seconds <= samples.at(-1).t) {
            counts.nonIncreasingTime++;
            return;
        }
        samples.push({t: seconds, e: error});
        geometry.push({t: seconds, sensor, target: targetXYZ, up});
    };

    let cadenceSource;
    if (data) {
        const ptsMode = source.pairingInfo?.mode === "pts";
        const video = ptsMode ? (videoData ?? NodeMan?.get("video", false)?.videoData) : null;
        const framePTS = video?.framePTSus;
        const recordPTS = data.misb.pesPTSus;
        if (ptsMode && (!framePTS?.length || !recordPTS?.length)) throw new Error(t("losErrorAnalysis.data.ptsUnavailable"));
        let videoFrame = 0;
        for (let record = 0; record < data.misb.length; record++) {
            const time = data.getTime(record);
            let frame;
            let seconds;
            if (ptsMode) {
                // Invert the SAME normalized PES/video lookup used by the
                // position node. Keep record times, not nominal frame/fps time.
                const recordTime = recordPTS[record];
                if (!Number.isFinite(recordTime)) {
                    counts.nonIncreasingTime++;
                    continue;
                }
                const wanted = recordTime + framePTS[0];
                while (videoFrame + 1 < framePTS.length && framePTS[videoFrame + 1] <= wanted) videoFrame++;
                const nextFrame = Math.min(videoFrame + 1, framePTS.length - 1);
                const fraction = (wanted - framePTS[videoFrame]) / (framePTS[nextFrame] - framePTS[videoFrame] || 1);
                frame = videoFrame + fraction - (source.getTimeOffsetFrames?.() ?? 0);
                seconds = recordTime / 1e6 - (source.getTimeOffsetFrames?.() ?? 0) / physicalHz;
                if (wanted < framePTS[0] || wanted > framePTS.at(-1)) {
                    counts.outsideCoverage++;
                    continue;
                }
            } else {
                frame = (time - clock.frameToMS(0)) * physicalHz / 1000 - (source.getTimeOffsetFrames?.() ?? 0);
                seconds = frame / physicalHz;
            }
            if (!Number.isFinite(frame) || frame < frame0 - 1e-6 || frame > frame1 + 1e-6) continue;
            if (data.isValid && !data.isValid(record)) {
                counts.outsideCoverage++;
                continue;
            }
            const angles = Object.fromEntries(Object.entries(ANGLE_COLUMNS).map(([key, column]) => [key, data.misb[record][column]]));
            if (!Object.values(angles).every(angle => typeof angle === "number" && Number.isFinite(angle))) {
                counts.missingAttitude++;
                continue;
            }
            const position = track.p(frame);
            if (!position || !xyz(position).every(Number.isFinite)) {
                counts.invalidGeometry++;
                continue;
            }
            append(frame, seconds, position, misbSightlineHeading(position, angles));
        }
        cadenceSource = t(ptsMode ? "losErrorAnalysis.data.cadencePTS" : "losErrorAnalysis.data.cadenceRecorded");
    } else {
        const hz = originalHz ?? physicalHz;
        if (!(hz > 0) || hz > physicalHz * 1.001) throw new Error(t("losErrorAnalysis.data.rateTooHigh"));
        const count = Math.floor((frame1 - frame0) / physicalHz * hz + 1e-7) + 1;
        for (let index = 0; index < count; index++) {
            // Only evaluate existing scene frames; never interpolate a new LOS.
            const frame = frame0 + Math.round(index * physicalHz / hz);
            const value = los.v(frame);
            append(frame, frame / physicalHz, value?.position, value?.heading);
        }
        cadenceSource = t(originalHz ? "losErrorAnalysis.data.cadenceUser" : "losErrorAnalysis.data.cadenceScene");
    }
    if (samples.length < 2) throw new Error(t("losErrorAnalysis.data.notEnough"));
    const origin = samples[0].t;
    for (const sample of samples) sample.t -= origin;
    for (const row of geometry) row.t -= origin;
    return {
        samples, geometry, counts, cadenceSource, recordedCadence: !!data, physicalHz,
        cadence: cadence(samples), losLabel: los.id, frame0, frame1,
    };
}

/** Explicit synthetic-data export. Contains the chosen platform/target geometry
 * and fresh directions, never the measured pointing or measured residuals. */
export function syntheticLOSCSV(geometry, errors, directionWithError) {
    if (geometry.length !== errors.length) throw new Error(t("losErrorAnalysis.data.syntheticMismatch"));
    const header = "TimeSeconds,SensorECEF_X_m,SensorECEF_Y_m,SensorECEF_Z_m,TargetECEF_X_m,TargetECEF_Y_m,TargetECEF_Z_m,LOS_ECEF_X,LOS_ECEF_Y,LOS_ECEF_Z";
    return header + "\n" + geometry.map((row, index) => {
        const direction = directionWithError(row.sensor, row.target, errors[index].e, row.up);
        if (!direction) throw new Error(t("losErrorAnalysis.data.syntheticInvalid"));
        return [row.t, ...row.sensor, ...row.target, ...direction].join(",");
    }).join("\n") + "\n";
}
