// Wescam MX-series (MX-15/MX-20) gimbal camera OSD overlay.
//
// Layout is taken from a real MX display frame: a character grid anchored to the
// video rectangle, with a scrolling azimuth tape along the bottom, a scrolling
// elevation tape down the left, a north needle, and a centre reticle.
//
// Dynamic elements (drawn in the full HUD colour):
//    date / time / UTC offset      (from the global date-time node)
//    focal length                  (derived from the camera's vertical FOV)
//    camera relative az + elevation (the two tapes)
//    ACFT lat / lon / heading / altitude
//    TGT  lat / lon / altitude, LOS bearing and slant range
// Everything else is drawn dimmed, as static placeholder text, the same way
// CNodeMQ9UI handles the parts of the MQ-9 OSD we don't simulate.

import {CNodeViewUI} from "./CNodeViewUI";
import {getAzElFromPositionAndForward, getCompassHeading} from "../SphericalMath";
import {MV3} from "../threeUtils";
import {Raycaster} from "three";
import * as LAYER from "../LayerMasks";
import {intersectSurface} from "../threeExt";
import {ECEFToLLAVD_radii} from "../LLA-ECEF-ENU";
import {degrees, radians} from "../utils";
import {GlobalDateTimeNode, NodeMan} from "../Globals";
import {airframeHeadingFromVelocity} from "../AirframeHeading";
import {meanSeaLevelOffset} from "../EGM96Geoid";
import {getHUDColor} from "../HUDColor";

const METERS_TO_FEET = 3.28084;
const METERS_PER_NM = 1852;

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN",
                "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

// The OSD is laid out on this character grid. The counts come from measuring a
// 2670x1494 MX frame: cells are ~33 x 40 px, i.e. 80 columns by 37 rows.
const GRID_COLS = 80;
const GRID_ROWS = 37;

// The MX layout fills the width of a 16:9 picture. On a narrower picture the
// blocks pull in towards the centre rather than spreading to the edges, so the
// column spacing is scaled by how much narrower than 16:9 the video is.
const REF_ASPECT = 16 / 9;

// Tape scales, measured off the reference frame.
const AZ_WIDTH_PER_10DEG = 0.042;    // fraction of box width per 10 degrees
const AZ_HALF_WINDOW = 0.10;         // half the visible tape width, as a fraction of box width
const EL_HEIGHT_PER_10DEG = 0.074;   // fraction of box height per 10 degrees
const EL_HALF_WINDOW = 0.095;        // half the visible tape height, as a fraction of box height

// Tracks to derive the airframe heading from, best first. Same list and
// rationale as the wind-fit chain in CustomManagerSetup.js: the smoothed Custom
// switch (noise suppression steadies the heading), then the raw switch, then the
// single-purpose ids used by SitGimbal / SitAguadilla.
const CAMERA_TRACK_IDS = ["cameraTrackSwitchSmooth", "cameraTrackSwitch", "jetTrack", "cameraTrack"];

// The id of the best available camera track, or null if the sitch has none — in
// which case there is no airframe to be relative to, and the heading readout and
// azimuth tape are suppressed rather than reporting a heading of 000.
function findCameraTrackID() {
    for (const id of CAMERA_TRACK_IDS) {
        if (NodeMan.exists(id)) {
            const candidate = NodeMan.get(id);
            if (candidate && typeof candidate.p === "function") return id;
        }
    }
    return null;
}

function pad2(n) {
    return Math.abs(n).toString().padStart(2, '0');
}

function pad3(n) {
    return Math.abs(n).toString().padStart(3, '0');
}

// An MX reads altitudes in feet MSL. Sitrec positions are ECEF, so converting
// back gives an ellipsoidal height — take the geoid separation back off to get
// MSL, the same way CNodeLabels3D and CNode3DObject report altitude.
function altitudeMSLFeet(lla) {
    return (lla.z - meanSeaLevelOffset(lla.x, lla.y)) * METERS_TO_FEET;
}

export class CNodeWescamMXUI extends CNodeViewUI {

