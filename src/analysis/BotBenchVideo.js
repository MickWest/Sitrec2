// Local benchmark recorder. Invoked by run-botset-video.mjs in a dedicated
// custom sitch. Uses Sitrec's real renderer, object nodes and MQ9UI overlay.
import {Vector3} from "three";
import {NodeMan, Sit, GlobalDateTimeNode, NodeFactory} from "../Globals";
import {ViewMan} from "../CViewManager";
import {par} from "../par";
import {ENU2ECEF_radii, RLLAToECEF_radii, ECEFToLLAVD_radii} from "../LLA-ECEF-ENU";
import {getLocalUpVector, getLocalEastVector, getLocalNorthVector} from "../SphericalMath";
import {meanSeaLevelOffset, ensureGeoidLoaded} from "../EGM96Geoid";
import {generateWobbleOffsets} from "../TrackingWobbleMath";
import {MediabunnyExporter} from "../MediabunnyExporter";
import {encodeMISBLocalSet} from "../MISBEncoder";
import {botsetWobbleParams} from "../../benchmarks/botbench/lib/botsetErrors";
import {waitForExportFrameSettled} from "../ExportFrameSettler";
import {misbSightlineHeading} from "../MISBSightline";
import {LLAToECEF} from "../LLA-ECEF-ENU";
import {GlobalScene} from "../LocalFrame";

const DEG = 180 / Math.PI;
let active;

export async function prepare(plan) {
    if (!Sit.isCustom) throw new Error("Video generation requires a new custom sitch");
    if (active) throw new Error("Open a new sitch before preparing another video");
    if (plan.width !== 640 || plan.height !== 480 || plan.fps !== 30) throw new Error("Expected 640x480/30p");
    await ensureGeoidLoaded();
    par.paused = true;
    Sit.frames = plan.frames; Sit.aFrame = 0; Sit.bFrame = plan.frames - 1; Sit.fps = plan.fps;
    GlobalDateTimeNode.setStartDateTime(new Date(plan.site.epochISO));
    const lat = plan.site.latDeg / DEG, lon = plan.site.lonDeg / DEG;
    // ONE rigid frame, with its zero at the site's MSL ground elevation.
    const origin = RLLAToECEF_radii(lat, lon, plan.site.groundElevationMSL + meanSeaLevelOffset(plan.site.latDeg, plan.site.lonDeg));
    const position = a => ENU2ECEF_radii(new Vector3(...a), lat, lon, true).add(origin);
    const sensor = plan.sensorENU.map(position), target = plan.targetENU.map(position);
    const range = sensor[0].distanceTo(target[0]);
    const halfAngle = Math.asin(plan.diameterM / (2 * range));
    const hfov = 2 * Math.atan(plan.width / plan.targetPixels * Math.tan(halfAngle)) * DEG;
    const vfov = 2 * Math.atan(Math.tan(hfov / DEG / 2) * plan.height / plan.width) * DEG;
    const amplitude = plan.wobbleDegrees ?? Math.atan(2 * plan.wobblePercent / 100 * Math.tan(hfov / DEG / 2)) * DEG;
    const wobbleParams = {seed: plan.wobbleSeed, ...botsetWobbleParams(amplitude)};
    wobbleParams.driftSpeed = plan.driftSpeed ?? wobbleParams.driftSpeed;
    wobbleParams.correctionSpeed = plan.recenterSpeed ?? wobbleParams.correctionSpeed * (plan.recenterSpeedScale ?? 1);
    const wobble = generateWobbleOffsets(wobbleParams, plan.frames, plan.fps);
    const cameraNode = NodeMan.get("lookCamera"), view = NodeMan.get("lookView"), hud = NodeMan.get("MQ9UI");
    cameraNode.freeLook = true;
    const camera = cameraNode.camera;
    NodeMan.get("fovSwitch").selectOption("userFOV");
    NodeMan.get("fovUI").setValue(vfov);
    camera.fov = vfov; camera.aspect = plan.width / plan.height;
    camera.near = 0.1; camera.far = 1e7;
    const frustum = NodeMan.get("lookCamera_Frustum", false);
    if (frustum) frustum.matchVideoAspect = false;
    view.div.style.width = `${plan.width}px`; view.div.style.height = `${plan.height}px`;
    view.setFromDiv(view.div);
    NodeMan.get("canvasResolution").setValue(plan.width);
    ViewMan.iterate((id, v) => { if (v !== view && v !== hud) v.setVisible(false); });
    view.setVisible(true); hud.setVisible(true); hud.targetMode = 1; hud.irMode = 0;
    const track = NodeFactory.create("Array", {id: "botVideoTruth", array: target.map(position => ({position})), fps: 30});
    const balloon = NodeFactory.create("3DObject", {id: "botVideoBalloon", geometry: "sphere", radius: plan.diameterM / 2,
        size: 1, color: "white", material: "basic", opacity: 1, transparent: false});
    hud.addInput("cameraTrack", NodeFactory.create("Array", {id: "botVideoSensor", array: sensor.map(position => ({position})), fps: 30}));
    // A normal target node makes the geometry inspectable through NodeMan.
    balloon.addInput("track", track);
    const canvas = document.createElement("canvas"); canvas.width = plan.width; canvas.height = plan.height;
    active = {plan, sensor, target, hfov, vfov, amplitude, wobble, wobbleParams, camera, view, hud, balloon, canvas, records: []};
    renderFrame(0);
    const settled = await waitForExportFrameSettled({frame: 0, viewIds: [view.id], renderFrame: () => renderFrame(0)});
    if (settled.timedOut) throw new Error("Terrain did not finish loading before recording");
    return {hfov, vfov, amplitudeDeg: amplitude, wobbleParams, firstRangeM: range, frames: plan.frames};
}

