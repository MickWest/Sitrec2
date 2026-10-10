// Milliradian ranging reticle and clock, as drawn by a handheld thermal imager's
// on-screen display. The reticle is drawn from the look camera's field of view and
// the look view's magnification (Video Zoom), so its ticks stay true milliradians at
// any zoom, and an object's size or offset can be read off it the same way as on the
// real display. Its settings are in View > Reticle OSD, shown while the view is on.
//
// The layout (tick lengths, label and clock placement, the 2x pixel doubling) was
// measured from 1280x960 stills of a 640x480 sensor. Sizes below are in those
// 1280x960 image pixels and are scaled to the video image on screen.
import {CNodeViewUI} from "./CNodeViewUI";
import {GlobalDateTimeNode, Globals, guiMenus, NodeMan, setRenderOne} from "../Globals";
import {getHUDImageRect} from "../HUDImageRect";
import {formatReticleClock, parseReticleClock} from "../ReticleClock";
import {pixelsPerMrad, reticleForImage} from "../ReticleScale";
import {viewMagnification} from "../rendering/ViewRenderMode";
import {t} from "../i18n";

const REF_HEIGHT = 960;            // reference image height the sizes below are measured in

const LINE_WIDTH = 2;              // one sensor pixel
const MINOR_TICK = 6;              // half-length of a 1 mrad tick
const MAJOR_TICK = 10;             // half-length of a 5 mrad tick and of the end caps
const LABEL_FONT = 26;             // digits about 19 px tall
const LABEL_BASELINE = 33;         // below the horizontal bar

const CLOCK_FONT = 33;             // bold, digits about 24 px tall
const CLOCK_X = 20;
const CLOCK_WIDTH = 335;           // the display's wide digits; the text is stretched to fit
const CLOCK_BASELINE = 930;
const CLOCK_BOX = {x: 10, y: 892, width: 352, height: 52, alpha: 0.12};

export class CNodeMradReticleUI extends CNodeViewUI {

    constructor(v) {
        super(v);
        this.input("camera");
        this.doubleClickFullScreen = false;

        this.showClock = v.showClock ?? true;
        // The camera clock reading at the sitch start. Empty shows the sitch's own
        // local time; a value reproduces a camera whose clock was never set.
        this.clockStart = v.clockStart ?? "";
        this.addSimpleSerial("showClock");
        this.addSimpleSerial("clockStart");

        this.setupMenu();
    }

    setupMenu() {
        if (!guiMenus.view) return;
        const menu = this.menu = guiMenus.view.addFolder(t("mradReticle.folder")).close();
        menu.add(this, "showClock").name(t("mradReticle.showClock.label")).listen().onChange(() => setRenderOne(true))
            .tooltip(t("mradReticle.showClock.tooltip"));
        menu.add(this, "clockStart").name(t("mradReticle.clockStart.label")).listen().onFinishChange(() => setRenderOne(true))
            .tooltip(t("mradReticle.clockStart.tooltip"));
        menu.show(this.visible);
    }

    setVisibleRaw(visible) {
        super.setVisibleRaw(visible);
        this.menu?.show(this.visible);
    }

    clockText() {
        const dt = GlobalDateTimeNode;
        if (!dt?.dateNow || !dt.dateStart) return null;
        const tz = dt.getTimeZoneOffset() * 3600000;
        let ms = dt.dateNow.getTime() + tz;
        const start = parseReticleClock(this.clockStart);
        if (start !== null) ms += start - (dt.dateStart.getTime() + tz);
        return formatReticleClock(ms);
    }

    renderCanvas(frame) {
        if (this.overlayView && !this.overlayView.visible) return;
        super.renderCanvas(frame);
        if (!this.visible) return;

        const camera = this.in.camera.camera;
        const rect = getHUDImageRect(this.widthPx, this.heightPx,
            NodeMan.get("mirrorVideo", false) ?? NodeMan.get("video", false), 4 / 3);
        const k = rect.height / REF_HEIGHT;   // screen pixels per reference image pixel

        // The reticle center is the boresight, which is the center of the view. The look
        // view draws the scene larger than camera.fov when the video is zoomed.
        const magnification = viewMagnification(this.in.relativeTo, frame, Globals.renderDebugFlags.dbg_renderEffects);
        const pxPerMrad = pixelsPerMrad(this.heightPx, camera.fov, magnification);
        const reticle = reticleForImage(rect.width, pxPerMrad);

        const c = this.ctx;
        c.save();
        c.strokeStyle = c.fillStyle = "#FFFFFF";
        c.lineWidth = Math.max(1, LINE_WIDTH * k);
        this.drawReticle(c, reticle, this.widthPx / 2, this.heightPx / 2, pxPerMrad, k);
        if (this.showClock) this.drawClock(c, rect, k);
        c.restore();
    }

    // Tick positions along one arm (in mrad) with their half-lengths: every
    // minorStep, long at each majorStep, and always a long cap at the end.
    armTicks(r, end, k) {
        const ticks = [];
        if (r.minorStep) {
            for (let m = r.minorStep; m < end; m += r.minorStep) {
                ticks.push([m, (r.majorStep && m % r.majorStep === 0 ? MAJOR_TICK : MINOR_TICK) * k]);
            }
        }
        ticks.push([end, MAJOR_TICK * k]);
        return ticks;
    }

    drawReticle(c, r, x0, y0, s, k) {
        c.beginPath();
        // horizontal bar, ticks across it
        c.moveTo(x0 - r.left * s, y0);
        c.lineTo(x0 + r.right * s, y0);
        for (const [sign, end] of [[-1, r.left], [1, r.right]]) {
            for (const [m, t] of this.armTicks(r, end, k)) {
                const x = x0 + sign * m * s;
                c.moveTo(x, y0 - t);
                c.lineTo(x, y0 + t);
            }
        }
        // vertical bar (up is -y on the canvas), ticks across it
        c.moveTo(x0, y0 - r.up * s);
        c.lineTo(x0, y0 + r.down * s);
        for (const [sign, end] of [[-1, r.up], [1, r.down]]) {
            for (const [m, t] of this.armTicks(r, end, k)) {
                const y = y0 + sign * m * s;
                c.moveTo(x0 - t, y);
                c.lineTo(x0 + t, y);
            }
        }
        c.stroke();

        c.font = `${Math.round(LABEL_FONT * k)}px sans-serif`;
        c.textAlign = "center";
        c.textBaseline = "alphabetic";
        for (const label of r.labels) {
            for (const sign of [-1, 1]) {
                c.fillText(String(label), x0 + sign * label * s, y0 + LABEL_BASELINE * k);
            }
        }
    }

    drawClock(c, rect, k) {
        const text = this.clockText();
        if (!text) return;
        const box = CLOCK_BOX;
        c.fillStyle = `rgba(0,0,0,${box.alpha})`;
        c.fillRect(rect.x + box.x * k, rect.y + box.y * k, box.width * k, box.height * k);
        c.fillStyle = "#FFFFFF";
        c.font = `bold ${Math.round(CLOCK_FONT * k)}px sans-serif`;
        c.textAlign = "left";
        c.textBaseline = "alphabetic";
        const measured = c.measureText(text).width;
        c.translate(rect.x + CLOCK_X * k, rect.y + CLOCK_BASELINE * k);
        if (measured > 0) c.scale(CLOCK_WIDTH * k / measured, 1);
        c.fillText(text, 0, 0);
    }

    dispose() {
        this.menu?.destroy();
        super.dispose();
    }
}
