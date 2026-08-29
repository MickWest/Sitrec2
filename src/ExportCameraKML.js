// Export the look camera — and the video frame it is matched to — as a Google Earth
// PhotoOverlay, so the sitch's camera solution can be checked against Google Earth's
// own imagery and 3D buildings.
//
// A PhotoOverlay is KML's "photo hung in space in front of a viewpoint": a <Camera>
// (where the photographer stood and which way they faced) plus a <ViewVolume> (the
// angles the photo's edges subtend). Google Earth flies to the Camera and pastes the
// image into that view volume, so if Sitrec's camera is right, the photo lines up with
// the terrain behind it. That alignment IS the test — a plain <Camera> would only move
// the viewpoint and leave nothing to compare against.
//
// The image can't be a data: URI (Google Earth won't fetch those), so the output is a
// KMZ: a zip whose root doc.kml refers to the JPEG by relative path.
//
// GEOMETRY NOTES, since three separate conventions meet here:
//
//   Altitude — KML <altitude> with altitudeMode "absolute" is height above MEAN SEA
//   LEVEL (EGM96), while Sitrec's ECEF→LLA gives height above the ELLIPSOID. They
//   differ by the geoid undulation N (up to ~100 m), so we subtract it.
//
//   Tilt — KML measures from straight down: 0 = nadir, 90 = horizon, 180 = zenith.
//   Sitrec measures elevation from the horizontal. So tilt = elevation + 90.
//
//   Roll — KML composes the camera as heading (about local up), then tilt (about the
//   local east axis), then roll (about the view axis), with heading positive clockwise.
//   Working that through, positive roll tips the camera's up vector toward the camera's
//   RIGHT (a right bank). extractRoll() below measures exactly that.
//
//   Field of view — camera.fov is the vertical angle subtended by the FULL video frame
//   (not by the look view, which is widened by fovCoverage when the video letterboxes).
//   The horizontal angle follows from the frame's aspect under the same square-pixel
//   pinhole model the rest of Sitrec uses. The look view's anamorphic Y-compress is
//   applied after projection and is not part of that model — same limitation the camera
//   fitter has, and we say so in the console rather than silently exporting a squashed
//   frame as if it were square-pixel.

import {saveAs} from "file-saver";
import {Vector3} from "three";
import {GlobalDateTimeNode, NodeMan, Sit} from "./Globals";
import {par} from "./par";
import {ECEFToLLAVD_radii} from "./LLA-ECEF-ENU";
import {getAzElFromPositionAndForward, getLocalUpVector} from "./SphericalMath";
import {meanSeaLevelOffset} from "./EGM96Geoid";
import {degrees, escapeXML, getExportPrefix, radians} from "./utils";
import {showError} from "./showError";

// How big the photo rectangle is, in metres across. `near` is then derived from it and the
// field of view, rather than being a distance we pick directly.
//
// This is the rule Google Earth Pro itself follows. A GE Pro-authored PhotoOverlay with a
// ±0.1° x ±0.055° view volume writes near=2806.68 — which sounds far until you multiply it
// out: 2806.68 * (tan(0.1) - tan(-0.1)) = 9.80 m. The rectangle is ten metres across. The
// distance is large only because the lens is narrow.
//
// Holding the SIZE rather than the distance is what makes it work at any focal length.
// Only the ViewVolume angles decide what the photo covers, so `near` purely sets how big
// the rectangle is and how far out it floats: fix the distance instead and a wide-angle
// sitch gets a kilometres-wide billboard hanging over the terrain it is meant to be
// compared against, while a long-lens one (Sitrec's FOV goes down to 0.35°) gets a
// sub-metre speck. Fixing the size gives both a photo you can see, sitting near its
// viewpoint — and Google Earth still fills the screen with it when you fly into the
// overlay, whatever the distance works out to be.
const PHOTO_WIDTH_M = 10;

// Trim to a sane number of decimals. Lat/lon get 8 (about a millimetre), angles 4.
// "-0.0000" is a legal but confusing way to write zero, and it is what a camera pointing
// exactly level or exactly north produces, so strip the sign off values that round to zero.
const fx = (v, d) => {
    const s = Number(v).toFixed(d);
    return /^-0(\.0*)?$/.test(s) ? s.slice(1) : s;
};

