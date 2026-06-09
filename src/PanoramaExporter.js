import {GlobalDateTimeNode, NodeMan, setRenderOne, Sit} from "./Globals";
import {par} from "./par";
import {ExportProgressWidget, getExportPrefix} from "./utils";
import {ViewMan} from "./CViewManager";
import {CNode} from "./nodes/CNode";
import {Raycaster, Vector3} from "three";
import {assert} from "./assert";
import {intersectSurface} from "./threeExt";
import * as LAYER from "./LayerMasks";
import {t} from "./i18n";

// Browser 2D-canvas limits — see the matching note in CMotionAnalysisUI.js. An
// over-limit canvas fails SILENTLY (drawImage paints nothing, reads back black), so we
// clamp BOTH the largest single dimension and the total area, not just the width.
const MAX_PANORAMA_DIM = 16384;
const MAX_PANORAMA_AREA = 128 * 1024 * 1024; // ~134M px, safely under the area limit
const DEFAULT_BACKGROUND_DISTANCE = 50000;

// Uniform downscale factor bringing a width x height panorama within both canvas
// limits (1 = no scaling needed). Aspect ratio preserved.
function panoFitScale(width, height) {
    let scale = 1;
    scale = Math.min(scale, MAX_PANORAMA_DIM / width);
    scale = Math.min(scale, MAX_PANORAMA_DIM / height);
    const area = width * height;
    if (area > MAX_PANORAMA_AREA) {
        scale = Math.min(scale, Math.sqrt(MAX_PANORAMA_AREA / area));
    }
    return scale;
}

function getBackgroundPoint(cameraPos, lookDir, terrainNode) {
    if (terrainNode) {
        const ray = new Raycaster(cameraPos, lookDir.clone().normalize());
        ray.layers.mask |= LAYER.MASK_MAIN | LAYER.MASK_LOOK;
        const intersection = terrainNode.getClosestIntersect(ray, terrainNode);
        if (intersection) {
            return intersection.point.clone();
        }
    }
    
    const globePoint = intersectSurface(cameraPos, lookDir);
    if (globePoint) {
        return globePoint;
    }
    
    return cameraPos.clone().add(lookDir.clone().normalize().multiplyScalar(DEFAULT_BACKGROUND_DISTANCE));
}

// Angular (radians) displacement of the previous background point in the current
// camera's frame. Kept in angle space so it is independent of the frame's FOV —
// conversion to pano pixels happens later at one fixed pixels-per-radian.
function getAngularDisplacement(prevBgPoint, cameraPos, cameraFwd, cameraRight, cameraUp) {
    const toPoint = prevBgPoint.clone().sub(cameraPos).normalize();
    const fwdDot = toPoint.dot(cameraFwd);
    if (fwdDot <= 0) return null;
    const rightAngle = Math.asin(Math.max(-1, Math.min(1, toPoint.dot(cameraRight))));
    const upAngle = Math.asin(Math.max(-1, Math.min(1, toPoint.dot(cameraUp))));
    return {
        ax: -rightAngle,
        ay: upAngle
    };
}

