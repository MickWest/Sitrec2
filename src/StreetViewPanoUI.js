// UI for the CNodeStreetViewPano prototype.
//
// Adds a "Street View Pano" folder under the View menu with controls to set a location
// (or copy the current camera position), fetch a Google Street View panorama via the
// server-side stitcher, and tune how the resulting background sphere is rendered.
//
// Wired in from CustomManagerSetup.setup() — see setupStreetViewPanoMenu() there.

import {guiMenus, NodeMan, setRenderOne} from "./Globals";
import {CNodeStreetViewPano} from "./nodes/CNodeStreetViewPano";
import {ECEFToLLAVD_radii} from "./LLA-ECEF-ENU";

let svFolder = null;
let statusController = null;

const PANO_ID = "streetViewPano";

// Default location: a well-covered Times Square panorama (handy out-of-the-box test).
const params = {
    lat: 40.758,
    lon: -73.9855,
    alt: 12,
    zoom: 3,
    radius: 5000,
    headingOffset: 0,
    opacity: 1.0,
    visible: true,
    status: "Not loaded",
};

// NOTE (prototype limitation): the pano node is created lazily on Fetch with a fixed id and
// is NOT part of the sitch graph, so it is not persisted in saved sitches — reloading a sitch
// does not restore the panorama (the user re-fetches). To make it persistent, give the node
// modSerialize/modDeserialize (lat/lon/alt/zoom/heading/radius/opacity) and recreate it with
// autoFetch on deserialize.
function getNode(create = false) {
    if (NodeMan.exists(PANO_ID)) return NodeMan.get(PANO_ID);
    if (!create) return null;
    const node = new CNodeStreetViewPano({id: PANO_ID});
    node.onStatus = (n) => { params.status = n.status; statusController?.updateDisplay(); };
    return node;
}

function copyCameraPosition() {
    // The observer viewpoint is the look camera, not the main/overview camera.
    const cam = NodeMan.get("lookCamera", true) ?? NodeMan.get("mainCamera", true);
    const pos = cam?.camera?.position ?? cam?._object?.position;
    if (!pos) { params.status = "No camera found"; statusController?.updateDisplay(); return false; }
    const lla = ECEFToLLAVD_radii(pos);   // {x:lat, y:lon, z:alt(HAE m)}
    params.lat = lla.x;
    params.lon = lla.y;
    params.alt = lla.z;
    if (svFolder) svFolder.controllersRecursive().forEach(c => c.updateDisplay());
    return true;
}

function fetchPano() {
    const node = getNode(true);
    node.lat = params.lat;
    node.lon = params.lon;
    node.alt = params.alt;
    node.zoom = params.zoom;
    node.radius = params.radius;
    node.headingOffsetDeg = params.headingOffset;
    node.opacity = params.opacity;
    node.onStatus = (n) => { params.status = n.status; statusController?.updateDisplay(); };
    node.show(params.visible);
    node.fetchPano();
}

// Move the observer (look) camera to the panorama's EXACT captured location. Google snaps
// to the nearest capture point, so the pano is usually a few metres from where it was
// requested; this re-centres the camera on it so the view sits at the sphere centre.
function centerCameraOnPano() {
    const node = getNode();
    const center = node && node.getCenterLLA();
    if (!center) {
        params.status = "Fetch a panorama first";
        statusController?.updateDisplay();
        return;
    }
    const fixed = NodeMan.get("fixedCameraPosition", true);
    if (fixed && typeof fixed.setLLA === "function") {
        // fixedCameraPosition is the look camera's "from" position; setLLA cascades so the
        // controller-driven camera actually moves (a direct camera.position write is clobbered).
        fixed.setLLA(center.lat, center.lon, center.alt);
        // Snap the sphere exactly onto the camera's resulting point => zero parallax.
        if (fixed.ecef) node.setCenterECEF(fixed.ecef.clone());
    } else {
        // No fixed-position node (free camera) — teleport directly.
        const cam = NodeMan.get("lookCamera", true) ?? NodeMan.get("mainCamera", true);
        if (cam && cam.camera && node.mesh) cam.camera.position.copy(node.mesh.position);
    }
    setRenderOne(true);
}

