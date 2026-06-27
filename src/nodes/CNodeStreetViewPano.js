// CNodeStreetViewPano — a Street View panorama rendered as a textured background sphere.
//
// Prototype of the "panorama-sphere-as-background" approach:
//   - takes an LLA (or a position copied from the camera via the UI),
//   - fetches an equirectangular panorama + metadata through the server-side stitcher
//     (sitrecServer/streetview.php, which uses Google's licensed Map Tiles API),
//   - builds an inside-viewed textured sphere centred at the pano's ECEF point, rotated so
//     the imagery aligns to true north using the metadata heading,
//   - renders it behind everything (renderOrder -1000, depthWrite:false) in the shared
//     GlobalScene, visible in the main and look views.
//
// The exact column-to-azimuth convention of Street View equirectangular imagery is not
// documented by Google, so a tunable `headingOffsetDeg` is exposed for calibration.

import {
    SphereGeometry, Mesh, MeshBasicMaterial, BackSide, TextureLoader,
    SRGBColorSpace, RepeatWrapping, LinearFilter, Vector3, Matrix4, MathUtils,
} from "three";
import {CNode3DGroup} from "./CNode3DGroup";
import {LLAToECEF} from "../LLA-ECEF-ENU";
import {getLocalUpVector, getLocalNorthVector, getLocalEastVector} from "../SphericalMath";
import {SITREC_SERVER} from "../configUtils";
import {Globals, setRenderOne} from "../Globals";
import {MASK_WORLD, MASK_MAIN, MASK_LOOK} from "../LayerMasks";

export class CNodeStreetViewPano extends CNode3DGroup {
    constructor(v) {
        v.layers = v.layers ?? (MASK_WORLD | MASK_MAIN | MASK_LOOK);
        super(v);

        // Observer / pano location. Either pass LLA:[lat,lon,alt] or lat/lon/alt directly.
        this.lat = v.lat ?? (v.LLA ? v.LLA[0] : 0);
        this.lon = v.lon ?? (v.LLA ? v.LLA[1] : 0);
        this.alt = v.alt ?? (v.LLA ? v.LLA[2] : 0);

        this.zoom = v.zoom ?? 3;                       // stitcher zoom (0..5, clamped per pano)
        this.radius = v.radius ?? 5000;               // sphere radius, metres
        this.headingOffsetDeg = v.headingOffsetDeg ?? 0; // calibration on top of metadata heading
        this.opacity = v.opacity ?? 1.0;
        this.mirror = v.mirror ?? true;               // flip texture horizontally for inside view

        // Resolved metadata (filled after fetch)
        this.panoId = null;
        this.panoLat = null;
        this.panoLon = null;
        this.heading = 0;
        this.copyright = "";
        this.date = null;

        this.status = "Not loaded";
        this.onStatus = v.onStatus;                   // optional UI callback(node)
        this.mesh = null;

        this._disposed = false;
        this.fetchGen = 0;                            // guards against superseded / post-dispose fetches

        if (v.autoFetch) this.fetchPano();
    }

    setStatus(s) {
        this.status = s;
        if (this.onStatus) this.onStatus(this);
    }

    // Fetch the nearest pano's metadata, then its stitched equirectangular image.
    fetchPano() {
        const lat = this.lat, lon = this.lon, zoom = this.zoom;
        // A newer fetch (or disposal) supersedes this one — its callbacks must not
        // overwrite the live pano or touch a torn-down node.
        const gen = ++this.fetchGen;
        const stale = () => this._disposed || gen !== this.fetchGen;
        this.setStatus("Resolving panorama…");
        const metaURL = SITREC_SERVER + "streetview.php?op=meta&lat=" + lat + "&lon=" + lon;
        Globals.pendingActions++;
        fetch(metaURL, {mode: "cors"})
            .then(r => r.json())
            .then(meta => {
                if (stale()) return;
                if (meta.status === "ZERO_RESULTS") { this.setStatus("No Street View coverage here"); return; }
                if (meta.status !== "OK") { this.setStatus("Error: " + (meta.error || "metadata")); return; }
                this.panoId = meta.panoId;
                this.heading = meta.heading ?? 0;
                this.copyright = meta.copyright ?? "";
                this.date = meta.date;
                this.panoLat = (meta.lat != null) ? meta.lat : lat;   // snapped capture location
                this.panoLon = (meta.lng != null) ? meta.lng : lon;
                this.setStatus("Loading panorama image…");
                const imgURL = SITREC_SERVER + "streetview.php?op=image&pano="
                    + encodeURIComponent(this.panoId) + "&zoom=" + zoom;
                const loader = new TextureLoader();
                loader.setCrossOrigin("anonymous");
                return loader.loadAsync(imgURL).then(tex => {
                    if (stale()) { tex.dispose(); return; }   // node gone or superseded — don't leak/clobber
                    this.buildSphere(tex);
                    const tag = [this.copyright, this.date].filter(Boolean).join("  ");
                    this.setStatus("Loaded" + (tag ? "  —  " + tag : ""));
                    setRenderOne(true);
                });
            })
            .catch(err => {
                this.setStatus("Error: " + (err && err.message ? err.message : err));
                console.warn("CNodeStreetViewPano fetch failed:", err);
            })
            .finally(() => { Globals.pendingActions--; });
    }

