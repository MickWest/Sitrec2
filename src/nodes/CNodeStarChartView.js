// CNodeStarChartView - a Heavens-Above style whole-sky star chart view.
//
// Draws the visible hemisphere as an azimuthal-equidistant disk: zenith at the
// center, horizon at the edge, north up, and EAST ON THE LEFT - the mirror
// convention every printed finder chart uses, because the chart is meant to be
// held overhead and compared to the sky. Stars come from the loaded BSC
// catalog (via the night sky node's CStarField), constellation lines and names
// from the d3-celestial GeoJSON files, planets from astronomy-engine, and
// optionally the track of the "Satellite to Track" node with time labels in
// the boxed per-minute format of heavens-above.com charts.
//
// The chart is drawn for the current frame's date/time and the look camera's
// location, so it stays consistent with the 3D night sky rendering.

import {CNodeTabbedCanvasView} from "./CNodeTabbedCanvasView";
import {FileManager, GlobalDateTimeNode, guiShowHide, NodeMan, setRenderOne} from "../Globals";
import {par} from "../par";
import {ECEFToLLAVD_radii} from "../LLA-ECEF-ENU";
import {getAzElFromPositionAndForward} from "../SphericalMath";
import {degrees, radians} from "../utils";
import {applyAnnualAberration, getEQJToECEFMatrix} from "../CelestialMath";
import {V3} from "../threeUtils";
import * as Astronomy from "astronomy-engine";

// Named color schemes for the chart. "Heavens-Above" mimics the pale blue
// surround / white disk / black stars of heavens-above.com finder charts.
const starChartSchemes = {
    "Lavendar": {
        outer: "#D3D9F0", disk: "#FFFFFF", edge: "#000050",
        tick: "#000050", azLabel: "#000050", cardinal: "#8890AC",
        star: "#000000", constLine: "#BBBBBB", constName: "#999999",
        planet: "#000000", planetLabel: "#2222DD",
        track: "#000000", timeBox: "#FFFFFF", timeBoxEdge: "#000000", timeText: "#000000",
    },
    "Black": {
        outer: "#000000", disk: "#000000", edge: "#888888",
        tick: "#888888", azLabel: "#AAAAAA", cardinal: "#CCCCCC",
        star: "#FFFFFF", constLine: "#454560", constName: "#8888AA",
        planet: "#FFFFFF", planetLabel: "#88CCFF",
        track: "#FFD34D", timeBox: "#000000", timeBoxEdge: "#FFD34D", timeText: "#FFD34D",
    },
    "Night Vision": {
        outer: "#000000", disk: "#000000", edge: "#802020",
        tick: "#802020", azLabel: "#B03030", cardinal: "#C04040",
        star: "#FF5050", constLine: "#601818", constName: "#A03030",
        planet: "#FF6060", planetLabel: "#FF8080",
        track: "#FF4040", timeBox: "#000000", timeBoxEdge: "#FF4040", timeText: "#FF5050",
    },
    "White": {
        outer: "#FFFFFF", disk: "#FFFFFF", edge: "#000000",
        tick: "#000000", azLabel: "#000000", cardinal: "#666666",
        star: "#000000", constLine: "#BBBBBB", constName: "#999999",
        planet: "#000000", planetLabel: "#000000",
        track: "#000000", timeBox: "#FFFFFF", timeBoxEdge: "#000000", timeText: "#000000",
    },
};

const defaultScheme = "White";

// Naked-eye bodies, with dot radii (px at a 400px chart radius) roughly
// following apparent brightness. Sun/Moon drawn as disks, not magnitudes.
const chartBodies = ["Mercury", "Venus", "Mars", "Jupiter", "Saturn", "Sun", "Moon"];
const chartBodyRadius = {Sun: 7, Moon: 7, Venus: 4.5, Jupiter: 4, Saturn: 3.2, Mars: 3, Mercury: 2.6};

