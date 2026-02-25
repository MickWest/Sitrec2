// CNodeDisplaySkyOverlay takes a CNodeCanvas derived node, CNodeDisplayNightSky and a camera
// and displays star names on an overlay
import {CNodeViewUI} from "./CNodeViewUI";
import {GlobalDateTimeNode, guiShowHide, setRenderOne, Sit} from "../Globals";
import {getCelestialDirectionFromRaDec, raDec2Celestial} from "../CelestialMath";
import {wgs84} from "../LLA-ECEF-ENU";
import {intersectSphere2, V3} from "../threeUtils";
import {Ray, Raycaster, Sphere, Vector3} from "three";
import {calculateAltitude} from "../threeExt";

const registeredLabels = new Set();

export function registerLabel3D(label) {
    registeredLabels.add(label);
}

export function unregisterLabel3D(label) {
    registeredLabels.delete(label);
}

export class CNodeDisplaySkyOverlay extends CNodeViewUI {

    constructor(v) {
        super(v);
        this.addInput("startTime", GlobalDateTimeNode)

        this.camera = v.camera;
        this.nightSky = v.nightSky;

        this.showStarNames = false;

        const gui = v.gui ?? guiShowHide;

        if (this.overlayView.id === "lookView") {
            this.syncVideoZoom = true;
        }

        gui.add(this, "showStarNames").onChange(() => {
            setRenderOne(true);
        }).name(this.overlayView.id + " Star names").listen();
        this.addSimpleSerial("showStarNames");


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

    renderCanvas(frame) {
        super.renderCanvas(frame);

        this.renderLabels3D(frame);

        const showSatelliteNames = this.showSatelliteNames;
        if (!this.showStarNames && !showSatelliteNames) return

        const font_h = 9
        this.ctx.font = Math.floor(font_h) + 'px' + " " + 'Arial'
        this.ctx.fillStyle = "#ffffff";
        this.ctx.strokeStyle = '#ffffff';
        this.ctx.textAlign = 'left';

        const earthSphere = new Sphere(V3(0, 0, 0), wgs84.POLAR_RADIUS)
        const actualCameraPosition = this.camera.position
        const date = this.in.startTime.dateNow

        if (this.showStarNames) {
            const starCamera = this.camera.clone();
            if (this.camera.renderedFOV) {
                starCamera.fov = this.camera.renderedFOV;
            }
            starCamera.position.set(0, 0, 0);
            starCamera.aspect = this.widthPx / this.heightPx;
            this.applyCameraOffset(starCamera);
            starCamera.updateMatrix();
            starCamera.matrixWorld.copy(starCamera.matrix);
            starCamera.matrixWorldInverse.copy(starCamera.matrixWorld).invert();
            starCamera.updateProjectionMatrix();
            this.renderStarNames(starCamera, earthSphere, actualCameraPosition, date);
        }

        if (showSatelliteNames) {
            this.renderSatelliteNames(earthSphere);
        }
    }

    applyCameraOffset(camera) {
        if (!this.overlayView || !this.overlayView.getCameraOffset) return;
        const { xOffset, yOffset } = this.overlayView.getCameraOffset();
        if (xOffset === 0 && yOffset === 0) return;
        
        const xOffsetRad = xOffset * Math.PI / 180;
        const yOffsetRad = yOffset * Math.PI / 180;
        
        const up = new Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
        camera.rotateOnWorldAxis(up, -xOffsetRad);
        
        const right = new Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
        camera.rotateOnWorldAxis(right, -yOffsetRad);
    }

    renderStarNames(camera, earthSphere, actualCameraPosition, date) {
        for (var HR in this.nightSky.starField.commonNames) {
            const n = HR - 1

            const mag = this.nightSky.starField.getStarMagnitude(n)
            if (mag > Sit.starLimit) {
                continue
            }

            const ra = this.nightSky.starField.getStarRA(n)
            const dec = this.nightSky.starField.getStarDEC(n)
            
            const starDirection = getCelestialDirectionFromRaDec(ra, dec, date)
            
            const ray = new Ray(actualCameraPosition, starDirection)
            const target0 = V3()
            const target1 = V3()
            if (intersectSphere2(ray, earthSphere, target0, target1)) {
                continue
            }

            const pos = raDec2Celestial(ra, dec, 100)
            pos.applyMatrix4(this.nightSky.celestialSphere.matrix)
            pos.project(camera)

            if (pos.z > -1 && pos.z < 1 && pos.x >= -1 && pos.x <= 1 && pos.y >= -1 && pos.y <= 1) {
                const zoomedX = pos.x * this.zoom;
                const zoomedY = pos.y * this.zoom;
                
                const x = (zoomedX + 1) * this.widthPx / 2 + 5
                const y = (-zoomedY + 1) * this.heightPx / 2 - 5
                this.ctx.fillText(this.nightSky.starField.commonNames[HR], x, y)
            }
        }

        for (const [name, planet] of Object.entries(this.nightSky.planets.planetSprites)) {
            const pos = planet.equatorial.clone()
            pos.applyMatrix4(this.nightSky.celestialSphere.matrix)
            pos.project(camera)

            this.ctx.strokeStyle = planet.color;
            this.ctx.fillStyle = planet.color;

            if (pos.z > -1 && pos.z < 1 && pos.x >= -1 && pos.x <= 1 && pos.y >= -1 && pos.y <= 1) {
                const zoomedX = pos.x * this.zoom;
                const zoomedY = pos.y * this.zoom;
                
                const x = (zoomedX + 1) * this.widthPx / 2 + 5
                const y = (-zoomedY + 1) * this.heightPx / 2 - 5
                this.ctx.fillText(name, x, y)
            }
        }
    }

    renderSatelliteNames(earthSphere) {
        const satellites = this.nightSky.satellites;
        if (!satellites.TLEData) return;

        const isLookView = this.overlayView.id === "lookView";
        const isMainView = this.overlayView.id === "mainView";

        const camera = this.camera.clone();
        if (this.camera.renderedFOV) {
            camera.fov = this.camera.renderedFOV;
        }
        camera.aspect = this.widthPx / this.heightPx;
        this.applyCameraOffset(camera);
        camera.updateMatrix();
        camera.updateMatrixWorld();
        camera.updateProjectionMatrix();

        const cameraPos = this.camera.position;
        const satData = satellites.TLEData.satData;
        const numSats = satData.length;

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

            if (satellites.labelFlares && !sat.isFlaring) continue;
            if (satellites.labelLit && !sat.isLit) continue;
            if (isMainView && satellites.labelLookVisible && !sat.visibleInLook) continue;

            const distSq = sat.eus.distanceToSquared(cameraPos);
            if (!sat.userFiltered && distSq >= arrowRangeSq) continue;

            const viewPos = sat.eus.clone().applyMatrix4(camera.matrixWorldInverse);
            if (viewPos.z >= 0) continue;
            
            const satScreenPos = sat.eus.clone().project(camera);
            const isInsideFrustum = satScreenPos.x >= -1 && satScreenPos.x <= 1 &&
                satScreenPos.y >= -1 && satScreenPos.y <= 1;
            
            if (!isInsideFrustum) {
                if (satScreenPos.x < -1) {
                    const zoomedX = satScreenPos.x * this.zoom;
                    const pixelX = (zoomedX + 1) * this.widthPx / 2;
                    const offscreenPixels = -pixelX;
                    if (offscreenPixels > 30 * 16) {
                        continue;
                    }
                } else {
                    continue;
                }
            }

            const camToSat = sat.eus.clone().sub(cameraPos);
            const distToSat = Math.sqrt(distSq);
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
        
        this.ctx.fillStyle = "#ffffff";
        
        const maxLabels = this.maxSatelliteLabels;
        for (let i = 0; i < candidates.length && i < maxLabels; i++) {
            const sat = satData[candidates[i].index];
            const screenPos = candidates[i].screenPos;

            const zoomedX = screenPos.x * this.zoom;
            const zoomedY = screenPos.y * this.zoom;
            
            const x = (zoomedX + 1) * this.widthPx / 2 + 5
            const y = (-zoomedY + 1) * this.heightPx / 2 - 5

            let name = sat.name.replace("0 STARLINK", "SL").replace("STARLINK", "SL");
            name = name.replace(/\s+$/, '');
            this.ctx.fillText(name, x, y)
        }
    }

    renderLabels3D(frame) {
        if (registeredLabels.size === 0) return;

        const viewLayerMask = this.camera.layers.mask;

        const camera = this.camera.clone();
        if (this.camera.renderedFOV) {
            camera.fov = this.camera.renderedFOV;
        }
        camera.aspect = this.widthPx / this.heightPx;
        this.applyCameraOffset(camera);
        camera.updateMatrix();
        camera.updateMatrixWorld();
        camera.updateProjectionMatrix();

        for (const label of registeredLabels) {
            if (!label.group || !label.group.visible) continue;
            if (!(label.groupNode.group.layers.mask & viewLayerMask)) continue;
            if (!(label.layerMask & viewLayerMask)) continue;
            if (!label.shouldRender(viewLayerMask)) continue;

            // Call preRender to ensure textPosition is calculated for THIS view
            // (view-dependent for negative-length arrows that use pixelsToMeters)
            if (label.preRender) {
                label.preRender(this.overlayView);
            }

            let pos = label.textPosition.clone();
            if (label.offset) {
                pos = this.overlayView.offsetScreenPixels(pos, label.offset.x, label.offset.y);
            }

            const screenPos = pos.clone().project(camera);
            if (screenPos.z < -1 || screenPos.z > 1) continue;

            const zoomedX = screenPos.x * this.zoom;
            const zoomedY = screenPos.y * this.zoom;
            if (zoomedX < -1.5 || zoomedX > 1.5 || zoomedY < -1.5 || zoomedY > 1.5) continue;

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
            let x = (zoomedX + 1) * this.widthPx / 2;
            let y = (-zoomedY + 1) * this.heightPx / 2;
            
            if (textAlign === 'left') {
                x -= 5;
                y += 5;
            }

            const fontSize = label.size || 12;
            this.ctx.font = (label.fontWeight ? label.fontWeight + ' ' : '') + Math.floor(fontSize) + 'px Arial';
            this.ctx.textAlign = textAlign;
            
            const color = label.color || '#FFFFFF';
            const alpha = Math.floor(transparency * 255).toString(16).padStart(2, '0');
            this.ctx.fillStyle = color.length === 7 ? color + alpha : color;
            
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