    constructor(v) {
        super(v);
        this.input("camera");  // a camera node, this is the camera track

        // Camera track, used to work out the airframe heading, and target track.
        // Both take whatever the sitch specifies. Their fallbacks are resolved
        // lazily on first render, because this node is created from
        // CCustomManager.setup(), which runs before Sit.setup() — sitches that
        // build their tracks there have none yet at construction time.
        this.input("cameraTrack", true);
        this.input("target", true);

        this.cx = 50;
        this.cy = 50;
        this.doubleClickFullScreen = false;

        this.gridCols = GRID_COLS;
        this.gridRows = GRID_ROWS;
        this.gridTexts = [];

        // The focal length readout is a 35mm-equivalent value, matching the
        // convention already used for EXIF optics in EXIFUtils.js. Override
        // sensorHeightMM in the sitch if a different sensor is wanted.
        this.sensorHeightMM = v.sensorHeightMM ?? 24;

        const grey = '#888888';

        // ---- top block ----------------------------------------------------
        this.dateText = this.addGridText(1, 1, "01JAN2000");
        this.addGridText(13, 1, "AUTO", grey);
        this.addGridText(20, 1, "VIC", grey);
        this.addGridText(41, 1, "EON", grey, 'center');
        this.focalText = this.addGridText(61, 1, "1000", '#FFFFFF', 'right');
        this.addGridText(63, 1, "COL", grey);
        this.addGridText(72, 1, "AUTO", grey, 'right');
        this.addGridText(78, 1, "∞", grey);

        this.timeText = this.addGridText(1, 2, "00:00:00");
        this.addGridText(20, 2, "CENT", grey);
        this.addGridText(63, 2, "LOW", grey);
        this.addGridText(72, 2, "50", grey, 'right');

        this.tzText = this.addGridText(1, 3, "UTC+0.0");

        // ---- bottom block -------------------------------------------------
        this.addGridText(1, 31, "LI:DISARM", grey);
        this.addGridText(1, 32, "LI:LOW", grey);
        this.addGridText(73, 32, "MAN", grey);
        this.addGridText(77, 32, "NONE", grey);

        this.addGridText(2, 34, "ACFT");
        this.addGridText(80, 34, "TGT", '#FFFFFF', 'right');

        this.acftLat = this.addGridText(13, 35, "00:00:00N", '#FFFFFF', 'right');
        this.acftLon = this.addGridText(13, 36, "000:00:00W", '#FFFFFF', 'right');
        this.acftHdg = this.addGridText(20, 35, "000°", '#FFFFFF', 'right');
        this.acftAlt = this.addGridText(21, 36, "0FT", '#FFFFFF', 'right');

        this.losBrg = this.addGridText(63, 35, "000°", '#FFFFFF', 'right');
        this.tgtAlt = this.addGridText(54, 36, "0FT", '#FFFFFF', 'right');
        this.losRange = this.addGridText(63, 36, "0.0NM", '#FFFFFF', 'right');
        this.addGridText(65, 36, "LOS");
        this.tgtLat = this.addGridText(80, 35, "00:00:00N", '#FFFFFF', 'right');
        this.tgtLon = this.addGridText(80, 36, "000:00:00W", '#FFFFFF', 'right');
    }

    addGridText(col, row, text, color = '#FFFFFF', align = 'left') {
        const entry = {col, row, text, color, align};
        this.gridTexts.push(entry);
        return entry;
    }

    // "33:53:05N" - degrees:minutes:seconds, seconds truncated so they can
    // never carry up to 60.
    formatLatLon(value, positive, negative) {
        const dir = value >= 0 ? positive : negative;
        value = Math.abs(value);
        const deg = Math.floor(value);
        const minFloat = (value - deg) * 60;
        const min = Math.floor(minFloat);
        const sec = Math.floor((minFloat - min) * 60);
        return `${pad2(deg)}:${pad2(min)}:${pad2(sec)}${dir}`;
    }

