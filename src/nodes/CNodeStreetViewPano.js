// CNodeStreetViewPano — a Street View panorama rendered as a textured background sphere.
//
// Prototype of the "panorama-sphere-as-background" approach:
//   - takes an LLA (or a position copied from the camera via the UI),
//   - fetches an equirectangular panorama + metadata through the server-side stitcher
//     (sitrecServer/streetview.php, which uses Google's licensed Map Tiles API),
//   - builds TWO inside-viewed textured spheres (sharing one texture), rotated so the imagery
//     aligns to true north using the metadata heading, both CENTRED ON THE LOOK CAMERA every
//     frame (preRender) so they move with the observer like a skybox:
//       * a "sky" sphere drawn before the 3D scene with depthTest OFF (while opaque) — it sits
//         behind everything, so fading the 3D sim (buildings/terrain) reveals it;
//       * a "registered" sphere at renderOrder 0 with depthTest ON — it z-sorts with the
//         environment (near terrain occludes it; it occludes geometry beyond its radius).
//     Neither writes depth (objects/tracks drawn after are never hidden). Look view ONLY.
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
import {Globals, NodeMan, setRenderOne} from "../Globals";
import {MASK_LOOK} from "../LayerMasks";

export class CNodeStreetViewPano extends CNode3DGroup {
    constructor(v) {
        // Look view only — the pano is a first-person backdrop for the observer camera; it must
        // NOT appear in the main (map) view or any other view. MASK_LOOK alone keeps it out of
        // MASK_MAINRENDER while the look view (MASK_LOOKRENDER) still includes MASK_LOOK.
        v.layers = v.layers ?? MASK_LOOK;
        super(v);

        // Observer / pano location. Either pass LLA:[lat,lon,alt] or lat/lon/alt directly.
        this.lat = v.lat ?? (v.LLA ? v.LLA[0] : 0);
        this.lon = v.lon ?? (v.LLA ? v.LLA[1] : 0);
        this.alt = v.alt ?? (v.LLA ? v.LLA[2] : 0);

        this.zoom = v.zoom ?? 3;                       // stitcher zoom (0..5, clamped per pano)
        this.radius = v.radius ?? 5000;               // sphere radius, metres
        this.headingOffsetDeg = v.headingOffsetDeg ?? 0; // calibration on top of metadata heading
        this.elevationOffsetDeg = v.elevationOffsetDeg ?? 0; // calibration on top of the metadata tilt
        this.opacity = v.opacity ?? 1.0;
        this.mirror = v.mirror ?? true;               // flip texture horizontally for inside view

        // Resolved metadata (filled after fetch)
        this.panoId = null;
        this.panoLat = null;
        this.panoLon = null;
        this.heading = 0;
        // Google reports the capture pose in the metadata: `tilt` is the angle (from the
        // panorama's south pole) at which the true horizon sits — 90° means the horizon is
        // already on the image's centre row, anything else means the car was pitched (e.g. on
        // a sloped street), so the horizon is (tilt-90)° off centre and the dome must be
        // pitched to compensate. `roll` is already baked out of the published tiles (it is the
        // rotation Google applied to LEVEL the horizon), so we keep it only for reference.
        this.tilt = 90;
        this.roll = 0;
        this.copyright = "";
        this.date = null;

        this.status = "Not loaded";
        this.onStatus = v.onStatus;                   // optional UI callback(node)
        this.mesh = null;

        this._disposed = false;
        this.fetchGen = 0;                            // guards against superseded / post-dispose fetches

        // Persist the location + tuning so a saved sitch can recreate the pano on load (the
        // stitched image itself is not stored — it is re-fetched). The texture/metadata are
        // restored by re-fetching in the load hook (see StreetViewPanoUI.restoreStreetViewPanoFromMod).
        this.addSimpleSerials(["lat", "lon", "alt", "zoom", "radius",
            "headingOffsetDeg", "elevationOffsetDeg", "opacity"]);

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
                this.tilt = (meta.tilt != null) ? meta.tilt : 90;
                this.roll = meta.roll ?? 0;
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

    // Two concentric panorama spheres, both centred on the look camera and sharing one texture:
    //
    //   skyMesh ("sky")        — drawn BEFORE the 3D scene (renderOrder -1000) and, while opaque,
    //                            with depthTest OFF, so it sits behind everything like a skybox.
    //                            Fading the 3D sim (buildings/terrain) reveals THIS sphere — a
    //                            single z-tested sphere can't be revealed because it is depth-
    //                            rejected wherever geometry is nearer than its radius.
    //   mesh ("registered")    — the original z-sorted sphere (renderOrder 0, depthTest ON): near
    //                            terrain occludes it and it occludes geometry beyond its radius.
    //
    // Both produce the same image (a camera-centred sphere's appearance is radius-independent), so
    // where both are visible they overlap exactly — no doubling, just the two different z-behaviours.
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
        this._tex = tex;   // shared by both spheres; disposed once in disposeSphere()

        this.mesh = this._makeSphereMesh(tex, 0);          // registered / z-sorted
        this.skyMesh = this._makeSphereMesh(tex, -1000);   // sky / behind everything

        this._orientBoth();
        this._applyMaterials(this.opacity);
        this.group.add(this.mesh);
        this.group.add(this.skyMesh);
        this.propagateLayerMask();
    }

    _makeSphereMesh(tex, renderOrder) {
        const geo = new SphereGeometry(this.radius, 64, 48);
        const mat = new MeshBasicMaterial({
            map: tex, side: BackSide, depthWrite: false, fog: false, toneMapped: false,
        });
        const mesh = new Mesh(geo, mat);
        mesh.renderOrder = renderOrder;
        return mesh;
    }

