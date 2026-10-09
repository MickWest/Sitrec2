import {GlobalDateTimeNode, NodeMan, Sit} from "./Globals";
import {getLocalUpVector} from "./SphericalMath";
import {MISB} from "./MISBFields";
import {misbSightlineHeading} from "./MISBSightline";
import {angularResidual, cadence} from "./LOSErrorModel";

export function selectedNode(node) {
    const seen=new Set();
    while(node?.getObject && !seen.has(node)) {seen.add(node);node=node.getObject();}
    return node;
}

function sourceTrack(node, seen=new Set()) {
    node=selectedNode(node);
    if(!node || seen.has(node)) return null;
    seen.add(node);
    if(node.in?.misb?.misb && node.timeArray) return node;
    for(const input of Object.values(node.in ?? {})) {
        const found=sourceTrack(input,seen);
        if(found) return found;
    }
    return null;
}

function withinData(node, frame) {
    const source=sourceTrack(node), span=source?.getDataFrameSpan?.();
    return !span || (frame>=span.first && frame<=span.last);
}

const xyz = v => [v?.x,v?.y,v?.z];

/** Capture relative angular errors against truth, without modifying the scene.
 * Recorded MISB LOS is evaluated at its ORIGINAL record timestamps with raw
 * attitude columns, rather than treating expanded display frames as data.
 * Other LOS sources use the scene grid, explicitly labelled as unverified. */
