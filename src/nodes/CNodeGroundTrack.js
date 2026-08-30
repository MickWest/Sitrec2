// Ground Track — a track of points ON THE GROUND, placed by clicking where the object appears.
//
// The technique this exists for: an object seen against terrain is IN FRONT of that terrain. Put
// a point on the ground directly behind it — the hillside it crosses, the field it passes over —
// and you have said two things at once. You have fixed the line of sight (camera position through
// a real place), and you have put a ceiling on the range, because the object cannot be further
// away than the ground it is silhouetted against.
//
// What is stored is therefore the GROUND POINT, in the world, not a pixel. That is the whole
// difference from Point Track and Object Track, which store a video pixel and turn it into a
// direction using the camera's field of view. Here the direction is a consequence: camera
// position to a fixed place on the earth. It needs no FOV at all, it survives a change of lens
// model, and — because a place is a place — it can be read straight off the map in the main view
// when the video is too ambiguous to click.
//
//    Video / Look view                          Main view
//    ┌────────────────────┐                     camera ●
//    │        ·  object   │                            ╲
//    │       ╱            │                             ╲   line of sight
//    │   ┌──╳─────────┐   │  ← click the ground          ╲
//    │   │  hillside  │   │    BEHIND the object          ╳ ─── ground point (stored)
//    └───┴────────────┴───┘                        ~~~~~~~ terrain ~~~~~~~
//
// Between keyframes the ground point is interpolated. What it must NOT do there is re-snap onto
// the terrain, which is what an early version did: over a clifftop the interpolated path dived
// down to the beach and climbed back up, and since the line of sight is camera-to-point, that
// terrain profile was injected straight into the LOS as a swing of several degrees. Downstream,
// a traverse turns that into fake speed and fake acceleration in the recovered track. The terrain
// belongs to where the user PLACED a point, not to the guesses between them. See BETWEEN_MODES.
//
// Editing happens in the 3D views; see GroundTrackHandles3D for the gestures.

import {CNodeTrack} from "./CNodeTrack";
import {Globals, guiMenus, NodeMan, Sit, setRenderOne, UndoManager, Units} from "../Globals";
import {par} from "../par";
import {ECEFToLLAVD_radii, LLAToECEF} from "../LLA-ECEF-ENU";
import {elevationAtLL} from "../threeExt";
import {getAzElFromPositionAndForward, getLocalNorthVector, getLocalUpVector} from "../SphericalMath";
import {radians} from "../utils";
import {surfaceAlongRay} from "../FitSurfacePick";
import {ViewMan} from "../CViewManager";
import {GroundTrackHandles3D} from "../GroundTrackHandles3D";
import {KeyframeRegistry} from "../CKeyframeRegistry";
import {EventManager} from "../CEventManager";

/** At most this many points are projected to draw the path — a polyline, not a plot. */
const MAX_PATH_SAMPLES = 200;

/**
 * What happens BETWEEN the placed points. Both agree exactly at the points themselves.
 *
 * "3D Position" runs a smooth curve through the placed positions and leaves it there. Cheap —
 * pure arithmetic, no terrain queried at all — and the line of sight it produces is smooth,
 * which is the property that matters downstream. The cost is that between points the curve is
 * not ON the ground: over a bay it flies across at clifftop height, so the range ceiling in
 * between is an estimate rather than a measurement.
 *
 * "Ground Intersection" interpolates the DIRECTION instead — as azimuth and elevation at the
 * camera, which is the closest frame-independent thing to "smoothly across the screen" — and
 * then asks where each of those rays actually meets the world. Every frame is then a real place
 * with a real range ceiling, and the line of sight is still smooth. It costs one terrain raycast
 * per frame over the span, which is why it is not the default.
 */
const BETWEEN_3D = "3D Position";
const BETWEEN_GROUND = "Ground Intersection";
const BETWEEN_MODES = [BETWEEN_3D, BETWEEN_GROUND];