    _orientBoth() {
        if (this.mesh) this.orientMesh(this.mesh);
        if (this.skyMesh) this.orientMesh(this.skyMesh);
    }

    // Opacity / blend state for both spheres. The sky sphere ignores the depth buffer (true
    // skybox) ONLY while fully opaque: a transparent depth-test-off mesh moves to the transparent
    // pass and would draw OVER the whole scene, so below opacity 1 it falls back to depth-tested
    // (it then behaves like the registered sphere — the skybox reveal is a Street-Opacity-1 mode).
    _applyMaterials(o) {
        this.opacity = o;
        const setMat = (mesh, skybox) => {
            if (!mesh) return;
            const m = mesh.material;
            const transparent = o < 1;
            const depthTest = skybox ? (o < 1) : true;
            if (m.transparent !== transparent || m.depthTest !== depthTest) {
                m.transparent = transparent;
                m.depthTest = depthTest;
                m.needsUpdate = true;
            }
            m.opacity = o;
        };
        setMat(this.mesh, false);
        setMat(this.skyMesh, true);
    }

    // Centre both spheres on the look camera every frame so they track the observer like a
    // skybox (orientation, set by orientMesh, is position-independent). Runs per view render,
    // after the camera matrices are updated (see CNodeView3D).
    preRender(view) {
        const cam = NodeMan.get("lookCamera", true);
        const camPos = cam?.camera?.position;
        if (!camPos) return;
        if (this.mesh) this.mesh.position.copy(camPos);
        if (this.skyMesh) this.skyMesh.position.copy(camPos);
    }

    // Centre the sphere at the pano's ECEF point and rotate so the texture centre column
    // faces the metadata heading (compass bearing, clockwise from north) and the imagery's
    // horizon sits on the local horizontal — applying the metadata tilt so a pano captured on
    // a sloped street is no longer vertically offset from the 3D scene. Both have a tunable
    // calibration offset on top (headingOffsetDeg / elevationOffsetDeg).
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

        // Heading-only basis: local +X (equirectangular centre column) -> forward; +Y -> up.
        let xAxis = forward;
        let yAxis = up.clone();
        let zAxis = new Vector3().crossVectors(xAxis, yAxis).normalize(); // "right" (east-ish)

        // Pitch the dome about its right axis so the imagery horizon lands on the true horizon.
        // In this basis a POSITIVE angle `a` rotates the texture DOWN on screen (verified against
        // the 3D scene). Google's `tilt` puts the horizon (tilt-90)° ABOVE the texture centre row,
        // so the texture sits that much too high and we pitch it DOWN by +(tilt-90). The manual
        // elevationOffsetDeg trims on top, with positive RAISING the dome (subtracted from a).
        // Rotating in the right-axis plane:
        //   forward' = forward*cos a + up*sin a,   up' = up*cos a - forward*sin a
        const a = MathUtils.degToRad((this.tilt - 90) - this.elevationOffsetDeg);
        const ca = Math.cos(a), sa = Math.sin(a);
        xAxis = forward.clone().multiplyScalar(ca).add(up.clone().multiplyScalar(sa)).normalize();
        yAxis = up.clone().multiplyScalar(ca).add(forward.clone().multiplyScalar(-sa)).normalize();
        zAxis = new Vector3().crossVectors(xAxis, yAxis).normalize();

        const m = new Matrix4().makeBasis(xAxis, yAxis, zAxis);

        mesh.quaternion.setFromRotationMatrix(m);
        mesh.position.copy(P);
    }

    // ---- live UI setters ----
    setHeadingOffset(deg) {
        this.headingOffsetDeg = deg;
        if (this.mesh) { this._orientBoth(); setRenderOne(true); }
    }

    setElevationOffset(deg) {
        this.elevationOffsetDeg = deg;
        if (this.mesh) { this._orientBoth(); setRenderOne(true); }
    }

    setOpacity(o) {
        if (this.mesh) { this._applyMaterials(o); setRenderOne(true); }
        else this.opacity = o;
    }

    setRadius(r) {
        this.radius = r;
        for (const mesh of [this.mesh, this.skyMesh]) {
            if (mesh) {
                mesh.geometry.dispose();
                mesh.geometry = new SphereGeometry(r, 64, 48);
            }
        }
        if (this.mesh) setRenderOne(true);
    }

    // The LLA the pano was actually captured at (snapped by Google), or null if not loaded.
    getCenterLLA() {
        if (this.panoLat == null) return null;
        return {lat: this.panoLat, lon: this.panoLon, alt: this.alt};
    }

    // Snap both spheres' exact centre to a world ECEF point so they coincide with the camera
    // after "Center Camera On Street View" (zero parallax). preRender re-centres each frame, so
    // this is just the immediate snap. Heading orientation is preserved.
    setCenterECEF(ecef) {
        if (!this.mesh) return;
        this._orientBoth();             // orientation from the pano lat/lon (alt-insensitive)
        this.mesh.position.copy(ecef);  // then snap the centres exactly onto the camera point
        this.skyMesh?.position.copy(ecef);
        setRenderOne(true);
    }

    disposeSphere() {
        for (const mesh of [this.mesh, this.skyMesh]) {
            if (!mesh) continue;
            this.group.remove(mesh);
            mesh.geometry?.dispose();
            mesh.material?.dispose();   // NOT material.map — the texture is shared, disposed below
        }
        this._tex?.dispose();
        this._tex = null;
        this.mesh = null;
        this.skyMesh = null;
    }

    dispose() {
        this._disposed = true;     // any in-flight fetch will bail in its async tail
        this.disposeSphere();
        super.dispose();
    }
}