    // Airframe heading in degrees true, from the camera track's air velocity
    // (ground velocity corrected for wind), as in CNodeMQ9UI.
    //
    // Returns null whenever there is no heading to be had — no camera track, or
    // a track that isn't going anywhere. The caller then blanks the heading and
    // drops the azimuth tape. The stationary case matters: the Custom sitch
    // defaults to a fixed camera, and a fixed camera in a 1.2m/frame wind would
    // otherwise report the wind direction dressed up as an airframe heading.
    getAirframeHeading(frame) {
        if (!this.in.cameraTrack) {
            const trackID = findCameraTrackID();
            if (!trackID) return null;
            this.addInput("cameraTrack", trackID);
        }

        const trackPos = this.in.cameraTrack.p(frame);
        const groundVelocity = this.in.cameraTrack.p(frame + 1).clone().sub(trackPos);

        // wind vector is in meters per frame, same as the velocity
        const localWind = NodeMan.get("localWind", false);
        const wind = localWind ? localWind.getValueFrame(frame, trackPos) : null;

        return airframeHeadingFromVelocity(trackPos, groundVelocity, wind);
    }

    // Where the camera is pointing: the target track if there is one, otherwise
    // wherever the line of sight meets the terrain or the reference surface.
    getTargetPosition(frame, camera, forward) {
        if (!this.in.target && NodeMan.exists("targetTrackSwitchSmooth")) {
            this.addInput("target", "targetTrackSwitchSmooth");
        }
        if (this.in.target) {
            return this.in.target.p(frame);
        }

        const terrainNode = NodeMan.get("TerrainModel", false);
        if (terrainNode) {
            const ray = new Raycaster(camera.position, forward.clone().normalize());
            ray.layers.mask |= LAYER.MASK_MAIN | LAYER.MASK_LOOK;
            const intersection = terrainNode.getClosestIntersect(ray);
            if (intersection) return intersection.point.clone();
        }

        return intersectSurface(camera.position, forward);
    }

    updateDateTime() {
        if (GlobalDateTimeNode === undefined) return;

        const tzOffset = GlobalDateTimeNode.getTimeZoneOffset();
        // dateNow is UTC; shift by the offset and read it back with getUTC*,
        // which is how CNodeDateTime itself converts to display-local time.
        const local = new Date(GlobalDateTimeNode.dateNow.getTime() + tzOffset * 3600000);

        this.dateText.text = `${pad2(local.getUTCDate())}${MONTHS[local.getUTCMonth()]}${local.getUTCFullYear()}`;
        this.timeText.text = `${pad2(local.getUTCHours())}:${pad2(local.getUTCMinutes())}:${pad2(local.getUTCSeconds())}`;
        this.tzText.text = `UTC${tzOffset < 0 ? '-' : '+'}${Math.abs(tzOffset).toFixed(1)}`;
    }

