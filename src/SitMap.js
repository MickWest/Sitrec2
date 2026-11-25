import {Raycaster, Vector3} from "three";
import {NodeMan} from "./Globals";
import {ViewMan} from "./CViewManager";
import {ECEFToLLAVD_radii} from "./LLA-ECEF-ENU";
import {ensureGeoidLoaded, meanSeaLevelOffset} from "./EGM96Geoid";
import {getAzElFromPositionAndForward, getLocalUpVector} from "./SphericalMath";
import {getPointBelow} from "./threeExt";
import {extractRoll} from "./ExportCameraKML";
import {withDisplayedCamera} from "./ViewUtils";
import {isPanoramicCamera} from "./PanoramicCamera";
import {isFisheyeCamera} from "./FisheyeProjection";
import {SitMapClient} from "./SitMapBridge";
import {raycastLocalGround} from "./raycastGround";

const groundRay = new Raycaster();

export function sampleSitMapCamera(viewID = "lookView", sourcePitch) {
    const view = ViewMan.get(viewID, false);
    if (!view?.camera || view.camera.isOrthographicCamera || isPanoramicCamera(view.camera) || isFisheyeCamera(view.camera)) {
        throw new Error(`SitMap needs a perspective camera in ${viewID}.`);
    }
    return withDisplayedCamera(view, camera => {
        const position = camera.getWorldPosition(new Vector3());
        const ray = (x, y) => new Vector3(x, y, 0.5).unproject(camera).sub(position).normalize();
        const forward = ray(0, 0), top = ray(0, 1), bottom = ray(0, -1);
        const up = top.clone().addScaledVector(forward, -top.dot(forward)).normalize();
        const lla = ECEFToLLAVD_radii(position);
        const [heading, elevation] = getAzElFromPositionAndForward(position, forward);
        const result = {
            latitude: lla.x, longitude: lla.y, altitudeMSL: lla.z - meanSeaLevelOffset(lla.x, lla.y),
            heading, elevation, roll: extractRoll(position, forward, up),
            // Avoid floating-point noise just beyond a boundary such as 120°.
            verticalFov: Number((Math.acos(Math.max(-1, Math.min(1, top.dot(bottom)))) * 180 / Math.PI).toFixed(10)),
            aspect: camera.aspect,
        };
        if (NodeMan.exists("TerrainModel")) {
            const ground = ECEFToLLAVD_radii(getPointBelow(position));
            result.groundAltitudeMSL = ground.z - meanSeaLevelOffset(ground.x, ground.y);
        }
        if (!Object.values(result).every(Number.isFinite)) throw new Error("The Sitrec camera is not ready.");
        // The elevation beneath the eye is not the elevation of the point the
        // camera sees. On a slope, using the former displaces MapKit's eye and
        // framing. Send the actual center-ray surface hit, including 3D tiles.
        const surfaceTarget = direction => {
            groundRay.set(position, direction);
            const hit = raycastLocalGround(groundRay, camera);
            if (!hit?.isTerrain) return undefined;
            const target = ECEFToLLAVD_radii(hit.point);
            const altitudeMSL = target.z - meanSeaLevelOffset(target.x, target.y);
            const distance = position.distanceTo(hit.point);
            if (distance < 1 || distance > 2_000_000 || altitudeMSL >= result.altitudeMSL) return undefined;
            return {latitude: target.x, longitude: target.y, altitudeMSL, distance};
        };
        if (elevation < 0) result.groundTarget = surfaceTarget(forward);
        // MapKit acknowledges its accepted pitch. Its source camera then needs
        // the terrain hit along THAT ray, not a plane at the requested target's
        // elevation; these can differ substantially across a hillside.
        if (Number.isFinite(sourcePitch) && sourcePitch >= 0 && sourcePitch <= 85
            && Math.abs(sourcePitch - (90 + elevation)) > 0.05) {
            const up = getLocalUpVector(position);
            const horizontal = forward.clone().addScaledVector(up, -forward.dot(up)).normalize();
            const p = sourcePitch * Math.PI / 180;
            const sourceDirection = horizontal.multiplyScalar(Math.sin(p)).addScaledVector(up, -Math.cos(p)).normalize();
            const target = surfaceTarget(sourceDirection);
            if (target) result.sourceGroundTarget = {...target, pitch: sourcePitch};
        }
        return result;
    });
}

let client;
export function getSitMap() {
    if (!client) client = new SitMapClient({sampleCamera: sampleSitMapCamera});
    return client;
}
export async function sendToSitMap(options = {}) { await ensureGeoidLoaded(); return getSitMap().sendView(options); }
export async function syncSitMap(options = {}) {
    if (options.enabled === false) return getSitMap().stopSync();
    await ensureGeoidLoaded();
    const {enabled, ...rest} = options;
    return getSitMap().startSync(rest);
}
// Called after Sitrec updates and renders its cameras, including paused edits.
export function publishSitMapFrame() { client?.publish(); }