export function renderFrame(f) {
    const a = active;
    if (!a || !Number.isInteger(f) || f < 0 || f >= a.plan.frames) throw new Error("Invalid video frame");
    const {camera, sensor, target, view, hud, balloon, wobble, canvas, plan} = a;
    par.frame = f; GlobalDateTimeNode.update(f);
    camera.position.copy(sensor[f]);
    camera.up.copy(getLocalUpVector(sensor[f]));
    camera.lookAt(target[f]);
    camera.rotateY(-wobble[f].pan / DEG); camera.rotateX(wobble[f].tilt / DEG);
    camera.fov = a.vfov; camera.aspect = plan.width / plan.height;
    camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
    balloon.group.position.copy(target[f]); balloon.group.updateMatrixWorld(true);
    // Recording advances independently of the animation loop. Request terrain
    // subdivision for this camera pose before asking the export settler to wait.
    NodeMan.get("terrainUI", false)?.update();
    for (const node of NodeMan.getPreRenderNodes()) node.preRender(view);
    view.renderCanvas(f);
    hud.renderCanvas(f);
    const ctx = canvas.getContext("2d");
    ctx.filter = "grayscale(1)";
    ctx.drawImage(view.canvas, 0, 0, plan.width, plan.height);
    ctx.drawImage(hud.canvas, 0, 0, plan.width, plan.height);
    ctx.filter = "none";
    const pos = ECEFToLLAVD_radii(camera.position), forward = camera.getWorldDirection(new Vector3());
    const up = getLocalUpVector(camera.position), east = getLocalEastVector(camera.position), north = getLocalNorthVector(camera.position);
    const az = (Math.atan2(forward.dot(east), forward.dot(north)) * DEG + 360) % 360;
    const el = Math.asin(Math.max(-1, Math.min(1, forward.dot(up)))) * DEG;
    // Derive roll from the actual rendered basis, so pan/tilt composition is
    // represented in KLV as well as the boresight.
    const right0 = forward.clone().cross(up).normalize();
    const up0 = right0.clone().cross(forward).normalize();
    const actualUp = new Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    const roll = (Math.atan2(actualUp.dot(right0), actualUp.dot(up0)) * DEG + 360) % 360;
    const values = {2: Date.parse(plan.site.epochISO) * 1000 + Math.round(f * 1e6 / plan.fps),
        5: 0, 6: 0, 7: 0, 13: pos.x, 14: pos.y, 15: pos.z - meanSeaLevelOffset(pos.x, pos.y),
        16: a.hfov, 17: a.vfov, 18: az, 19: el, 20: roll};
    const projected = target[f].clone().project(camera);
    const renderedVFOV = camera.renderedFOV ?? camera.fov;
    if (Math.abs(renderedVFOV - a.vfov) > 1e-8 || Math.abs(camera.aspect - plan.width / plan.height) > 1e-8) {
        throw new Error(`Rendered camera differs from recording lens: ${renderedVFOV} degrees, aspect ${camera.aspect}`);
    }
    const projectedDiameterPixels = plan.height * Math.tan(Math.asin(plan.diameterM / (2 * sensor[f].distanceTo(target[f])))) / Math.tan(renderedVFOV / DEG / 2);
    return {frame: f, klv: Array.from(encodeMISBLocalSet(values)), values,
        sensorECEF: sensor[f].toArray(), directionECEF: forward.toArray(), upECEF: actualUp.toArray(),
        projectedDiameterPixels,
        targetPixel: [(projected.x + 1) * plan.width / 2, (1 - projected.y) * plan.height / 2]};
}