    renderCanvas(frame) {
        if (this.overlayView && !this.overlayView.visible) return;

        const camera = this.in.camera.camera;
        camera.updateMatrixWorld();

        // camera forward = negated z basis of its world matrix
        const forward = MV3(camera.matrixWorld.elements.slice(8, 11));
        forward.negate();

        const heading = getCompassHeading(camera.position, forward, camera);
        const cameraHeadingDeg = ((degrees(heading) % 360) + 360) % 360;
        // Elevation is deliberately ABSOLUTE (below the local horizon), not
        // airframe-relative: the MX gimbal is inertially stabilised, so its
        // elevation readout references the stabilised horizon. Azimuth is the
        // relative one. Both were checked against a real MX frame — 10737ft
        // over a 1663ft target at 4.4NM is 19.8 degrees of depression, and the
        // tape's centre pointer sits on -02 there.
        const cameraElevation = getAzElFromPositionAndForward(camera.position, forward)[1];

        // azimuth of the camera relative to the nose, 0..360, or null if this
        // sitch has no camera track to give us an airframe to be relative to
        const airframeHeadingDeg = this.getAirframeHeading(frame);
        const relativeAzimuth = airframeHeadingDeg === null
            ? null
            : ((cameraHeadingDeg - airframeHeadingDeg) % 360 + 360) % 360;

        this.updateDateTime();

        // Focal length from the vertical FOV, as a 35mm-equivalent value.
        const vFOV = camera.fov;
        this.focalText.text = `${Math.round((this.sensorHeightMM / 2) / Math.tan(radians(vFOV) / 2))}`;

        // ACFT block
        const lla = ECEFToLLAVD_radii(camera.position);
        this.acftLat.text = this.formatLatLon(lla.x, 'N', 'S');
        this.acftLon.text = this.formatLatLon(lla.y, 'E', 'W');
        this.acftHdg.text = airframeHeadingDeg === null
            ? "---°"
            : `${pad3(Math.round(airframeHeadingDeg) % 360)}°`;
        this.acftAlt.text = `${Math.round(altitudeMSLFeet(lla))}FT`;

        // TGT / LOS block
        const targetPos = this.getTargetPosition(frame, camera, forward);
        if (targetPos) {
            const targetLLA = ECEFToLLAVD_radii(targetPos);
            this.tgtLat.text = this.formatLatLon(targetLLA.x, 'N', 'S');
            this.tgtLon.text = this.formatLatLon(targetLLA.y, 'E', 'W');
            this.tgtAlt.text = `${Math.round(altitudeMSLFeet(targetLLA))}FT`;

            const toTarget = targetPos.clone().sub(camera.position);
            const slantRange = toTarget.length();
            const bearingRad = getCompassHeading(camera.position, toTarget.normalize(), null);
            const bearingDeg = ((degrees(bearingRad) % 360) + 360) % 360;
            this.losBrg.text = `${pad3(Math.round(bearingDeg) % 360)}°`;
            this.losRange.text = `${(slantRange / METERS_PER_NM).toFixed(1)}NM`;
        } else {
            this.tgtLat.text = "-";
            this.tgtLon.text = "-";
            this.tgtAlt.text = "-";
            this.losBrg.text = "-";
            this.losRange.text = "-";
        }

        super.renderCanvas(frame);

        const c = this.ctx;

        // Match the grid to the video rectangle, exactly as CNodeMQ9UI does, so
        // the OSD sits on the picture rather than on the whole view.
        let boxX = 0, boxY = 0, boxW = this.widthPx, boxH = this.heightPx;
        let videoView = NodeMan.get("mirrorVideo", false);
        if (!videoView) {
            videoView = NodeMan.get("video", false);
        }
        if (videoView && videoView.getSourceAndDestCoords) {
            videoView.getSourceAndDestCoords();
            boxX = videoView.dx;
            boxY = videoView.dy;
            boxW = videoView.dWidth;
            boxH = videoView.dHeight;
        } else {
            // No video: centre on the look view, clamped to 16:9 max aspect
            const viewAspect = this.widthPx / this.heightPx;
            if (viewAspect > REF_ASPECT) {
                boxW = this.heightPx * REF_ASPECT;
                boxX = (this.widthPx - boxW) / 2;
            }
        }

        // Narrower than 16:9 pulls the blocks in towards the centre.
        const aspect = boxW / boxH;
        if (aspect < REF_ASPECT) {
            const shrunkW = boxW * (aspect / REF_ASPECT);
            boxX += (boxW - shrunkW) / 2;
            boxW = shrunkW;
        }

        const hudColor = getHUDColor();
        const dimHUDColor = getHUDColor(0.55);
        const charWidth = boxW / this.gridCols;
        const charHeight = boxH / this.gridRows;
        // 1.6 * charWidth is the largest font whose monospace advance still fits
        // a cell, so compressed columns shrink the text instead of overlapping.
        const fontSize = Math.floor(Math.min(charHeight * 0.9, charWidth * 1.6));
        // Row pitch follows the font, so a shrunk font gives tight blocks rather
        // than sparse ones. At 16:9 this is exactly charHeight.
        const rowStep = fontSize / 0.9;
        const centerX = boxX + boxW / 2;
        const centerY = boxY + boxH / 2;

        // Top rows hang from the top of the picture, bottom rows sit up from the
        // bottom, so both blocks stay on their edge whatever the row pitch is.
        const topMargin = boxH * 0.0074;
        const rowY = (row) => row * 2 <= this.gridRows
            ? boxY + topMargin + (row - 1) * rowStep
            : boxY + boxH - (this.gridRows - row + 1) * rowStep;

        c.font = `${fontSize}px monospace`;
        c.textBaseline = 'top';
        for (const t of this.gridTexts) {
            c.fillStyle = t.color === '#888888' ? dimHUDColor : hudColor;
            c.textAlign = t.align;
            let x;
            if (t.align === 'right') {
                x = boxX + t.col * charWidth;
            } else if (t.align === 'center') {
                x = boxX + (t.col - 0.5) * charWidth;
            } else {
                x = boxX + (t.col - 1) * charWidth;
            }
            c.fillText(t.text, x, rowY(t.row));
        }

        c.strokeStyle = hudColor;
        c.fillStyle = hudColor;
        c.lineWidth = 1;

        if (relativeAzimuth !== null) {
            this.drawAzimuthTape(c, relativeAzimuth, boxX, boxW, rowY(34), charWidth, fontSize);
        }
        this.drawElevationTape(c, cameraElevation, boxX, boxH, centerY, charWidth, fontSize);
        this.drawNorthNeedle(c, heading, boxX, boxY, boxW, boxH, fontSize);
        this.drawReticle(c, centerX, centerY, boxH);
    }

