// ATFLIR symbology, shared by the legacy jet sitches and the optional custom HUD.
import {NodeMan, Sit} from "../Globals";
import {par} from "../par";
import {abs, degrees, floor, m2f, pad, radians} from "../utils";
import {CNodeViewUI} from "./CNodeViewUI";
import {Color, LinearSRGBColorSpace, Vector3} from "three";
import {getAzElFromPositionAndForward, getCompassHeading} from "../SphericalMath";
import {ECEFToLLAVD_radii} from "../LLA-ECEF-ENU";
import {meanSeaLevelOffset} from "../EGM96Geoid";
import {MISB} from "../MISBUtils";
import {airframeHeadingFromVelocity} from "../AirframeHeading";
import {closingSpeedKnots, getTrackMISBRow, telemetryNumber, trackAirVelocity, trackFrameSpan} from "../SensorTrackTelemetry";
import {getHUDImageRect} from "../HUDImageRect";
import {getHUDColor} from "../HUDColor";
import {drawHUDText, ensureMQ9FontLoaded, MQ9_FONT} from "../HUDFonts";
import {airDataFromTAS, KNOT_MPS, pressureAltitudeFromPressure, standardAtmosphere} from "../AirData";

const TEXT_SCALE = 0.9;
const TEXT_BRIGHTNESS = 0.85;
const textColor = new Color();

export class   CNodeATFLIRUI extends CNodeViewUI {

    constructor(v) {
        super({...v, defaultFont: MQ9_FONT, defaultAlign: "left", defaultFontSize: v.defaultFontSize ?? 3.5});
        this.fontReady = ensureMQ9FontLoaded();
        this.showHideController?.tooltip("ATFLIR display. CAS (knots) and Mach use the camera track minus Local Wind. Static pressure and temperature use metadata when present, otherwise a standard atmosphere at the camera's MSL height. Altitude uses pressure altitude from metadata/profile pressure in 10-foot steps, otherwise MSL height. BLK is a placeholder.");

        this.optionalInputs(["camera", "cameraTrack", "target", "jetAltitude", "jetTAS", "atmosphere"]);
        this.trackDriven = !!this.in.camera;
        // Keep custom readouts local: creating a hidden HUD must not overwrite
        // the legacy jet's par.az/el/rng/Vc or its video clock offset.
        this.readouts = this.trackDriven ? {az: null, el: null, rng: null, Vc: null, time: 0} : par;
        const readouts = this.readouts;
        this.airData = {casKnots: null, mach: null};

        this.timeStart = v.timeStart;
        this.timeStartMin = v.timeStartMin;
        this.timeStartSec = v.timeStartSec;
        // Optional reconstruction display timing. Keep the geometric readouts
        // available even before a source instrument first displays them.
        this.timeOffsetSeconds = v.timeOffsetSeconds ?? (60*(v.timeStartMin ?? 0)+(v.timeStartSec ?? 0));
        this.timeFormat = v.timeFormat ?? "mmss";
        this.rangeStartFrame = v.rangeStartFrame ?? 0;
        this.targetMarkerStartFrame = v.targetMarkerStartFrame ?? 0;
        this.simpleSerials.push("timeOffsetSeconds", "timeFormat", "rangeStartFrame", "targetMarkerStartFrame");
        const display = this;

        this.cx = 50
        this.cy = 36.4

        this.wpx = this.widthPx;
        this.hpx = this.heightPx

        this.addText("fov", "NAR", 14.8, 3.1)
        this.addText("mode", "IR", 48.4, 3.1)
        this.addText("reticle", "RTCL", 61.9, 3.1)
        this.addText("operational", "OPR", 3.5, 7)
        this.addText("zoom", this.trackDriven ? "" : (Sit.lookFOV === 0.35 ? "Z 2.0" : "Z 1.0"), 14.8, 7)

        this.addText("az", "", 47, 7).listen(readouts, "az", function (value) {
            this.text = Number.isFinite(value) ? (floor(0.499999+abs(value))) + "° " + (value > 0 ? "R" : "L") : "";
        })

        this.addText("el", "", 8.2, 48.5).listen(readouts, "el", function (value) {
            this.text = Number.isFinite(value) ? (value < 0 ? "-" : " ") + (floor(0.49999+abs(value))) + "°" : "";
        })


        this.addText("rng", "", 72, 31.4).listen(readouts, "rng", function (value) {
            if (Number.isFinite(value) && value > 0 && (!display.trackDriven || readouts.frame >= display.rangeStartFrame))
                this.text = value.toFixed(1) + " RNG";
            else
                this.text = ""
        })

        const trackDriven = this.trackDriven;
        this.addText("Vc", "", 79.5, 41.5).listen(readouts, "Vc", function (value) {
            // Display model: round upward to 10-knot steps. Keep readouts.Vc
            // unquantized for the physical calculation and analysis.
            if (Number.isFinite(value) && (trackDriven || value !== 0) && (!trackDriven || readouts.frame >= display.rangeStartFrame))
                this.text = (Math.ceil(value / 10) * 10).toFixed() + " Vc";
            else
                this.text = ""
        })


        const timeStartMin = v.timeStartMin ?? (this.trackDriven ? 0 : 52);
        const timeStartSec = v.timeStartSec ?? (this.trackDriven ? 0 : 45);
        const startTimeSeconds = 60*timeStartMin + timeStartSec;
        if (!this.trackDriven) par.startTimeSeconds = startTimeSeconds;
        this.addText("time", "....", 45.9, 99.8).listen(readouts, "time", function (value) {
            const sec = floor((trackDriven ? display.timeOffsetSeconds : par.startTimeSeconds) + (value ?? 0));
            this.text = trackDriven && display.timeFormat === "seconds" ? String(sec) : pad(floor(sec/60),2)+pad(sec%60,2);
        })


        this.textAlt1000s = this.addText("alt-1000s", "", 74.7, 96, 4.2)
        this.textAlt000 = this.addText("alt-000", "", 79.3, 95.805, 3.7)

        this.addText("cas", "", 15.5, 93.4).listen(this.airData, "casKnots", function (value) {
            this.text = Number.isFinite(value) ? value.toFixed(0) : "";
        });
        this.addText("mach", "", 13.3, 96.7).listen(this.airData, "mach", function (value) {
            this.text = Number.isFinite(value) ? `M ${value.toFixed(2)}` : "";
        });
        this.addText("blk", "BLK", 14.3, 99.8);
    }