export function setupStreetViewPanoMenu() {
    if (!guiMenus.terrain) return;
    if (svFolder) return;   // idempotent (re-run on every sitch load)

    svFolder = guiMenus.terrain.addFolder("Street View Pano")
        .close()
        .tooltip("Fetch a Google Street View panorama and render it as a background sphere centred at its location.");

    svFolder.add(params, "lat", undefined, undefined, 0.00001).name("Latitude")
        .tooltip("Latitude of the location to fetch a panorama for");
    svFolder.add(params, "lon", undefined, undefined, 0.00001).name("Longitude")
        .tooltip("Longitude of the location to fetch a panorama for");
    svFolder.add(params, "alt", undefined, undefined, 0.5).name("Altitude (m)")
        .tooltip("Height (HAE, metres) of the sphere centre — roughly ground + eye height");

    svFolder.add({useCam: () => copyCameraPosition()}, "useCam")
        .name("Use Camera Position")
        .tooltip("Copy the current look (observer) camera lat/lon/alt into the fields above");

    svFolder.add(params, "zoom", 0, 5, 1).name("Zoom (detail)")
        .tooltip("Stitcher zoom level — higher = sharper but more tiles fetched (billed). Clamped per pano.");

    svFolder.add({fetch: () => fetchPano()}, "fetch")
        .name("Fetch Panorama")
        .tooltip("Resolve the nearest Street View pano and load it as a background sphere");

    const fetchHereController = svFolder.add({fetchHere: () => { if (copyCameraPosition()) fetchPano(); }}, "fetchHere")
        .name("Fetch At Camera")
        .tooltip("Copy the camera position, then fetch the nearest panorama there");

    const centerCamController = svFolder.add({centerCam: () => centerCameraOnPano()}, "centerCam")
        .name("Center Camera On Street View")
        .tooltip("Move the observer (look) camera to the loaded panorama's exact captured location, so the view sits at the sphere centre (fixes the offset from Google snapping to the nearest pano)");

    svFolder.add(params, "headingOffset", -180, 180, 0.5).name("Heading Offset°")
        .tooltip("Calibration rotation added to the pano's metadata heading, in case the imagery is rotated")
        .onChange(v => { getNode()?.setHeadingOffset(v); });

    svFolder.add(params, "radius", 100, 50000, 100).name("Sphere Radius (m)")
        .tooltip("Radius of the background sphere")
        .onChange(v => { getNode()?.setRadius(v); });

    svFolder.add(params, "opacity", 0, 1, 0.01).name("Opacity")
        .tooltip("Blend the panorama with whatever is behind it")
        .onChange(v => { getNode()?.setOpacity(v); });

    svFolder.add(params, "visible").name("Visible")
        .tooltip("Show/hide the panorama sphere")
        .onChange(v => { getNode()?.show(v); setRenderOne(true); });

    statusController = svFolder.add(params, "status").name("Status").disable().listen();

    // The parent guiMenus.terrain is a permanent shell, but disposeEverything()'s
    // menuBar.destroy(false) on every sitch reload recurses into children with the same
    // all=false flag — so without an explicit perm the folder + controllers would be
    // destroyed on the next sitch load, and the `if (svFolder) return` guard would then
    // keep them from ever rebuilding (menu vanishes for the rest of the session). Mark the
    // folder and all its controllers permanent. (Same pattern as CameraMotionFromVideo.js.)
    const permAll = (node) => {
        if (typeof node.perm === "function") node.perm();
        if (node.children) node.children.forEach(permAll);
    };
    permAll(svFolder);

    // Promote the two camera-placement actions to the top of the folder (call order matters:
    // the last moveToFirst wins, so Fetch ends up first and Center second).
    centerCamController.moveToFirst();
    fetchHereController.moveToFirst();

    // We are added to the Terrain menu AFTER its "Terrain Tweaks" sub-folder, so re-assert
    // Terrain Tweaks to the bottom to keep it the last entry on a fresh load too.
    const tweaks = (guiMenus.terrain?.folders || []).find(
        f => (f.$title?.textContent || "").includes("Terrain Tweaks"));
    if (tweaks && tweaks.moveToEnd) tweaks.moveToEnd();
}