export async function exportPanorama() {
    const lookView = ViewMan.get("lookView", false);
    if (!lookView) {
        alert("No lookView found for panorama export");
        return;
    }

    const lookCameraNode = NodeMan.get("lookCamera", false);
    if (!lookCameraNode) {
        alert("No lookCamera found for panorama export");
        return;
    }

    const startFrame = Sit.aFrame;
    const endFrame = Sit.bFrame;
    const totalFrames = endFrame - startFrame + 1;

    const savedFrame = par.frame;
    const savedPaused = par.paused;
    par.paused = true;

    const progress = new ExportProgressWidget('Calculating panorama extents...', totalFrames * 2);

    try {
        const frameData = [];
        const frameWidth = lookView.canvas.width;
        const frameHeight = lookView.canvas.height;
        
        const terrainNode = NodeMan.get("TerrainModel", false);

        let cumX = 0, cumY = 0;
        let prevBgPoint = null;

        for (let i = 0; i < totalFrames; i++) {
            if (progress.shouldStop()) {
                throw new Error("Export cancelled");
            }

            const frame = startFrame + i;
            par.frame = frame;
            GlobalDateTimeNode.update(frame);

            for (const entry of Object.values(NodeMan.list)) {
                const node = entry.data;
                if (node.isController) continue;
                if (node.update !== undefined) {
                    node.update(frame);
                }
            }

            lookView.camera.updateMatrix();
            lookView.camera.updateMatrixWorld();
            
            for (const node of NodeMan.getPreRenderNodes()) {
                node.preRender(lookView);
            }

            const cameraPos = lookView.camera.position.clone();
            const fwd = new Vector3();
            lookView.camera.getWorldDirection(fwd);
            const right = new Vector3();
            const up = new Vector3();
            right.setFromMatrixColumn(lookView.camera.matrixWorld, 0);
            up.setFromMatrixColumn(lookView.camera.matrixWorld, 1);
            
            const fov = lookView.fovOverride ?? lookView.camera.fov;
            const bgPoint = getBackgroundPoint(cameraPos, fwd, terrainNode);

            if (i === 0) {
                const dist = bgPoint.distanceTo(cameraPos);
                console.log(`Panorama: Initial background point at distance ${dist.toFixed(0)}m`);
            }

            if (prevBgPoint) {
                const disp = getAngularDisplacement(prevBgPoint, cameraPos, fwd, right, up);
                if (disp) {
                    cumX += disp.ax;
                    cumY += disp.ay;
                }
            }

            frameData.push({frame, ax: cumX, ay: cumY, vFovRad: fov * Math.PI / 180});
            prevBgPoint = bgPoint;

            if (i % 10 === 0) {
                progress.update(i + 1);
                await new Promise(r => setTimeout(r, 0));
            }
        }

        // One fixed angular scale for the whole panorama, anchored to the narrowest
        // FOV in the range so the most-zoomed frame stays at native resolution and
        // wider frames are drawn enlarged to span their true angular extent.
        let minVFovRad = Infinity;
        for (const fd of frameData) {
            minVFovRad = Math.min(minVFovRad, fd.vFovRad);
        }
        const pixelsPerRadian = frameHeight / minVFovRad;

        let minPx = Infinity, maxPx = -Infinity;
        let minPy = Infinity, maxPy = -Infinity;

        for (const fd of frameData) {
            fd.drawScale = fd.vFovRad / minVFovRad;
            // frame center in pano pixels; zoom is about the optical axis, so a
            // FOV change scales the frame about its center
            fd.px = fd.ax * pixelsPerRadian;
            fd.py = fd.ay * pixelsPerRadian;
            fd.halfW = frameWidth * fd.drawScale / 2;
            fd.halfH = frameHeight * fd.drawScale / 2;
            minPx = Math.min(minPx, fd.px - fd.halfW);
            maxPx = Math.max(maxPx, fd.px + fd.halfW);
            minPy = Math.min(minPy, fd.py - fd.halfH);
            maxPy = Math.max(maxPy, fd.py + fd.halfH);
        }

        console.log(`Panorama: X range ${minPx.toFixed(1)} to ${maxPx.toFixed(1)} px (${(maxPx-minPx).toFixed(1)}px)`);
        console.log(`Panorama: Y range ${minPy.toFixed(1)} to ${maxPy.toFixed(1)} px (${(maxPy-minPy).toFixed(1)}px)`);

        let panoWidthPx = Math.ceil(maxPx - minPx);
        let panoHeightPx = Math.ceil(maxPy - minPy);

        // Clamp to the browser canvas limits (dimension AND area) so a large sweep
        // does not silently produce an all-black, over-limit canvas.
        const scale = panoFitScale(panoWidthPx, panoHeightPx);
        if (scale < 1) {
            panoWidthPx = Math.max(1, Math.floor(panoWidthPx * scale));
            panoHeightPx = Math.max(1, Math.floor(panoHeightPx * scale));
        }

        console.log(`Panorama: ${panoWidthPx}x${panoHeightPx}px, scale=${scale.toFixed(3)}`);

        const panoCanvas = document.createElement('canvas');
        panoCanvas.width = panoWidthPx;
        panoCanvas.height = panoHeightPx;
        const panoCtx = panoCanvas.getContext('2d');

        panoCtx.fillStyle = 'black';
        panoCtx.fillRect(0, 0, panoWidthPx, panoHeightPx);

        progress.setStatus('Rendering panorama frames...');

        for (let i = 0; i < totalFrames; i++) {
            if (progress.shouldStop()) {
                throw new Error("Export cancelled");
            }

            const fd = frameData[i];
            par.frame = fd.frame;
            GlobalDateTimeNode.update(fd.frame);

            for (const entry of Object.values(NodeMan.list)) {
                const node = entry.data;
                if (node.isController && !node.allowUpdate) {
                    assert(node.update === CNode.prototype.update,
                        `Controller ${node.id} has overridden update() - move logic to apply()`);
                    continue;
                }
                if (node.update !== undefined) {
                    node.update(fd.frame);
                }
            }

            lookView.camera.updateMatrix();
            lookView.camera.updateMatrixWorld();

            for (const node of NodeMan.getPreRenderNodes()) {
                node.preRender(lookView);
            }

            lookView.renderCanvas(fd.frame);

            const x = (fd.px - fd.halfW - minPx) * scale;
            const y = (fd.py - fd.halfH - minPy) * scale;
            const w = frameWidth * fd.drawScale * scale;
            const h = frameHeight * fd.drawScale * scale;

            panoCtx.drawImage(
                lookView.canvas,
                0, 0, frameWidth, frameHeight,
                x, y, w, h
            );

            if (i % 10 === 0) {
                progress.update(totalFrames + i + 1);
                await new Promise(r => setTimeout(r, 0));
            }
        }

        if (progress.shouldSave()) {
            progress.setStatus('Saving panorama...');
            
            panoCanvas.toBlob((blob) => {
                const filename = `${getExportPrefix()}_panorama_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.png`;
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                a.click();
                URL.revokeObjectURL(url);
                
                console.log(`Panorama exported: ${filename}`);
            }, 'image/png');
        }

    } catch (e) {
        if (e.message !== "Export cancelled") {
            console.error('Panorama export failed:', e);
            alert('Panorama export failed: ' + e.message);
        }
    } finally {
        progress.remove();
        par.frame = savedFrame;
        par.paused = savedPaused;
        setRenderOne(true);
    }
}

export function setupPanoramaExport(folder) {
    folder.add({exportPanorama}, "exportPanorama").name(t("panoramaExport.exportLookPanorama.label"))
        .tooltip(t("panoramaExport.exportLookPanorama.tooltip"));
}
