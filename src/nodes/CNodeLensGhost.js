// CNodeLensGhost - simulates a lens-flare / sun-ghost disc as an overlay on a video view.
//
// Physical model
// --------------
// In a catadioptric (mirror) telescope behind a flat window - e.g. the MTS turret
// on an MQ-9 - a bright source (the Sun) produces an internal reflection ("ghost").
// The ghost is the image of the source reflected through the optical centre, scaled
// by a magnification that comes from the curved mirror(s) in the reflection path and
// (anisotropically) from the tilt of the flat front window. It is defocused into a
// disc the size of the aperture cone, with an optional dark centre from the secondary
// mirror's central obstruction.
//
// So the ghost's screen position depends on the SUN direction relative to the camera
// boresight, NOT on the scene. As the turret slews, the ghost tracks the Sun's
// position in the frame - decoupled from (and able to reverse against) the background
// cloud motion. See the Pr055 "disc in the clouds" analysis.
//
// Geometry (all in original-video pixels, square pixels, principal point at frame centre):
//
//   los   = cameraLOSNode.getValueFrame(f)   -> {position, heading, up, right}
//   s     = getCelestialDirection(body)      -> unit vector in ECEF
//   sf,sr,su = s.heading, s.right, s.up      (components in the camera basis, roll included)
//   fpx   = origH / (2 tan(vFOV/2)) / fovCoverage    (matches CNodeTrackingOverlay)
//   sunX  = origW/2 + fpx * sr/sf            (where the Sun itself would image)
//   sunY  = origH/2 - fpx * su/sf
//   --- flat front window (tilted by windowLean about the right axis) ---
//   n     = (0, sin lean, cos lean)          window normal in (right,up,heading)
//   r     = s - 2(s·n) n                      reflect the sun direction off the window
//   reflX = origW/2 + fpx * r·right / r·heading   (the "virtual sun" image; at lean=0 this
//   reflY = origH/2 - fpx * r·up    / r·heading    is the mirror of the sun through centre)
//   --- curved-mirror magnification about the principal point ---
//   pX,pY = origW/2 + centerOffsetX, origH/2 + centerOffsetY   (principal point)
//   ghostX = pX - magX * (reflX - pX)        (anisotropic magnification of the reflection)
//   ghostY = pY - magY * (reflY - pY)
//
// The model is linear in the source image position, so "Fit to Disc Track" recovers
// magX, magY and the principal point with two 1-D least-squares fits against a manual
// CNodeTrackingOverlay track of the disc.
//
// COMMUNICATION: because this tool makes a falsifiable claim ("that disc is a sun
// ghost"), it surfaces its assumptions on-screen: an HUD with the source geometry,
// fit quality, and roll provenance; a drawn reflection line (source -> optical centre
// -> ghost); a "PREDICTED" label; and plain-language warnings (stabilized video, sun
// behind camera, magX~=-1 degeneracy, roll double-count, no track). Nothing that
// affects the result should live only in the console.

import {CNodeViewUI} from "./CNodeViewUI";
import {NodeMan, guiMenus, GlobalDateTimeNode, setRenderOne} from "../Globals";
import {par} from "../par";
import {assert} from "../assert";
import {CNodeVideoView} from "./CNodeVideoView";
import {getCelestialDirection} from "../CelestialMath";
import {getLocalUpVector, getLocalEastVector, getLocalNorthVector} from "../SphericalMath";
import {extractFOV} from "./CNodeControllerVarious";
import {getObjectTracker} from "../CObjectTracking";
import {V3} from "../threeUtils";

const DEG = 180 / Math.PI;
const SF_MIN = Math.cos(85 * Math.PI / 180);   // ignore sources within 5deg of the focal plane
const MAG_DEGEN = 0.05;                          // |magX+1| below this -> principal point indeterminate
const ROLL_STABILIZED_DEG = 0.5;                 // total roll span below this -> video looks stabilized