    // Scrolling azimuth tape along the bottom, centred on the relative azimuth.
    // Labels are tens of degrees ("08" = 080), with a dot every 5 degrees.
    drawAzimuthTape(c, relativeAzimuth, boxX, boxW, labelTop, charWidth, fontSize) {
        const centerX = boxX + boxW / 2;
        const pxPerDeg = (boxW * AZ_WIDTH_PER_10DEG) / 10;
        const halfWindow = boxW * AZ_HALF_WINDOW;

        const tickBottom = labelTop - fontSize * 0.11;
        const tickTop = tickBottom - fontSize * 0.39;
        const pointerTop = tickBottom - fontSize * 0.62;
        const pointerBottom = labelTop + fontSize * 1.5;

        c.font = `${fontSize}px monospace`;
        c.textAlign = 'center';
        c.textBaseline = 'top';

        // step in 5 degree increments over the visible window
        const first = Math.ceil((relativeAzimuth - halfWindow / pxPerDeg) / 5) * 5;
        const last = Math.floor((relativeAzimuth + halfWindow / pxPerDeg) / 5) * 5;
        for (let deg = first; deg <= last; deg += 5) {
            const x = centerX + (deg - relativeAzimuth) * pxPerDeg;
            if (deg % 10 === 0) {
                c.beginPath();
                c.moveTo(x, tickBottom);
                c.lineTo(x, tickTop);
                c.stroke();
                const label = ((deg % 360) + 360) % 360;
                c.fillText(pad2(label / 10), x, labelTop);
            } else {
                // minor tick, a dot level with the top of the major ticks
                c.fillRect(x - charWidth * 0.06, tickTop, charWidth * 0.12, fontSize * 0.09);
            }
        }

        // fixed centre pointer, above and below the numbers
        c.beginPath();
        c.moveTo(centerX, pointerTop);
        c.lineTo(centerX, tickBottom);
        c.moveTo(centerX, labelTop + fontSize * 1.15);
        c.lineTo(centerX, pointerBottom);
        c.stroke();
    }