/**
 * How far a "Ground Intersection" hit may disagree with the smooth curve, as a range ratio.
 *
 * These lines of sight graze. Measured on the Aguadilla clifftop track: 6 km range at 6 degrees
 * of depression, where dRange/dAngle is about a kilometre per degree — so the 0.07 degrees the
 * direction moves between two frames is enough for a ray to clear the cliff lip it was aimed at
 * and sail on to the far side of the bay. The track then teleports 14 km and back, which is a
 * true intersection and a useless track.
 *
 * The curve through the placed points is the prior, and it is anchored at both ends on ground the
 * user actually pointed at, so a hit that disagrees with it by more than this is far likelier to
 * be a skimmed ray than a real step in the terrain. Rejected hits fall back to the curve.
 *
 * The sensitivity is worth reading, not just guarding against — but note where it applies. At a
 * PLACED point the range is the distance to a real place and there is no angle in it at all. It is
 * only the interpolated frames, where the direction is a guess, that a grazing ray turns into a
 * soft number. Read a ceiling off the points the user placed; the ones between them are
 * interpolation wearing a measurement's clothes.
 */
const RANGE_AGREEMENT = 1.5;

/**
 * One scalar series of the track, sampled at (possibly fractional) frame f.
 *
 * `frames` is ascending and unevenly spaced — keyframes land wherever the object was actually
 * identifiable — so the spline is the non-uniform Catmull-Rom the manual tracking overlay uses:
 * each interior tangent is the average of the slopes either side, scaled by the local interval.
 *
 * Outside the keyframe span the value is HELD at the end keyframe rather than extrapolated. A
 * ground point is a place, and a place extrapolated a few thousand frames off the end of the
 * evidence is somewhere in the next county — which is not a weaker claim than holding still, it
 * is a wilder one, and the traverse downstream would faithfully chase it there. Holding at least
 * keeps the line of sight aimed at somewhere real, and reads as what it is: no data here. The
 * track is drawn only over the span for the same reason.
 */
function sampleSeries(f, frames, values, spline) {
    const n = frames.length;
    if (n === 1) return values[0];

    if (f <= frames[0]) return values[0];
    if (f >= frames[n - 1]) return values[n - 1];

    let i = 0;
    while (i < n - 2 && f > frames[i + 1]) i++;
    const t0 = frames[i], t1 = frames[i + 1];
    const p0 = values[i], p1 = values[i + 1];
    const u = (f - t0) / (t1 - t0);
    if (!spline || n < 3) return p0 + u * (p1 - p0);

    // Off the ends, mirror the neighbouring interval so the first and last segments get a
    // tangent at all. Without it a three-keyframe track would be a straight line in and out.
    const tPrev = i > 0 ? frames[i - 1] : t0 - (t1 - t0);
    const pPrev = i > 0 ? values[i - 1] : p0 - (p1 - p0);
    const tNext = i + 2 < n ? frames[i + 2] : t1 + (t1 - t0);
    const pNext = i + 2 < n ? values[i + 2] : p1 + (p1 - p0);

    const h = t1 - t0;
    const m0 = h * ((p0 - pPrev) / (t0 - tPrev) + (p1 - p0) / h) / 2;
    const m1 = h * ((p1 - p0) / h + (pNext - p1) / (tNext - t1)) / 2;

    const u2 = u * u, u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * p0 + (u3 - 2 * u2 + u) * m0
         + (-2 * u3 + 3 * u2) * p1 + (u3 - u2) * m1;
}