export class CNodeStarChartView extends CNodeTabbedCanvasView {
    constructor(v) {
        v.menuName = 'Star Chart';
        super(v);

        this.nightSkyNode = v.nightSkyNode;

        this.colorScheme = v.colorScheme ?? defaultScheme;
        this.showSatelliteTrack = v.showSatelliteTrack ?? true;
        this.magLimit = v.magLimit ?? 5.5;
        this.addSimpleSerial("colorScheme");
        this.addSimpleSerial("showSatelliteTrack");

        // signature of the last drawn chart, so a render pass that changes
        // nothing the chart depends on doesn't redraw ~3000 star dots
        this._lastSignature = null;

        this.guiFolder = guiShowHide.addFolder("Star Chart").close()
            .tooltip("Whole-sky star chart (Heavens-Above style) for the current time and camera location");
        this.guiFolder.add(this, "visible").listen().name("Show Star Chart")
            .onChange(value => {
                this.visible = undefined; // force setVisible to apply
                this.setVisible(value);
                setRenderOne(true);
            })
            .tooltip("Show or hide the star chart view");
        this.guiFolder.add(this, "colorScheme", Object.keys(starChartSchemes)).listen().name("Color Scheme")
            .onChange(() => setRenderOne(true))
            .tooltip("Color scheme for the star chart");
        this.guiFolder.add(this, "showSatelliteTrack").listen().name("Satellite Track")
            .onChange(() => setRenderOne(true))
            .tooltip("Plot the track of the 'Satellite to Track' across the chart, with times");
    }

    dispose() {
        if (this.guiFolder) {
            this.guiFolder.destroy();
            this.guiFolder = null;
        }
        super.dispose();
    }

    applyPendingResize() {
        // resizing the backing store clears the canvas, so the skip-redraw
        // signature must not survive it (covers forceContextRescale too)
        if (this._pendingCanvasResize) this._lastSignature = null;
        super.applyPendingResize();
    }

    // Stricter than the base class (which allows half the view offscreen):
    // the chart is a single circular graphic, so keep it entirely visible.
    // This also rescues the default placement on 4:3 and narrower windows,
    // where a square sized from the window height overflows the right edge.
    // left/top are relative to the view's parent container, so clamp against
    // that container's size, not the window's - they differ when views live
    // in an inset, overflow-hidden content area.
    constrainToScreen(left, top) {
        const rect = this.div.getBoundingClientRect();
        const parent = this.div.parentElement;
        const pw = parent?.clientWidth || window.innerWidth;
        const ph = parent?.clientHeight || window.innerHeight;
        return {
            left: Math.min(Math.max(left, 0), Math.max(0, pw - rect.width)),
            top: Math.min(Math.max(top, 0), Math.max(0, ph - rect.height)),
        };
    }

    // azimuthal equidistant projection: r = R at the horizon, 0 at the zenith,
    // az clockwise from north with east on the LEFT (sky-chart mirror)
    _project(cx, cy, R, azRad, elDeg) {
        const r = R * (90 - elDeg) / 90;
        return [cx - r * Math.sin(azRad), cy - r * Math.cos(azRad)];
    }

    _formatTime(ms, tzOffsetHours, withSeconds) {
        const d = new Date(ms + tzOffsetHours * 3600000);
        const p2 = n => String(n).padStart(2, "0");
        let s = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
        if (withSeconds) s += `:${p2(d.getUTCSeconds())}`;
        return s;
    }