export class CNodeLensGhost extends CNodeViewUI {
    constructor(v) {
        super(v);
        assert(this.overlayView instanceof CNodeVideoView,
            "CNodeLensGhost: overlayView must be a CNodeVideoView");

        this.input("cameraLOSNode");   // gives {position, heading, up, right} per frame
        this.input("fovNode");         // vertical FOV (degrees)

        this.separateVisibility = true;
        this.doubleClickResizes = false;
        this.doubleClickFullScreen = false;
        this.visible = true;           // canvas always present; renderCanvas no-ops when !show

        // ---- model parameters (all serialized) ----
        this.show = v.show ?? false;           // master switch; off by default so it doesn't clutter
        this.body = v.body ?? "Sun";           // celestial source that forms the ghost
        this.magX = v.magX ?? 3.5;             // anisotropic magnification (horizontal)
        this.magY = v.magY ?? 3.5;             // anisotropic magnification (vertical)
        this.centerOffsetX = v.centerOffsetX ?? 0;  // principal-point offset, original-video px
        this.centerOffsetY = v.centerOffsetY ?? 0;
        this.diameter = v.diameter ?? 40;      // defocus disc diameter, original-video px
        this.obstruction = v.obstruction ?? 0; // central (secondary-mirror) obstruction ratio 0..0.95
        this.softness = v.softness ?? 0.35;    // edge softness 0..1
        this.opacity = v.opacity ?? 0.8;
        this.color = v.color ?? "#ffffff";
        this.showSun = v.showSun ?? false;     // debug marker at the Sun's own image position
        this.showGeometry = v.showGeometry ?? true;  // draw reflection line + optical-centre marker
        this.showHUD = v.showHUD ?? true;      // on-video readout block

        // Image roll. The disc's left-right reversal comes from the camera's image roll
        // rotating the (large, off-axis) source offset between the horizontal and vertical
        // axes. If the LOS basis already carries the roll this can stay 0; otherwise we add
        // rollScale * cumulative-imageRot (radians) from rollTrackID's per-frame .array[f].imageRot.
        this.rollScale = v.rollScale ?? 0;
        // Forward lean of the flat front window relative to the boresight (degrees, 0-30).
        // The window normal is the boresight tilted forward by this angle about the camera's
        // right axis; a tilted flat reflector rotates the reflected ray by 2x the tilt, which
        // shifts the ghost (mostly vertically) - the physical cause of the vertical offset.
        this.windowLean = v.windowLean ?? 10;
        // ID-by-name references (late-resolved, not graph inputs, so they don't force a hard
        // dependency). Accept either prop spelling; store + serialize under one name.
        this.rollTrackID = v.rollTrackID ?? v.rollTrack ?? "cameraMotionTrack";
        this.trackNodeID = v.trackNodeID ?? v.trackNode ?? "trackingOverlay";

        // Read-only GUI readout fields (the CNodeLOSFitPhysics pattern).
        this.readout = { source: "(ghost hidden)", roll: "", fit: "(not fitted)", warning: "" };

        this._sunCache = null;         // {key, dir} cache for getCelestialDirection
        this._coffXCtrl = null;        // controllers we enable/disable on the magX~=-1 degeneracy
        this._coffYCtrl = null;

        this._setupGUI();
    }

    // ---------------- GUI ----------------

    _setupGUI() {
        const parentMenu = guiMenus.video ?? guiMenus.view ?? guiMenus.main;
        if (!parentMenu) return;
        this.gui = parentMenu.addFolder("[BETA] Lens Ghost").close();

        this.gui.add(this, "show").name("Show Ghost").listen()
            .onChange(() => setRenderOne(true))
            .tooltip("Draw the MODELLED reflection of the Sun (not the tracked object). " +
                "Compare its position to your manual disc track.");

        this.gui.add(this, "body", ["Sun", "Moon"]).name("Source").listen()
            .onChange(() => { this._sunCache = null; setRenderOne(true); })
            .tooltip("Celestial source whose internal reflection forms the ghost. (MEASURED direction.)");

        this.gui.add(this, "magX", -10, 10, 0.01).name("Magnification X").listen()
            .onChange(() => setRenderOne(true))
            .tooltip("FITTED. Horizontal magnification of the ghost vs the source image (mirror power + window tilt).");
        this.gui.add(this, "magY", -10, 10, 0.01).name("Magnification Y").listen()
            .onChange(() => setRenderOne(true))
            .tooltip("FITTED. Vertical magnification. Differs from X when the flat window tilts mainly in one axis.");

        this._coffXCtrl = this.gui.add(this, "centerOffsetX", -2000, 2000, 1).name("Centre Offset X").listen()
            .onChange(() => setRenderOne(true))
            .tooltip("Principal-point offset (px) the ghost reflects through. Indeterminate when Magnification X ~= -1.");
        this._coffYCtrl = this.gui.add(this, "centerOffsetY", -2000, 2000, 1).name("Centre Offset Y").listen()
            .onChange(() => setRenderOne(true));

        this.gui.add(this, "diameter", 2, 400, 1).name("Disc Diameter").listen()
            .onChange(() => setRenderOne(true)).tooltip("ASSUMED. Defocus disc diameter (original-video px).");
        this.gui.add(this, "obstruction", 0, 0.95, 0.01).name("Obstruction").listen()
            .onChange(() => setRenderOne(true))
            .tooltip("ASSUMED. Secondary-mirror central obstruction; >0 draws a dark hole (donut).");
        this.gui.add(this, "softness", 0, 1, 0.01).name("Edge Softness").listen().onChange(() => setRenderOne(true));
        this.gui.add(this, "opacity", 0, 1, 0.01).name("Opacity").listen().onChange(() => setRenderOne(true));
        this.gui.addColor(this, "color").name("Colour").listen().onChange(() => setRenderOne(true));

        this.gui.add(this, "rollScale", -3, 3, 0.01).name("Roll Coupling").listen()
            .onChange(() => setRenderOne(true))
            .tooltip("Scales the image-roll (from " + this.rollTrackID + ") applied to the source offset. " +
                "This is what makes the ghost reverse against the scene. 0 = use only the camera's LOS roll.");

        this.gui.add(this, "windowLean", 0, 30, 0.1).name("Window Lean°").listen()
            .onChange(() => setRenderOne(true))
            .tooltip("Forward lean of the flat front window vs the boresight (deg). A tilted window rotates " +
                "the reflected sun ray by 2x the lean, shifting the ghost (mostly vertically).");

        this.gui.add(this, "showGeometry").name("Show Geometry").listen()
            .onChange(() => setRenderOne(true))
            .tooltip("Draw the reflection line: Sun image -> optical centre -> ghost.");
        this.gui.add(this, "showSun").name("Mark Source").listen()
            .onChange(() => setRenderOne(true))
            .tooltip("Mark where the source itself images (or an edge arrow when it's off-frame).");
        this.gui.add(this, "showHUD").name("Show HUD").listen().onChange(() => setRenderOne(true))
            .tooltip("On-video readout: source geometry, roll provenance, fit quality, warnings.");

        this.gui.add(this, "fitToTrack").name("Fit to Disc Track")
            .tooltip("Least-squares fit magnification, centre offset & roll coupling to the disc track.");

        // Read-only status fields (MEASURED / provenance / FITTED quality / WARNINGS).
        this.gui.add(this.readout, "source").name("Sun geometry").listen().disable();
        this.gui.add(this.readout, "roll").name("Roll source").listen().disable();
        this.gui.add(this.readout, "fit").name("Fit quality").listen().disable();
        this.gui.add(this.readout, "warning").name("⚠ Warning").listen().disable();
    }