export async function record() {
    const a = active;
    if (!a) throw new Error("Prepare a video scenario first");
    const exporter = new MediabunnyExporter({...a.plan, format: "mp4", codec: "avc", hardwareAcceleration: "prefer-software",
        videoStartDate: new Date(a.plan.site.epochISO), bitrate: 5_000_000});
    a.records = [];
    try {
        await exporter.initialize();
        for (let f = 0; f < a.plan.frames; f++) {
            renderFrame(f);
            const settled = await waitForExportFrameSettled({frame: f, viewIds: [a.view.id], renderFrame: () => renderFrame(f), stableChecks: 1, postSettleRenders: 0});
            if (settled.timedOut) throw new Error(`Terrain did not settle at frame ${f}`);
            a.records.push(renderFrame(f));
            await exporter.addFrame(a.canvas, f);
            if (f % 30 === 0) {
                window._botBenchVideo.progress = f;
                await new Promise(r => setTimeout(r, 0));
            }
        }
        const blob = await exporter.finalize();
        const url = URL.createObjectURL(blob), link = document.createElement("a");
        link.href = url; link.download = `${a.plan.name}.mp4`; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return {records: a.records, hfov: a.hfov, vfov: a.vfov, amplitudeDeg: a.amplitude, wobbleParams: a.wobbleParams};
    } finally {
        await exporter.dispose();
        par.paused = true;
    }
}

export function preview() { return active.canvas.toDataURL("image/jpeg", 0.9); }

