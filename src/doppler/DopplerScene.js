import {BufferGeometry, Float32BufferAttribute, Group, Points, PointsMaterial} from "three";
import {Line2} from "three/addons/lines/Line2.js";
import {LineSegmentsGeometry} from "three/addons/lines/LineSegmentsGeometry.js";
import {moveTerrainTo} from "../CoordinateInput";
import {NodeMan, setRenderOne} from "../Globals";
import {MASK_HELPERS} from "../LayerMasks";
import {LLAToECEF} from "../LLA-ECEF-ENU";
import {GlobalScene} from "../LocalFrame";
import {disposeMatLine, makeMatLine} from "../MatLines";
import {observerTrack, prepareTrack, toECEF} from "./DopplerModel";

const COLORS=["#55d7ff","#ffb95c","#a0e09b","#dc9bff"];

// This transient overlay never registers nodes, replaces tracks, or changes the
// simulation clock. Its geometry belongs to the main view's helper layer.
export class DopplerScene {
    show({candidate,rank,events,tracks,soundSpeed=343,maxGap=30}) {
        if(this.disposed) throw new Error("This candidate scene has been disposed.");
        if(!candidate || ![candidate.lat,candidate.lon,candidate.altitudeM,candidate.recordingStart].every(Number.isFinite) ||
            Math.abs(candidate.lat)>90 || Math.abs(candidate.lon)>180 || !Number.isFinite(soundSpeed) || soundSpeed<280 || soundSpeed>380 ||
            !Number.isFinite(maxGap) || maxGap<=0 || !Array.isArray(events) || !events.length || events.length>4 ||
            !Array.isArray(candidate.events) || candidate.events.length!==events.length || !Array.isArray(tracks) ||
            candidate.events.some(e=>!e || typeof e.flight!=="string") ||
            events.some(e=>!e || !Number.isFinite(e.start) || !Number.isFinite(e.end) || e.start>=e.end)) {
            throw new Error("Choose a valid candidate with its events, source tracks, sound speed and maximum fix gap.");
        }
        if(!GlobalScene) throw new Error("The 3D scene is not available.");
        const group=new Group();group.name="Doppler candidate review";group.layers.mask=MASK_HELPERS;
        const origin=LLAToECEF(candidate.lat,candidate.lon,candidate.altitudeM);
        group.position.copy(origin);
        const observer=toECEF(candidate.lat,candidate.lon,candidate.altitudeM),byID=new Map(tracks.map(track=>[String(track.id),track]));
        const resources=[],legend=[];let extent=1000;
        try {
            for(const [eventIndex,event] of events.entries()) {
                const fit=candidate.events[eventIndex],track=byID.get(String(fit.flight)),color=COLORS[eventIndex];
                const entry={eventIndex,name:event.name ?? `Event ${eventIndex+1}`,id:String(fit.flight),color,
                    callsign:track?.callsign ?? "",registration:track?.registration ?? "",aircraftType:track?.aircraftType ?? "",
                    frequency:fit.frequency,rmsHz:fit.rmsHz,cpaArrival:fit.cpaArrival,rangeM:fit.rangeM,speedMS:fit.speedMS,
                    recordingWindow:[event.start,event.end],sourceIntervals:[],segmentCount:0};
                entry.identity=[entry.callsign,entry.registration,entry.aircraftType,entry.id].filter((value,index,all)=>value && all.indexOf(value)===index).join(" / ");
                legend.push(entry);
                if(!track) {entry.status="missing_track";entry.message="The candidate source track is unavailable.";continue;}
                let view;
                try {view=observerTrack(prepareTrack(track,soundSpeed,maxGap),observer,soundSpeed);}
                catch(error) {entry.status="unusable_track";entry.reason=error.message;entry.message=error.message;continue;}
                const start=candidate.recordingStart+event.start,end=candidate.recordingStart+event.end;
                const fixes=new Map(track.points.map(point=>[point.time,point])),positions=[];
                for(const segment of view.segments) {
                    if(segment.arrival1<start || segment.arrival0>end) continue;
                    // Render original fix endpoints, without clipping, resampling,
                    // or bridging an absent model segment. At most one fix can
                    // extend beyond either acoustic event boundary.
                    for(const time of [segment.t0,segment.t1]) {
                        const point=fixes.get(time),relative=LLAToECEF(point.lat,point.lon,point.altitudeM).sub(origin);
                        extent=Math.max(extent,relative.length());positions.push(relative.x,relative.y,relative.z);
                    }
                    const previous=entry.sourceIntervals.at(-1);
                    if(previous && previous[1]===segment.t0) previous[1]=segment.t1;
                    else entry.sourceIntervals.push([segment.t0,segment.t1]);
                    entry.segmentCount++;
                }
                if(!positions.length) {entry.status="missing_event_coverage";entry.message="No usable source segments overlap this event's acoustic arrival window.";continue;}
                const geometry=new LineSegmentsGeometry();geometry.setPositions(positions);
                const material=makeMatLine(color,2.5),line=new Line2(geometry,material);
                line.name=entry.name;line.layers.mask=MASK_HELPERS;line.frustumCulled=false;
                group.add(line);resources.push({geometry,material,pooled:true});entry.status="shown";entry.message="Original source segments; missing fix gaps remain open.";
            }
            const geometry=new BufferGeometry();geometry.setAttribute("position",new Float32BufferAttribute([0,0,0],3));
            const material=new PointsMaterial({color:0xffffff,size:16,sizeAttenuation:false,depthTest:false,depthWrite:false});
            const marker=new Points(geometry,material);marker.name="Candidate observer";marker.layers.mask=MASK_HELPERS;marker.renderOrder=1000;
            group.add(marker);resources.push({geometry,material,pooled:false});
        } catch(error) {
            this.release(resources);throw error;
        }
        this.removeOverlay();this.group=group;this.resources=resources;GlobalScene.add(group);group.updateMatrixWorld(true);
        this.legend={rank:rank ?? null,provisional:true,observer:{lat:candidate.lat,lon:candidate.lon,altitudeM:candidate.altitudeM,color:"#ffffff"},
            recordingStart:candidate.recordingStart,events:legend,
            note:"Provisional candidate. Original source fixes within acoustic event windows; gaps remain open. Observer marker remains visible through terrain."};
        if(!this.viewSnapshot) {
            const node=NodeMan.get("mainCamera",false),camera=node?.camera,terrain=NodeMan.get("terrainUI",false);
            this.viewSnapshot={node,camera,position:camera?.position.clone(),quaternion:camera?.quaternion.clone(),up:camera?.up.clone(),
                terrain:terrain && Number.isFinite(terrain.lat) && Number.isFinite(terrain.lon) ? {node:terrain,lat:terrain.lat,lon:terrain.lon} : null};
        }
        moveTerrainTo(candidate.lat,candidate.lon);
        const cameraNode=NodeMan.get("mainCamera",false),camera=cameraNode?.camera;
        const halfFOV=(Number.isFinite(camera?.fov) ? camera.fov : 50)*Math.PI/360;
        const framingAngle=Math.atan(Math.tan(halfFOV)*Math.min(1,Number.isFinite(camera?.aspect) && camera.aspect>0 ? camera.aspect : 1));
        const above=Math.max(2500,extent*1.15/Math.sin(framingAngle)/Math.hypot(1,.65));
        cameraNode?.goToPoint?.(origin,above,above*.65);
        setRenderOne(true);return this.legend;
    }

    release(resources=[]) {
        for(const {geometry,material,pooled} of resources) {
            geometry.dispose();if(pooled) disposeMatLine(material);else material.dispose();
        }
    }

    removeOverlay() {
        if(this.group) this.group.parent?.remove(this.group);
        this.release(this.resources);this.resources=[];this.group=null;this.legend=null;setRenderOne(true);
    }

    clear() {
        this.removeOverlay();const saved=this.viewSnapshot;this.viewSnapshot=null;
        if(saved?.camera && NodeMan.get("mainCamera",false)===saved.node && saved.node.camera===saved.camera) {
            saved.camera.position.copy(saved.position);saved.camera.quaternion.copy(saved.quaternion);saved.camera.up.copy(saved.up);saved.camera.updateMatrixWorld(true);
        }
        if(saved?.terrain && NodeMan.get("terrainUI",false)===saved.terrain.node) moveTerrainTo(saved.terrain.lat,saved.terrain.lon);
        setRenderOne(true);
    }

    dispose() {this.clear();this.disposed=true;}
}