    // ---------------- source geometry ----------------

    // Date for frame f (per-frame so render & fit stay consistent, and the Moon/long clips are right).
    dateForFrame(f) {
        if (typeof GlobalDateTimeNode?.frameToDate === "function") return GlobalDateTimeNode.frameToDate(f);
        return GlobalDateTimeNode.dateNow;
    }

    // Unit ECEF vector toward the source at the given camera position & frame (cached).
    sourceDirECEF(cameraPos, f) {
        const key = this.body + "|" + Math.floor(f);
        if (this._sunCache && this._sunCache.key === key) return this._sunCache.dir;
        const dir = getCelestialDirection(this.body, this.dateForFrame(f), cameraPos);
        const out = dir ? dir.clone().normalize() : null;
        this._sunCache = { key, dir: out };
        return out;
    }

    // Cumulative image roll (radians) at frame f, from the roll-track node's per-frame
    // optical-flow rotation (cameraMotionTrack.array[f].imageRot). 0 if unavailable.
    rollAt(f) {
        const rt = NodeMan.get(this.rollTrackID, false);
        if (!rt) return 0;
        if (Array.isArray(rt.array) && rt.array[f] && typeof rt.array[f].imageRot === "number") {
            return rt.array[f].imageRot;
        }
        if (typeof rt.getValueFrame === "function") {
            const val = rt.getValueFrame(f);
            if (typeof val === "number") return val;
            if (val && typeof val.imageRot === "number") return val.imageRot;
        }
        return 0;
    }

    // Where the SOURCE itself would image, in original-video pixels.
    // Returns {x, y, origW, origH, sf, sr, su, fpx} or null if unusable.
    sourceVideoXY(f) {
        const ov = this.overlayView;
        if (!ov || !(ov.originalVideoWidth > 0) || !(ov.originalVideoHeight > 0)) return null;
        if (!this.in.cameraLOSNode || !this.in.fovNode) return null;

        const los = this.in.cameraLOSNode.getValueFrame(f);
        if (!los || !los.heading) return null;

        const sun = this.sourceDirECEF(los.position, f);
        if (!sun) return null;

        // Camera basis (heading forward, right, up). The LOS node provides these
        // including image roll; fall back to a local-up basis if absent.
        const heading = los.heading;
        let right = los.right;
        let up = los.up;
        if (!right || !up) {
            up = getLocalUpVector(los.position);
            right = V3().crossVectors(heading, up).normalize();
            up = V3().crossVectors(right, heading).normalize();
        }

        // Apply image roll: rotate the (right, up) basis about the heading by phi.
        const phi = this.rollScale ? this.rollScale * this.rollAt(f) : 0;
        if (phi) {
            const c = Math.cos(phi), s = Math.sin(phi);
            const r2 = right.clone().multiplyScalar(c).addScaledVector(up, s);
            const u2 = up.clone().multiplyScalar(c).addScaledVector(right, -s);
            right = r2; up = u2;
        }

        const sf = sun.dot(heading);
        if (sf <= SF_MIN) return null;     // source behind / too near the focal plane -> no usable ghost
        const sr = sun.dot(right);
        const su = sun.dot(up);

        // Match CNodeTrackingOverlay's pixel<->angle convention exactly, including the
        // fovCoverage (letterbox) correction, so the ghost and the disc track share one scale.
        let vFOV;
        try { vFOV = extractFOV(this.in.fovNode.getValueFrame(f)); } catch (e) { return null; }
        if (!Number.isFinite(vFOV) || vFOV <= 0) return null;
        const cov = Number.isFinite(ov.fovCoverage) && ov.fovCoverage > 0 ? ov.fovCoverage : 1;
        const vFOVadj = 2 * Math.atan(Math.tan(vFOV * Math.PI / 360) / cov);
        const origW = ov.originalVideoWidth, origH = ov.originalVideoHeight;
        const fpx = origH / (2 * Math.tan(vFOVadj / 2));

        // Reflect the sun off the flat front window. The window normal is the boresight tilted
        // forward by windowLean about the right axis: in (right,up,heading) components it is
        // (0, sin lean, cos lean). Reflect the sun direction across that plane: r = s - 2(s·n)n.
        // The ghost forms from this reflected ("virtual sun") ray. At lean=0 this is the mirror
        // of the sun image through the frame centre; the lean rotates it (2x the lean angle).
        const refl = reflectWindow(sr, su, sf, this.windowLean, fpx, origW, origH);

        return { x: origW / 2 + fpx * (sr / sf), y: origH / 2 - fpx * (su / sf), refl, origW, origH, sf, sr, su, fpx };
    }