export class CNodeGroundTrack extends CNodeTrack {
    constructor(v) {
        super(v);

        // Only "Ground Intersection" reads it, but declared as a real input either way: in that
        // mode the answer genuinely depends on where the camera was, so a change to the camera
        // track has to reach this node. The "3D Position" mode pays a recalculate it does not
        // need, which is affordable precisely because that mode is pure arithmetic.
        this.input("cameraLOSNode", true);      // optional

        this.frames = Sit.frames;
        this.useSitFrames = true;

        // {frame, lat, lon, alt} — geodetic, with ELLIPSOIDAL height, the same storage every
        // other picked position in Sitrec uses. An ECEF triple would silently mean somewhere
        // else if the earth model ever changed.
        this.keyframes = [];

        // Editing: handles drawn, and Ctrl+click in a 3D view claimed. Off by default, so a
        // sitch that carries a ground track does not have its 3D views quietly re-purposed.
        this.enabled = false;
        this.showTrack = true;
        this.curveType = "Spline";
        this.betweenPoints = BETWEEN_3D;
        // Place against the 3D tile geometry (roofs, walls) rather than the elevation surface.
        // On, for the same reason "Fit Camera to Points" has it on: the tiles are the surface
        // actually on screen, and that is the surface the object is silhouetted against.
        this.useTiles = true;
        this.useObjects = false;

        this.pointsText = "0";
        this.rangeText = "—";

        this.handles = new GroundTrackHandles3D({owner: this});
        KeyframeRegistry.register("groundTrack", {
            getFrames: () => this.keyframes.map((k) => k.frame),
        });

        this._undoBefore = null;
        this._pendingVisible = undefined;

        // Terrain streams in. Without this the baked elevations — and so the path, the lines of
        // sight and every traversal built on them — would keep whatever heights happened to be
        // loaded when the points were placed. Same contract every other terrain-dependent node
        // signs (CNodeSplineEdit, CNodeJetTrack, CNodePositionLLA); the event is coalesced to
        // one per animation frame by CNodeTerrain, and EventManager is cleared on sitch reload,
        // so there is nothing to unsubscribe.
        EventManager.addEventListener("elevationChanged", () => this.onElevationChanged());

        this._setupGUI();

        // Lazy: a ground track nobody looks at costs one flag, not Sit.frames elevation lookups.
        this._needsRecalculate = true;
    }

    dispose() {
        KeyframeRegistry.unregister("groundTrack");
        this.handles.dispose();
        super.dispose();
    }

    // ---------- the track itself ----------

    /** True once there is enough to define a line of sight — one point is a fixed direction. */
    hasTrack() {
        return this.keyframes.length > 0;
    }

    recalculate() {
        this._needsRecalculate = false;
        const n = Sit.frames;
        this.frames = n;
        this.array = new Array(n);

        const ks = [...this.keyframes].sort((a, b) => a.frame - b.frame);

        if (ks.length === 0) {
            // No keyframes: nothing to say. The array still has to exist and be finite —
            // CNodeTrack asserts on an empty one — so fill it with the ground at the sitch
            // origin. Nothing reads it: the LOS adapter falls back to the plain camera line of
            // sight when hasTrack() is false, and the overlay draws nothing.
            const home = LLAToECEF(Sit.lat, Sit.lon, elevationAtLL(Sit.lat, Sit.lon));
            for (let f = 0; f < n; f++) this.array[f] = {position: home.clone()};
            return;
        }

        const frames = ks.map((k) => k.frame);
        // Longitude is unwrapped against the first keyframe so a track that crosses the
        // antimeridian interpolates the short way round instead of racing back across the globe.
        const lat = ks.map((k) => k.lat);
        const lon = ks.map((k) => unwrapLongitude(k.lon, ks[0].lon));
        const alt = ks.map((k) => k.alt);
        const spline = this.curveType === "Spline";

        // The smooth curve through the placed positions. Both modes need it — one AS the answer,
        // the other as the fallback for a ray that finds no world to hit.
        const curveAt = (f) => LLAToECEF(sampleSeries(f, frames, lat, spline),
                                         sampleSeries(f, frames, lon, spline),
                                         sampleSeries(f, frames, alt, spline));

        // Not while a handle is under the cursor. Ground Intersection is a terrain raycast per
        // frame — measured at 392 ms against 11 ms for the curve on a 1378-frame span — and a
        // drag recalculates on every mouse move, so honouring it there would turn dragging into
        // a slideshow. The curve is the right stand-in: it agrees at the points, which is where
        // the handle being dragged is, and the real answer is recomputed on release (onCommit).
        if (this.betweenPoints === BETWEEN_GROUND && !this.handles?.isDragging
            && this.intersectGround(ks, frames, spline, curveAt)) {
            return;
        }
        for (let f = 0; f < n; f++) this.array[f] = {position: curveAt(f)};
    }

