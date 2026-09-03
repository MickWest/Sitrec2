/**
 * CNodeADSBLiveTraffic — every aircraft adsb.lol can currently see near the
 * sitch origin, drawn as one lightweight layer.
 *
 * ONE node for the whole sky, not one per aircraft. A busy area returns 130+
 * aircraft and a quiet one a handful, and the count changes every poll; giving
 * each its own CNodeTrack, CNodeDisplayTrack, CNode3DObject and GUI folder
 * would mean hundreds of nodes churning several times a minute, with a per-frame
 * getValue cost and a saved sitch carrying the lot. Instead the whole layer is
 * two draw calls: one InstancedMesh of aircraft darts and one LineSegments of
 * trails. Individual aircraft are promoted to real tracks on demand, through the
 * existing "Import ADS-B Track..." path, which fetches that one aircraft's full
 * 24-hour trace.
 *
 * NOT SERIALIZED, deliberately. CustomManagerSerialize writes "anything with a
 * modSerialize function", so defining none keeps this layer out of every save —
 * which is right for a view of the live present, and is also what lets the file
 * live outside src/nodes/ and load as its own webpack chunk (see the dynamic
 * import in CustomManagerSetup.js). A node under src/nodes/ would be pulled into
 * the main bundle by RegisterNodes' require.context whatever the import said.
 *
 * Data license: adsb.lol data is ODbL — credit "adsb.lol". Fetched live,
 * never bundled.
 */

import {
    BufferAttribute, BufferGeometry, Color, ConeGeometry, DynamicDrawUsage,
    DoubleSide, InstancedMesh, LineBasicMaterial, LineSegments, MeshBasicMaterial,
    Matrix4, Quaternion, Vector3,
} from "three";
import {CNode3DGroup} from "../nodes/CNode3DGroup";
import * as LAYER from "../LayerMasks";
import {FileManager, NodeMan, setRenderOne, Sit} from "../Globals";
import {ViewMan} from "../CViewManager";
import {ECEFToLLA_radii, LLAToECEFInto} from "../LLA-ECEF-ENU";
import {getLocalNorthVector, getLocalUpVector} from "../SphericalMath";
import {meanSeaLevelOffset} from "../EGM96Geoid";
import {fetchLiveTraffic} from "../ADSBLiveFetch";
import {dispose} from "../threeExt";
import {getLiveFeedOverlay} from "../livefeeds/LiveFeedOverlay";
import {formatLatLon} from "../CoordinateFormat";

// The feed updates about once a second, but polling that fast is neither
// necessary nor polite: the proxy caches for 5 s, so anything quicker just
// re-reads the same cache entry. Motion between polls is dead-reckoned, so the
// display stays smooth at this rate.
const POLL_INTERVAL_MS = 5000;

// A poll that has not answered in this long is abandoned. Without it a single
// hung request stalls the layer FOREVER: _poll() skips while one is in flight,
// so a fetch that never settles means no poll ever runs again — and because
// nothing threw, the readout goes on saying "no aircraft in range", which is the
// one thing it exists to distinguish from a working empty sky. Three poll
// intervals, so a merely slow network still gets its answer.
const POLL_TIMEOUT_MS = 15000;

// After a failure the next poll is delayed by INTERVAL * 2^failures, capped.
// adsb.lol is volunteer-run and free, and an outage is exactly the moment it can
// least afford a browser retrying every five seconds forever. It also stops a
// tab left open overnight burning the proxy's rate limit against a dead feed.
const MAX_BACKOFF_STEPS = 4;   // 5s -> 10 -> 20 -> 40 -> 80s

// A position older than this is dropped rather than drawn. The feed includes
// aircraft last heard some time ago, and dead-reckoning a minute-old position
// at 500 knots puts the aircraft eight miles from where it is — better to show
// nothing than to show a confident lie.
const MAX_POSITION_AGE_SEC = 60;

// How many past positions each aircraft's trail keeps. At one point per poll
// this is a little over two minutes of history — enough to read a turn, small
// enough that 200 aircraft cost 200 x 25 x 2 vertices.
const TRAIL_POINTS = 25;

// Room to grow without reallocating the InstancedMesh every time a busy area
// gains an aircraft. Above this the extra aircraft are not drawn, and the count
// is reported so the cap is visible rather than mysterious.
const MAX_AIRCRAFT = 512;