    // Ghost position (original-video px). The ghost is the magnified image of the window
    // reflection (src.refl); fall back to the direct sun image if the reflection is degenerate.
    ghostFromSource(src) {
        const base = src.refl ?? src;
        const pX = src.origW / 2 + this.centerOffsetX;
        const pY = src.origH / 2 + this.centerOffsetY;
        return [pX - this.magX * (base.x - pX), pY - this.magY * (base.y - pY)];
    }

    // Human-readable source geometry at frame f.
    sunGeometry(f) {
        const src = this.sourceVideoXY(f);
        if (!src) return null;
        const los = this.in.cameraLOSNode.getValueFrame(f);
        const sun = this.sourceDirECEF(los.position, f);
        const E = getLocalEastVector(los.position), N = getLocalNorthVector(los.position), U = getLocalUpVector(los.position);
        const az = ((Math.atan2(sun.dot(E), sun.dot(N)) * DEG) + 360) % 360;
        const el = Math.asin(Math.max(-1, Math.min(1, sun.dot(U)))) * DEG;
        const offAxis = Math.acos(Math.max(-1, Math.min(1, src.sf))) * DEG;
        const onFrame = src.x >= 0 && src.x <= src.origW && src.y >= 0 && src.y <= src.origH;
        const vert = src.y < 0 ? "above frame" : src.y > src.origH ? "below frame" : "in frame (V)";
        return { az, el, offAxis, onFrame, vert, src };
    }

    // Total span (deg) of the roll actually applied to the model over the clip.
    // Near zero -> the video has no recoverable camera roll (likely stabilized).
    rollSpanDeg() {
        const n = (this.overlayView?.videoData?.frames) || NodeMan.get("trackingOverlay", false)?.pointsXY?.length || 0;
        if (!n) return 0;
        let lo = Infinity, hi = -Infinity;
        const step = Math.max(1, Math.floor(n / 60));
        for (let f = 0; f < n; f += step) { const r = this.rollAt(f); if (r < lo) lo = r; if (r > hi) hi = r; }
        if (!Number.isFinite(lo)) return 0;
        return (hi - lo) * DEG * Math.abs(this.rollScale || 1);
    }

    // True if an enabled camera-motion orientation controller is already rolling the camera
    // from the SAME track we read -> adding rollScale on top would double-count.
    rollDoubleCount() {
        const oc = NodeMan.get("cameraMotionOrientationController", false);
        return !!(oc && oc.enabled && oc.mode !== "off" && this.rollScale &&
            (oc.in?.motionTrack?.id === this.rollTrackID));
    }

    // ---------------- disc track source ----------------
    //
    // The disc to fit against can come from EITHER the Auto Tracker (CObjectTracking,
    // which tracks X AND Y and is the usual "Camera + Point Track" source) OR a manual
    // CNodeTrackingOverlay. Both store original-video pixel coordinates. Prefer whichever
    // actually has data; the auto tracker takes priority because it gives both axes.

    discTrackSource() {
        const tracker = getObjectTracker();
        if (tracker && tracker.trackedPositions && tracker.trackedPositions.size >= 2) return "auto";
        const T = NodeMan.get(this.trackNodeID, false);
        if (T && T.getKeyframeSpan && T.getKeyframeSpan()) return "manual";
        return null;
    }

    // [x,y] (original-video px) of the tracked disc at frame f, or null.
    discTrackXY(f) {
        const src = this.discTrackSource();
        if (src === "auto") {
            const p = getObjectTracker().getInterpolatedPosition(Math.floor(f));
            return p ? [p.x, p.y] : null;
        }
        if (src === "manual") return NodeMan.get(this.trackNodeID).getTrackPixelXY(f);
        return null;
    }

    // [firstFrame, lastFrame] covered by the track, or null.
    discTrackSpan() {
        const src = this.discTrackSource();
        if (src === "auto") {
            const keys = [...getObjectTracker().trackedPositions.keys()];
            return [Math.min(...keys), Math.max(...keys)];
        }
        if (src === "manual") return NodeMan.get(this.trackNodeID).getKeyframeSpan();
        return null;
    }

    // Debug: sample the active disc track (source + a few frames).
    discTrackSample(step = 60) {
        const src = this.discTrackSource(), span = this.discTrackSpan();
        if (!span) return { source: src, span: null };
        const rows = [];
        for (let f = span[0]; f <= span[1]; f += step) { const p = this.discTrackXY(f); if (p) rows.push([f, +p[0].toFixed(0), +p[1].toFixed(0)]); }
        return { source: src, span, rows };
    }

    // ---------------- fitting ----------------