    /**
     * "Ground Intersection": interpolate the DIRECTION, then find where each ray meets the world.
     *
     * Fills this.array and returns true, or returns false without touching it when there is no
     * camera to cast from — in which case recalculate falls back to the 3D curve rather than to
     * nothing.
     *
     * Direction is carried as azimuth and elevation at the camera's own position. Two scalars, so
     * the same interpolation as everything else; independent of the camera's roll and of its
     * field of view, which is the property that makes a ground track worth having in the first
     * place. It is not literally screen space — a hard-rolling camera would differ — but for
     * anything else it is the same smooth sweep across the image.
     *
     * The placed points are written back verbatim rather than re-derived. A ray recast through
     * its own keyframe lands on the same spot only to within the refraction correction that
     * groundUnderCanvasPoint iterates out and a bare cast does not, and a point must never drift
     * off the place the user put it over a detail like that.
     */
    intersectGround(ks, frames, spline, curveAt) {
        const cameraLOS = this.in.cameraLOSNode;
        if (!cameraLOS) return false;

        const az = [], el = [];
        for (let i = 0; i < ks.length; i++) {
            const eye = cameraLOS.getValueFrame(frames[i])?.position;
            if (!eye) return false;
            const ground = LLAToECEF(ks[i].lat, ks[i].lon, ks[i].alt);
            const [a, e] = getAzElFromPositionAndForward(eye, ground.clone().sub(eye).normalize());
            az.push(a);
            el.push(e);
        }
        // Azimuth is a compass bearing, so a track passing north reads 359, 1 — unwrapped, or the
        // interpolation sweeps the long way round the horizon.
        unwrapDegrees(az);

        // view.camera, not a LOD-prepared one: the tiles pass reads only the layer mask.
        const camera = ViewMan.get("lookView", false)?.camera;
        const first = frames[0];
        const last = frames[frames.length - 1];

        for (let f = first; f <= last; f++) {
            const ki = frames.indexOf(f);
            if (ki >= 0) {
                this.array[f] = {position: LLAToECEF(ks[ki].lat, ks[ki].lon, ks[ki].alt)};
                continue;
            }
            const curve = curveAt(f);
            const eye = cameraLOS.getValueFrame(f)?.position;
            let hit = null;
            if (eye) {
                const dir = forwardFromAzEl(eye,
                                            sampleSeries(f, frames, az, spline),
                                            sampleSeries(f, frames, el, spline));
                hit = surfaceAlongRay(eye, dir, this.useTiles, camera, this.useObjects);
                if (hit && !rangesAgree(eye.distanceTo(hit), eye.distanceTo(curve))) hit = null;
            }
            // No hit, or one that skimmed past what it was aimed at (see RANGE_AGREEMENT): fall
            // back to the curve so the track stays continuous instead of teleporting.
            this.array[f] = {position: hit ?? curve};
        }

        // Outside the span the track holds, exactly as the 3D mode's sampleSeries does. Note it
        // holds the POSITION and not the direction: the camera keeps moving out there, so a held
        // direction would sweep the ground point across the landscape on its own, which is motion
        // invented from no evidence at all.
        for (let f = 0; f < first; f++) {
            this.array[f] = {position: this.array[first].position.clone()};
        }
        for (let f = last + 1; f < this.frames; f++) {
            this.array[f] = {position: this.array[last].position.clone()};
        }
        return true;
    }

    /**
     * Terrain arrived, or changed, under the track.
     *
     * Only "Ground Intersection" cares. The 3D mode reads no terrain at all once the points are
     * placed — the curve runs through the positions the user picked, and re-deriving those from
     * newly-arrived tiles would move points nobody moved, which is the same reason the camera fit
     * leaves its landmarks where they were put. So the mode with no terrain dependency does no
     * work here, and the mode that depends on terrain at every frame recalculates. There is no
     * useful guard between the two: unlike an elevation lookup, a raycast leaves behind no cheap
     * question to ask about whether its answer would still be the same.
     */
    onElevationChanged() {
        if (this.betweenPoints !== BETWEEN_GROUND || !this.hasTrack()) return;
        // Dirty first, for the same reason afterEdit does it: the cascade is entitled to skip a
        // track with nothing displaying it, and the overlay draws from the array either way.
        this._needsRecalculate = true;
        this.recalculateCascade();
        setRenderOne(true);
    }