    renderCanvas(frame) {
        super.renderCanvas(frame);
        if (!this.visible || !this.ctx) return;

        const w = this.widthPx, h = this.heightPx;
        if (!w || !h) return;

        const nightSky = this.nightSkyNode;
        const cameraNode = NodeMan.get("lookCamera", false);
        if (!nightSky || !cameraNode) return;

        const scheme = starChartSchemes[this.colorScheme] ?? starChartSchemes[defaultScheme];
        const date = GlobalDateTimeNode.frameToDate(par.frame);
        const cameraPos = cameraNode.camera.position;
        const lla = ECEFToLLAVD_radii(cameraPos); // degrees lat/lon, meters alt

        let satNode = this.showSatelliteTrack ? NodeMan.get("satelliteTrack", false) : null;
        if (satNode) satNode.ensureRecalculated();
        if (satNode && (!satNode.norad || !satNode.array || satNode.array.length < 2)) satNode = null;

        // the endpoints stand in for the whole track: a new TLE or satellite
        // moves them, and norad/length catch the rest
        const satSig = satNode
            ? `${satNode.norad}/${satNode.array.length}/${satNode.array[0]?.position?.x ?? 0}/${satNode.array[satNode.array.length - 1]?.position?.x ?? 0}`
            : "none";
        const signature = [w, h, this.devicePixelRatio, this.colorScheme, this.magLimit,
            date.getTime(), lla.x.toFixed(4), lla.y.toFixed(4), lla.z.toFixed(0),
            GlobalDateTimeNode.getTimeZoneOffset(),
            nightSky.starField?.BSC_NumStars ?? 0, nightSky.constellationStyle, satSig,
        ].join("|");
        if (signature === this._lastSignature) return;
        this._lastSignature = signature;

        const cx = w / 2, cy = h / 2;
        const margin = Math.max(34, Math.min(w, h) * 0.055);
        const R = Math.min(w, h) / 2 - margin;
        if (R < 20) return;

        const latRad = radians(lla.x), lonRad = radians(lla.y);
        const azEl = this._makeAzElProjector(date, latRad, lonRad);

        const ctx = this.ctx;
        ctx.save();

        ctx.fillStyle = scheme.outer;
        ctx.fillRect(0, 0, w, h);
        ctx.beginPath();
        ctx.arc(cx, cy, R, 0, 2 * Math.PI);
        ctx.fillStyle = scheme.disk;
        ctx.fill();

        this._drawAzimuthRing(ctx, cx, cy, R, scheme);

        // everything on the sky clips to the horizon disk, so below-horizon
        // points (which project outside the circle) clip themselves
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, R - 0.5, 0, 2 * Math.PI);
        ctx.clip();

        this._drawConstellations(ctx, cx, cy, R, azEl, scheme);
        this._drawStars(ctx, cx, cy, R, azEl, scheme);
        this._drawPlanets(ctx, cx, cy, R, azEl, lla, date, scheme);
        if (satNode) this._drawSatelliteTrack(ctx, cx, cy, R, satNode, cameraPos, scheme);

        ctx.restore();

        // horizon circle on top of any clipped strokes at the boundary
        ctx.beginPath();
        ctx.arc(cx, cy, R, 0, 2 * Math.PI);
        ctx.strokeStyle = scheme.edge;
        ctx.lineWidth = 1.2;
        ctx.stroke();