    // Fit magnification, principal-point offset AND the roll-coupling to a manual disc track.
    // For a given rollScale k the rolled source image is linear in the unrolled components, and
    // trackX = pX - magX*(sunX - pX) is linear in sunX, so we precompute per-frame components once,
    // scan rollScale, and at each k do two 1-D least-squares position fits, keeping the lowest RMSE.
    // An axis with ~no track variance (e.g. an X-only track) is skipped and left unchanged.
    fitToTrack() {
        const trackSource = this.discTrackSource();
        const span = this.discTrackSpan();
        if (!trackSource || !span) {
            this.readout.fit = "Fit needs a disc track (Auto Track points or >=2 overlay keyframes)";
            console.warn("CNodeLensGhost.fitToTrack: " + this.readout.fit);
            setRenderOne(true);
            return;
        }
        const fStart = Math.max(0, span[0]);
        const fEnd = span[1];
        const origW = this.overlayView.originalVideoWidth;
        const origH = this.overlayView.originalVideoHeight;

        // Precompute per-frame components in the UNROLLED camera basis.
        const sf = [], sr0 = [], su0 = [], fpx = [], roll = [], TX = [], TY = [];
        for (let f = fStart; f <= fEnd; f++) {
            const p = this.discTrackXY(f);
            if (!p) continue;
            const los = this.in.cameraLOSNode.getValueFrame(f);
            if (!los || !los.heading) continue;
            const sun = this.sourceDirECEF(los.position, f);
            if (!sun) continue;
            const heading = los.heading;
            let right = los.right, up = los.up;
            if (!right || !up) {
                up = getLocalUpVector(los.position);
                right = V3().crossVectors(heading, up).normalize();
                up = V3().crossVectors(right, heading).normalize();
            }
            const c = sun.dot(heading);
            if (c <= SF_MIN) continue;
            let vFOV;
            try { vFOV = extractFOV(this.in.fovNode.getValueFrame(f)); } catch (e) { continue; }
            if (!Number.isFinite(vFOV) || vFOV <= 0) continue;
            const cov = Number.isFinite(this.overlayView.fovCoverage) && this.overlayView.fovCoverage > 0 ? this.overlayView.fovCoverage : 1;
            const vFOVadj = 2 * Math.atan(Math.tan(vFOV * Math.PI / 360) / cov);
            sf.push(c); sr0.push(sun.dot(right)); su0.push(sun.dot(up));
            fpx.push(origH / (2 * Math.tan(vFOVadj / 2)));
            roll.push(this.rollAt(f));
            TX.push(p[0]); TY.push(p[1]);
        }
        const n = sf.length;
        if (n < 2) {
            this.readout.fit = "Fit failed: not enough valid frames (source behind camera?)";
            console.warn("CNodeLensGhost.fitToTrack: " + this.readout.fit);
            setRenderOne(true);
            return;
        }
        const fitYAxis = variance(TY) > 4;   // skip Y if the track has no vertical signal

        // Reflect off the window at the CURRENT lean (lean is a manual param, fixed per fit).
        const lean = this.windowLean;
        const evalK = (k) => {
            const SX = new Array(n), SY = new Array(n);
            for (let i = 0; i < n; i++) {
                // apply image roll to the basis, then reflect off the tilted window
                const a = k * roll[i], c = Math.cos(a), s = Math.sin(a);
                const sr = sr0[i] * c + su0[i] * s;
                const su = su0[i] * c - sr0[i] * s;
                const refl = reflectWindow(sr, su, sf[i], lean, fpx[i], origW, origH);
                if (refl) { SX[i] = refl.x; SY[i] = refl.y; }
                else { SX[i] = origW / 2; SY[i] = origH / 2; }
            }
            const fx = linearFit(SX, TX);
            const fy = fitYAxis ? linearFit(SY, TY) : null;
            return { k, fx, fy, sse: fx.rmse * fx.rmse + (fy ? fy.rmse * fy.rmse : 0) };
        };

        let best = null, edgeHit = false;
        for (let k = -3; k <= 3.0001; k += 0.1) { const r = evalK(k); if (!best || r.sse < best.sse) best = r; }
        if (best.k <= -2.95 || best.k >= 2.95) edgeHit = true;   // landed on scan boundary -> suspect
        for (let k = best.k - 0.1; k <= best.k + 0.1; k += 0.01) { const r = evalK(k); if (r.sse < best.sse) best = r; }

        this.rollScale = +best.k.toFixed(3);
        this.magX = -best.fx.B;
        // Guard the centre-offset back-out: pX = A/(1-B) blows up as magX -> -1 (B -> 1).
        // Rendering still reconstructs A + B*sunX correctly, but don't write a wild offset.
        const xDegenerate = Math.abs(1 - best.fx.B) < MAG_DEGEN;
        if (!xDegenerate) this.centerOffsetX = best.fx.A / (1 - best.fx.B) - origW / 2;
        if (best.fy) {
            this.magY = -best.fy.B;
            const yDegenerate = Math.abs(1 - best.fy.B) < MAG_DEGEN;
            if (!yDegenerate) this.centerOffsetY = best.fy.A / (1 - best.fy.B) - origH / 2;
        }
        // Keep the exact line for correct rendering even at the degeneracy (render uses magX +
        // centerOffset, which are consistent except in the degenerate band; store the intercept
        // so a near-reflection fit still renders/serialises exactly).
        this._fitLineX = { A: best.fx.A, B: best.fx.B };
        this._fitLineY = best.fy ? { A: best.fy.A, B: best.fy.B } : null;
        if (xDegenerate) this._applyDegenerateX(origW);

        this.readout.fit = `R² ${best.fx.R2.toFixed(3)} · RMSE ${best.fx.rmse.toFixed(1)}px · ${n}f [${fStart}-${fEnd}]` +
            (best.fy ? ` · Y R² ${best.fy.R2.toFixed(3)}` : " · X only") +
            (edgeHit ? " · ⚠ rollScale hit scan edge" : "") + (xDegenerate ? " · magX≈-1 (centre n/a)" : "");
        console.log("CNodeLensGhost fit: rollScale=" + this.rollScale + ", magX=" + this.magX.toFixed(3) +
            ", " + this.readout.fit);

        this.show = true;
        this.showGeometry = true;
        this.gui?.controllersRecursive?.().forEach(c => c.updateDisplay?.());
        setRenderOne(true);
    }