    /** The ground point at frame f, or null when there is no track. */
    getGroundPosition(f) {
        if (!this.hasTrack()) return null;
        const i = Math.max(0, Math.min(this.frames - 1, Math.round(f)));
        return this.getValueFrame(i).position;
    }

    // ---------- what the 3D overlays ask for ----------

    getKeyframes() {
        // Straight from the stored lat/lon/alt, not from the computed array: this is where the
        // user PUT the point, and the array reproduces it exactly at the keyframe frame anyway.
        return this.keyframes.map((k) => ({
            frame: k.frame,
            position: LLAToECEF(k.lat, k.lon, k.alt),
        }));
    }

    /**
     * The drawn path: the keyframe span only.
     *
     * Outside it the track is held at an end keyframe (see sampleSeries), so drawing the whole
     * frame range would add thousands of samples all sitting on top of the first and last
     * handles — a lot of work to draw nothing, and a line that claims to describe frames it
     * knows nothing about.
     */
    getPathSamples() {
        // Recalculated FIRST: the span is clamped against this.frames, which only takes its
        // current value from a recalculate. A stale larger count would index past the array.
        this.ensureRecalculated();
        const span = this.getKeyframeSpan();
        if (span === null) return [];
        const [first, last] = span;
        const step = Math.max(1, Math.ceil((last - first) / MAX_PATH_SAMPLES));
        const out = [];
        for (let f = first; f < last; f += step) out.push(this.array[f].position);
        out.push(this.array[last].position);
        return out;
    }

    /** Frames actually covered by keyframes, as [first, last], or null if fewer than two. */
    getKeyframeSpan() {
        if (this.keyframes.length < 2) return null;
        const fr = this.keyframes.map((k) => k.frame).sort((a, b) => a - b);
        const first = Math.max(0, Math.min(this.frames - 1, fr[0]));
        const last = Math.max(0, Math.min(this.frames - 1, fr[fr.length - 1]));
        return last > first ? [first, last] : null;
    }

    getCurrentPoint() {
        return this.getGroundPosition(par.frame);
    }

    getUseTiles() { return this.useTiles; }
    getUseObjects() { return this.useObjects; }

    // ---------- edits ----------

    /** Place, or move, the keyframe for `frame`. Positions arrive as ECEF from the pick. */
    setPoint(frame, position) {
        const lla = ECEFToLLAVD_radii(position);
        const k = this.keyframes.find((q) => q.frame === frame);
        if (k) {
            k.lat = lla.x; k.lon = lla.y; k.alt = lla.z;
        } else {
            this.keyframes.push({frame, lat: lla.x, lon: lla.y, alt: lla.z});
            this.keyframes.sort((a, b) => a.frame - b.frame);
        }
        this.afterEdit();
    }

    deletePoint(frame) {
        const before = this.keyframes.length;
        this.withUndo("Delete ground track point", () => {
            this.keyframes = this.keyframes.filter((k) => k.frame !== frame);
        });
        if (this.keyframes.length !== before) this.afterEdit();
    }

    deleteCurrentPoint() {
        this.deletePoint(Math.round(par.frame));
    }

    /**
     * Pull the A/B analysis limits in around the keyframes, with a little air either side.
     *
     * The same convenience the manual tracking overlay offers, and it matters more here:
     * outside the span the line of sight is held, so every graph and traversal beyond the
     * keyframes is describing a frame the track knows nothing about.
     */
    limitABToTrack() {
        const span = this.getKeyframeSpan();
        if (span === null) return;
        const [first, last] = span;
        const margin = (last - first) / 10;
        Sit.aFrame = Math.max(0, Math.floor(first - margin));
        Sit.bFrame = Math.min(Sit.frames - 1, Math.ceil(last + margin));
        NodeMan.recalculateAllRootFirst();
        setRenderOne(true);
    }