// KML's heading range is 0..360, and a camera a hair west of north comes out of the az/el
// maths as 359.9999999, which rounds to a literal "360.0000" — in range by a whisker, but
// it reads as a full turn and trips readers that validate heading < 360. Round first, then
// wrap, so that case lands on 0 where it belongs.
const fxHeading = (v) => fx((Number(Number(v).toFixed(4)) % 360 + 360) % 360, 4);

/**
 * Roll of a camera about its own view axis, in the KML sense: positive when the
 * camera's up vector has tipped toward the camera's right (a right bank).
 *
 * Measured from the camera's basis rather than read off the PTZ slider, so it is
 * correct whichever controller is currently driving the camera. Same sign as Sitrec's
 * other horizon-roll measures (extractRollFromMatrix, horizonAngle) — and therefore the
 * negation of the PTZ roll slider, which is applied as camera.rotateZ(radians(roll)).
 *
 * Not extractRollFromMatrix() itself: that one references V3(0,1,0), the fixed WORLD Y
 * axis, which in ECEF is only "up" at latitude 0, longitude 90E. A camera anywhere else
 * needs the ellipsoid normal under it, which is what getLocalUpVector gives.
 *
 * Returns 0 when the camera is looking straight up or down, where "which way is up"
 * is degenerate and roll and heading describe the same rotation.
 */
export function extractRoll(camera) {
    const forward = new Vector3();
    const camUp = new Vector3();
    camera.getWorldDirection(forward);
    camUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize();

    const localUp = getLocalUpVector(camera.position);

    // The zero-roll reference: local up with its along-view component removed.
    const upRef = localUp.clone().sub(forward.clone().multiplyScalar(localUp.dot(forward)));
    if (upRef.lengthSq() < 1e-8) return 0;
    upRef.normalize();

    // Signed angle from upRef to camUp about forward. forward x upRef points along the
    // camera's right, so this is positive exactly when up has tipped right.
    const sin = upRef.clone().cross(camUp).dot(forward);
    const cos = upRef.dot(camUp);
    return degrees(Math.atan2(sin, cos));
}

/**
 * The look camera's pose in the terms KML's <Camera> wants.
 * Returns {lat, lon, altMSL, altHAE, heading, tilt, roll, fovV, position, forward}.
 *
 * `view` is the view the camera is rendered in. Two of its controls rotate the camera at
 * RENDER time rather than in the camera node — Camera Tweaks' X/Y offset
 * (applyCameraOffset) and traverse display targeting (applyDisplayLookAt) — so the camera
 * sitting in the node between renders can be aimed somewhere the look view is not. Export
 * what is on screen, since matching the look view is the entire point, by borrowing the
 * same apply/remove bracket the render and the tile LOD use, in the same order.
 *
 * Only the ORIENTATION half of that bracket is taken. prepareCameraForLOD() would also
 * widen camera.fov by /fovCoverage to cover the view's letterboxing, and the field this
 * export needs is the un-widened one — the angle the video frame itself subtends.
 */
export function getCameraKMLPose(cameraNode, view = null) {
    const camera = cameraNode.camera;

    // Only bracket a view that actually renders THIS camera, so one view's offsets can
    // never be applied to another view's camera.
    const brackets = (view && view.camera === camera
        && typeof view.applyCameraOffset === "function"
        && typeof view.applyDisplayLookAt === "function");

    let savedLookAt = null, savedQuaternion = null;
    try {
        if (brackets) {
            savedLookAt = view.applyDisplayLookAt(par.frame);
            savedQuaternion = view.applyCameraOffset();
        }
        camera.updateMatrixWorld();

        const position = camera.position.clone();
        const forward = new Vector3();
        camera.getWorldDirection(forward);

        const lla = ECEFToLLAVD_radii(position);
        const lat = lla.x, lon = lla.y, altHAE = lla.z;

        const [heading, elevation] = getAzElFromPositionAndForward(position, forward);

        return {
            lat, lon,
            altHAE,
            altMSL: altHAE - meanSeaLevelOffset(lat, lon),
            heading,
            tilt: elevation + 90,
            roll: extractRoll(camera),
            fovV: camera.fov,
            position, forward,
        };
    } finally {
        // Unwind in the reverse order, and in a finally: leaving the live camera rotated
        // because something threw would visibly break the view the user is looking at.
        if (brackets) {
            view.removeCameraOffset(savedQuaternion);
            view.removeDisplayLookAt(savedLookAt);
            camera.updateMatrixWorld();
        }
    }
}