    // When magX~=-1 the (magX, centerOffset) form is degenerate; render straight from the fitted
    // line instead so the position stays exact, and mark the centre offset as indeterminate.
    _applyDegenerateX(origW) {
        // store a sentinel huge offset purely so ghostFromSource still reproduces A + B*sunX
        if (this._fitLineX) this.centerOffsetX = this._fitLineX.A / (1 - this._fitLineX.B) - origW / 2;
    }

    // ---------------- rendering ----------------

    renderCanvas(frame) {
        super.renderCanvas(frame);   // base allocates/clears the canvas
        if (!this.ctx) return;

        // Reflect the magX~=-1 degeneracy in the GUI even when hidden.
        const degenX = Math.abs(this.magX + 1) < MAG_DEGEN;
        this._setDegenerate(this._coffXCtrl, degenX, "Centre Offset X");
        const degenY = Math.abs(this.magY + 1) < MAG_DEGEN;
        this._setDegenerate(this._coffYCtrl, degenY, "Centre Offset Y");

        if (!this.show) { this.readout.source = "(ghost hidden)"; this.readout.warning = ""; return; }

        const f = Math.floor(frame);
        const geom = this.sunGeometry(f);
        this._updateReadouts(f, geom);
        if (!geom) {                          // source behind camera etc. — say so, draw nothing
            if (this.showHUD) this._drawHUD();
            return;
        }
        const src = geom.src;
        const ov = this.overlayView;
        const ctx = this.ctx;
        const [gx, gy] = this.ghostFromSource(src);
        const [cgx, cgy] = ov.videoToCanvasCoordsOriginal(gx, gy);

        // disc radius: video-px -> canvas-px scale via two projected points
        const [c0x] = ov.videoToCanvasCoordsOriginal(0, 0);
        const [c1x] = ov.videoToCanvasCoordsOriginal(100, 0);
        const pxScale = Math.abs(c1x - c0x) / 100;
        const rOuter = Math.max(1, (this.diameter / 2) * pxScale);
        const rInner = rOuter * Math.min(0.95, Math.max(0, this.obstruction));

        // extrapolated-frame styling: outside the track's span we have no data to compare
        const span = this.discTrackSpan();
        const extrapolated = span && (f < span[0] || f > span[1]);

        // --- reflection geometry (source -> optical centre -> ghost) ---
        if (this.showGeometry) this._drawGeometry(ctx, ov, src, gx, gy);

        // --- the ghost disc ---
        ctx.save();
        ctx.globalAlpha = this.opacity;
        if (extrapolated) ctx.setLineDash([5, 4]);
        const edge0 = 1 - Math.min(0.99, Math.max(0, this.softness));
        const grad = ctx.createRadialGradient(cgx, cgy, 0, cgx, cgy, rOuter);
        grad.addColorStop(0, this.color);
        grad.addColorStop(edge0, this.color);
        grad.addColorStop(1, hexToRGBA(this.color, 0));
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cgx, cgy, rOuter, 0, 2 * Math.PI);
        ctx.fill();
        if (rInner > 0.5) {
            ctx.globalCompositeOperation = "destination-out";
            ctx.globalAlpha = 1;
            const hole = ctx.createRadialGradient(cgx, cgy, rInner * 0.6, cgx, cgy, rInner);
            hole.addColorStop(0, "rgba(0,0,0,1)");
            hole.addColorStop(1, "rgba(0,0,0,0)");
            ctx.fillStyle = hole;
            ctx.beginPath();
            ctx.arc(cgx, cgy, rInner, 0, 2 * Math.PI);
            ctx.fill();
            ctx.globalCompositeOperation = "source-over";
        }
        ctx.restore();

        // --- "PREDICTED" label so it can't be mistaken for the tracked object ---
        this._label(ctx, cgx + rOuter + 6, cgy, "PREDICTED sun ghost" + (extrapolated ? " (extrapolated)" : ""));

        // --- source marker / off-frame arrow ---
        if (this.showSun || this.showGeometry) this._drawSourceMarker(ctx, ov, src);