    clearPoints() {
        if (this.keyframes.length === 0) return;
        this.withUndo("Clear ground track", () => {
            this.keyframes = [];
        });
        this.afterEdit();
    }

    /** The drag is over, so the expensive mode can have its proper answer back. */
    onCommit() {
        if (this.betweenPoints === BETWEEN_GROUND) this.afterEdit();
    }

    /**
     * Recompute the track and push the change downstream — the traverse depends on it.
     *
     * The dirty flag is NOT redundant with the cascade, and this is the trap. CNodeTrack sets
     * checkDisplayOutputs, so recalculateCascade skips a track with no DISPLAY node downstream —
     * and while the LOS Source is anything other than "Camera + Ground Track", this track has
     * none: its only consumer is groundTrackLOS, behind an unselected switch. So the cascade
     * declined, this.array kept its old values, and moving a point moved the HANDLE (drawn from
     * this.keyframes) while the drawn spline (drawn from this.array) sat still.
     *
     * Marking it dirty first fixes that without giving up the optimisation: if the cascade does
     * recalculate, it clears the flag and nothing is done twice; if it declines, the flag
     * survives and the next getPathSamples/getValueFrame rebuilds lazily, which is exactly when
     * the answer is actually wanted.
     */
    afterEdit() {
        this._needsRecalculate = true;
        this.pointsText = String(this.keyframes.length);
        // The elevation cache is deliberately NOT cleared: it validates every entry against the
        // location it was measured at, so entries for frames the edit did not move are still
        // good, and the ones it did move recompute themselves on the recalculate below.
        this.recalculateCascade();
        setRenderOne(true);
    }

    // ---------- undo ----------

    captureState() {
        return JSON.stringify(this.keyframes);
    }

    restoreState(state) {
        this.keyframes = JSON.parse(state);
        this.afterEdit();
    }

    onBeginEdit() {
        this._undoBefore = this.captureState();
    }

    onEndEdit(description) {
        const before = this._undoBefore;
        this._undoBefore = null;
        if (before === undefined || before === null) return;
        const after = this.captureState();
        if (before === after) return;                   // a grab-and-release that moved nothing
        UndoManager?.add({
            undo: () => this.restoreState(before),
            redo: () => this.restoreState(after),
            description,
        });
    }

    withUndo(description, fn) {
        this.onBeginEdit();
        fn();
        this.onEndEdit(description);
    }

    // ---------- readouts ----------

    /**
     * Range from the camera to the ground point at the current frame.
     *
     * The number this whole feature exists to produce: the object is somewhere on this line and
     * cannot be past the far end of it, so this is a hard ceiling on its distance.
     *
     * Recomputed every frame the track is on screen rather than cached against the frame number.
     * A cache keyed on the frame goes stale in every other direction — the camera track edited,
     * the platform position moved, a point dragged, the unit system switched — and a distance
     * readout that is silently wrong is worse than no readout. The cost is one extra evaluation
     * of the camera line-of-sight node per rendered frame, which the traverse downstream already
     * makes thousands of; the real saving is the gate below, which is why an unused ground track
     * pays nothing at all.
     */
    updateRange() {
        const f = Math.round(par.frame);
        const ground = this.getGroundPosition(f);
        const cameraLOS = NodeMan.get("JetLOSCameraCenter", false);
        if (!ground || !cameraLOS) {
            this.rangeText = "—";
            return;
        }
        const los = cameraLOS.getValueFrame(f);
        if (!los || !los.position) {
            this.rangeText = "—";
            return;
        }
        this.rangeText = formatDistance(los.position.distanceTo(ground));
    }

    update(f) {
        if (super.update) super.update(f);

        // Deferred from modDeserialize. Showing the track builds two overlay VIEWS, and
        // creating views from inside the mod pass corrupts it — CNodeFitCameraPoints found
        // this the expensive way, with 17 unrelated nodes silently losing their restored
        // state. Record the wish there, grant it here.
        if (this._pendingVisible !== undefined && !Globals.deserializing) {
            this._pendingVisible = undefined;
            this.syncOverlays();
        }

        // Only while there is a track AND something is showing it. With no points placed this
        // is free, which is the state every sitch that never opens the feature stays in.
        if (this.hasTrack() && (this.enabled || this.showTrack)) this.updateRange();
        else this.rangeText = "—";
    }