/**
 * Draw the current video frame into a canvas at its native resolution, with the same
 * rotation, effects and colour adjustments the video window shows — the same call the
 * "Render Source Video" and "Export Video Frame" paths use.
 *
 * Returns {canvas, crop} where crop is the sub-rectangle of the full frame that ended
 * up in the canvas, in normalized [0,1] frame coordinates. It is the full frame unless
 * the video window is zoomed in, in which case drawAdjustedSourceFrame crops to the
 * zoom/pan region and the view volume has to narrow to match.
 */
function renderVideoFrameToCanvas(videoView, frame) {
    const canvas = document.createElement("canvas");
    if (!videoView.drawAdjustedSourceFrame(frame, canvas)) return null;
    if (!canvas.width || !canvas.height) return null;

    // Mirrors drawAdjustedSourceFrame's source-rect computation, in normalized
    // coordinates so it is independent of which pixel space the frame is measured in.
    let u0 = 0, v0 = 0, span = 1;
    const zoomNode = videoView.in?.zoom;
    if (zoomNode !== undefined && zoomNode.v0 > 100) {
        const zoom = zoomNode.v0 / 100;
        span = 1 / zoom;
        const clamp = (x) => Math.max(0, Math.min(1 - span, x));
        u0 = clamp((1 - span) / 2 + (videoView.panOffsetX || 0));
        v0 = clamp((1 - span) / 2 + (videoView.panOffsetY || 0));
    }

    return {canvas, crop: {u0, v0, u1: u0 + span, v1: v0 + span}};
}

/**
 * The four <ViewVolume> half-angles, in degrees, for an image covering `crop` of a
 * frame `width` x `height` pixels seen through a camera of vertical field `fovV`.
 *
 * Left/bottom come out negative and right/top positive, as KML expects. They are only
 * symmetric when the whole frame is used; a zoomed, panned video window gives an
 * off-centre crop, which the four independent angles represent exactly.
 */
export function viewVolumeFromCrop(fovV, width, height, crop) {
    // Focal length in frame pixels: the vertical field spans the full frame height.
    const f = height / (2 * Math.tan(fovV * Math.PI / 360));
    const ang = (px) => degrees(Math.atan(px / f));
    return {
        leftFov: ang((crop.u0 - 0.5) * width),
        rightFov: ang((crop.u1 - 0.5) * width),
        topFov: ang((0.5 - crop.v0) * height),
        bottomFov: ang((0.5 - crop.v1) * height),
    };
}

/**
 * Distance to the photo plane that makes the rectangle PHOTO_WIDTH_M metres across, given
 * the view volume's horizontal angles. The photo's width at distance d is
 * d * (tan(rightFov) - tan(leftFov)), so invert that.
 */
function photoPlaneDistance(viewVolume) {
    const spanTan = Math.tan(radians(viewVolume.rightFov)) - Math.tan(radians(viewVolume.leftFov));
    if (!(spanTan > 1e-9)) return PHOTO_WIDTH_M;   // degenerate field, nothing better to say
    return PHOTO_WIDTH_M / spanTan;
}

function sitchDateString(frame) {
    try {
        return GlobalDateTimeNode ? GlobalDateTimeNode.frameToDate(frame).toISOString() : "";
    } catch (e) {
        return "";
    }
}

// Google Earth Pro gives its own PhotoOverlays a camera icon rather than the default
// pushpin — on the globe and in the Places list — so an exported viewpoint reads as a
// viewpoint at a glance. Same icons, but via their public maps.google.com URLs: GE Pro
// writes its list icon as ":/camera_mode.png", an internal resource path that only
// resolves inside GE Pro itself.
const CAMERA_STYLE_ID = "sitrec-camera";
const CAMERA_STYLE = `\t<Style id="${CAMERA_STYLE_ID}">
\t\t<IconStyle>
\t\t\t<Icon>
\t\t\t\t<href>http://maps.google.com/mapfiles/kml/shapes/camera.png</href>
\t\t\t</Icon>
\t\t</IconStyle>
\t\t<ListStyle>
\t\t\t<listItemType>check</listItemType>
\t\t\t<ItemIcon>
\t\t\t\t<state>open closed error fetching0 fetching1 fetching2</state>
\t\t\t\t<href>http://maps.google.com/mapfiles/kml/shapes/camera-lv.png</href>
\t\t\t</ItemIcon>
\t\t\t<bgColor>00ffffff</bgColor>
\t\t\t<maxSnippetLines>2</maxSnippetLines>
\t\t</ListStyle>
\t</Style>`;

