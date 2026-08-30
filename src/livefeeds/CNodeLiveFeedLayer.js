/**
 * CNodeLiveFeedLayer — one generic instanced marker layer, driven by a
 * LiveFeedRegistry entry.
 *
 * The ADS-B traffic layer stays separate on purpose: aircraft need dead
 * reckoning between polls, trails, and click-to-promote, none of which apply to
 * an earthquake or a launch pad. What the OTHER feeds have in common is exactly
 * this — poll a proxy, parse to points, draw markers, report status — so they
 * share one implementation and differ only by their table entry.
 *
 * NOT SERIALIZED: no modSerialize, so CustomManagerSerialize never writes these
 * into a save. That is right for a view of the live present, and it is also what
 * lets this file live outside src/nodes/ and load as its own webpack chunk. A
 * node under src/nodes/ is swept into the main bundle by RegisterNodes'
 * require.context whatever the import says.
 */

import {
    BoxGeometry, Color, ConeGeometry, DynamicDrawUsage, InstancedMesh, Matrix4,
    MeshBasicMaterial, OctahedronGeometry, Quaternion, SphereGeometry, Vector3,
} from "three";
import {CNode3DGroup} from "../nodes/CNode3DGroup";
import * as LAYER from "../LayerMasks";
import {NodeMan, setRenderOne} from "../Globals";
import {ViewMan} from "../CViewManager";
import {LLAToECEFInto} from "../LLA-ECEF-ENU";
import {getLocalNorthVector, getLocalUpVector} from "../SphericalMath";
import {meanSeaLevelOffset} from "../EGM96Geoid";
import {fetchLiveFeed} from "./LiveFeedFetch";
import {dispose} from "../threeExt";

const MAX_MARKERS = 2048;

// Apparent marker size as a fraction of distance from the camera — the same
// constant-screen-size trick the traffic layer uses, and for the same reason:
// one view has to serve a close approach and a whole hemisphere, and no fixed
// metric size works for both.
// Deliberately smaller than the ADS-B layer's 0.011. That layer draws ~100
// directional darts whose heading has to be readable; these feeds draw over a
// thousand markers at once (1009 ships and 809 webcams in the Baltic), and at
// the aircraft size they merge into a mass that hides the map underneath. About
// 0.2 degrees stays legible individually while a dense field still reads as
// dense.
const SCREEN_SIZE_FACTOR = 0.0035;
const MIN_MARKER_METRES = 30;
const MAX_MARKER_METRES = 6000;

// Up-axis of every marker geometry below, so orientation is one setFromUnitVectors.
const MARKER_UP = new Vector3(0, 1, 0);

// A hung request must not stall a layer forever: the in-flight guard skips polls
// while one is outstanding, so a fetch that never settles means no poll ever runs
// again — with nothing thrown and nothing shown.
const POLL_TIMEOUT_MS = 25000;
const MAX_BACKOFF_STEPS = 4;

/**
 * Marker geometries, one shared instance per shape.
 *
 * Shape carries meaning here rather than being decoration: with several layers
 * on at once, colour alone stops being enough to tell a ship from a webcam at a
 * glance, and colour-blind viewers lose the distinction entirely.
 */
function makeGeometry(shape) {
    switch (shape) {
        case 'dart':
            // Directional: points along its course, like the ADS-B darts.
            return new ConeGeometry(0.35, 1.4, 4).translate(0, -0.2, 0);
        case 'cone':
            return new ConeGeometry(0.5, 1.2, 8);
        case 'box':
            return new BoxGeometry(0.7, 0.35, 1.4);
        case 'sphere':
            return new SphereGeometry(0.5, 8, 6);
        case 'octahedron':
        default:
            return new OctahedronGeometry(0.6);
    }
}