    // ---------- GUI ----------

    syncOverlays() {
        this.handles.setVisible(this.enabled || (this.showTrack && this.hasTrack()));
    }

    _setupGUI() {
        const parent = guiMenus.traverse;
        if (!parent) return;
        this.gui = parent.addFolder("Ground Track").close();

        this.gui.add(this, "enabled").name("Enable Ground Track").listen()
            .onChange(() => this.syncOverlays())
            .tooltip("Place points on the GROUND behind the object, in the Look view or the " +
                "Main view.\n\nCtrl+click places (or moves) the point for the current frame.\n" +
                "Clicking an unselected point SELECTS it — it goes to that point's frame and " +
                "moves nothing. Clicking and dragging the selected point (the red one) moves " +
                "it. Alt+click deletes a point. Dragging empty space still orbits the view.\n\n" +
                "Select 'Camera + Ground Track' as the LOS Source to use the result for " +
                "traversals.");

        this.gui.add(this, "showTrack").name("Show Track").listen()
            .onChange(() => this.syncOverlays())
            .tooltip("Draw the interpolated ground path, and a cross at the point for the " +
                "current frame, even when editing is off.");

        this.gui.add(this, "curveType", ["Spline", "Linear"]).name("Interpolation").listen()
            .onChange(() => this.afterEdit())
            .tooltip("How the ground point moves BETWEEN keyframes. Spline is smooth; Linear " +
                "goes straight from one to the next. Outside the keyframes the track holds " +
                "still at the first or last point — there is no evidence out there, so read " +
                "the track between the points you placed.");

        this.gui.add(this, "betweenPoints", BETWEEN_MODES).name("Between Points").listen()
            .onChange(() => this.afterEdit())
            .tooltip("What happens BETWEEN the points you placed. Your points never move either " +
                "way.\n\n3D Position runs a smooth curve through them and leaves it there — " +
                "cheap, and the line of sight stays smooth, but over a bay the curve flies " +
                "across at clifftop height rather than following the shore.\n\nGround " +
                "Intersection sweeps the DIRECTION smoothly instead and finds where each of " +
                "those lines of sight actually meets the ground, so every frame is a real place " +
                "with a real range. It costs a terrain ray per frame.");

        this.gui.add(this, "useTiles").name("Place on 3D Tiles")
            .tooltip("Place points against the 3D building geometry — roofs, walls, trees — " +
                "rather than the smooth elevation map. Falls back to the elevation map where " +
                "no tiles are loaded.");

        this.gui.add(this, "useObjects").name("Place on Objects")
            .tooltip("Also place points on the scene's own 3D objects (an aircraft, a balloon). " +
                "Off by default: a ground track is meant to land on the ground.");

        this.gui.add(this, "deleteCurrentPoint").name("Delete Point at Frame")
            .tooltip("Delete the ground track point for the current frame, if there is one.");

        this.gui.add(this, "clearPoints").name("Clear All Points")
            .tooltip("Delete every ground track point.");

        this.gui.add(this, "limitABToTrack").name("Limit A/B to Track")
            .tooltip("Move the A and B analysis limits to just outside the first and last " +
                "ground point, so graphs and traversals cover only the frames the track " +
                "actually describes.");

        this.gui.add(this, "pointsText").name("Points").listen().disable()
            .tooltip("How many ground points have been placed.");

        this.gui.add(this, "rangeText").name("Ground Range").listen().disable()
            .tooltip("Distance from the camera to the ground point at the current frame. The " +
                "object is somewhere on that line, so it cannot be further away than this.");
    }

    // ---------- serialization ----------

