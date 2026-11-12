// Celestial lines drawn over the video picture: the V boxes of the night sky's Lines folder.
//
// The main and look views draw these lines in 3D. The video view is a 2D canvas, so here each
// line is projected through the look camera into the video picture and stroked on an overlay
// of the video view. The look camera's vertical field of view spans the height of the video
// picture (the convention of VideoPixelRay.js), so a line lands on the video where the look
// view shows it against the same picture. The camera's orientation is the one the look view
// displays, Camera Tweaks included.
//
// The lines are not hidden by the ground: the video has no depth, so a grid continues below
// the horizon.

import {CNodeViewUI} from "./CNodeViewUI";
import {Globals, NodeMan, Sit} from "../Globals";
import {Matrix4, Vector3} from "three";
import {directionToVideoPixel} from "../VideoPixelRay";
import {applyRefractionECI, prepareObserverRefraction, REFRACTION_DEFAULTS} from "../atmosphere/refraction";
import {horizonCompassFrame} from "../HorizonCompassRibbon";
import {fisheyeViewToNDC, isFisheyeCamera} from "../FisheyeProjection";
import {isPanoramicCamera, panoramic} from "../PanoramicCamera";
import {panoramaFrame, panoramaProject} from "../rendering/PanoramaMath";
import {withDisplayedCamera} from "../ViewUtils";
import {getFlowAlignRotation} from "../FlowAlignment";

// The color of the 3D lines (CCelestialElements).
const LINE_COLOR = "#808080";

// The 3D grid fades its strokes between these distances, in pixels, from a pole, where all
// the meridians meet (CelestialGridMaterial).
const POLE_FADE_NEAR = 10;
const POLE_FADE_FAR = 50;

// A pinhole camera has no image at 90 degrees from its axis, and the image of a direction
// near that is very far away. A segment is cut where it goes past this angle.
const PINHOLE_MAX_ANGLE = 89 * Math.PI / 180;
const PINHOLE_MIN_FORWARD = Math.cos(PINHOLE_MAX_ANGLE);

// The longest step between two vertices of a GRID line is 1.8 degrees, and refraction moves a
// direction by less than one degree. A grid vertex that is this far outside the picture's
// corner can not be an end of a segment that is in the picture, so it is rejected before the
// refraction, which is most of the work. A constellation line is different: it is one long
// segment from star to star, and a star far outside the picture can be the end of a segment
// that crosses the picture. Its vertices are never rejected this way.
const GRID_CULL_MARGIN = 3 * Math.PI / 180;

export class CNodeVideoSkyLines extends CNodeViewUI {
    constructor(v) {
        super(v);
        this.nightSky = v.nightSky;
        // Made the first time a V box is on, so a save has no state for it to get back.
        this.skipModSerialize = true;
        // This overlay is switched off while the video view stays on. The render loop does not
        // draw a view that is off, and the draw is what clears the canvas, so the lines drawn
        // last would stay on the video. With this flag the view manager hides the canvas itself
        // (CViewManager.updateDOMVisibility), as it does for the other switched overlays.
        this.separateVisibility = true;

        this.viewMatrix = new Matrix4();
        this.horizonMatrix = new Matrix4();
        this.cameraPosition = new Vector3();
        this.direction = new Vector3();
        this.previousView = new Vector3();
        this.currentView = new Vector3();
        this.clippedA = new Vector3();
        this.clippedB = new Vector3();
        this.pixel = {x: 0, y: 0};
    }

    // The sets of lines that have their V box on.
    lineSets() {
        const sky = this.nightSky;
        const elements = sky.celestialElements;
        const sets = [];
        if (sky.showEquatorialGridVideo) {
            sets.push({lines: elements.celestialGridLines, horizon: false, refracted: true, grid: true});
        }
        if (sky.showAzimuthalGridVideo) {
            sets.push({lines: elements.azimuthalGridLines, horizon: true, refracted: false, grid: true});
        }
        if (sky.showConstellationsVideo) {
            sets.push({lines: elements.constellationLines, horizon: false, refracted: true, grid: false});
        }
        return sets;
    }