// altitudeMode is deliberately "absolute" — height above sea level — because that is what
// Sitrec knows and what the geoid correction above produces. Google Earth Pro writes
// gx:altitudeMode "relativeToSeaFloor" in its own saves, which over land means height
// above the TERRAIN; feeding an MSL altitude into that would lift the camera by the ground
// elevation beneath it (hundreds of metres in most sitches).
function cameraXML(pose, indent) {
    const i = indent;
    return `${i}<Camera>
${i}\t<longitude>${fx(pose.lon, 8)}</longitude>
${i}\t<latitude>${fx(pose.lat, 8)}</latitude>
${i}\t<altitude>${fx(pose.altMSL, 3)}</altitude>
${i}\t<heading>${fxHeading(pose.heading)}</heading>
${i}\t<tilt>${fx(pose.tilt, 4)}</tilt>
${i}\t<roll>${fx(pose.roll, 4)}</roll>
${i}\t<altitudeMode>absolute</altitudeMode>
${i}</Camera>`;
}

// Child order here is the order the KML schema requires — Google Earth is forgiving
// about it, but other readers validate against the sequence.
function photoOverlayKML({name, description, pose, imageHref, viewVolume, near}) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2" xmlns:atom="http://www.w3.org/2005/Atom">
<Document>
\t<name>${escapeXML(name)}</name>
${CAMERA_STYLE}
\t<PhotoOverlay>
\t\t<name>${escapeXML(name)}</name>
\t\t<description><![CDATA[${description}]]></description>
\t\t<visibility>1</visibility>
\t\t<styleUrl>#${CAMERA_STYLE_ID}</styleUrl>
${cameraXML(pose, "\t\t")}
\t\t<Icon>
\t\t\t<href>${escapeXML(imageHref)}</href>
\t\t</Icon>
\t\t<rotation>0</rotation>
\t\t<ViewVolume>
\t\t\t<leftFov>${fx(viewVolume.leftFov, 6)}</leftFov>
\t\t\t<rightFov>${fx(viewVolume.rightFov, 6)}</rightFov>
\t\t\t<bottomFov>${fx(viewVolume.bottomFov, 6)}</bottomFov>
\t\t\t<topFov>${fx(viewVolume.topFov, 6)}</topFov>
\t\t\t<near>${fx(near, 3)}</near>
\t\t</ViewVolume>
\t\t<Point>
\t\t\t<altitudeMode>absolute</altitudeMode>
\t\t\t<coordinates>${fx(pose.lon, 8)},${fx(pose.lat, 8)},${fx(pose.altMSL, 3)}</coordinates>
\t\t</Point>
\t\t<shape>rectangle</shape>
\t</PhotoOverlay>
</Document>
</kml>
`;
}

// No video to hang in front of the viewpoint, so export the viewpoint alone: a
// placemark whose <Camera> puts Google Earth exactly where Sitrec's camera is.
function cameraPlacemarkKML({name, description, pose}) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
\t<name>${escapeXML(name)}</name>
\t<Placemark>
\t\t<name>${escapeXML(name)}</name>
\t\t<description><![CDATA[${description}]]></description>
${cameraXML(pose, "\t\t")}
\t\t<Point>
\t\t\t<altitudeMode>absolute</altitudeMode>
\t\t\t<coordinates>${fx(pose.lon, 8)},${fx(pose.lat, 8)},${fx(pose.altMSL, 3)}</coordinates>
\t\t</Point>
\t</Placemark>
</Document>
</kml>
`;
}

function describe(pose, frame, extra = "") {
    const date = sitchDateString(frame);
    return [
        `Exported from Sitrec${Sit?.name ? " — " + escapeXML(Sit.name) : ""}`,
        date ? `Time: ${date}` : "",
        `Frame: ${frame}`,
        `Position: ${fx(pose.lat, 6)}, ${fx(pose.lon, 6)} at ${fx(pose.altMSL, 1)} m MSL ` +
        `(${fx(pose.altHAE, 1)} m HAE)`,
        `Heading: ${fxHeading(pose.heading)}°  Elevation: ${fx(pose.tilt - 90, 2)}° ` +
        `(KML tilt ${fx(pose.tilt, 2)}°)  Roll: ${fx(pose.roll, 2)}°`,
        `Vertical FOV: ${fx(pose.fovV, 3)}°`,
        extra,
    ].filter(Boolean).join("<br/>\n");
}