const KNOTS_TO_MPS = 0.514444;

// The dart geometry's nose axis. A module constant, not a fresh Vector3 per
// call: setFromUnitVectors is called once per aircraft per poll.
const DART_NOSE = new Vector3(0, 1, 0);
// The silhouette is drawn flat in XY, so its "up" — the axis that must be laid
// onto the local vertical — is +Z.
const SHAPE_UP = new Vector3(0, 0, 1);

// Apparent size of an aircraft marker, as a fraction of its distance from the
// camera — roughly 0.6 degrees, about the size of a fingernail at arm's length.
// Big enough to see and to read a heading from, small enough that a hundred of
// them over a city do not merge into one mass.
const SCREEN_SIZE_FACTOR = 0.011;
// Clamps in metres, so a marker never collapses to nothing up close nor becomes
// a landmark in its own right at the horizon.
const MIN_DART_METRES = 60;
const MAX_DART_METRES = 4000;

// Altitude bands for colour, in feet. Reading altitude off a colour is the one
// thing a flat overhead view cannot otherwise convey, and matching the bands
// most tar1090 users already know means the layer needs no legend to be useful.
const ALTITUDE_COLORS = [
    {maxFt: 1000, color: 0xff2d2d},
    {maxFt: 5000, color: 0xff8c1a},
    {maxFt: 10000, color: 0xffe01a},
    {maxFt: 20000, color: 0x6ee01a},
    {maxFt: 30000, color: 0x1ad0ff},
    {maxFt: Infinity, color: 0x9a7dff},
];

function colorForAltitude(altitudeM, onGround) {
    if (onGround) return 0x999999;
    if (altitudeM === null) return 0x999999;
    const ft = altitudeM / 0.3048;
    for (const band of ALTITUDE_COLORS) {
        if (ft < band.maxFt) return band.color;
    }
    return 0xffffff;
}

/**
 * A flat aircraft silhouette — fuselage, swept wings, tailplane — nose along +Y,
 * lying in the XY plane so it reads as a plan view from above.
 *
 * A shape rather than the cone this started as, because at a glance the shape is
 * what says "aircraft" and, more usefully, which way it is pointing. A cone read
 * as a blob at the sizes these are drawn. Still ONE shared geometry across every
 * instance — no per-type models — so it stays the cheap "simplified object" the
 * layer is built around.
 *
 * Two-sided and unlit: seen from below it must not vanish, and there is no
 * lighting worth respecting on a marker whose colour encodes altitude.
 */
