import {GlobalDateTimeNode, NodeMan, setRenderOne, Sit} from "./Globals";
import {par} from "./par";
import {ExportProgressWidget, getExportPrefix} from "./utils";
import {ViewMan} from "./CViewManager";
import {CNode} from "./nodes/CNode";
import {Raycaster, Vector3} from "three";
import {assert} from "./assert.js";
import {intersectMSL} from "./threeExt";
import * as LAYER from "./LayerMasks";

const MAX_PANORAMA_WIDTH = 20000;
const DEFAULT_BACKGROUND_DISTANCE = 50000;

function getBackgroundPoint(cameraPos, lookDir, terrainNode) {
    if (terrainNode) {
        const ray = new Raycaster(cameraPos, lookDir.clone().normalize());
        ray.layers.mask |= LAYER.MASK_MAIN | LAYER.MASK_LOOK;
        const intersection = terrainNode.getClosestIntersect(ray, terrainNode);
        if (intersection) {
            return intersection.point.clone();
        }
    }
    
    const globePoint = intersectMSL(cameraPos, lookDir);
    if (globePoint) {
        return globePoint;
    }
    
    return cameraPos.clone().add(lookDir.clone().normalize().multiplyScalar(DEFAULT_BACKGROUND_DISTANCE));
}

function getScreenDisplacement(prevBgPoint, cameraPos, cameraFwd, cameraRight, cameraUp, vFov, frameHeight) {
    const toPoint = prevBgPoint.clone().sub(cameraPos).normalize();
    const fwdDot = toPoint.dot(cameraFwd);
    if (fwdDot <= 0) return null;
    const rightAngle = Math.asin(Math.max(-1, Math.min(1, toPoint.dot(cameraRight))));
    const upAngle = Math.asin(Math.max(-1, Math.min(1, toPoint.dot(cameraUp))));
    const pixelsPerRadian = frameHeight / (vFov * Math.PI / 180);
    return {
        dx: -rightAngle * pixelsPerRadian,
        dy: upAngle * pixelsPerRadian
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
            
            for (const entry of Object.values(NodeMan.list)) {
                const node = entry.data;
                if (node.preRender !== undefined) {
                    node.preRender(lookView);
                }
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
                const disp = getScreenDisplacement(prevBgPoint, cameraPos, fwd, right, up, fov, frameHeight);
                if (disp) {
                    cumX += disp.dx;
                    cumY += disp.dy;
                }
            }

            frameData.push({frame, px: cumX, py: cumY, fov});
            prevBgPoint = bgPoint;

            if (i % 10 === 0) {
                progress.update(i + 1);
                await new Promise(r => setTimeout(r, 0));
            }
        }

        let minPx = Infinity, maxPx = -Infinity;
        let minPy = Infinity, maxPy = -Infinity;

        for (const fd of frameData) {
            minPx = Math.min(minPx, fd.px);
            maxPx = Math.max(maxPx, fd.px);
            minPy = Math.min(minPy, fd.py);
            maxPy = Math.max(maxPy, fd.py);
        }

        console.log(`Panorama: X range ${minPx.toFixed(1)} to ${maxPx.toFixed(1)} px (${(maxPx-minPx).toFixed(1)}px)`);
        console.log(`Panorama: Y range ${minPy.toFixed(1)} to ${maxPy.toFixed(1)} px (${(maxPy-minPy).toFixed(1)}px)`);

        const pxRange = maxPx - minPx;
        const pyRange = maxPy - minPy;

        let panoWidthPx = Math.ceil(pxRange + frameWidth);
        let panoHeightPx = Math.ceil(pyRange + frameHeight);

        let scale = 1;
        if (panoWidthPx > MAX_PANORAMA_WIDTH) {
            scale = MAX_PANORAMA_WIDTH / panoWidthPx;
            panoWidthPx = MAX_PANORAMA_WIDTH;
            panoHeightPx = Math.ceil(panoHeightPx * scale);
        }

        const scaledFrameWidth = Math.ceil(frameWidth * scale);
        const scaledFrameHeight = Math.ceil(frameHeight * scale);

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

            for (const entry of Object.values(NodeMan.list)) {
                const node = entry.data;
                if (node.preRender !== undefined) {
                    node.preRender(lookView);
                }
            }

            lookView.renderCanvas(fd.frame);

            const x = (fd.px - minPx) * scale;
            const y = (fd.py - minPy) * scale;

            panoCtx.drawImage(
                lookView.canvas,
                0, 0, frameWidth, frameHeight,
                x, y, scaledFrameWidth, scaledFrameHeight
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
    folder.add({exportPanorama}, "exportPanorama").name("Export Look Panorama")
        .tooltip("Create a panorama image from lookView across all frames based on background position");
}