        ctx.restore();
    }

    // EQJ (J2000/ICRS) ra/dec in radians -> {az, el} in radians, routed through
    // the SAME EQJ→ECEF matrix the 3D sky is drawn with. Going via ECEF rather
    // than a local-sidereal-time hour angle is what keeps the chart and the sky
    // from disagreeing: sidereal time alone omits precession, which is where the
    // chart's old ~0.4° offset against the terrain came from.
    // `aberrate` is opt-in per call: catalog stars and the constellation lines
    // drawn between them need annual aberration, but the planet positions come
    // from astronomy-engine with aberration already folded in.
    _makeAzElProjector(date, latRad, lonRad) {
        const m = getEQJToECEFMatrix(date);
        const sLat = Math.sin(latRad), cLat = Math.cos(latRad);
        const sLon = Math.sin(lonRad), cLon = Math.cos(lonRad);
        const v = V3();
        return (ra, dec, aberrate = false) => {
            const cd = Math.cos(dec);
            v.set(cd * Math.cos(ra), cd * Math.sin(ra), Math.sin(dec));
            if (aberrate) applyAnnualAberration(v, date);
            v.applyMatrix4(m);
            const e = -sLon * v.x + cLon * v.y;
            const n = -sLat * cLon * v.x - sLat * sLon * v.y + cLat * v.z;
            const u = cLat * cLon * v.x + cLat * sLon * v.y + sLat * v.z;
            let az = Math.atan2(e, n);
            if (az < 0) az += 2 * Math.PI;
            return {az, el: Math.asin(Math.max(-1, Math.min(1, u)))};
        };
    }

    _drawAzimuthRing(ctx, cx, cy, R, scheme) {
        const degFont = Math.max(9, R * 0.030);
        const cardFont = Math.max(12, R * 0.048);

        for (let az = 0; az < 360; az += 10) {
            const a = radians(az);
            const sx = -Math.sin(a), sy = -Math.cos(a); // unit radial, outward

            ctx.beginPath();
            ctx.moveTo(cx + sx * R, cy + sy * R);
            ctx.lineTo(cx + sx * (R + 4), cy + sy * (R + 4));
            ctx.strokeStyle = scheme.tick;
            ctx.lineWidth = 1;
            ctx.stroke();

            // labels lie along the ring, flipped on the lower half so they
            // stay readable
            let rot = -a;
            if (az > 90 && az < 270) rot += Math.PI;
            ctx.save();
            ctx.translate(cx + sx * (R + 7 + degFont * 0.6), cy + sy * (R + 7 + degFont * 0.6));
            ctx.rotate(rot);
            ctx.font = `${degFont}px Arial`;
            ctx.fillStyle = scheme.azLabel;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(az + "°", 0, 0);
            ctx.restore();
        }

        const cardinals = [["N", 0], ["NE", 45], ["E", 90], ["SE", 135], ["S", 180], ["SW", 225], ["W", 270], ["NW", 315]];
        for (const [name, az] of cardinals) {
            const a = radians(az);
            const sx = -Math.sin(a), sy = -Math.cos(a);
            let rot = -a;
            if (az > 90 && az < 270) rot += Math.PI;
            ctx.save();
            ctx.translate(cx + sx * (R + 10 + degFont + cardFont * 0.7), cy + sy * (R + 10 + degFont + cardFont * 0.7));
            ctx.rotate(rot);
            ctx.font = `bold ${cardFont}px Arial`;
            ctx.fillStyle = scheme.cardinal;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(name, 0, 0);
            ctx.restore();
        }
    }

    _drawConstellations(ctx, cx, cy, R, azEl, scheme) {
        // same dataset choice as the 3D night sky's "constellation style" option
        const dataKey = this.nightSkyNode.constellationStyle === "astrometry"
            ? "constellationsLinesAstrometry" : "constellationsLines";
        const lines = FileManager.exists(dataKey) ? FileManager.get(dataKey) : null;
        if (lines?.features) {
            ctx.strokeStyle = scheme.constLine;
            ctx.lineWidth = Math.max(0.6, 0.8 * R / 400);
            ctx.beginPath();
            for (const feature of lines.features) {
                for (const seg of feature.geometry.coordinates) {
                    let prev = null;
                    for (const p of seg) {
                        const {az, el} = azEl(radians(Number(p[0])), radians(Number(p[1])), true);
                        const elDeg = degrees(el);
                        const [x, y] = this._project(cx, cy, R, az, elDeg);
                        // segments fully below the horizon are skipped rather
                        // than clipped: a below-horizon chord can cross the disk
                        if (prev && (prev.elDeg > 0 || elDeg > 0)) {
                            ctx.moveTo(prev.x, prev.y);
                            ctx.lineTo(x, y);
                        }
                        prev = {x, y, elDeg};
                    }
                }
            }
            ctx.stroke();
        }

        const names = FileManager.exists("constellations") ? FileManager.get("constellations") : null;
        if (names?.features) {
            ctx.font = `${Math.max(9, R * 0.030)}px Arial`;
            ctx.fillStyle = scheme.constName;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            for (const feature of names.features) {
                const c = feature.geometry?.coordinates;
                const name = feature.properties?.name;
                if (!c || !name) continue;
                const {az, el} = azEl(radians(Number(c[0])), radians(Number(c[1])));
                const elDeg = degrees(el);
                if (elDeg < 2) continue;
                const [x, y] = this._project(cx, cy, R, az, elDeg);
                ctx.fillText(name, x, y);
            }
        }
    }

    _drawStars(ctx, cx, cy, R, azEl, scheme) {
        const sf = this.nightSkyNode.starField;
        if (!sf || !sf.BSC_NumStars) return;

        ctx.fillStyle = scheme.star;
        const sizeScale = R / 400;
        for (let i = 0; i < sf.BSC_NumStars; i++) {
            const mag = sf.BSC_MAG[i];
            if (mag > this.magLimit) continue;
            const {az, el} = azEl(sf.BSC_RA[i], sf.BSC_DEC[i], true);
            const elDeg = degrees(el);
            if (elDeg < -1) continue;
            const [x, y] = this._project(cx, cy, R, az, elDeg);
            // printed-chart convention: dot radius shrinks linearly with magnitude
            const r = Math.max(0.4, (0.5 + 0.55 * (this.magLimit - mag)) * sizeScale);
            ctx.beginPath();
            ctx.arc(x, y, r, 0, 2 * Math.PI);
            ctx.fill();
        }
    }

    _drawPlanets(ctx, cx, cy, R, azEl, lla, date, scheme) {
        const observer = new Astronomy.Observer(lla.x, lla.y, lla.z);
        const labelFont = Math.max(9, R * 0.030);
        ctx.font = `${labelFont}px Arial`;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";

        for (const body of chartBodies) {
            let eq;
            try {
                // J2000 (ofdate=false), matching CPlanets and getCelestialDirection.
                // The precession to the equator of date lives in the EQJ→ECEF
                // matrix the projector applies, so asking for of-date coordinates
                // here as well would apply it twice.
                eq = Astronomy.Equator(body, date, observer, false, true);
            } catch {
                continue;
            }
            const {az, el} = azEl(eq.ra * Math.PI / 12, radians(eq.dec));
            const elDeg = degrees(el);
            if (elDeg < -0.5) continue;
            const [x, y] = this._project(cx, cy, R, az, elDeg);
            const r = chartBodyRadius[body] * R / 400;

            ctx.beginPath();
            ctx.arc(x, y, r, 0, 2 * Math.PI);
            if (body === "Sun") {
                // open disk so the Sun reads differently from the Moon
                ctx.strokeStyle = scheme.planet;
                ctx.lineWidth = 1.5;
                ctx.stroke();
            } else {
                ctx.fillStyle = scheme.planet;
                ctx.fill();
            }
            ctx.fillStyle = scheme.planetLabel;
            ctx.fillText(body, x + r + 3, y);
        }
    }

    _drawSatelliteTrack(ctx, cx, cy, R, satNode, cameraPos, scheme) {
        const frames = satNode.array.length;

        const projectFrame = (f) => {
            const pos = satNode.array[f]?.position;
            if (!pos) return null;
            const toSat = pos.clone().sub(cameraPos).normalize();
            const [azDeg, elDeg] = getAzElFromPositionAndForward(cameraPos, toSat);
            const [x, y] = this._project(cx, cy, R, radians(azDeg), elDeg);
            return {x, y, elDeg};
        };

        // sample the track sparsely - a LEO satellite moves smoothly, and 720
        // samples are indistinguishable from per-frame at chart resolution
        const step = Math.max(1, Math.floor(frames / 720));
        const pts = [];
        for (let f = 0; f < frames; f += step) pts.push(projectFrame(f));
        if ((frames - 1) % step !== 0) pts.push(projectFrame(frames - 1));

        ctx.strokeStyle = scheme.track;
        ctx.lineWidth = Math.max(1, 1.3 * R / 400);
        ctx.beginPath();
        let lastAbove = null; // last sample above the horizon, for the arrowhead
        let prevAbove = null; // the sample before it, for the arrow direction
        for (let i = 1; i < pts.length; i++) {
            const a = pts[i - 1], b = pts[i];
            if (!a || !b) continue;
            // both endpoints below the horizon: the segment is off-chart, and
            // drawing it risks a spurious chord across the disk
            if (a.elDeg <= 0 && b.elDeg <= 0) continue;
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            if (b.elDeg > 0) {
                prevAbove = a;
                lastAbove = b;
            }
        }
        ctx.stroke();

        if (lastAbove && prevAbove) {
            const ang = Math.atan2(lastAbove.y - prevAbove.y, lastAbove.x - prevAbove.x);
            const ah = Math.max(6, 9 * R / 400);
            ctx.beginPath();
            ctx.moveTo(lastAbove.x, lastAbove.y);
            ctx.lineTo(lastAbove.x - ah * Math.cos(ang - 0.4), lastAbove.y - ah * Math.sin(ang - 0.4));
            ctx.moveTo(lastAbove.x, lastAbove.y);
            ctx.lineTo(lastAbove.x - ah * Math.cos(ang + 0.4), lastAbove.y - ah * Math.sin(ang + 0.4));
            ctx.stroke();
        }

        this._drawTrackTimes(ctx, cx, cy, R, satNode, cameraPos, scheme);
    }

    // boxed time labels at round local-time boundaries along the track,
    // drawn perpendicular to the track like heavens-above.com charts
    _drawTrackTimes(ctx, cx, cy, R, satNode, cameraPos, scheme) {
        const frames = satNode.array.length;
        const t0 = GlobalDateTimeNode.frameToDate(0).getTime();
        const t1 = GlobalDateTimeNode.frameToDate(frames - 1).getTime();
        if (!(t1 > t0)) return;

        // label at round boundaries, aiming for ~8 labels over the sitch
        // duration (the 24h ladder top loosens this for multi-day spans)
        const durS = (t1 - t0) / 1000;
        const intervals = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 21600, 43200, 86400];
        let interval = intervals[intervals.length - 1];
        for (const iv of intervals) {
            if (durS / iv <= 8) {
                interval = iv;
                break;
            }
        }
        const withSeconds = interval < 60;
        const tzOffset = GlobalDateTimeNode.getTimeZoneOffset(); // hours

        const projectAtTime = (T) => {
            // frameToDate is linear in frame, so invert it by interpolation
            const f = (T - t0) / (t1 - t0) * (frames - 1);
            const f0 = Math.floor(f), f1 = Math.min(frames - 1, f0 + 1);
            const pos0 = satNode.array[f0]?.position;
            const pos1 = satNode.array[f1]?.position;
            if (!pos0 || !pos1) return null;
            const pos = pos0.clone().lerp(pos1, f - f0);
            const toSat = pos.sub(cameraPos).normalize();
            const [azDeg, elDeg] = getAzElFromPositionAndForward(cameraPos, toSat);
            const [x, y] = this._project(cx, cy, R, radians(azDeg), elDeg);
            return {x, y, elDeg};
        };

        const fontPx = Math.max(8, R * 0.026);
        const ivMs = interval * 1000;
        const tzMs = tzOffset * 3600000;
        // align tick times to round boundaries in LOCAL time
        const firstTick = Math.ceil((t0 + tzMs) / ivMs) * ivMs - tzMs;

        for (let T = firstTick; T <= t1; T += ivMs) {
            const p = projectAtTime(T);
            if (!p || p.elDeg < 1) continue;
            // tangent from a short time step, for the label normal
            const q = projectAtTime(Math.min(t1, T + Math.max(1000, ivMs / 10)));
            if (!q) continue;
            let tx = q.x - p.x, ty = q.y - p.y;
            const tl = Math.hypot(tx, ty);
            if (tl < 1e-6) continue;
            tx /= tl;
            ty /= tl;
            // normal pointing downward on screen, so boxes hang below the track
            let nx = -ty, ny = tx;
            if (ny < 0) {
                nx = -nx;
                ny = -ny;
            }

            const timeStr = this._formatTime(T, tzOffset, withSeconds);
            ctx.font = `${fontPx}px Arial`;
            const bw = ctx.measureText(timeStr).width + 6;
            const bh = fontPx + 5;

            // small tick from the track to the box
            ctx.strokeStyle = scheme.track;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p.x + nx * 4, p.y + ny * 4);
            ctx.stroke();

            // box elongated along the normal, text kept upright
            let ang = Math.atan2(ny, nx);
            if (ang > Math.PI / 2 || ang < -Math.PI / 2) ang += Math.PI;
            const dist = 5 + bw / 2;
            ctx.save();
            ctx.translate(p.x + nx * dist, p.y + ny * dist);
            ctx.rotate(ang);
            ctx.fillStyle = scheme.timeBox;
            ctx.fillRect(-bw / 2, -bh / 2, bw, bh);
            ctx.strokeStyle = scheme.timeBoxEdge;
            ctx.lineWidth = 1;
            ctx.strokeRect(-bw / 2, -bh / 2, bw, bh);
            ctx.fillStyle = scheme.timeText;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(timeStr, 0, 1);
            ctx.restore();
        }
    }
}