function makeAircraftGeometry() {
    // Half-width, so the silhouette spans 1.0 across the wings and ~1.4 nose to
    // tail; the instance scale then means "size on screen" in one number.
    const v = [
        // fuselage
        [0, 0.7], [-0.075, -0.55], [0.075, -0.55],
        // port wing (swept back)
        [-0.03, 0.16], [-0.5, -0.3], [-0.03, -0.12],
        // starboard wing
        [0.03, 0.16], [0.03, -0.12], [0.5, -0.3],
        // tailplane
        [-0.22, -0.62], [0.22, -0.62], [0, -0.4],
    ];
    const positions = new Float32Array(v.length * 3);
    for (let i = 0; i < v.length; i++) {
        positions[i * 3] = v[i][0];
        positions[i * 3 + 1] = v[i][1];
        positions[i * 3 + 2] = 0;
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    // Wound so all four triangles face +Z; the material is DoubleSide anyway, so
    // the plan view is correct from above and from below.
    geometry.setIndex([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    geometry.computeVertexNormals();
    return geometry;
}

export class CNodeADSBLiveTraffic extends CNode3DGroup {
    constructor(v) {
        // HELPERS keeps the layer in the main (analyst) view and out of the look
        // camera's recreation, which is where a synthetic overlay would be
        // mistaken for part of the reconstruction being argued about.
        v.layers ??= LAYER.MASK_HELPERS;
        super(v);

        this.radiusNM = v.radiusNM ?? 50;
        this.showTrails = v.showTrails ?? true;

        // hex -> {aircraft record, ecef Vector3, trail: Vector3[], lastSeenMs}
        this.aircraft = new Map();

        this.polling = false;
        this.pollTimer = null;
        this.inFlight = null;
        this.lastPollMs = 0;
        this.lastCenter = null;
        this.lastRadiusNM = null;
        this.lastError = null;
        this.stale = false;
        this.promoting = null;
        this.consecutiveFailures = 0;
        this.nextPollAllowedMs = 0;

        this._buildMeshes();

        // Scratch objects, reused every frame. At 130 aircraft x 60 fps a fresh
        // Vector3 per aircraft per frame is ~8000 allocations a second for
        // nothing; the render loop is exactly where that matters.
        this._scratchMatrix = new Matrix4();
        this._scratchScale = new Vector3();
        this._scratchColor = new Color();
    }

    _buildMeshes() {
        const dart = makeAircraftGeometry();
        // NO vertexColors here, deliberately. On an InstancedMesh the per-instance
        // colour comes from the `instanceColor` attribute that setColorAt creates,
        // which drives the shader on its own. Setting vertexColors:true as well
        // makes the shader also expect a per-VERTEX `color` attribute on the
        // geometry — which this geometry does not have, so every dart rendered
        // black regardless of the colours being written.
        // DoubleSide: the silhouette is a flat plane, so from underneath — which
        // is where an observer on the ground looks from — a single-sided material
        // would make every aircraft disappear.
        const material = new MeshBasicMaterial({side: DoubleSide});
        this.instances = new InstancedMesh(dart, material, MAX_AIRCRAFT);
        // The matrices change every frame from dead reckoning, so tell three.js
        // not to assume they are static.
        this.instances.instanceMatrix.setUsage(DynamicDrawUsage);
        this.instances.count = 0;
        this.instances.frustumCulled = false;   // instances span the whole area
        this.group.add(this.instances);

        // One LineSegments for every trail. Pre-allocated at the maximum so the
        // geometry is never rebuilt: only the draw range and the vertex data
        // change as aircraft come and go.
        const trailVertices = MAX_AIRCRAFT * TRAIL_POINTS * 2;
        const trailGeometry = new BufferGeometry();
        trailGeometry.setAttribute('position',
            new BufferAttribute(new Float32Array(trailVertices * 3), 3).setUsage(DynamicDrawUsage));
        trailGeometry.setAttribute('color',
            new BufferAttribute(new Float32Array(trailVertices * 3), 3).setUsage(DynamicDrawUsage));
        this.trailGeometry = trailGeometry;
        this.trails = new LineSegments(trailGeometry,
            new LineBasicMaterial({vertexColors: true, transparent: true, opacity: 0.65}));
        this.trails.frustumCulled = false;
        this.group.add(this.trails);
    }

    // CNode3DGroup exposes the THREE.Group as _object; named here so the intent
    // reads at the use sites above.
    get group() {
        return this._object;
    }

    // ── Polling ──────────────────────────────────────────────────────────────

    start() {
        if (this.polling) return;
        this.polling = true;
        this.group.visible = true;
        this._poll();   // immediately, so the layer is not blank for 5 seconds
        this.pollTimer = setInterval(() => this._poll(), POLL_INTERVAL_MS);
    }

    stop() {
        this.polling = false;
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        // Abort a request already on the wire. Without this a poll that started
        // just before the layer was switched off still lands, repopulating the
        // map and drawing aircraft into a layer the user has turned off.
        this.inFlight?.abort();
        this.inFlight = null;
        this.aircraft.clear();
        // Switching the layer off and on again is the user asking to try now, so
        // a backoff from a previous outage must not silently delay the retry.
        this.consecutiveFailures = 0;
        this.nextPollAllowedMs = 0;
        this.lastError = null;
        this.instances.count = 0;
        this.trailGeometry.setDrawRange(0, 0);
        this.group.visible = false;
        getLiveFeedOverlay().clear();
        setRenderOne(true);
    }

    /**
     * Where to centre the query: the main camera's position, not the sitch
     * origin.
     *
     * Sit.lat/lon is the origin, and in a fresh custom sitch it stays at its
     * default (32, -118) — the Pacific off Baja — until the user explicitly
     * runs Reset Origin. Querying there would show an empty sky to anyone who
     * had simply flown the camera to a city, which looks exactly like a broken
     * feature. The camera is where the user is actually looking, so that is what
     * "local traffic" means to them.
     *
     * Re-read every poll rather than cached: the poll is on a 5 s timer anyway,
     * so following the camera costs nothing, and the proxy's cache key rounds
     * position to 0.1 degrees so small movements still share an upstream fetch.
     *
     * ECEFToLLA_radii, not atan2(z, hypot(x,y)): the latter gives GEOCENTRIC
     * latitude, which differs from the geodetic latitude the feed uses by up to
     * 0.19 degrees — about 21 km, a material error at these radii.
     *
     * ECEFToLLA_radii returns RADIANS despite every other lat/lon in this file
     * being degrees — the degrees wrapper next to it, unproject(), goes through
     * the spherical ECEFToLLA and so gives up the geodetic accuracy that is the
     * whole reason for choosing _radii. So the conversion is done here.
     */
    _queryCenter() {
        const cameraNode = NodeMan.exists("mainCamera") ? NodeMan.get("mainCamera") : null;
        const p = cameraNode?.camera?.position;
        if (p) {
            const [latRad, lonRad] = ECEFToLLA_radii(p.x, p.y, p.z);
            const lat = latRad * 180 / Math.PI;
            const lon = lonRad * 180 / Math.PI;
            if (Number.isFinite(lat) && Number.isFinite(lon)) return {lat, lon};
        }
        return {lat: Sit.lat, lon: Sit.lon};
    }

    async _poll() {
        if (!this.polling) return;
        // A poll still running when the next one is due means the network is
        // slower than the interval. Skipping is right: queuing them would build
        // a backlog that never drains and would spend rate-limit tokens on data
        // that is stale by the time it arrives.
        if (this.inFlight) return;
        // Backoff gate. The interval timer keeps firing at its normal rate; this
        // simply declines the ones that fall inside the backoff window, so
        // recovery needs no timer juggling — the first poll after the window
        // succeeds and resets it.
        if (performance.now() < this.nextPollAllowedMs) return;

        const controller = new AbortController();
        this.inFlight = controller;
        // Flagged on the controller rather than held in a variable, so the catch
        // below can tell a timeout (report it) from stop()'s abort (silent).
        const timeout = setTimeout(() => {
            controller.timedOut = true;
            controller.abort();
        }, POLL_TIMEOUT_MS);
        const center = this._queryCenter();
        const radius = this.radiusNM;
        try {
            const result = await fetchLiveTraffic({
                lat: center.lat,
                lon: center.lon,
                radiusNM: this.radiusNM,
                signal: controller.signal,
            });
            if (!this.polling) return;   // switched off while in flight
            this._ingest(result);
            // Recorded on SUCCESS, and captured BEFORE the await so a slider drag
            // mid-flight cannot relabel the result either. Setting these at poll
            // start meant a failed poll, or a camera move, described the previous
            // (still-displayed) results as a search at the new place and range —
            // which is the exact dishonesty the position was added to prevent.
            this.lastCenter = center;
            this.lastRadiusNM = radius;
            this.lastError = null;
            this.stale = !!result.stale;
            this.consecutiveFailures = 0;
            this.nextPollAllowedMs = 0;
        } catch (e) {
            if (e?.name === 'AbortError') {
                // stop() aborts too, and that one is not a failure to report.
                if (controller.timedOut) {
                    this.lastError = "the feed did not respond in time";
                    console.warn("ADS-B live traffic poll timed out");
                    this._backOff();
                }
                return;
            }
            // A failed poll leaves the previous aircraft on screen rather than
            // emptying the sky: one dropped request is far more likely than
            // every aircraft vanishing at once. They age out of
            // MAX_POSITION_AGE_SEC on their own if the outage persists.
            this.lastError = e?.message || String(e);
            console.warn("ADS-B live traffic poll failed:", this.lastError);
            this._backOff();
        } finally {
            clearTimeout(timeout);
            if (this.inFlight === controller) this.inFlight = null;
        }
    }

    /** Push the next allowed poll further out after each consecutive failure. */
    _backOff() {
        this.consecutiveFailures = Math.min(this.consecutiveFailures + 1, MAX_BACKOFF_STEPS);
        const delay = POLL_INTERVAL_MS * Math.pow(2, this.consecutiveFailures);
        this.nextPollAllowedMs = performance.now() + delay;
        console.warn(`ADS-B live traffic: backing off ${Math.round(delay / 1000)}s`
            + ` after ${this.consecutiveFailures} failure(s)`);
    }

    /** Fold one poll's aircraft into the running map, keeping the trails. */
    _ingest(result) {
        const nowMs = performance.now();
        this.lastPollMs = nowMs;
        const seen = new Set();

        for (const a of result.aircraft) {
            if (a.positionAgeSec !== null && a.positionAgeSec > MAX_POSITION_AGE_SEC) continue;
            seen.add(a.hex);

            let entry = this.aircraft.get(a.hex);
            if (!entry) {
                entry = {trail: [], ecef: new Vector3()};
                this.aircraft.set(a.hex, entry);
            }
            entry.data = a;
            entry.lastSeenMs = nowMs;
            // The reported position is the anchor that dead reckoning advances
            // from, so it is stored separately from the drawn position.
            entry.anchor = this._toECEF(a, entry.anchor);
            entry.anchorMs = nowMs;
            entry.ecef.copy(entry.anchor);
            // The course direction and the dart's orientation depend only on the
            // reported position and track, so they are derived ONCE here rather
            // than every frame. getLocalNorthVector allocates five vectors per
            // call and the quaternion needs a normalize; at 130 aircraft times
            // 60 fps that was the whole per-frame cost of the layer, all of it
            // recomputing values that change five times a minute.
            this._updateOrientation(entry, a);

            // One trail point per poll, from the REPORTED position rather than
            // the dead-reckoned one — a trail of guesses would smoothly record
            // the error rather than the path.
            entry.trail.push(entry.anchor.clone());
            if (entry.trail.length > TRAIL_POINTS) entry.trail.shift();
        }

        // Drop aircraft that have left the radius or gone quiet. They are
        // removed on absence from a SUCCESSFUL poll, never on a failed one —
        // see the catch above.
        for (const [hex, entry] of this.aircraft) {
            if (!seen.has(hex)) this.aircraft.delete(hex);
        }

        this._rebuild();
    }

    /**
     * Aircraft position in ECEF.
     *
     * The datum conversion is the part that has to be right: LLAToECEF wants
     * height above the ellipsoid (HAE). A geometric altitude already is one; a
     * barometric altitude is conventionally MSL and needs the geoid separation
     * added, which is tens of metres in most of the world. Mixing the two
     * silently would put half the traffic at the wrong height.
     */
    _toECEF(a, target) {
        const out = target || new Vector3();
        let altitudeHAE = a.altitudeM;
        if (altitudeHAE === null) {
            // On the ground with no figure reported. Sea level is wrong nearly
            // everywhere, so use the sitch origin's geoid height as the least
            // wrong available guess and let the terrain hide the difference.
            altitudeHAE = meanSeaLevelOffset(a.lat, a.lon);
        } else if (!a.altitudeIsHAE) {
            altitudeHAE += meanSeaLevelOffset(a.lat, a.lon);
        }
        return LLAToECEFInto(a.lat, a.lon, altitudeHAE, out);
    }

    // ── Drawing ──────────────────────────────────────────────────────────────

    /** Push the current aircraft set into the instance matrices and the trails. */
    _rebuild() {
        this._updateCameraPos();
        let index = 0;
        let trailVertex = 0;
        const positions = this.trailGeometry.getAttribute('position');
        const trailColors = this.trailGeometry.getAttribute('color');

        for (const entry of this.aircraft.values()) {
            if (index >= MAX_AIRCRAFT) break;
            const a = entry.data;
            const colorHex = colorForAltitude(a.altitudeM, a.onGround);
            this._scratchColor.setHex(colorHex);

            this._writeInstance(index, entry);
            this.instances.setColorAt(index, this._scratchColor);
            index++;

            if (this.showTrails && entry.trail.length > 1) {
                // Line SEGMENTS, so each pair of points is emitted as its own
                // two vertices. A single LineStrip would join the last point of
                // one aircraft's trail to the first of the next, drawing a line
                // across the sky between unrelated aircraft.
                // Faded from tail to head, so the trail reads as a direction of
                // travel rather than as an undirected line. The oldest point sits
                // at 15% brightness and the newest at full, which also stops a
                // dense area filling with equally-bright history.
                const n = entry.trail.length;
                for (let i = 1; i < n; i++) {
                    const from = entry.trail[i - 1];
                    const to = entry.trail[i];
                    const fadeA = 0.15 + 0.85 * ((i - 1) / (n - 1));
                    const fadeB = 0.15 + 0.85 * (i / (n - 1));
                    positions.setXYZ(trailVertex, from.x, from.y, from.z);
                    trailColors.setXYZ(trailVertex, this._scratchColor.r * fadeA,
                        this._scratchColor.g * fadeA, this._scratchColor.b * fadeA);
                    trailVertex++;
                    positions.setXYZ(trailVertex, to.x, to.y, to.z);
                    trailColors.setXYZ(trailVertex, this._scratchColor.r * fadeB,
                        this._scratchColor.g * fadeB, this._scratchColor.b * fadeB);
                    trailVertex++;
                }
            }
        }

        this.instances.count = index;
        this.instances.instanceMatrix.needsUpdate = true;
        if (this.instances.instanceColor) this.instances.instanceColor.needsUpdate = true;

        this.trailGeometry.setDrawRange(0, trailVertex);
        positions.needsUpdate = true;
        trailColors.needsUpdate = true;

        setRenderOne(true);
    }

    /**
     * Derive an aircraft's course direction and dart orientation from its
     * reported position and track. Called once per poll, not per frame.
     *
     * The direction is built in the aircraft's OWN local frame — its ellipsoid
     * up and its local north — not in a global one. In ECEF there is no single
     * "north": an aircraft over Japan and one over Chile have opposite ideas of
     * it, so a shared basis would leave half the traffic pointing into the
     * ground.
     */
    _updateOrientation(entry, a) {
        const up = getLocalUpVector(entry.anchor);
        const north = getLocalNorthVector(entry.anchor);

        // Course is degrees clockwise from north, so rotate north about up by
        // the NEGATIVE of it: clockwise seen from above is negative about the up
        // axis in a right-handed frame.
        const heading = (a.trackDeg ?? 0) * Math.PI / 180;
        entry.course = north.applyAxisAngle(up, -heading).normalize();

        // Orient the dart's +Y (its nose) onto that direction.
        // TWO rotations, not one. setFromUnitVectors alone would point the nose
        // correctly but leave the flat silhouette at an arbitrary roll about that
        // axis — edge-on and invisible from directly above for half the traffic.
        // So: lay the shape's +Z onto local UP first, then spin about that up
        // axis to bring its +Y nose onto the course.
        entry.quaternion = entry.quaternion || new Quaternion();
        entry.quaternion.setFromUnitVectors(SHAPE_UP, up);
        const nose = DART_NOSE.clone().applyQuaternion(entry.quaternion);
        const roll = new Quaternion().setFromUnitVectors(nose, entry.course);
        entry.quaternion.premultiply(roll);
    }

    /**
     * Place one instance, sized so it stays roughly constant ON SCREEN.
     *
     * A fixed metric size does not work for this layer. The same view has to
     * serve an approach at four miles and a whole terminal area from ninety, and
     * a dart big enough to see at ninety miles swamps the airport at four. Under
     * a perspective camera an object at distance d subtending a fixed angle has
     * world size d * angle, so scaling by distance is what holds the marker at a
     * constant apparent size — the same trick a radar display uses.
     *
     * The clamp keeps it sane at the extremes: without a floor, an aircraft the
     * camera is sitting on shrinks to nothing, and without a ceiling one on the
     * far horizon becomes kilometres across.
     */
    _writeInstance(index, entry) {
        const distance = this._cameraPos
            ? this._cameraPos.distanceTo(entry.ecef)
            : 1 / SCREEN_SIZE_FACTOR;   // no camera yet: fall back to unit scale
        const size = Math.min(MAX_DART_METRES,
            Math.max(MIN_DART_METRES, distance * SCREEN_SIZE_FACTOR));
        this._scratchScale.setScalar(size);
        this._scratchMatrix.compose(entry.ecef, entry.quaternion, this._scratchScale);
        this.instances.setMatrixAt(index, this._scratchMatrix);
    }

    /** Forward a hover hit to the shared overlay. */
    setHoverTarget(hit, mouseX, mouseY) {
        getLiveFeedOverlay().setHover(hit, mouseX, mouseY);
    }

    /**
     * Has this aircraft already been promoted to a full track?
     *
     * Checked against the FILE MANAGER rather than a local set, so it still holds
     * after a reload and after a track imported by any other route — the manual
     * "Import ADS-B Track…" dialog fetches the same file under the same name.
     * A local set would forget on reload and re-import a track the user already
     * has, which is the duplicate this exists to prevent.
     */
    isPromoted(hex) {
        return FileManager.exists("trace_full_" + hex + ".json");
    }

    /** Cache the camera position for this pass, so it is read once and not per aircraft. */
    _updateCameraPos() {
        const cameraNode = NodeMan.exists("mainCamera") ? NodeMan.get("mainCamera") : null;
        const p = cameraNode?.camera?.position;
        if (p) {
            this._cameraPos = this._cameraPos || new Vector3();
            this._cameraPos.copy(p);
        }
    }

    /**
     * Dead-reckon between polls.
     *
     * Five seconds is a long time at 500 knots — about 1.3 km — so without this
     * the traffic teleports once per poll. Advancing each aircraft along its
     * reported course and ground speed turns that into continuous motion, and
     * every poll re-anchors on the truth, so the estimate never accumulates.
     */
    update(f) {
        super.update(f);
        if (!this.polling || this.aircraft.size === 0) return;

        const nowMs = performance.now();
        let moved = false;

        // Marker size depends on distance from the camera, so instances have to
        // be re-placed when the CAMERA moves as well as when the aircraft do.
        this._updateCameraPos();

        let index = 0;
        for (const entry of this.aircraft.values()) {
            if (index >= MAX_AIRCRAFT) break;
            const a = entry.data;
            const speed = a.groundSpeedKt;
            // entry.course was derived at poll time, so the per-frame work is
            // one multiply-add: position = anchor + course * (speed * elapsed).
            if (speed && entry.course && !a.onGround) {
                const elapsedSec = (nowMs - entry.anchorMs) / 1000;
                const distance = speed * KNOTS_TO_MPS * elapsedSec;
                entry.ecef.copy(entry.anchor).addScaledVector(entry.course, distance);
                moved = true;
            }
            this._writeInstance(index, entry);
            index++;
        }

        this.instances.instanceMatrix.needsUpdate = true;
        // Throttled inside the overlay, so several layers cannot each pay for a
        // relayout in the same frame.
        getLiveFeedOverlay().update();
        if (moved) {
            // Only OUR motion needs a repaint requested. A camera move already
            // triggers one on its own, so asking again there would hold the
            // render loop hot for no reason — but under render-on-demand,
            // omitting it here freezes the traffic until something else moves.
            setRenderOne(true);
        }
    }

    /**
     * What the overlay may label. Only aircraft that HAVE a name worth showing —
     * a bare hex tells the user nothing they can act on and would crowd out a
     * callsign that does.
     */
    labelCandidates() {
        const out = [];
        for (const entry of this.aircraft.values()) {
            const name = entry.data.callsign || entry.data.registration;
            if (!name) continue;
            out.push({
                ecef: entry.ecef,
                label: name,
                color: colorForAltitude(entry.data.altitudeM, entry.data.onGround),
            });
        }
        return out;
    }

    // ── Picking ──────────────────────────────────────────────────────────────

    /**
     * The aircraft nearest a screen point, or null if none is close enough.
     *
     * Screen-space proximity, NOT a raycast against the InstancedMesh. A dart is
     * about 0.6 degrees across, so an exact mesh hit would demand pixel-accurate
     * aim at a moving target; a radius in pixels is what makes this clickable at
     * all. It is also the approach findClosestTrack() already uses in
     * CNodeView3DMouse, so tracks and aircraft behave the same way under the
     * cursor.
     *
     * The projection matches checkTrackSegments() exactly, including
     * ViewMan.screenOffsetX and the view's leftPx/topPx: mouseX/mouseY arrive as
     * absolute page coordinates, while project() gives normalised device
     * coordinates relative to the view, and getting that conversion wrong puts
     * the hit test in a different place from the cursor.
     */
    findAircraftAtScreen(view, mouseX, mouseY, thresholdPx = 16) {
        if (!this.polling || !view?.camera || !this.group.visible) return null;

        let best = null;
        let bestDistance = thresholdPx;
        const containerOffsetX = ViewMan.screenOffsetX || 0;
        this._scratchScreen = this._scratchScreen || new Vector3();

        for (const [hex, entry] of this.aircraft) {
            this._scratchScreen.copy(entry.ecef).project(view.camera);
            // z > 1 is behind the camera; project() still returns a plausible
            // x/y there, mirrored, so without this an aircraft behind you is
            // clickable through the back of your head.
            if (this._scratchScreen.z > 1) continue;

            const sx = (this._scratchScreen.x * 0.5 + 0.5) * view.widthPx + view.leftPx + containerOffsetX;
            const sy = (1 - (this._scratchScreen.y * 0.5 + 0.5)) * view.heightPx + view.topPx;
            const distance = Math.hypot(mouseX - sx, mouseY - sy);

            if (distance < bestDistance) {
                bestDistance = distance;
                best = {hex, aircraft: entry.data, distancePx: distance};
            }
        }
        return best;
    }

    /**
     * Note that an aircraft is being fetched, so the status readout can say so.
     *
     * The trace fetch takes a second or two, and a click with no visible effect
     * reads as a click that missed — which would have the user clicking again
     * and queuing a second identical import.
     */
    setPromoting(label) {
        this.promoting = label;
    }

    /**
     * Say, briefly, that a second click on an already-imported aircraft did
     * nothing on purpose.
     *
     * Silence would be indistinguishable from a click that missed, which is what
     * sends the user clicking again. Reuses the promoting slot so it appears in
     * the same place the import progress does.
     */
    flashAlreadyImported(label) {
        this.promoting = `${label} already imported`;
        clearTimeout(this._promotingTimer);
        this._promotingTimer = setTimeout(() => {
            if (this.promoting && this.promoting.endsWith("already imported")) this.promoting = null;
        }, 3000);
    }

    /**
     * What the menu readout shows: enough to tell working from broken.
     *
     * Staleness is reported BEFORE the count, and it changes the wording rather
     * than adding a suffix. A stale empty result used to read as a confident "no
     * aircraft in range" — the proxy was serving an old cached copy because
     * adsb.lol was unreachable, and the layer presented that as a quiet sky. That
     * is precisely the state this readout exists to distinguish, so it must not
     * be the one state it hides.
     */
    status() {
        if (!this.polling) return "off";
        if (this.promoting) return `importing ${this.promoting}…`;
        // A warning sign and a plain sentence, because this row is a disabled
        // (greyed, low-contrast) control under a checkbox — an error phrased as
        // "HTTP 502" in small grey text is easy to scroll past, which is exactly
        // what happened: the layer reported the outage correctly and the user
        // still had to ask why no aircraft were showing.
        if (this.lastError) {
            const retryIn = Math.max(0, Math.round((this.nextPollAllowedMs - performance.now()) / 1000));
            return `\u26a0 ${this.lastError}` + (retryIn > 0 ? ` — retrying in ${retryIn}s` : " — retrying");
        }
        // Before the first poll answers, "no aircraft in range" would be a claim
        // about the sky that has not been checked yet.
        if (!this.lastPollMs) return "loading…";
        const count = this.aircraft.size;
        // An empty result has to say WHERE it looked. This layer follows the
        // camera, and a fresh custom sitch sits at its default origin in the open
        // Pacific — so "no aircraft in range" is true, unhelpful, and reads as a
        // broken feature. Naming the position makes "I am over empty ocean"
        // obvious at a glance, which is the actual answer.
        if (count === 0 && !this.stale && this.lastCenter) {
            // "31.7°N 118.0°W": hemisphere letters and one decimal, for a human
            // glancing at a menu row to see roughly where the search happened.
            return `none within ${Math.round(this.lastRadiusNM)}nm of ${formatLatLon(this.lastCenter.lat, this.lastCenter.lon, {decimals: 1})}`;
        }
        if (this.stale) {
            return count === 0
                ? "feed unreachable — nothing current to show"
                : `${count} aircraft (stale — feed unreachable)`;
        }
        if (count === 0) return "no aircraft in range";
        return `${count} aircraft`;
    }

    dispose() {
        this.stop();
        this.group.remove(this.instances);
        this.group.remove(this.trails);
        dispose(this.instances);
        dispose(this.trails);
        super.dispose();
    }
}