    setAltitude(meters, incrementFeet = 1) {
        if (!Number.isFinite(meters)) {
            this.textAlt1000s.text = this.textAlt000.text = "";
            return;
        }
        const altitude = Math.round(m2f(meters) / incrementFeet) * incrementFeet;
        this.textAlt1000s.text = ""+pad(Math.floor(altitude/1000),2)
        this.textAlt000.text = ""+pad(altitude%1000,3);
    }

    update() {
        if (!this.trackDriven) this.setAltitude(this.in.jetAltitude?.v0);
    }

    updateAirData(frame, track, row, altitudeMSL) {
        const wind = NodeMan.get("localWind", false);
        const velocity = trackAirVelocity(track, wind, frame, Sit.frames, Sit.fps, Sit.simSpeed ?? 1);
        // A legacy jet's configured TAS is already air-relative. For a custom
        // reconstruction, derive TAS from the actual selected track minus wind.
        const jetTAS = !this.trackDriven ? (this.in.jetTAS ?? NodeMan.get("jetTAS", false))?.v(frame) : null;
        const tasMPS = Number.isFinite(jetTAS) ? jetTAS * KNOT_MPS : velocity?.length() ?? null;
        const profile = this.in.atmosphere?.getAtAltitude(altitudeMSL);
        const isa = standardAtmosphere(altitudeMSL);
        const pressureHpa = telemetryNumber(row?.[MISB.StaticPressure]) ?? telemetryNumber(profile?.pressure);
        const temperatureC = telemetryNumber(row?.[MISB.OutsideAirTemperature]) ?? telemetryNumber(profile?.temp);
        const pressurePa = pressureHpa > 0 ? pressureHpa * 100 : isa?.pressurePa;
        const temperatureK = temperatureC !== null && temperatureC > -273.15 ? temperatureC + 273.15 : isa?.temperatureK;
        this.airData ??= {};
        Object.assign(this.airData, airDataFromTAS(tasMPS, pressurePa, temperatureK), {
            tasMPS, pressurePa, temperatureK,
            speedSource: Number.isFinite(jetTAS) ? "configured TAS" : wind ? "track minus local wind" : "track, zero wind assumed",
            pressureSource: pressureHpa > 0 ? "metadata/profile" : "standard atmosphere",
            temperatureSource: temperatureC !== null && temperatureC > -273.15 ? "metadata/profile" : "standard atmosphere",
        });
    }