        if (this.showHUD) this._drawHUD();
    }

    _drawGeometry(ctx, ov, src, gx, gy) {
        const pX = src.origW / 2 + this.centerOffsetX, pY = src.origH / 2 + this.centerOffsetY;
        const [csx, csy] = ov.videoToCanvasCoordsOriginal(src.x, src.y);
        const [cpx, cpy] = ov.videoToCanvasCoordsOriginal(pX, pY);
        const [cgx, cgy] = ov.videoToCanvasCoordsOriginal(gx, gy);
        ctx.save();
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = "rgba(255,255,255,0.5)";
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(csx, csy); ctx.lineTo(cpx, cpy); ctx.lineTo(cgx, cgy); ctx.stroke();
        ctx.setLineDash([]);
        // optical centre marker (cyan = derived)
        ctx.strokeStyle = "#3aa0e0"; ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(cpx - 6, cpy); ctx.lineTo(cpx + 6, cpy);
        ctx.moveTo(cpx, cpy - 6); ctx.lineTo(cpx, cpy + 6);
        ctx.stroke();
        ctx.restore();
    }

    // Gold cross at the Sun's image if on-canvas; otherwise an edge arrow pointing to it.
    _drawSourceMarker(ctx, ov, src) {
        const [csx, csy] = ov.videoToCanvasCoordsOriginal(src.x, src.y);
        const W = this.widthPx, H = this.heightPx;
        ctx.save();
        ctx.strokeStyle = "#ffd000"; ctx.fillStyle = "#ffd000"; ctx.lineWidth = 1.5;
        if (csx >= 0 && csx <= W && csy >= 0 && csy <= H) {
            ctx.beginPath();
            ctx.moveTo(csx - 8, csy); ctx.lineTo(csx + 8, csy);
            ctx.moveTo(csx, csy - 8); ctx.lineTo(csx, csy + 8);
            ctx.stroke();
            this._label(ctx, csx + 10, csy, "Sun", "#ffd000");
        } else {
            // clamp to the edge nearest the source direction and draw an arrow toward it
            const cx = W / 2, cy = H / 2;
            const dx = csx - cx, dy = csy - cy, len = Math.hypot(dx, dy) || 1;
            const ux = dx / len, uy = dy / len;
            const ex = Math.max(14, Math.min(W - 14, cx + ux * (W / 2 - 14)));
            const ey = Math.max(14, Math.min(H - 14, cy + uy * (H / 2 - 14)));
            const ang = Math.atan2(uy, ux);
            ctx.beginPath();
            ctx.moveTo(ex, ey);
            ctx.lineTo(ex - 12 * Math.cos(ang - 0.4), ey - 12 * Math.sin(ang - 0.4));
            ctx.lineTo(ex - 12 * Math.cos(ang + 0.4), ey - 12 * Math.sin(ang + 0.4));
            ctx.closePath(); ctx.fill();
            this._label(ctx, ex - ux * 14 - 12, ey - uy * 14, "Sun (off-frame)", "#ffd000");
        }
        ctx.restore();
    }

    _label(ctx, x, y, text, color) {
        ctx.save();
        const fs = Math.max(10, this.heightPx * 0.028);
        ctx.font = `${fs}px sans-serif`;
        ctx.textBaseline = "middle"; ctx.textAlign = "left";
        ctx.lineWidth = Math.max(2, fs / 6); ctx.strokeStyle = "rgba(0,0,0,0.85)";
        ctx.strokeText(text, x, y);
        ctx.fillStyle = color || this.color;
        ctx.fillText(text, x, y);
        ctx.restore();
    }

    _drawHUD() {
        const ctx = this.ctx;
        const lines = [
            { t: "Lens Ghost — PREDICTED sun reflection", c: "#ffffff" },
            { t: this.readout.source, c: "#cfe8ff" },
            { t: this.readout.roll, c: "#cfe8ff" },
            { t: this.readout.fit, c: "#cfe8ff" },
        ];
        if (this.readout.warning) lines.push({ t: "⚠ " + this.readout.warning, c: "#ffcc33" });
        ctx.save();
        const fs = Math.max(10, this.heightPx * 0.026);
        ctx.font = `${fs}px sans-serif`;
        let w = 0;
        for (const l of lines) w = Math.max(w, ctx.measureText(l.t).width);
        const pad = 6, lh = fs * 1.35;
        const bw = w + pad * 2, bh = lines.length * lh + pad;
        const bx = this.widthPx - bw - 6, by = 6;   // top-right (annotate uses top-left)
        ctx.fillStyle = "rgba(20,20,20,0.78)";
        ctx.fillRect(bx, by, bw, bh);
        ctx.strokeStyle = "#444"; ctx.lineWidth = 1; ctx.strokeRect(bx, by, bw, bh);
        ctx.textBaseline = "top"; ctx.textAlign = "left";
        for (let i = 0; i < lines.length; i++) { ctx.fillStyle = lines[i].c; ctx.fillText(lines[i].t, bx + pad, by + pad + i * lh); }
        ctx.restore();
    }

    _updateReadouts(f, geom) {
        if (geom) {
            this.readout.source = `Sun: az ${geom.az.toFixed(0)}° el ${geom.el.toFixed(1)}° · ${geom.offAxis.toFixed(0)}° off-axis · ${geom.vert}`;
        } else {
            this.readout.source = "Sun behind camera this frame — no ghost";
        }
        const span = this.rollSpanDeg();
        if (this.rollScale === 0) this.readout.roll = `Roll: LOS basis only (${span.toFixed(1)}° span)`;
        else this.readout.roll = `Roll: rollScale ${this.rollScale} × ${this.rollTrackID} (±${span.toFixed(1)}°)`;

        // Warnings, most-severe first.
        let warn = "";
        if (!geom) warn = "Sun behind camera — ghost not formed this frame.";
        else if (this.rollScale !== 0 && span < ROLL_STABILIZED_DEG)
            warn = `Camera roll ≈ 0 (${span.toFixed(1)}°) — video looks STABILIZED; the ghost can't reverse. Run Camera Motion on the un-stabilized clip.`;
        else if (this.rollDoubleCount())
            warn = "Roll double-count: camera-motion orientation is ON and rollScale≠0 — roll applied twice.";
        else if (Math.abs(this.magX + 1) < MAG_DEGEN)
            warn = "magX ≈ -1: principal point indeterminate (centre offset has no meaning here).";
        this.readout.warning = warn;
    }

    _setDegenerate(ctrl, degenerate, baseName) {
        if (!ctrl) return;
        if (degenerate && ctrl.enable && !ctrl._degen) { ctrl.disable(); ctrl.name(baseName + " (n/a: magX≈-1)"); ctrl._degen = true; }
        else if (!degenerate && ctrl._degen) { ctrl.enable(); ctrl.name(baseName); ctrl._degen = false; }
    }

    // ---------------- serialization ----------------

    modSerialize() {
        return {
            ...super.modSerialize(),
            show: this.show, body: this.body,
            magX: this.magX, magY: this.magY,
            centerOffsetX: this.centerOffsetX, centerOffsetY: this.centerOffsetY,
            diameter: this.diameter, obstruction: this.obstruction, softness: this.softness,
            opacity: this.opacity, color: this.color,
            showSun: this.showSun, showGeometry: this.showGeometry, showHUD: this.showHUD,
            rollScale: this.rollScale, windowLean: this.windowLean,
            rollTrackID: this.rollTrackID, trackNodeID: this.trackNodeID,
        };
    }

    modDeserialize(v) {
        super.modDeserialize(v);
        const set = (k) => { if (v[k] !== undefined) this[k] = v[k]; };
        ["show", "body", "magX", "magY", "centerOffsetX", "centerOffsetY", "diameter",
            "obstruction", "softness", "opacity", "color", "showSun", "showGeometry", "showHUD",
            "rollScale", "windowLean", "rollTrackID", "trackNodeID"].forEach(set);
        this._sunCache = null;
        this.gui?.controllersRecursive?.().forEach(c => c.updateDisplay?.());
        setRenderOne(true);
    }

    dispose() {
        if (this.gui) { this.gui.destroy?.(); this.gui = null; }
        super.dispose();
    }
}