export class CNodeLiveFeedLayer extends CNode3DGroup {
    /**
     * @param {object} v
     * @param {object} v.feed  the LiveFeedRegistry entry this layer draws.
     */
    constructor(v) {
        // HELPERS: visible in the main analyst view, absent from the look camera's
        // recreation, where a live overlay would be mistaken for part of the scene
        // being argued about.
        v.layers ??= LAYER.MASK_HELPERS;
        super(v);

        this.feed = v.feed;
        this.markers = [];
        this.polling = false;
        this.pollTimer = null;
        this.inFlight = null;
        this.lastError = null;
        this.stale = false;
        this.consecutiveFailures = 0;
        this.nextPollAllowedMs = 0;
        this.selected = null;
        this.selectedUntilMs = 0;

        this._buildMesh();

        this._scratchMatrix = new Matrix4();
        this._scratchScale = new Vector3();
        this._scratchQuat = new Quaternion();
        this._scratchColor = new Color();
        this._scratchScreen = new Vector3();
        this._cameraPos = null;
    }

    get group() {
        return this._object;
    }

    _buildMesh() {
        // No vertexColors on the material: per-instance colour comes from the
        // instanceColor attribute setColorAt creates, and that drives the shader on
        // its own. Adding vertexColors would ALSO make it expect a per-vertex
        // colour attribute the shared geometry does not have, rendering every
        // marker black.
        this.instances = new InstancedMesh(
            makeGeometry(this.feed.shape), new MeshBasicMaterial(), MAX_MARKERS);
        this.instances.instanceMatrix.setUsage(DynamicDrawUsage);
        this.instances.count = 0;
        this.instances.frustumCulled = false;
        this.group.add(this.instances);
    }

    // ── Polling ──────────────────────────────────────────────────────────────

    start() {
        if (this.polling) return;
        this.polling = true;
        this.group.visible = true;
        this._poll();
        this.pollTimer = setInterval(() => this._poll(), Math.min(this.feed.pollMs, 60000));
    }

    stop() {
        this.polling = false;
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        // A request already on the wire would otherwise land after the user turned
        // the layer off and repopulate it.
        this.inFlight?.abort();
        this.inFlight = null;
        this.markers = [];
        this.instances.count = 0;
        // Toggling off and on is the user asking to try NOW, so a backoff left
        // over from an earlier outage must not silently delay the retry.
        this.consecutiveFailures = 0;
        this.nextPollAllowedMs = 0;
        this.lastError = null;
        this.group.visible = false;
        setRenderOne(true);
    }

    async _poll() {
        if (!this.polling || this.inFlight) return;
        if (performance.now() < this.nextPollAllowedMs) return;
        // pollMs can be far longer than the timer interval (webcams are 15
        // minutes), so the interval fires often and this declines the ones that
        // are not due. One timer, any cadence.
        if (this.lastPollMs && performance.now() - this.lastPollMs < this.feed.pollMs) return;

        const controller = new AbortController();
        this.inFlight = controller;
        const timeout = setTimeout(() => {
            controller.timedOut = true;
            controller.abort();
        }, POLL_TIMEOUT_MS);

        try {
            const result = await fetchLiveFeed(this.feed.id, {signal: controller.signal});
            if (!this.polling) return;
            this.lastPollMs = performance.now();
            this.markers = this.feed.parse(result.json) || [];
            this.stale = !!result.stale;
            this.lastError = null;
            this.consecutiveFailures = 0;
            this.nextPollAllowedMs = 0;
            this._rebuild();
        } catch (e) {
            if (e?.name === 'AbortError') {
                // stop() aborts too, and that one is not a failure worth reporting.
                if (controller.timedOut) {
                    this.lastError = "the feed did not respond in time";
                    this._backOff();
                }
                return;
            }
            // Existing markers are kept rather than cleared: one dropped request is
            // far likelier than every ship in the Baltic vanishing at once.
            this.lastError = e?.message || String(e);
            console.warn(`Live feed '${this.feed.id}' poll failed:`, this.lastError);
            this._backOff();
        } finally {
            clearTimeout(timeout);
            if (this.inFlight === controller) this.inFlight = null;
        }
    }