export function collectLOSErrorSamples({losNode, truthNode, frame0=0, frame1,
    scene=Sit, clock=GlobalDateTimeNode, originalHz=null, videoData=null}) {
    const los=selectedNode(losNode), physicalHz=scene.fps/(scene.simSpeed ?? 1);
    if(!los || !truthNode) throw new Error("Choose a pointing LOS and a truth track first.");
    frame1=frame1 ?? Math.min(los.frames,scene.frames)-1;
    const track=los.in?.cameraTrack, source=track && los.in?.sensorAz && los.in?.platformHeading ? sourceTrack(track) : null;
    const data=source?.in.misb, samples=[], geometry=[], counts={outsideCoverage:0,invalidGeometry:0,missingAttitude:0,nonIncreasingTime:0};
    const append=(frame,t,position,heading)=>{
        if(!withinData(truthNode,frame) || !withinData(track ?? los,frame)) {counts.outsideCoverage++;return;}
        const target=truthNode.p(frame), sensor=xyz(position), targetXYZ=xyz(target);
        const up=position?.isVector3 ? xyz(getLocalUpVector(position)) : null;
        const e=up ? angularResidual(sensor,targetXYZ,xyz(heading),up) : null;
        if(!e) {counts.invalidGeometry++;return;}
        if(samples.length && t<=samples.at(-1).t) {counts.nonIncreasingTime++;return;}
        samples.push({t,e}); geometry.push({t,sensor,target:targetXYZ,up});
    };
    let cadenceSource;
    if(data) {
        const angleFields={platformHeading:MISB.PlatformHeadingAngle,platformPitch:MISB.PlatformPitchAngle,
            platformRoll:MISB.PlatformRollAngle,sensorAz:MISB.SensorRelativeAzimuthAngle,
            sensorEl:MISB.SensorRelativeElevationAngle,sensorRoll:MISB.SensorRelativeRollAngle};
        const ptsMode=source.pairingInfo?.mode==="pts";
        const video=ptsMode ? (videoData ?? NodeMan?.get("video",false)?.videoData) : null;
        const pts=video?.framePTSus, recordPTS=data.misb.pesPTSus;
        if(ptsMode && (!pts?.length || !recordPTS?.length)) throw new Error("Recorded LOS timing uses video PTS, but the original timestamp arrays are unavailable.");
        let videoFrame=0;
        for(let i=0;i<data.misb.length;i++) {
            const time=data.getTime(i);
            let frame,t;
            if(ptsMode) {
                // Invert the SAME normalized PES/video lookup used by the
                // position node. Keep record times, not nominal frame/fps time.
                const record=recordPTS[i];
                if(!Number.isFinite(record)) {counts.nonIncreasingTime++;continue;}
                const wanted=record+pts[0];
                while(videoFrame+1<pts.length && pts[videoFrame+1]<=wanted) videoFrame++;
                const next=Math.min(videoFrame+1,pts.length-1),fraction=(wanted-pts[videoFrame])/(pts[next]-pts[videoFrame]||1);
                frame=videoFrame+fraction-(source.getTimeOffsetFrames?.() ?? 0);
                t=record/1e6-(source.getTimeOffsetFrames?.() ?? 0)/physicalHz;
                if(wanted<pts[0] || wanted>pts.at(-1)) {counts.outsideCoverage++;continue;}
            } else {
                frame=(time-clock.frameToMS(0))*physicalHz/1000-(source.getTimeOffsetFrames?.() ?? 0);
                t=frame/physicalHz;
            }
            if(!Number.isFinite(frame) || frame<frame0-1e-6 || frame>frame1+1e-6) continue;
            if(data.isValid && !data.isValid(i)) {counts.outsideCoverage++;continue;}
            const angles=Object.fromEntries(Object.entries(angleFields).map(([key,column])=>[key,data.misb[i][column]]));
            if(!Object.values(angles).every(x=>typeof x==="number" && Number.isFinite(x))) {counts.missingAttitude++;continue;}
            const position=track.p(frame);
            if(!position || !xyz(position).every(Number.isFinite)) {counts.invalidGeometry++;continue;}
            append(frame,t,position,misbSightlineHeading(position,angles));
        }
        cadenceSource=ptsMode ? "Original attitude PES timestamps paired to video PTS (raw angles; current platform/truth positions)" : "Original recorded attitude timestamps (raw angle columns; current platform/truth positions)";
    } else {
        const hz=originalHz ?? physicalHz;
        if(!(hz>0) || hz>physicalHz*1.001) throw new Error("Original rate must be positive and no higher than the scene rate.");
        const count=Math.floor((frame1-frame0)/physicalHz*hz+1e-7)+1;
        for(let i=0;i<count;i++) {
            // Only evaluate existing scene frames; never interpolate a new LOS.
            const frame=frame0+Math.round(i*physicalHz/hz), value=los.v(frame);
            append(frame,frame/physicalHz,value?.position,value?.heading);
        }
        cadenceSource=originalHz ? "User-specified recording cadence, nearest scene frames" : "Scene frames; original recording cadence unverified";
    }
    if(samples.length<2) throw new Error("Not enough overlapping valid pointing and truth samples in A–B.");
    const origin=samples[0].t;
    for(const s of samples) s.t-=origin;
    for(const row of geometry) row.t-=origin;
    return {samples,geometry,counts,cadenceSource,recordedCadence:!!data,physicalHz,
        cadence:cadence(samples),losLabel:los.id,frame0,frame1};
}

/** Explicit synthetic-data export. Contains the chosen platform/target geometry
 * and fresh directions, never the measured pointing or measured residuals. */
export function syntheticLOSCSV(geometry, errors, directionWithError) {
    if(geometry.length!==errors.length) throw new Error("Synthetic samples do not match the geometry.");
    const header="TimeSeconds,SensorECEF_X_m,SensorECEF_Y_m,SensorECEF_Z_m,TargetECEF_X_m,TargetECEF_Y_m,TargetECEF_Z_m,LOS_ECEF_X,LOS_ECEF_Y,LOS_ECEF_Z";
    return header+"\n"+geometry.map((r,i)=>{
        const d=directionWithError(r.sensor,r.target,errors[i].e,r.up);
        if(!d) throw new Error("Synthetic angular error is too large or geometry is invalid.");
        return [r.t,...r.sensor,...r.target,...d].join(",");
    }).join("\n")+"\n";
}