    addText(key, text, x, y, size, color, align, font) {
        return super.addText(key, text, x, y, (size ?? this.defaultFontSize) * TEXT_SCALE, color, align, font);
    }

    drawText(text, x, y) {
        this.ctx.save();
        // Scale the displayed RGB values, keeping glyphs opaque over the image.
        this.ctx.fillStyle = "#" + textColor.setStyle(this.ctx.fillStyle, LinearSRGBColorSpace)
            .multiplyScalar(TEXT_BRIGHTNESS).getHexString(LinearSRGBColorSpace);
        drawHUDText(this.ctx, text, x, y, parseFloat(this.ctx.font));
        this.ctx.restore();
    }

    updateTrackReadouts(frame) {
        this.readouts.frame = frame;
        // Custom setup precedes legacy Sit.setup(), so resolve tracks lazily.
        if (!this.in.cameraTrack) {
            const id = ["cameraTrackSwitchSmooth", "cameraTrackSwitch", "jetTrack", "cameraTrack"]
                .find(id => NodeMan.exists(id));
            if (id) this.addInput("cameraTrack", id);
        }
        if (!this.in.target) {
            const id = ["targetTrackSwitchSmooth", "targetTrackSwitch", "targetTrack"]
                .find(id => NodeMan.exists(id));
            if (id) this.addInput("target", id);
        }
        const camera = this.in.camera.camera;
        camera.updateMatrixWorld();
        const forward = new Vector3().setFromMatrixColumn(camera.matrixWorld, 2).negate();
        const track = this.in.cameraTrack;
        const row = track ? getTrackMISBRow(track, frame) : null;
        let heading = telemetryNumber(row?.[MISB.PlatformHeadingAngle]);
        if (heading === null && track) {
            const [a, b] = trackFrameSpan(frame, Sit.frames);
            if (b > a) {
                const position = track.p(frame);
                const velocity = track.p(b).clone().sub(track.p(a)).divideScalar(b - a);
                const wind = NodeMan.get("localWind", false)?.getValueFrame(frame, position);
                heading = airframeHeadingFromVelocity(position, velocity, wind);
            }
        }
        const bearing = degrees(getCompassHeading(camera.position, forward, camera));
        this.readouts.az = heading === null ? null : ((bearing - heading + 540) % 360) - 180;
        this.readouts.el = getAzElFromPositionAndForward(camera.position, forward)[1];
        const target = this.in.target;
        this.readouts.rng = target ? camera.position.distanceTo(target.p(frame)) / 1852 : null;
        // The target marker follows the projected track. A centered marker is a
        // consequence of the camera pointing at it, not a claim of tracker lock.
        this.targetMarker = target && frame >= (this.targetMarkerStartFrame ?? 0) ? target.p(frame).clone().project(camera) : null;
        this.readouts.Vc = closingSpeedKnots(track, target, frame, Sit.frames, Sit.fps, Sit.simSpeed ?? 1);
        this.readouts.time = frame * (Sit.simSpeed ?? 1) / Sit.fps;
        // The aircraft bank indicator is independent of the camera image roll.
        // Without recorded platform roll, leave the moving horizon arms absent.
        this.bank = telemetryNumber(row?.[MISB.PlatformRollAngle]);
        const lla = ECEFToLLAVD_radii(camera.position);
        const altitudeMSL = lla.z - meanSeaLevelOffset(lla.x, lla.y);
        this.updateAirData(frame, track, row, altitudeMSL);
        const pressureAltitude = this.airData.pressureSource === "metadata/profile"
            ? pressureAltitudeFromPressure(this.airData.pressurePa) : null;
        this.readouts.altitudeSource = pressureAltitude === null ? "MSL height" : "pressure altitude";
        this.readouts.altitudeMeters = pressureAltitude ?? altitudeMSL;
        this.setAltitude(this.readouts.altitudeMeters, pressureAltitude === null ? 1 : 10);
        // FOV alone cannot identify a sensor's optical/digital zoom mode.
        this.textElements.fov.text = "FOV";
        this.textElements.zoom.text = `${camera.fov.toFixed(3)}°`;
    }