    buildSphere(tex) {
        this.disposeSphere();

        tex.colorSpace = SRGBColorSpace;
        tex.minFilter = LinearFilter;
        tex.generateMipmaps = false;
        if (this.mirror) {
            // View the inside of the sphere without left-right mirroring of the photo.
            tex.wrapS = RepeatWrapping;
            tex.repeat.x = -1;
            tex.offset.x = 1;
        }

        const geo = new SphereGeometry(this.radius, 64, 48);
        const mat = new MeshBasicMaterial({
            map: tex,
            side: BackSide,            // we sit inside the sphere
            depthWrite: false,         // never occlude real geometry
            depthTest: true,           // but real geometry in front still hides it
            fog: false,
            toneMapped: false,
            transparent: this.opacity < 1,
            opacity: this.opacity,
        });

        const mesh = new Mesh(geo, mat);
        mesh.renderOrder = -1000;      // drawn first, behind the whole scene
        this.orientMesh(mesh);
        this.group.add(mesh);
        this.propagateLayerMask();
        this.mesh = mesh;
    }

    // Centre the sphere at the pano's ECEF point and rotate so the texture centre column
    // faces the metadata heading (compass bearing, clockwise from north), plus calibration.
    orientMesh(mesh) {
        const lat = (this.panoLat != null) ? this.panoLat : this.lat;
        const lon = (this.panoLon != null) ? this.panoLon : this.lon;
        const P = LLAToECEF(lat, lon, this.alt);

        const up = getLocalUpVector(P).normalize();
        const north = getLocalNorthVector(P).normalize();
        const east = getLocalEastVector(P).normalize();

        const h = MathUtils.degToRad(this.heading + this.headingOffsetDeg);
        // Compass forward direction: bearing h, clockwise from north.
        const forward = north.clone().multiplyScalar(Math.cos(h))
            .add(east.clone().multiplyScalar(Math.sin(h))).normalize();

        // Local +X (equirectangular centre column) -> forward; +Y -> up.
        const xAxis = forward;
        const yAxis = up.clone();
        const zAxis = new Vector3().crossVectors(xAxis, yAxis).normalize();
        const m = new Matrix4().makeBasis(xAxis, yAxis, zAxis);

        mesh.quaternion.setFromRotationMatrix(m);
        mesh.position.copy(P);
    }

    // ---- live UI setters ----
    setHeadingOffset(deg) {
        this.headingOffsetDeg = deg;
        if (this.mesh) { this.orientMesh(this.mesh); setRenderOne(true); }
    }

    setOpacity(o) {
        this.opacity = o;
        if (this.mesh) {
            this.mesh.material.opacity = o;
            this.mesh.material.transparent = o < 1;
            this.mesh.material.needsUpdate = true;
            setRenderOne(true);
        }
    }

    setRadius(r) {
        this.radius = r;
        if (this.mesh) {
            this.mesh.geometry.dispose();
            this.mesh.geometry = new SphereGeometry(r, 64, 48);
            setRenderOne(true);
        }
    }

    // The LLA the pano was actually captured at (snapped by Google), or null if not loaded.
    getCenterLLA() {
        if (this.panoLat == null) return null;
        return {lat: this.panoLat, lon: this.panoLon, alt: this.alt};
    }

    // Snap the sphere's exact centre to a world ECEF point so it coincides with the camera
    // after "Center Camera On Street View" (zero parallax). Heading orientation is preserved.
    setCenterECEF(ecef) {
        if (!this.mesh) return;
        this.orientMesh(this.mesh);     // orientation from the pano lat/lon (alt-insensitive)
        this.mesh.position.copy(ecef);  // then snap the centre exactly onto the camera point
        setRenderOne(true);
    }

    disposeSphere() {
        if (this.mesh) {
            this.group.remove(this.mesh);
            this.mesh.geometry?.dispose();
            this.mesh.material?.map?.dispose();
            this.mesh.material?.dispose();
            this.mesh = null;
        }
    }

    dispose() {
        this._disposed = true;     // any in-flight fetch will bail in its async tail
        this.disposeSphere();
        super.dispose();
    }
}