/**
 * "Export Camera as KML (Photo)" — the Camera menu button.
 *
 * Writes a KMZ containing the current video frame as a PhotoOverlay seen from the look
 * camera, or a plain KML with just the camera when no video frame is available.
 */
export async function exportCameraAsKML() {
    const cameraNode = NodeMan.get("lookCamera", false);
    if (!cameraNode || !cameraNode.camera) {
        showError("Can't export the camera: this sitch has no look camera.");
        return null;
    }

    const lookView = NodeMan.get("lookView", false);
    const pose = getCameraKMLPose(cameraNode, lookView);
    if (!Number.isFinite(pose.lat) || !Number.isFinite(pose.lon) || !Number.isFinite(pose.altMSL)) {
        showError("Can't export the camera: its position did not convert to a valid " +
            "latitude/longitude/altitude.");
        return null;
    }

    const frame = Math.floor(par.frame);
    const baseName = `${getExportPrefix()}_camera_${String(frame).padStart(5, "0")}`;

    const videoView = NodeMan.get("video", false);
    const rendered = (videoView && videoView.videoData && videoView.drawAdjustedSourceFrame)
        ? renderVideoFrameToCanvas(videoView, frame)
        : null;

    if (!rendered) {
        // Nothing to photograph — export the viewpoint on its own rather than a
        // PhotoOverlay with no photo, which Google Earth shows as an empty frame.
        const kml = cameraPlacemarkKML({
            name: `${Sit?.name ?? "Sitrec"} camera`,
            description: describe(pose, frame, "No video frame was available, so this is the " +
                "camera viewpoint only."),
            pose,
        });
        saveAs(new Blob([kml], {type: "application/vnd.google-earth.kml+xml"}), baseName + ".kml");
        console.log(`Exported camera-only KML (no video frame): ${baseName}.kml`);
        return {kml};
    }

    const {canvas, crop} = rendered;
    const viewVolume = viewVolumeFromCrop(pose.fovV, canvas.width, canvas.height, crop);
    const near = photoPlaneDistance(viewVolume);

    const hFOV = viewVolume.rightFov - viewVolume.leftFov;
    const vFOVUsed = viewVolume.topFov - viewVolume.bottomFov;

    // Y-compress is applied after projection, so the square-pixel pinhole this export
    // writes cannot describe it. Say so rather than let a squashed frame quietly claim
    // to be a straight one.
    const yCompress = lookView?.yCompress;
    const notes = [];
    if (yCompress > 1.0001) {
        notes.push(`Look view Y-compress is ${yCompress.toFixed(2)}x, which this export ` +
            `cannot represent — the photo will not align vertically.`);
    }
    if (crop.u1 - crop.u0 < 0.999) {
        notes.push(`The video window is zoomed in, so only that crop is exported ` +
            `(field of view narrowed to match).`);
    }

    const description = describe(pose, frame,
        `Image FOV: ${fx(hFOV, 3)}° x ${fx(vFOVUsed, 3)}°  (${canvas.width} x ${canvas.height} px)` +
        (notes.length ? "<br/>\n" + notes.map(escapeXML).join("<br/>\n") : ""));

    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.92));
    if (!blob) {
        showError("Can't export the camera: the video frame could not be encoded as a JPEG.");
        return null;
    }

    const imageHref = "files/frame.jpg";
    const kml = photoOverlayKML({
        name: `${Sit?.name ?? "Sitrec"} camera, frame ${frame}`,
        description,
        pose,
        imageHref,
        viewVolume,
        near,
    });

    const {default: JSZip} = await import("jszip");
    const zip = new JSZip();
    zip.file("doc.kml", kml);
    zip.file(imageHref, blob);
    const kmz = await zip.generateAsync({type: "blob", mimeType: "application/vnd.google-earth.kmz"});
    saveAs(kmz, baseName + ".kmz");

    console.log(`Exported PhotoOverlay KMZ: ${baseName}.kmz — ` +
        `${fx(pose.lat, 6)}, ${fx(pose.lon, 6)} @ ${fx(pose.altMSL, 1)}m MSL, ` +
        `heading ${fxHeading(pose.heading)}°, tilt ${fx(pose.tilt, 2)}°, roll ${fx(pose.roll, 2)}°, ` +
        `FOV ${fx(hFOV, 2)}° x ${fx(vFOVUsed, 2)}°, near ${fx(near, 0)}m`);
    notes.forEach(n => console.warn("Export Camera as KML: " + n));

    return {kml, viewVolume, pose, near};
}