    renderCanvas(frame) {
        super.renderCanvas(frame);

        const sets = this.lineSets();
        const video = this.overlayView;
        const lookView = NodeMan.get("lookView", false);
        if (sets.length === 0 || !lookView?.camera) return;
        const pictureWidth = video.videoWidth, pictureHeight = video.videoHeight;
        if (!(pictureWidth > 0) || !(pictureHeight > 0)) return;

        // The field of view between renders is the one that spans the picture. Inside
        // withDisplayedCamera it also has the zoom and the fit of the look view's own pane.
        const verticalFov = lookView._lodSavedFov ?? lookView.camera.fov;
        let lens = "pinhole";
        withDisplayedCamera(lookView, camera => {
            if (isPanoramicCamera(camera)) lens = "panorama";
            else if (isFisheyeCamera(camera)) lens = "fisheye";
            this.viewMatrix.copy(camera.matrixWorldInverse);
            this.cameraPosition.setFromMatrixPosition(camera.matrixWorld);
        });

        const refraction = prepareObserverRefraction(this.cameraPosition, {
            enabled: Sit.refractionEnabled ?? REFRACTION_DEFAULTS.enabled,
            pressureHPa: Sit.refractionPressure ?? REFRACTION_DEFAULTS.pressureHPa,
            tempC: Sit.refractionTemp ?? REFRACTION_DEFAULTS.tempC,
            equatorRadius: Globals.equatorRadius,
            polarRadius: Globals.polarRadius,
        });
        const {east, north, up} = horizonCompassFrame(this.cameraPosition, Globals.equatorRadius, Globals.polarRadius);
        this.horizonMatrix.makeBasis(east, north, up);

        // Where the picture is on the canvas, with the zoom and the pan of the video view.
        video.getSourceAndDestCoords();
        const {sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight} = video;
        if (!(sWidth > 0) || !(sHeight > 0) || !(dWidth > 0) || !(dHeight > 0)) return;
        const scaleX = dWidth / sWidth, scaleY = dHeight / sHeight;

        const aspect = pictureWidth / pictureHeight;
        const pinhole = lens === "pinhole";
        const panoramaVFov = panoramaFrame(panoramic.hfov, pictureWidth, pictureHeight).vfov;
        const halfDiagonal = Math.atan(Math.tan(verticalFov * Math.PI / 360) * Math.hypot(1, aspect));
        const gridMinForward = Math.cos(Math.min(PINHOLE_MAX_ANGLE, halfDiagonal + GRID_CULL_MARGIN));
        const skyMatrix = this.nightSky.celestialSphere.matrix;
        const direction = this.direction, pixel = this.pixel;

        // A point of a line, in its own frame -> its direction on the camera's axes (x right,
        // y up, -z forward), with refraction. False for a grid vertex that is too far outside
        // the picture to be an end of a segment in it.
        const toView = (x, y, z, set, out) => {
            direction.set(x, y, z).transformDirection(set.horizon ? this.horizonMatrix : skyMatrix);
            if (pinhole && set.grid) {
                out.copy(direction).transformDirection(this.viewMatrix);
                if (-out.z < gridMinForward) return false;
            }
            if (set.refracted && refraction.enabled) {
                applyRefractionECI(direction, refraction.zenith, refraction.opts);
            }
            out.copy(direction).transformDirection(this.viewMatrix);
            return true;
        };

        // A direction on the camera's axes -> canvas pixels. False where the lens has no image
        // of it. The direction is changed.
        const toCanvas = (view, out) => {
            if (pinhole) {
                if (!directionToVideoPixel(view.x, view.y, -view.z, verticalFov, pictureWidth, pictureHeight, pixel)) {
                    return false;
                }
            } else {
                if (lens === "fisheye") {
                    if (!fisheyeViewToNDC(view, aspect)) return false;
                } else {
                    panoramaProject(view, panoramic.hfov, panoramaVFov);
                    if (Math.abs(view.x) > 1 || Math.abs(view.y) > 1) return false;
                }
                pixel.x = (view.x + 1) * 0.5 * pictureWidth;
                pixel.y = (1 - view.y) * 0.5 * pictureHeight;
            }
            out.x = (pixel.x - sx) * scaleX + dx;
            out.y = (pixel.y - sy) * scaleY + dy;
            return Number.isFinite(out.x) && Number.isFinite(out.y);
        };

        // The two ends of a segment -> canvas pixels. False when no part of it has an image.
        // The image of a segment of a great circle through a pinhole is a straight line, so
        // a pinhole segment that goes past the limit angle is cut there and the rest is drawn.
        const clippedA = this.clippedA, clippedB = this.clippedB;
        const segmentToCanvas = (viewA, viewB, outA, outB) => {
            clippedA.copy(viewA);
            clippedB.copy(viewB);
            if (pinhole) {
                const forwardA = -clippedA.z, forwardB = -clippedB.z;
                if (forwardA < PINHOLE_MIN_FORWARD && forwardB < PINHOLE_MIN_FORWARD) return false;
                if (forwardA < PINHOLE_MIN_FORWARD) {
                    clippedA.lerp(clippedB, (PINHOLE_MIN_FORWARD - forwardA) / (forwardB - forwardA));
                } else if (forwardB < PINHOLE_MIN_FORWARD) {
                    clippedB.lerp(clippedA, (PINHOLE_MIN_FORWARD - forwardB) / (forwardA - forwardB));
                }
            }
            return toCanvas(clippedA, outA) && toCanvas(clippedB, outB);
        };

        const ctx = this.ctx;
        ctx.save();
        // The video view turns its picture by this angle (see CNodeVideoView.renderCanvas).
        const flowRotation = getFlowAlignRotation(frame);
        if (flowRotation !== 0) {
            ctx.translate(this.widthPx / 2, this.heightPx / 2);
            ctx.rotate(flowRotation);
            ctx.translate(-this.widthPx / 2, -this.heightPx / 2);
        }
        ctx.beginPath();
        ctx.rect(dx, dy, dWidth, dHeight);
        ctx.clip();
        ctx.strokeStyle = LINE_COLOR;
        ctx.lineWidth = this.nightSky.celestialLineWidth;
        ctx.lineCap = "round";

        // A wide lens can put the two ends of one short segment on opposite sides of the
        // picture (the rear seam of a panorama). Such a segment is not drawn.
        const maxStep = pinhole ? Infinity : dWidth / 2;
        const right = dx + dWidth, bottom = dy + dHeight;
        const faded = [];
        const a = {x: 0, y: 0}, b = {x: 0, y: 0}, pole = {x: 0, y: 0};
        const previousView = this.previousView, currentView = this.currentView;
        // Where the path ends now, so that a line of joined segments is one path.
        let penX = NaN, penY = NaN;

        ctx.beginPath();
        for (const set of sets) {
            const poles = [];
            if (set.grid) {
                for (const z of [1, -1]) {
                    if (toView(0, 0, z, set, currentView) && toCanvas(currentView, pole)) {
                        poles.push({x: pole.x, y: pole.y});
                    }
                }
            }
            for (const line of set.lines) {
                const position = line.sourceGeometry?.getAttribute("position");
                if (!position) continue;
                const strip = line.topology !== "segments";
                let hasPrevious = false;
                for (let i = 0; i < position.count; i++) {
                    // In a list of separate segments, an even vertex starts a new one.
                    const joined = strip || i % 2 === 1;
                    const hasCurrent = toView(position.getX(i), position.getY(i), position.getZ(i), set, currentView);
                    if (joined && hasPrevious && hasCurrent && segmentToCanvas(previousView, currentView, a, b)
                        && Math.abs(b.x - a.x) <= maxStep
                        && Math.max(a.x, b.x) >= dx && Math.min(a.x, b.x) <= right
                        && Math.max(a.y, b.y) >= dy && Math.min(a.y, b.y) <= bottom) {
                        const alpha = poleFade((a.x + b.x) / 2, (a.y + b.y) / 2, poles);
                        if (alpha >= 1) {
                            if (a.x !== penX || a.y !== penY) ctx.moveTo(a.x, a.y);
                            ctx.lineTo(b.x, b.y);
                            penX = b.x;
                            penY = b.y;
                        } else if (alpha > 0) {
                            faded.push(a.x, a.y, b.x, b.y, alpha);
                        }
                    }
                    previousView.copy(currentView);
                    hasPrevious = hasCurrent;
                }
            }
        }
        ctx.stroke();

        for (let i = 0; i < faded.length; i += 5) {
            ctx.globalAlpha = faded[i + 4];
            ctx.beginPath();
            ctx.moveTo(faded[i], faded[i + 1]);
            ctx.lineTo(faded[i + 2], faded[i + 3]);
            ctx.stroke();
        }
        ctx.restore();
    }
}

// 0 at a pole, 1 away from it, with a smooth step between the two fade distances.
function poleFade(x, y, poles) {
    let alpha = 1;
    for (const pole of poles) {
        const distance = Math.hypot(x - pole.x, y - pole.y);
        const step = Math.min(1, Math.max(0, (distance - POLE_FADE_NEAR) / (POLE_FADE_FAR - POLE_FADE_NEAR)));
        alpha = Math.min(alpha, step * step * (3 - 2 * step));
    }
    return alpha;
}