// Read the nodes produced by File > Import, not the generator's KLV buffer.
export async function verifyImported(expected) {
    await ensureGeoidLoaded();
    const nodes = Object.values(NodeMan.list).map(e => e.data);
    const data = nodes.find(n => n.misb?.length === expected.length && n.misb[0]?.[2] === expected[0].values[2]);
    const videoView = NodeMan.get("video"), video = videoView.videoData;
    const cameraNode = NodeMan.get("lookCamera"), camera = cameraNode.camera, view = NodeMan.get("lookView");
    const hud = NodeMan.get("MQ9UI");
    hud.setVisible(true);
    const los = nodes.find(n => n.constructor.name === "CNodeLOSTrackMISB");
    if (!data || !video || !los) throw new Error("Imported video, MISB track or camera sightline is missing");
    // Verify the ordinary import settings, without repairing them for the test.
    const smoothing = los.in.sensorAz.in.smooth;
    if (!smoothing) throw new Error("Imported camera angle smoothing control is missing");
    const defaultAngleSmoothingFrames = smoothing.v0;
    if (defaultAngleSmoothingFrames !== 0) throw new Error(`TS import filtered camera angles over ${defaultAngleSmoothingFrames} frames`);
    const result = {frames: video.frames, records: data.misb.length, width: video.videoWidth, height: video.videoHeight,
        defaultAngleSmoothingFrames, angleSmoothingFrames: smoothing.v0,
        fps: Sit.fps, maxPositionErrorM: 0, maxDirectionErrorDeg: 0, maxFovErrorDeg: 0, maxTimestampErrorUs: 0, maxPtsErrorUs: 0,
        maxTrackPositionErrorM: 0, maxTrackDirectionErrorDeg: 0, maxTrackUpErrorDeg: 0, maxVideoPtsErrorUs: 0,
        maxCameraPositionErrorM: 0, maxCameraDirectionErrorDeg: 0, maxCameraUpErrorDeg: 0,
        maxRenderedPointErrorPixels: 0, maxHUDAlignmentErrorPixels: 0};
    par.paused = true;
    for (let f = 0; f < expected.length; f++) {
        const row = data.misb[f], ref = expected[f];
        const pos = LLAToECEF(row[13], row[14], row[15] + meanSeaLevelOffset(row[13], row[14]));
        const direction = misbSightlineHeading(pos, {platformHeading: row[5], platformPitch: row[6], platformRoll: row[7],
            sensorAz: row[18], sensorEl: row[19], sensorRoll: row[20]});
        result.maxPositionErrorM = Math.max(result.maxPositionErrorM, pos.distanceTo(new Vector3(...ref.sensorECEF)));
        result.maxDirectionErrorDeg = Math.max(result.maxDirectionErrorDeg, direction.angleTo(new Vector3(...ref.directionECEF)) * DEG);
        result.maxFovErrorDeg = Math.max(result.maxFovErrorDeg, Math.abs(row[16] - ref.values[16]), Math.abs(row[17] - ref.values[17]));
        result.maxTimestampErrorUs = Math.max(result.maxTimestampErrorUs, Math.abs(row[2] - ref.values[2]));
        if (!Number.isFinite(data.misb.pesPTSus?.[f])) throw new Error(`KLV frame ${f} has no transport timestamp`);
        result.maxPtsErrorUs = Math.max(result.maxPtsErrorUs, Math.abs(data.misb.pesPTSus[f] - f * 1e6 / 30));
        if (!Number.isFinite(video.framePTSus?.[f])) throw new Error(`Video frame ${f} has no presentation timestamp`);
        result.maxVideoPtsErrorUs = Math.max(result.maxVideoPtsErrorUs, Math.abs(video.framePTSus[f] - f * 1e6 / 30));
        const sightline = los.v(f);
        result.maxTrackPositionErrorM = Math.max(result.maxTrackPositionErrorM, sightline.position.distanceTo(new Vector3(...ref.sensorECEF)));
        result.maxTrackDirectionErrorDeg = Math.max(result.maxTrackDirectionErrorDeg, sightline.heading.angleTo(new Vector3(...ref.directionECEF)) * DEG);
        const importedUp = new Vector3().setFromMatrixColumn(sightline.matrix, 1);
        result.maxTrackUpErrorDeg = Math.max(result.maxTrackUpErrorDeg, importedUp.angleTo(new Vector3(...ref.upECEF)) * DEG);
        par.frame = f; GlobalDateTimeNode.update(f);
        cameraNode.update(f); camera.updateMatrixWorld(true);
        result.maxCameraPositionErrorM = Math.max(result.maxCameraPositionErrorM, camera.position.distanceTo(new Vector3(...ref.sensorECEF)));
        result.maxCameraDirectionErrorDeg = Math.max(result.maxCameraDirectionErrorDeg, camera.getWorldDirection(new Vector3()).angleTo(new Vector3(...ref.directionECEF)) * DEG);
        result.maxCameraUpErrorDeg = Math.max(result.maxCameraUpErrorDeg, new Vector3().setFromMatrixColumn(camera.matrixWorld, 1).angleTo(new Vector3(...ref.upECEF)) * DEG);
    }
    if (result.frames !== expected.length || result.width !== 640 || result.height !== 480 || Math.abs(result.fps - 30) > 0.001
        || result.maxPositionErrorM > 0.16 || result.maxDirectionErrorDeg > 0.00002 || result.maxFovErrorDeg > 180 / 65535 / 2 + 1e-8
        || result.maxTimestampErrorUs > 1 || result.maxPtsErrorUs > 1 || result.maxVideoPtsErrorUs > 1
        || result.maxTrackPositionErrorM > 0.17 || result.maxTrackDirectionErrorDeg > 0.0002 || result.maxTrackUpErrorDeg > 0.0002
        // The camera's normal Savitzky-Golay position filter can overshoot
        // quantized altitude samples slightly; projection is checked below too.
        || result.maxCameraPositionErrorM > 0.25 || result.maxCameraDirectionErrorDeg > 0.0002 || result.maxCameraUpErrorDeg > 0.0002) {
        throw new Error(`Video round trip failed: ${JSON.stringify(result)}`);
    }
    const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 480;
    const ctx = canvas.getContext("2d");
    result.decodedFrames = [];
    for (const f of [...new Set([0, Math.min(284, expected.length - 1), Math.min(394, expected.length - 1), Math.floor(expected.length / 2), expected.length - 1])]) {
        // Move the visible timeline too, so its rendering cannot evict the
        // requested frame while the decoder is filling its cache.
        par.paused = true; par.frame = f; GlobalDateTimeNode.update(f);
        video.getImage(f);
        if (!await video.waitForFrame(f, 30000)) throw new Error(`TS video frame ${f} did not decode`);
        const source = video.getCachedImage(f);
        if (!source) throw new Error(`TS video frame ${f} is missing from the decoder cache`);
        cameraNode.update(f);
        for (const node of NodeMan.getPreRenderNodes()) node.preRender(view);
        // Inspect the camera at the actual scene draw, including viewport FOV,
        // zoom and pan adjustments that renderCanvas restores afterwards.
        const originalRender = view.renderer.render;
        let checkedProjection = false;
        view.renderer.render = function (scene, renderCamera) {
            if (scene === GlobalScene && renderCamera === camera) {
                checkedProjection = true;
                const ref = expected[f], forward = new Vector3(...ref.directionECEF), up = new Vector3(...ref.upECEF);
                const right = forward.clone().cross(up).normalize();
                // Probe a 3x3 grid at 8 km, approximately the ground range in
                // these scenes. Report discrepancies in original video pixels.
                for (const u of [-0.8, 0, 0.8]) for (const v of [-0.8, 0, 0.8]) {
                    const point = new Vector3(...ref.sensorECEF).addScaledVector(forward, 8000)
                        .addScaledVector(right, u * 8000 * Math.tan(ref.values[16] / DEG / 2))
                        .addScaledVector(up, v * 8000 * Math.tan(ref.values[17] / DEG / 2));
                    const projected = point.project(renderCamera);
                    const [vx, vy] = videoView.videoToCanvasCoords((u + 1) * 320, (1 - v) * 240);
                    const rect = view.canvas.getBoundingClientRect(), pane = view.div.getBoundingClientRect();
                    const x = ((projected.x + 1) / 2 * rect.width + rect.left - pane.left) / pane.width * videoView.widthPx;
                    const y = ((1 - projected.y) / 2 * rect.height + rect.top - pane.top) / pane.height * videoView.heightPx;
                    const error = Math.hypot((x - vx) * videoView.sWidth / videoView.dWidth,
                        (y - vy) * videoView.sHeight / videoView.dHeight);
                    if (!Number.isFinite(error)) throw new Error(`Invalid rendered projection at frame ${f}`);
                    result.maxRenderedPointErrorPixels = Math.max(result.maxRenderedPointErrorPixels, error);
                }
            }
            return originalRender.call(this, scene, renderCamera);
        };
        try { view.renderCanvas(f); } finally { view.renderer.render = originalRender; }
        if (!checkedProjection || result.maxRenderedPointErrorPixels > 0.5) {
            throw new Error(`Rendered camera round trip failed at frame ${f}: ${result.maxRenderedPointErrorPixels} pixels`);
        }
        hud.renderCanvas(f);
        // The HUD is a separate canvas: a correct 3D projection does not prove
        // that its crosshair follows the same image through zoom and pan.
        for (const [x, y] of [[50, 50], [44, 50], [56, 50], [50, 44], [50, 56]]) {
            const [vx, vy] = videoView.videoToCanvasCoords(320 + (x - 50) * 4.8, y * 4.8);
            const error = Math.hypot(
                (hud.px_square(x) / hud.widthPx * videoView.widthPx - vx) * videoView.sWidth / videoView.dWidth,
                (hud.py(y) / hud.heightPx * videoView.heightPx - vy) * videoView.sHeight / videoView.dHeight);
            if (!Number.isFinite(error) || error > 1e-6) throw new Error(`MQ9UI alignment failed at frame ${f}: ${error} pixels`);
            result.maxHUDAlignmentErrorPixels = Math.max(result.maxHUDAlignmentErrorPixels, error);
        }
        ctx.drawImage(source, 0, 0);
        const pixels = ctx.getImageData(0, 0, 640, 480).data;
        let sum = 0, min = 255, max = 0, maxChroma = 0;
        for (let i = 0; i < pixels.length; i += 4) {
            sum += pixels[i]; min = Math.min(min, pixels[i]); max = Math.max(max, pixels[i]);
            maxChroma = Math.max(maxChroma, Math.abs(pixels[i] - pixels[i + 1]), Math.abs(pixels[i] - pixels[i + 2]));
        }
        const mean = sum / (640 * 480);
        if (mean < 5 || max - min < 100 || maxChroma > 2) throw new Error(`TS frame ${f} is blank or not grayscale`);
        // The three starter scenes look down at textured ground. Inspect an
        // area away from the HUD/target, which alone can disguise unloaded tiles.
        const background = ctx.getImageData(100, 140, 160, 180).data;
        let total = 0, squared = 0;
        for (let i = 0; i < background.length; i += 4) { total += background[i]; squared += background[i] ** 2; }
        const n = background.length / 4;
        const backgroundStdDev = Math.sqrt(Math.max(0, squared / n - (total / n) ** 2));
        if (backgroundStdDev < 2) throw new Error(`TS frame ${f} has an untextured ground background`);
        result.decodedFrames.push({frame: f, mean, min, max, maxChroma, backgroundStdDev});
    }
    return {...result, preview: canvas.toDataURL("image/jpeg", 0.9)};
}