    modSerialize() {
        return {
            ...super.modSerialize(),
            enabled: this.enabled,
            showTrack: this.showTrack,
            curveType: this.curveType,
            betweenPoints: this.betweenPoints,
            useTiles: this.useTiles,
            useObjects: this.useObjects,
            keyframes: this.keyframes.map((k) => ({
                frame: k.frame, lat: k.lat, lon: k.lon, alt: k.alt,
            })),
        };
    }

    modDeserialize(v) {
        super.modDeserialize(v);
        if (v.enabled !== undefined) this.enabled = v.enabled;
        if (v.showTrack !== undefined) this.showTrack = v.showTrack;
        if (v.curveType !== undefined) this.curveType = v.curveType;
        if (BETWEEN_MODES.includes(v.betweenPoints)) this.betweenPoints = v.betweenPoints;
        else if (v.snapToTerrain !== undefined) {
            // Legacy. "Follow Terrain" re-snapped the INTERPOLATED points onto the ground, which
            // injected the terrain profile — a dive to the shoreline, a climb back up a cliff —
            // straight into the line of sight. Both of its settings are superseded, so an old
            // save comes back on the current default rather than either of them.
            console.warn("CNodeGroundTrack: dropping legacy 'Follow Terrain' setting; "
                + "interpolation is now '" + this.betweenPoints + "'");
        }
        if (v.useTiles !== undefined) this.useTiles = v.useTiles;
        if (v.useObjects !== undefined) this.useObjects = v.useObjects;
        if (Array.isArray(v.keyframes)) {
            this.keyframes = v.keyframes
                .filter((k) => Number.isFinite(k.frame) && Number.isFinite(k.lat)
                            && Number.isFinite(k.lon) && Number.isFinite(k.alt))
                .map((k) => ({frame: Math.round(k.frame), lat: k.lat, lon: k.lon, alt: k.alt}))
                .sort((a, b) => a.frame - b.frame);
        }
        this.pointsText = String(this.keyframes.length);
        this._needsRecalculate = true;
        // See update() — the overlays cannot be built from inside the mod pass.
        this._pendingVisible = true;
        setRenderOne(true);
    }
}

/**
 * A direction from an azimuth and elevation at a position — the inverse of
 * getAzElFromPositionAndForward, and built on the same local basis so the two round-trip.
 */
function forwardFromAzEl(position, azDegrees, elDegrees) {
    const up = getLocalUpVector(position);
    const north = getLocalNorthVector(position);
    const northH = north.clone().sub(up.clone().multiplyScalar(north.dot(up))).normalize();
    const east = northH.clone().cross(up).normalize();
    const az = radians(azDegrees);
    const el = radians(elDegrees);
    const cosEl = Math.cos(el);
    return northH.multiplyScalar(cosEl * Math.cos(az))
        .addScaledVector(east, cosEl * Math.sin(az))
        .addScaledVector(up, Math.sin(el))
        .normalize();
}

/** Whether a raycast range is close enough to the curve's to be believed. See RANGE_AGREEMENT. */
function rangesAgree(hitRange, curveRange) {
    if (!(curveRange > 0)) return true;
    const ratio = hitRange / curveRange;
    return ratio > 1 / RANGE_AGREEMENT && ratio < RANGE_AGREEMENT;
}

/** Make a series of degrees continuous, so interpolation never takes the long way round. */
function unwrapDegrees(values) {
    for (let i = 1; i < values.length; i++) {
        while (values[i] - values[i - 1] > 180) values[i] -= 360;
        while (values[i] - values[i - 1] < -180) values[i] += 360;
    }
}

/** Bring `lon` within half a turn of `reference`, so interpolation takes the short way round. */
function unwrapLongitude(lon, reference) {
    let out = lon;
    while (out - reference > 180) out -= 360;
    while (out - reference < -180) out += 360;
    return out;
}

/** Metres in the user's units — small units below one big unit, as the tracking overlay does. */
function formatDistance(metres) {
    if (!Number.isFinite(metres)) return "—";
    if (metres < Units.big.toM) {
        return (metres / Units.small.toM).toFixed(1) + " " + Units.small.abbrev;
    }
    return (metres / Units.big.toM).toFixed(3) + " " + Units.big.abbrev;
}