    _backOff() {
        this.consecutiveFailures = Math.min(this.consecutiveFailures + 1, MAX_BACKOFF_STEPS);
        const delay = this.feed.pollMs * Math.pow(2, this.consecutiveFailures);
        this.nextPollAllowedMs = performance.now() + delay;
    }

    // ── Drawing ──────────────────────────────────────────────────────────────

    /**
     * Marker position in ECEF.
     *
     * The datum conversion is the part that has to be right. LLAToECEF wants
     * height above the ellipsoid; a GPS altitude already is one, while anything
     * conventionally referenced to sea level needs the geoid separation added —
     * tens of metres in most of the world. A null altitude means "at the surface",
     * where the geoid height IS the answer, and a hardcoded 0 would put the marker
     * below ground across most of the planet.
     */
    _toECEF(marker, target) {
        const out = target || new Vector3();
        const geoid = meanSeaLevelOffset(marker.lat, marker.lon);
        let altitudeHAE;
        if (marker.altitudeM === null || marker.altitudeM === undefined) {
            altitudeHAE = geoid;
        } else if (marker.altitudeIsHAE) {
            altitudeHAE = marker.altitudeM;
        } else {
            altitudeHAE = marker.altitudeM + geoid;
        }
        return LLAToECEFInto(marker.lat, marker.lon, altitudeHAE, out);
    }

    _rebuild() {
        this._updateCameraPos();
        this._scratchColor.setHex(this.feed.color);

        let index = 0;
        for (const marker of this.markers) {
            if (index >= MAX_MARKERS) break;
            marker.ecef = this._toECEF(marker, marker.ecef);
            // A heading is only meaningful for the directional shapes; for the
            // rest the identity leaves the marker axis-aligned to local up, which
            // is what an earthquake or a launch pad should look like.
            marker.quaternion = this._orientation(marker, marker.quaternion);
            this._writeInstance(index, marker);
            this.instances.setColorAt(index,
                marker.color !== undefined
                    ? this._scratchColor.setHex(marker.color)
                    : this._scratchColor.setHex(this.feed.color));
            index++;
        }

        this.instances.count = index;
        this.instances.instanceMatrix.needsUpdate = true;
        if (this.instances.instanceColor) this.instances.instanceColor.needsUpdate = true;
        setRenderOne(true);
    }

    /**
     * Stand the marker up along the local vertical, and turn it to its heading if
     * it has one.
     *
     * Local up, not a global axis: in ECEF there is no single "up" or "north", so
     * a shared basis would leave markers in the southern hemisphere lying on their
     * sides or pointing into the ground.
     */
    _orientation(marker, target) {
        const q = target || new Quaternion();
        const up = getLocalUpVector(marker.ecef);
        if (marker.headingDeg === null || marker.headingDeg === undefined) {
            q.setFromUnitVectors(MARKER_UP, up);
            return q;
        }
        const north = getLocalNorthVector(marker.ecef);
        // Course is clockwise from north, which is NEGATIVE about the up axis in a
        // right-handed frame.
        const nose = north.applyAxisAngle(up, -marker.headingDeg * Math.PI / 180).normalize();
        q.setFromUnitVectors(MARKER_UP, nose);
        return q;
    }

    _writeInstance(index, marker) {
        const distance = this._cameraPos
            ? this._cameraPos.distanceTo(marker.ecef)
            : 1 / SCREEN_SIZE_FACTOR;
        const size = Math.min(MAX_MARKER_METRES,
            Math.max(MIN_MARKER_METRES, distance * SCREEN_SIZE_FACTOR))
            * (marker.sizeScale ?? 1);
        this._scratchScale.setScalar(size);
        this._scratchMatrix.compose(marker.ecef, marker.quaternion, this._scratchScale);
        this.instances.setMatrixAt(index, this._scratchMatrix);
    }

