// CNodeDisplaySkyOverlay takes a CNodeCanvas derived node, CNodeDisplayNightSky and a camera
// and displays star names on an overlay
import {CNodeViewUI} from "./CNodeViewUI";
import {GlobalDateTimeNode, guiShowHide, NodeMan, setRenderOne, Sit} from "../Globals";
import {applyAnnualAberration, getStarDirectionECEF, raDec2Celestial} from "../CelestialMath";
import {applyRefractionECI, refractionUniforms, refractionOptsFromUniforms} from "../atmosphere/refraction";
import {wgs84} from "../LLA-ECEF-ENU";
import {intersectSphere2, V3} from "../threeUtils";
import {Ray, Raycaster, Sphere} from "three";
import {calculateAltitude} from "../threeExt";
import {getHUDColor} from "../HUDColor";
import {viewControlLabel, viewMenuKey} from "../ViewUIBarMenus";
import {renderedRect, withDisplayedCamera} from "../ViewUtils";

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

        this.nightSky = v.nightSky;

        this.showStarNames = false;
        this.onlyLabelPlanets = false;

        const gui = v.gui ?? guiShowHide;

        if (this.overlayView.id === "lookView") {
            this.syncVideoZoom = true;
        }

        // These two are per-view by construction — there is one sky overlay per 3D view — so the
        // Show ▸ Celestial rows have to name the view. Composed rather than translated because
        // the set of views is not known up front; viewControlLabel keeps them to the same
        // "<Thing> in Main" / "<Thing> in Look" shape as every other per-view row. The header
        // menus mirror the same controllers and drop the suffix, since the menu names the view.
        const starNames = gui.add(this, "showStarNames").onChange(() => {
            setRenderOne(true);
        }).name(viewControlLabel(this.overlayView.id, "Star Names"))
            .tooltip("Show star name labels in this view").listen();
        this.addSimpleSerial("showStarNames");
        starNames.shareAs(viewMenuKey(this.overlayView.id, "starNames"));

        const onlyPlanets = gui.add(this, "onlyLabelPlanets").onChange(() => {
            setRenderOne(true);
        }).name(viewControlLabel(this.overlayView.id, "Only Label Planets"))
            .tooltip("When checked, suppress star labels but always show planet names").listen();
        this.addSimpleSerial("onlyLabelPlanets");
        onlyPlanets.shareAs(viewMenuKey(this.overlayView.id, "onlyPlanets"));

    }

    // The host view's camera, read LIVE rather than captured at construction.
    // CNodeView3D.camera is itself a getter onto cameraNode.camera, so a stored
    // copy goes stale the moment the camera node swaps its camera — and the
    // projection would then disagree with the Earth-occlusion tests below, which
    // read the camera POSITION through this same handle.
    get camera() {
        return this.overlayView.camera;
    }

    // A projection-only copy of the camera the host view was actually RENDERED with.
    //
    // `live` comes from withDisplayedCamera(), i.e. it has been through
    // prepareCameraForLOD() and carries every display-only transform the render
    // applies: the fovCoverage widening, Match Video Aspect's fov+aspect rewrite,
    // the video-pan asymmetric frustum in projectionMatrix.elements[8]/[9], the
    // y-compress in elements[5], the camera-tweak rotation and the display lookAt.
    //
    // Camera.copy() carries projectionMatrix/projectionMatrixInverse across, and we
    // must NOT call updateProjectionMatrix() on the copy: rebuilding from fov/aspect
    // /zoom would silently discard the pan and y-compress patches, which are written
    // straight into the matrix and cannot be reproduced from those three numbers.
    //
    // atOrigin moves the copy to the world origin for the celestial sphere, which is
    // rendered in GlobalNightSkyScene with the camera there; the projection is
    // untouched, only the view matrix changes.
    displayedCamera(live, atOrigin = false) {
        const camera = live.clone();
        if (atOrigin) {
            camera.position.set(0, 0, 0);
            camera.updateMatrix();
            camera.matrixWorld.copy(camera.matrix);
            camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
        }
        return camera;
    }

    // NDC -> canvas pixels, through the rectangle the 3D actually fills.
    //
    // That is NOT the whole overlay: with Match Video Aspect on, CNodeView3D
    // letterboxes by resizing and centring the 3D canvas ELEMENT inside the shared
    // div, so NDC +-1 spans only part of this overlay's pixel space. Mapping over the
    // full div instead stretched every label radially from the pane centre by
    // videoAspect/viewAspect — measured at 1.1626, up to 56 px out at the edges.
    // Same mapping as projectToCanvas() in FitSurfacePick.js.
    labelXY(ndc) {
        const r = this._renderedRect;
        return [r.x + (ndc.x + 1) * 0.5 * r.w, r.y + (1 - ndc.y) * 0.5 * r.h];
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

        const showSatelliteNames = this.showSatelliteNames;
        const anyLabels = registeredLabels.size > 0 || this.showStarNames || showSatelliteNames;
        if (!anyLabels) return;

        // Measured once per frame: renderedRect() does two getBoundingClientRect()
        // calls, and the satellite pass walks ~11,000 entries behind it.
        this._renderedRect = renderedRect(this.overlayView, this.widthPx, this.heightPx);

        // Everything that projects runs inside ONE prepared-camera window, so the
        // labels are placed with the projection the view was rendered with instead
        // of a hand-rebuilt approximation of it. This replaces what used to be three
        // separate camera clones, a hand-mirrored copy of the render's pan patch, and
        // a `* this.zoom` NDC multiply — prepareCameraForLOD() applies the full video
        // zoom itself (the pixel-match cap is made up by the shader magnifying the
        // smaller render target into the same CSS box, so full zoom is what reaches
        // the screen), and it applies the camera-tweak offset, so applying either
        // again here would double-count it.
        withDisplayedCamera(this.overlayView, (live) => {

            this.renderLabels3D(frame, this.displayedCamera(live));

            if (!this.showStarNames && !showSatelliteNames) return;

            const font_h = 9
            this.ctx.font = Math.floor(font_h) + 'px' + " " + 'Arial'
            this.ctx.fillStyle = "#ffffff";
            this.ctx.strokeStyle = '#ffffff';
            this.ctx.textAlign = 'left';

            const earthSphere = new Sphere(V3(0, 0, 0), wgs84.POLAR_RADIUS)
            const actualCameraPosition = this.camera.position
            const date = this.in.startTime.dateNow

            // Compute sky-brightness alpha so labels fade at dusk/dawn like the stars
            let starAlpha = 1;
            const sunNode = NodeMan.get("theSun", true);
            if (sunNode) {
                const skyBrightness = sunNode.calculateSkyBrightness(actualCameraPosition, date);
                starAlpha = Math.max(0, 1 - skyBrightness);
            }

            if (this.showStarNames) {
                // Camera at the origin: the celestial sphere holds directions on a
                // huge radius and is rendered that way in GlobalNightSkyScene.
                this.renderStarNames(this.displayedCamera(live, true), earthSphere,
                    actualCameraPosition, date, starAlpha);
            }

            if (showSatelliteNames) {
                // Satellites live in GlobalScene, at the camera's real position.
                this.renderSatelliteNames(this.displayedCamera(live), earthSphere, starAlpha);
            }
        });
    }

    renderStarNames(camera, earthSphere, actualCameraPosition, date, starAlpha = 1) {
        const alphaHex = Math.floor(starAlpha * 255).toString(16).padStart(2, '0');

        if (!this.onlyLabelPlanets) {
            this.ctx.fillStyle = "#ffffff" + alphaHex;
            const refractApplies = refractionUniforms.uRefractionEnabled.value > 0.5;
            const refractOpts = refractApplies ? refractionOptsFromUniforms() : null;
            for (var HR in this.nightSky.starField.commonNames) {
                const n = HR - 1

                const mag = this.nightSky.starField.getStarMagnitude(n)
                if (mag > Sit.starLimit) {
                    continue
                }

                const ra = this.nightSky.starField.getStarRA(n)
                const dec = this.nightSky.starField.getStarDEC(n)

                const pos = applyAnnualAberration(raDec2Celestial(ra, dec, 100), date)
                if (refractApplies) {
                    applyRefractionECI(pos, refractionUniforms.uZenithECI.value, refractOpts);
                }

                // Earth-occlude using the *apparent* sightline so a star
                // refracted into view from below the horizon doesn't get
                // its label suppressed while the rendered dot is visible.
                const starDirection = refractApplies
                    ? pos.clone().applyMatrix4(this.nightSky.celestialSphere.matrix).normalize()
                    : getStarDirectionECEF(ra, dec, date)

                const ray = new Ray(actualCameraPosition, starDirection)
                const target0 = V3()
                const target1 = V3()
                if (intersectSphere2(ray, earthSphere, target0, target1)) {
                    continue
                }
                pos.applyMatrix4(this.nightSky.celestialSphere.matrix)
                pos.project(camera)

                if (pos.z > -1 && pos.z < 1 && pos.x >= -1 && pos.x <= 1 && pos.y >= -1 && pos.y <= 1) {
                    const [x, y] = this.labelXY(pos);
                    this.ctx.fillText(this.nightSky.starField.commonNames[HR], x + 5, y - 5)
                }
            }
        }

        for (const [name, planet] of Object.entries(this.nightSky.planets.planetSprites)) {
            const pos = planet.equatorial.clone()
            pos.applyMatrix4(this.nightSky.celestialSphere.matrix)
            pos.project(camera)

            // Apply alpha to the planet's own color
            const c = planet.color;
            const alphaColor = c.length === 7 ? c + alphaHex : c;
            this.ctx.strokeStyle = alphaColor;
            this.ctx.fillStyle = alphaColor;

            if (pos.z > -1 && pos.z < 1 && pos.x >= -1 && pos.x <= 1 && pos.y >= -1 && pos.y <= 1) {
                const [x, y] = this.labelXY(pos);
                this.ctx.fillText(name, x + 5, y - 5)
            }
        }
    }

    renderSatelliteNames(camera, earthSphere, starAlpha = 1) {
        const satellites = this.nightSky.satellites;
        if (!satellites.TLEData) return;

        const isLookView = this.overlayView.id === "lookView";
        const isMainView = this.overlayView.id === "mainView";

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

            // Hide co-located satellites (docked to the camera satellite) in look view
            if (isLookView && sat.hiddenInLookView) continue;

            if (satellites.labelFlares && !sat.isFlaring) continue;
            if (satellites.labelLit && !sat.isLit) continue;
            if (isMainView && satellites.labelLookVisible && !sat.visibleInLook) continue;

            // arrowRange is a physical-range filter, so use the geometric
            // satellite position. Screen projection and Earth-occlusion use
            // the apparent position so the label tracks the rendered dot
            // when refraction lifts a sub-horizon satellite into view.
            const satRender = sat.ecefApparent || sat.ecef;
            const distSq = sat.ecef.distanceToSquared(cameraPos);
            if (!sat.userFiltered && distSq >= arrowRangeSq) continue;

            const viewPos = satRender.clone().applyMatrix4(camera.matrixWorldInverse);
            if (viewPos.z >= 0) continue;

            const satScreenPos = satRender.clone().project(camera);
            const isInsideFrustum = satScreenPos.x >= -1 && satScreenPos.x <= 1 &&
                satScreenPos.y >= -1 && satScreenPos.y <= 1;

            if (!isInsideFrustum) {
                if (satScreenPos.x < -1) {
                    const [pixelX] = this.labelXY(satScreenPos);
                    const offscreenPixels = -pixelX;
                    if (offscreenPixels > 30 * 16) {
                        continue;
                    }
                } else {
                    continue;
                }
            }

            const camToSat = satRender.clone().sub(cameraPos);
            const distToSat = camToSat.length();
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
        
        const alphaHex = Math.floor(starAlpha * 255).toString(16).padStart(2, '0');
        this.ctx.fillStyle = "#ffffff" + alphaHex;

        const maxLabels = this.maxSatelliteLabels;
        for (let i = 0; i < candidates.length && i < maxLabels; i++) {
            const sat = satData[candidates[i].index];
            const screenPos = candidates[i].screenPos;

            const [x, y] = this.labelXY(screenPos);

            let name = sat.name.replace("0 STARLINK", "SL").replace("STARLINK", "SL");
            name = name.replace(/\s+$/, '');
            this.ctx.fillText(name, x + 5, y - 5)
        }
    }

    renderLabels3D(frame, camera) {
        if (registeredLabels.size === 0) return;

        const viewLayerMask = this.camera.layers.mask;

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

            const screenPos = label.textPosition.clone().project(camera);
            if (screenPos.z < -1 || screenPos.z > 1) continue;
            if (screenPos.x < -1.5 || screenPos.x > 1.5
                || screenPos.y < -1.5 || screenPos.y > 1.5) continue;

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
            let [x, y] = this.labelXY(screenPos);

            // label.offset is applied here in 2D rather than by nudging the 3D
            // position through offsetScreenPixels() and re-projecting. That round
            // trip only worked when the projection it used matched the one the label
            // is drawn with, which stops being true as soon as the view is letterboxed.
            //
            // The 0.5 keeps the on-screen result identical to what it has always been:
            // offsetScreenPixels() steps NDC by pixels/widthPx, and NDC spans 2, not 1,
            // so every offsetX/offsetY has in practice always moved a label by HALF its
            // nominal pixels. Those values are node-definition data and reach us from
            // saved sitches, so they are taken as they have always behaved rather than
            // reinterpreted — correcting the factor here would move every existing label.
            if (label.offset) {
                x += 0.5 * label.offset.x;
                y -= 0.5 * label.offset.y;
            }

            if (textAlign === 'left') {
                x -= 5;
                y += 5;
            }

            const fontSize = label.size || 12;
            this.ctx.font = (label.fontWeight ? label.fontWeight + ' ' : '') + Math.floor(fontSize) + 'px Arial';
            this.ctx.textAlign = textAlign;
            
            const alpha = Math.floor(transparency * 255).toString(16).padStart(2, '0');
            const color = label.useHUDColor ? getHUDColor(transparency) : (label.color || '#FFFFFF');
            this.ctx.fillStyle = label.useHUDColor
                ? color
                : color.length === 7 ? color + alpha : color;
            
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
