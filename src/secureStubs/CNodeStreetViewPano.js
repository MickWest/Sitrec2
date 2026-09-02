// Secure-build stub. The original module is compiled out of the secure build; see docs/dev/Secure-Build.md
//
// The original (src/nodes/CNodeStreetViewPano.js) fetches a stitched street-level panorama
// and its metadata through the server's stitcher endpoint and drapes it on a sphere around
// the look camera. Here nothing is fetched and nothing is built: fetchPano() only reports the
// status.
//
// Unlike most stubs this one IS a node, extending the same base class as the original,
// because src/StreetViewPanoUI.js constructs it by id, binds its fields to a menu, and calls
// show() and dispose() on it, all of which come from the node base classes. It keeps the
// original's serialized fields so a saved sitch still loads.
//
// It sits flat in src/secureStubs/ rather than under a nodes/ sub-directory on purpose. The
// secure build swaps the module in AFTER resolution, and the swapped-in module keeps the
// ORIGINAL's directory as the base for its own relative imports. From src/secureStubs/ and
// from src/nodes/ alike, "../nodes/CNode3DGroup" and "../LayerMasks" name the same files, so
// the two imports below resolve whichever directory webpack uses. (Every other stub has no
// imports at all, for the same reason.) Being outside src/nodes/ also keeps it out of the
// RegisterNodes sweep, which would otherwise register the class twice.

import {CNode3DGroup} from "../nodes/CNode3DGroup";
import {MASK_LOOK} from "../LayerMasks";

// Also registered on the global object, so the marker survives minification (scripts/secureStubs.js).
export const SECURE_STUB_MARKER = "__SITREC_SECURE_STUB__:CNodeStreetViewPano";
globalThis.__SITREC_SECURE_STUBS__ = (globalThis.__SITREC_SECURE_STUBS__ || []).concat(SECURE_STUB_MARKER);

const STATUS = "Street-level panoramas are not available in this build";

export class CNodeStreetViewPano extends CNode3DGroup {
    constructor(v) {
        v.layers = v.layers ?? MASK_LOOK;
        super(v);

        this.lat = v.lat ?? (v.LLA ? v.LLA[0] : 0);
        this.lon = v.lon ?? (v.LLA ? v.LLA[1] : 0);
        this.alt = v.alt ?? (v.LLA ? v.LLA[2] : 0);

        this.zoom = v.zoom ?? 3;
        this.radius = v.radius ?? 5000;
        this.headingOffsetDeg = v.headingOffsetDeg ?? 0;
        this.elevationOffsetDeg = v.elevationOffsetDeg ?? 0;
        this.opacity = v.opacity ?? 1.0;
        this.mirror = v.mirror ?? true;

        this.panoId = null;
        this.panoLat = null;
        this.panoLon = null;
        this.heading = 0;
        this.tilt = 90;
        this.roll = 0;
        this.copyright = "";
        this.date = null;

        this.status = STATUS;
        this.onStatus = v.onStatus;
        this.mesh = null;
        this.skyMesh = null;

        this._disposed = false;
        this.fetchGen = 0;

        this.addSimpleSerials(["lat", "lon", "alt", "zoom", "radius",
            "headingOffsetDeg", "elevationOffsetDeg", "opacity"]);

        if (v.autoFetch) this.fetchPano();
    }

    setStatus(s) {
        this.status = s;
        if (this.onStatus) this.onStatus(this);
    }

    fetchPano() {
        this.setStatus(STATUS);
    }

    buildSphere() {
    }

    _makeSphereMesh() {
        return null;
    }

    _orientBoth() {
    }

    _applyMaterials() {
    }

    preRender() {
    }

    orientMesh() {
    }

    setHeadingOffset(deg) {
        this.headingOffsetDeg = deg;
    }

    setElevationOffset(deg) {
        this.elevationOffsetDeg = deg;
    }

    setOpacity(o) {
        this.opacity = o;
    }

    setRadius(r) {
        this.radius = r;
    }

    getCenterLLA() {
        return null;
    }

    setCenterECEF() {
    }

    disposeSphere() {
    }

    dispose() {
        this._disposed = true;
        super.dispose();
    }
}