    _updateCameraPos() {
        const cameraNode = NodeMan.exists("mainCamera") ? NodeMan.get("mainCamera") : null;
        const p = cameraNode?.camera?.position;
        if (p) {
            this._cameraPos = this._cameraPos || new Vector3();
            this._cameraPos.copy(p);
        }
    }

    /**
     * Marker size depends on distance from the camera, so instances have to be
     * re-placed when the CAMERA moves, not only when the data changes.
     *
     * No setRenderOne here, unlike the traffic layer: nothing in these feeds moves
     * between polls, so the only thing that can change a marker on screen is a
     * camera move — which already requests its own repaint. Asking again would
     * hold the render loop hot for nothing.
     */
    update(f) {
        super.update(f);
        if (!this.polling || this.markers.length === 0) return;
        this._updateCameraPos();
        let index = 0;
        for (const marker of this.markers) {
            if (index >= MAX_MARKERS) break;
            if (!marker.ecef) continue;
            this._writeInstance(index, marker);
            index++;
        }
        this.instances.instanceMatrix.needsUpdate = true;
    }

    // ── Picking ──────────────────────────────────────────────────────────────

    /**
     * The marker nearest a screen point. Screen-space proximity rather than a mesh
     * raycast, matching findClosestTrack() and the ADS-B layer, so everything in
     * the scene behaves the same way under the cursor.
     */
    findMarkerAtScreen(view, mouseX, mouseY, thresholdPx = 16) {
        if (!this.polling || !view?.camera || !this.group.visible) return null;
        let best = null;
        let bestDistance = thresholdPx;
        const containerOffsetX = ViewMan.screenOffsetX || 0;

        for (const marker of this.markers) {
            if (!marker.ecef) continue;
            this._scratchScreen.copy(marker.ecef).project(view.camera);
            // Behind the camera: project() still returns plausible mirrored x/y
            // there, so without this a marker behind you is clickable.
            if (this._scratchScreen.z > 1) continue;
            const sx = (this._scratchScreen.x * 0.5 + 0.5) * view.widthPx + view.leftPx + containerOffsetX;
            const sy = (1 - (this._scratchScreen.y * 0.5 + 0.5)) * view.heightPx + view.topPx;
            const distance = Math.hypot(mouseX - sx, mouseY - sy);
            if (distance < bestDistance) {
                bestDistance = distance;
                best = {marker, feed: this.feed, distancePx: distance};
            }
        }
        return best;
    }

    /**
     * Remember the marker the user just clicked, so the readout can describe it.
     *
     * Times out rather than latching: a stale "you clicked this" line sitting
     * under a live count would be read as current state. Ten seconds is long
     * enough to read a ship's speed and course and short enough not to mislead.
     */
    setSelected(marker) {
        this.selected = marker;
        this.selectedUntilMs = performance.now() + 10000;
    }

    /** What the menu readout shows: enough to tell working from broken. */
    status() {
        if (!this.polling) return "off";
        if (this.selected && performance.now() < this.selectedUntilMs) {
            return `${this.selected.label}${this.selected.detail ? " — " + this.selected.detail : ""}`;
        }
        if (this.lastError) return `error: ${this.lastError}`;
        // Before the first poll answers there is no result yet, and saying "none"
        // would claim one. Same class of lie as reporting stale data as current.
        if (!this.lastPollMs) return "loading…";
        const count = this.markers.length;
        // Staleness changes the wording rather than adding a suffix, and is
        // reported BEFORE the count: a stale empty result presented as a confident
        // "none" is the one state a status line must never hide.
        if (this.stale) {
            return count === 0
                ? "feed unreachable — nothing current"
                : `${count} (stale — feed unreachable)`;
        }
        if (count === 0) return "none";
        return String(count);
    }

    dispose() {
        this.stop();
        this.group.remove(this.instances);
        dispose(this.instances);
        super.dispose();
    }
}