    // Scrolling elevation tape down the left, centred on the camera elevation.
    // Labels are tens of degrees, so "-02" is 20 degrees of depression.
    drawElevationTape(c, elevation, boxX, boxH, centerY, charWidth, fontSize) {
        const pxPerDeg = (boxH * EL_HEIGHT_PER_10DEG) / 10;
        const halfWindow = boxH * EL_HALF_WINDOW;

        const labelRight = boxX + charWidth * 4.4;
        const tickLeft = boxX + charWidth * 4.6;
        const tickRight = boxX + charWidth * 5.05;

        c.font = `${fontSize}px monospace`;
        c.textAlign = 'right';
        c.textBaseline = 'middle';

        const first = Math.ceil((elevation - halfWindow / pxPerDeg) / 5) * 5;
        const last = Math.floor((elevation + halfWindow / pxPerDeg) / 5) * 5;
        for (let deg = first; deg <= last; deg += 5) {
            const y = centerY - (deg - elevation) * pxPerDeg;
            if (deg % 10 === 0) {
                c.beginPath();
                c.moveTo(tickLeft, y);
                c.lineTo(tickRight, y);
                c.stroke();
                c.fillText(`${deg < 0 ? '-' : ''}${pad2(deg / 10)}`, labelRight, y);
            } else {
                c.fillRect(tickLeft + charWidth * 0.1, y - fontSize * 0.045,
                           charWidth * 0.14, fontSize * 0.09);
            }
        }

        // fixed centre pointer: a dash either side of the tape
        c.beginPath();
        c.moveTo(boxX + charWidth * 2.0, centerY);
        c.lineTo(boxX + charWidth * 2.45, centerY);
        c.moveTo(boxX + charWidth * 5.2, centerY);
        c.lineTo(boxX + charWidth * 5.6, centerY);
        c.stroke();
    }

    // North needle: an upright "N" on a line with an arrowhead, pointing along
    // the compass direction of north.
    //
    // This is a flat compass needle driven by azimuth alone — it deliberately
    // does NOT project the north vector through the camera. Measured on a real
    // MX frame (azimuth 193, depression 19.8): a true 3D projection would put
    // the needle 146 degrees clockwise from up, azimuth-only puts it at 167,
    // and the frame shows about 164.
    drawNorthNeedle(c, heading, boxX, boxY, boxW, boxH, fontSize) {
        // screen bearing of north is -heading, measured clockwise from up
        const dx = -Math.sin(heading);
        const dy = -Math.cos(heading);

        const ax = boxX + boxW * 0.047;
        const ay = boxY + boxH * 0.176;
        const len = fontSize * 3.5;   // 0.084 of picture height at 16:9

        c.beginPath();
        c.moveTo(ax - dx * len * 0.5, ay - dy * len * 0.5);
        c.lineTo(ax - dx * len * 0.2, ay - dy * len * 0.2);
        c.moveTo(ax + dx * len * 0.2, ay + dy * len * 0.2);
        c.lineTo(ax + dx * len * 0.38, ay + dy * len * 0.38);
        c.stroke();

        // arrowhead at the far end, pointing along the needle
        const tipX = ax + dx * len * 0.5;
        const tipY = ay + dy * len * 0.5;
        const backX = ax + dx * len * 0.3;
        const backY = ay + dy * len * 0.3;
        const wingX = -dy * len * 0.14;
        const wingY = dx * len * 0.14;
        c.beginPath();
        c.moveTo(tipX, tipY);
        c.lineTo(backX + wingX, backY + wingY);
        c.lineTo(backX - wingX, backY - wingY);
        c.closePath();
        c.fill();

        c.font = `${fontSize}px monospace`;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText('N', ax, ay);
    }

    // Centre reticle: four arms with a gap in the middle, each capped by a
    // short perpendicular serif.
    drawReticle(c, centerX, centerY, boxH) {
        const gap = boxH * 0.0107;
        const arm = boxH * 0.0328;
        const cap = boxH * 0.012;

        c.beginPath();
        // vertical arms
        c.moveTo(centerX, centerY - gap);
        c.lineTo(centerX, centerY - arm);
        c.moveTo(centerX - cap, centerY - arm);
        c.lineTo(centerX + cap, centerY - arm);
        c.moveTo(centerX, centerY + gap);
        c.lineTo(centerX, centerY + arm);
        c.moveTo(centerX - cap, centerY + arm);
        c.lineTo(centerX + cap, centerY + arm);
        // horizontal arms
        c.moveTo(centerX - gap, centerY);
        c.lineTo(centerX - arm, centerY);
        c.moveTo(centerX - arm, centerY - cap);
        c.lineTo(centerX - arm, centerY + cap);
        c.moveTo(centerX + gap, centerY);
        c.lineTo(centerX + arm, centerY);
        c.moveTo(centerX + arm, centerY - cap);
        c.lineTo(centerX + arm, centerY + cap);
        c.stroke();
    }

}