    px(x) {
        return this.hudRect ? this.hudRect.x + this.hudRect.width * x / 100 : super.px(x);
    }

    py(y) {
        return this.hudRect ? this.hudRect.y + this.hudRect.height * y / 100 : super.py(y);
    }

    sx(x) {
        return this.hudRect ? this.hudRect.width * x / 100 : super.sx(x);
    }

    // Render for CNodeATFLIRUI
    renderCanvas(frame) {
        if (!this.visible) return;
        if (this.overlayView && !this.overlayView.visible) return;
        if (this.trackDriven) {
            this.updateTrackReadouts(frame);
            this.hudRect = getHUDImageRect(this.widthPx, this.heightPx,
                NodeMan.get("mirrorVideo", false) ?? NodeMan.get("video", false), 1);
        } else {
            const track = this.in.cameraTrack ?? NodeMan.get("jetTrack", false);
            this.updateAirData(frame, track, track ? getTrackMISBRow(track, frame) : null, this.in.jetAltitude?.v0);
        }
        // The bundled font has different advances from sans-serif. Place the
        // smaller altitude digits after the actual prefix, without overlap.
        this.ctx.font = `${Math.floor(this.sx(this.textAlt1000s.size * 100))}px ${MQ9_FONT}`;
        this.textAlt000.x = this.textAlt1000s.x + this.ctx.measureText(this.textAlt1000s.text).width / this.sx(100);
        super.renderCanvas(frame)

        const bank = this.trackDriven ? this.bank : NodeMan.get("bank", false)?.v(frame);
        const a = radians(bank ?? 0);
        const c = this.ctx

        c.strokeStyle = this.trackDriven ? getHUDColor() : '#FFFFFF';
        // Scale the vector strokes with the source image, so RS-170 filtering
        // receives the same symbology proportions at any viewport/export size.
        c.lineWidth = this.sx(0.25);
        c.strokeRect(this.px(58.6), this.py(0.25), this.sx(15.4), this.py(3.6) - this.py(0.25));
        c.beginPath();
        this.moveTo(93.9, 1.8);
        this.lineTo(95.6, 4.0);
        this.lineTo(97.3, 1.8);
        c.stroke();

        const marker = this.targetMarker;
        if (marker && Math.abs(marker.x) < 1 && Math.abs(marker.y) < 1 && marker.z >= -1 && marker.z <= 1) {
            const x = (marker.x + 1) * 50, y = (1 - marker.y) * 50;
            c.beginPath();
            for (const sign of [-1, 1]) {
                this.moveTo(x + sign * 1.5, y - 1.2);
                this.lineTo(x + sign * 1.5, y + 1.2);
                this.moveTo(x + sign * 1.5, y);
                this.lineTo(x + sign * .6, y);
            }
            c.stroke();
        }
        const r = 1.6 // radius of small circle
        const k = 4 // length of spike
        const k_top = 3 // length of spike
        c.beginPath();
        c.arc(this.px(this.cx), this.py(this.cy), this.sx(r), 0, 2 * Math.PI)

        c.moveTo(this.px(this.cx - r), this.py(this.cy))
        c.lineTo(this.px(this.cx - r - k), this.py(this.cy))

        c.moveTo(this.px(this.cx + r), this.py(this.cy))
        c.lineTo(this.px(this.cx + r + k), this.py(this.cy))

        c.moveTo(this.px(this.cx), this.py(this.cy) - this.sx(r))
        c.lineTo(this.px(this.cx), this.py(this.cy - k_top) - this.sx(r))  // px(r) in the y as we scale r by x for arc

        c.stroke();

        if (!Number.isFinite(bank)) return;

        var o = 6.7 // offset of start of line from middle
        var l = 13 // length of line
        var d = 3 // lenght of small line at the end
        c.beginPath()
        this.rLine(this.cx - o, this.cy, this.cx - o - l, this.cy,a)
        this.rLineTo(c,this.cx - o - l, this.cy + d,a)
        this.rLine(this.cx + o, this.cy, this.cx + o + l, this.cy,a)
        this.rLineTo(c,this.cx + o + l, this.cy + d,a)
        c.stroke()
    }




}