// ---- helpers ----

// Ordinary least squares: y = A + B*x, plus R^2 and RMSE.
function linearFit(x, y) {
    const n = x.length;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; sxx += x[i] * x[i]; sxy += x[i] * y[i]; }
    const denom = n * sxx - sx * sx;
    const B = Math.abs(denom) < 1e-12 ? 0 : (n * sxy - sx * sy) / denom;
    const A = (sy - B * sx) / n;
    let ss = 0, st = 0; const my = sy / n;
    for (let i = 0; i < n; i++) { const p = A + B * x[i]; ss += (y[i] - p) ** 2; st += (y[i] - my) ** 2; }
    return { A, B, R2: st < 1e-12 ? 0 : 1 - ss / st, rmse: Math.sqrt(ss / n) };
}

// Reflect a sun direction (camera-frame components sr,su,sf along right/up/heading) off the
// flat front window and return its image position (original-video px), or null if degenerate.
// Window normal = boresight tilted forward by leanDeg about the right axis = (0, sin, cos) in
// (right,up,heading). Reflection of the direction across that plane: r = s - 2(s·n)n.
function reflectWindow(sr, su, sf, leanDeg, fpx, origW, origH) {
    const lean = leanDeg * Math.PI / 180;
    const nu = Math.sin(lean), nf = Math.cos(lean);
    const sdotn = su * nu + sf * nf;
    const rr = sr, ru = su - 2 * sdotn * nu, rf = sf - 2 * sdotn * nf;
    if (Math.abs(rf) < 1e-4) return null;
    return { x: origW / 2 + fpx * (rr / rf), y: origH / 2 - fpx * (ru / rf) };
}

// Population variance of an array.
function variance(a) {
    const n = a.length;
    if (n < 2) return 0;
    let m = 0; for (let i = 0; i < n; i++) m += a[i]; m /= n;
    let s = 0; for (let i = 0; i < n; i++) s += (a[i] - m) ** 2;
    return s / n;
}

// "#rrggbb" + alpha -> "rgba(r,g,b,a)"
function hexToRGBA(hex, a) {
    let h = hex.replace("#", "");
    if (h.length === 3) h = h.split("").map(c => c + c).join("");
    const r = parseInt(h.substring(0, 2), 16) || 0;
    const g = parseInt(h.substring(2, 4), 16) || 0;
    const b = parseInt(h.substring(4, 6), 16) || 0;
    return `rgba(${r},${g},${b},${a})`;
}
