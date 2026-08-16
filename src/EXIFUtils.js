import {Vector3} from "three";
import {ViewMan} from "./CViewManager";
import {ECEFToLLAVD_radii, LLAToECEF} from "./LLA-ECEF-ENU";
import {meanSeaLevelOffset, ensureGeoidLoaded} from "./EGM96Geoid";
import {GlobalDateTimeNode, guiMenus, NodeMan, setRenderOne} from "./Globals";
import {forceUpdateUIText} from "./nodes/CNodeViewUI";
import {intersectSurface} from "./threeExt";
import {getLocalNorthVector, getLocalUpVector} from "./SphericalMath";
import {atan, degrees, m2f, radians, tan} from "./utils";
import {applyExifUtcOffset, pickExifUtcOffset} from "./exifCaptureTime";
import {showChoice} from "./showError";
import {EventManager} from "./CEventManager";

let exifrPromise;

function getExifr() {
    exifrPromise ??= (() => {
        if (typeof require === "function") {
            try {
                return Promise.resolve(require("exifr"));
            } catch {
            }
        }

        return import("exifr");
    })().then(module => module.default ?? module);
    return exifrPromise;
}

function toFiniteNumber(value) {
    if (value === undefined || value === null) return undefined;
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : undefined;
    }
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed === "") return undefined;
        const parsed = Number(trimmed);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    if (Array.isArray(value)) {
        for (const entry of value) {
            const parsed = toFiniteNumber(entry);
            if (parsed !== undefined) return parsed;
        }
        return undefined;
    }
    if (typeof value === "object") {
        if ("value" in value) return toFiniteNumber(value.value);
        if ("numerator" in value && "denominator" in value) {
            const numerator = toFiniteNumber(value.numerator);
            const denominator = toFiniteNumber(value.denominator);
            if (numerator !== undefined && denominator !== undefined && denominator !== 0) {
                return numerator / denominator;
            }
        }
    }
    return undefined;
}

function pickNumber(source, keys) {
    for (const key of keys) {
        const value = toFiniteNumber(source?.[key]);
        if (value !== undefined) {
            return {key, value};
        }
    }
    return null;
}

function pickValue(source, keys) {
    for (const key of keys) {
        const value = source?.[key];
        if (value !== undefined && value !== null && value !== "") {
            return {key, value};
        }
    }
    return null;
}

function normalizeHeadingDegrees(value) {
    return ((value % 360) + 360) % 360;
}

function normalizeSignedDegrees(value) {
    const normalized = ((value + 180) % 360 + 360) % 360 - 180;
    return normalized === -180 ? 180 : normalized;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

// The long side of the 36x24mm full-frame gate that every "35mm equivalent" is quoted against.
// Matches FULL_FRAME_LONG_MM in CNodeControllerPTZUI, which anchors the slider the same way.
const FULL_FRAME_LONG_MM = 36;

/**
 * Millimetres per FocalPlaneResolutionUnit, accepting BOTH the raw EXIF code and the
 * human-readable string exifr substitutes for it.
 *
 * exifr translates enum tags to strings by default and we do not turn that off, so unit 2
 * arrives as "Inch", not 2. Reading it as a number therefore failed for every camera that
 * reports its field of view this way — Canon bodies write FocalPlane* and no
 * FocalLengthIn35mmFormat, so they silently lost their FOV entirely on import.
 *
 * Both forms have to be handled, because exifr's dictionary only covers 1–3. Units 4 and 5
 * have no entry there and still come through as plain numbers.
 */
function focalPlaneUnitToMm(rawUnit) {
    if (typeof rawUnit === "string") {
        switch (rawUnit.trim().toLowerCase()) {
            case "inch":
            case "inches":
                return 25.4;
            case "centimeter":
            case "centimetre":
                return 10;
            case "millimeter":
            case "millimetre":
                return 1;
            case "micrometer":
            case "micrometre":
                return 0.001;
            default:
                // Includes "No absolute unit of measurement" (unit 1), which cannot size a sensor.
                return null;
        }
    }

    switch (toFiniteNumber(rawUnit)) {
        case 2: return 25.4;
        case 3: return 10;
        case 4: return 1;
        case 5: return 0.001;
        default: return null;
    }
}

function deriveSensorSize(raw) {
    const xResolution = toFiniteNumber(raw?.FocalPlaneXResolution);
    const yResolution = toFiniteNumber(raw?.FocalPlaneYResolution);
    const imageWidth = toFiniteNumber(raw?.ExifImageWidth);
    const imageHeight = toFiniteNumber(raw?.ExifImageHeight);
    const mmPerUnit = focalPlaneUnitToMm(raw?.FocalPlaneResolutionUnit);

    if (!xResolution || !yResolution || !imageWidth || !imageHeight || !mmPerUnit) {
        return null;
    }

    return {
        sensorWidthMm: imageWidth / xResolution * mmPerUnit,
        sensorHeightMm: imageHeight / yResolution * mmPerUnit,
        source: "focalPlaneResolution"
    };
}

/**
 * The aspect ratio of the frame AS DISPLAYED, from the stored pixel dimensions and the rotation.
 * Undefined when the file does not say.
 */
function displayedAspect(raw, dimensionSwapped) {
    const w = toFiniteNumber(raw?.ExifImageWidth);
    const h = toFiniteNumber(raw?.ExifImageHeight);
    if (!(w > 0) || !(h > 0)) return undefined;
    return dimensionSwapped ? h / w : w / h;
}

function deriveVerticalFov(raw, optics, dimensionSwapped = false) {
    const zoomRatio = optics.digitalZoomRatio ?? 1;
    const focal35 = optics.focalLength35mm;
    if (focal35 !== undefined && focal35 > 0) {
        const effectiveFocal35 = focal35 * zoomRatio;

        // A 35mm-equivalent focal length describes the frame's LONG axis against the 36mm long
        // side of the full-frame gate — the same convention the FOV sliders use. It does NOT
        // describe the vertical unless the frame happens to be 3:2, which is what reading it
        // against the gate's 24mm height silently assumed.
        //
        // That assumption is worst on cropped frames, which is most drone footage: a DJI Air 2S
        // wide crop is 5472x2472 (2.21:1) and still reports 22mm, because the crop takes height
        // off the same lens and leaves the full width. Read against the height it produced a
        // 100.7 degree horizontal field where 78.6 is right — a 22 degree error.
        //
        // Limitation worth naming: this is exact when the long axis is the one that was NOT
        // cropped, which covers uncropped frames of either orientation and every letterbox or
        // pillarbox crop. A crop that eats into both axes cannot be recovered from EXIF at all,
        // since nothing in the file says how much was taken.
        const longAxisFovDeg = degrees(2 * atan(FULL_FRAME_LONG_MM / (2 * effectiveFocal35)));
        const aspect = displayedAspect(raw, dimensionSwapped);

        let verticalFovDeg;
        if (aspect === undefined) {
            // No pixel dimensions to go on. Fall back to the old 3:2 reading rather than nothing;
            // it is right for the commonest frame shape and no worse than before.
            verticalFovDeg = degrees(2 * atan(24 / (2 * effectiveFocal35)));
        } else if (aspect >= 1) {
            // Landscape: the long axis is horizontal, so convert across to the vertical.
            verticalFovDeg = degrees(2 * atan(tan(radians(longAxisFovDeg) / 2) / aspect));
        } else {
            // Portrait: the long axis already IS the vertical one.
            verticalFovDeg = longAxisFovDeg;
        }

        return {
            verticalFovDeg,
            source: "35mmEquivalent"
        };
    }

    const focalLength = optics.focalLengthMm;
    const sensor = deriveSensorSize(raw);
    if (focalLength !== undefined && focalLength > 0 && sensor?.sensorHeightMm) {
        const effectiveFocalLength = focalLength * zoomRatio;
        // deriveSensorSize describes the sensor AS READ OUT, which is always landscape. A photo
        // shot in portrait carries an Orientation of 90 or 270 degrees and is displayed rotated,
        // so the axis that ends up vertical on screen is the sensor's WIDTH, not its height.
        // Reading the height regardless made an 85mm portrait frame report 16.07 degrees where
        // 23.91 is correct - half the vertical field missing, and every reconstruction from it
        // wrong by that much.
        const verticalMm = dimensionSwapped ? sensor.sensorWidthMm : sensor.sensorHeightMm;
        return {
            verticalFovDeg: degrees(2 * atan(verticalMm / (2 * effectiveFocalLength))),
            // Report the pair the way it is displayed too, so anything downstream that pairs
            // these with the image dimensions agrees with what is on screen.
            sensorWidthMm: dimensionSwapped ? sensor.sensorHeightMm : sensor.sensorWidthMm,
            sensorHeightMm: verticalMm,
            source: sensor.source
        };
    }

    return null;
}

function buildForwardVector(position, azimuthDeg, elevationDeg) {
    const up = getLocalUpVector(position);
    const north = getLocalNorthVector(position);
    const east = new Vector3().crossVectors(north, up).normalize();
    const forward = north.clone();
    forward.applyAxisAngle(east, radians(elevationDeg));
    forward.applyAxisAngle(up, -radians(azimuthDeg));
    return {forward, up};
}

function findPTZController(cameraNode) {
    const ptzController = NodeMan.get("ptzAngles", false);
    if (ptzController) return ptzController;

    const inputs = cameraNode?.inputs ?? {};
    for (const input of Object.values(inputs)) {
        if (input?.isController && input.az !== undefined && input.el !== undefined) {
            return input;
        }
    }
    return null;
}

function findAuthoritativeCameraPositionNode() {
    const fixedCameraPosition = NodeMan.get("fixedCameraPosition", false);
    if (fixedCameraPosition?.setLLA) {
        return fixedCameraPosition;
    }

    return null;
}

function findAuthoritativeTargetPositionNode() {
    const fixedTargetPositionWind = NodeMan.get("fixedTargetPositionWind", false);
    if (fixedTargetPositionWind?.setLLA) {
        return fixedTargetPositionWind;
    }

    return null;
}

function findPreferredFrustumFocusTrack() {
    return NodeMan.get("targetTrackSwitchSmooth", false)
        ?? NodeMan.get("fixedTargetPositionWind", false)
        ?? NodeMan.get("fixedTargetPosition", false)
        ?? null;
}

function summarizeLocation(metadata) {
    const location = metadata?.placement;
    if (!location?.hasLocation) return null;
    return `${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)} @ ${location.altitude.toFixed(1)} m ${location.altitudeReference ?? "MSL"}`;
}

function getPlacementAltitudeInfo(placement) {
    const altitude = placement?.altitude ?? 0;
    const altitudeReference = placement?.altitudeReference ?? "MSL";

    if (!placement?.hasLocation) {
        return {
            altitudeMSL: altitude,
            altitudeHAE: altitude,
            altitudeReference,
        };
    }

    const geoidOffset = meanSeaLevelOffset(placement.latitude, placement.longitude);
    if (altitudeReference === "HAE") {
        return {
            altitudeMSL: altitude - geoidOffset,
            altitudeHAE: altitude,
            altitudeReference,
        };
    }

    return {
        altitudeMSL: altitude,
        altitudeHAE: altitude + geoidOffset,
        altitudeReference,
    };
}

function summarizeLLA(lat, lon, alt, altitudeReference = "MSL") {
    return `${lat.toFixed(6)}, ${lon.toFixed(6)} @ ${alt.toFixed(1)} m ${altitudeReference}`;
}

function vectorToLLAArray(vector) {
    const lla = ECEFToLLAVD_radii(vector);
    return [lla.x, lla.y, lla.z];
}

function updateCameraLookState(cameraNode, camera, target) {
    cameraNode.lookAtLLA = vectorToLLAArray(target);
    cameraNode.upLLA = vectorToLLAArray(camera.position.clone().addScaledVector(camera.up, 1000));
}

const IMAGE_IMPORT_VIEW_LAYOUTS = [
    {
        requiredViews: ["mainView", "lookView", "videoView"],
        build: ({videoView}) => [
            {name: "mainView", left: 0, top: 0, width: 0.55, height: 1, visible: true},
            {name: "lookView", left: 0.55, top: 0, width: 0.45, height: 0.5, visible: true},
            {name: videoView.id ?? "video", left: 0.55, top: 0.5, width: 0.45, height: 0.5, visible: true},
        ],
    },
    {
        requiredViews: ["mainView", "lookView"],
        build: () => [
            {name: "mainView", left: 0, top: 0, width: 0.55, height: 1, visible: true},
            {name: "lookView", left: 0.55, top: 0, width: 0.45, height: 1, visible: true},
        ],
    },
    {
        requiredViews: ["lookView"],
        build: () => [
            {name: "lookView", left: 0, top: 0, width: 1, height: 1, visible: true},
        ],
    },
];

function getImportedImageViewLayout(views) {
    const layout = IMAGE_IMPORT_VIEW_LAYOUTS.find(({requiredViews}) => requiredViews.every(viewName => views[viewName]));
    return layout?.build(views) ?? [];
}

function applyViewPosition(position) {
    ViewMan.updateViewFromPreset(position.name, position);
}

function applyImportedImageCameraPositionInternal(metadata, filename = "", options = {}) {
    if (!metadata) return null;

    const {
        logResult = true,
        snapshot = true,
        render = true,
    } = options;

    const cameraNode = NodeMan.get("lookCamera", false) ?? NodeMan.get("mainCamera", false);
    if (!cameraNode?.camera) {
        if (logResult) {
            console.log(`[EXIF] Parsed metadata for ${filename}, but no look/main camera exists to apply camera position`);
        }
        return null;
    }

    const placement = metadata.placement ?? {};
    if (!placement.hasLocation) {
        if (logResult) {
            console.log(`[EXIF] Parsed metadata for ${filename}, but no GPS location was available for camera positioning`);
        }
        return null;
    }

    const applied = {};
    const camera = cameraNode.camera;
    const cameraPositionNode = findAuthoritativeCameraPositionNode();
    const {altitudeMSL, altitudeHAE} = getPlacementAltitudeInfo(placement);
    const cameraLat = NodeMan.get("cameraLat", false);
    const cameraLon = NodeMan.get("cameraLon", false);
    const cameraAlt = NodeMan.get("cameraAlt", false);
    const importedCameraPosition = LLAToECEF(placement.latitude, placement.longitude, altitudeHAE);

    // A geotagged photo's GPS altitude is ABSOLUTE (MSL) and authoritative — it must not
    // be reinterpreted as height-above-ground nor clamped to the terrain. By default the
    // camera is positioned by CNodeControllerTrackPosition with forceAboveSurface on, which
    // clamps the camera ABOVE the loaded 3D-tile surface. A ground-level photo whose true
    // altitude sits below the coarse/building-topped tile surface then gets pushed up by
    // ~one terrain-height (e.g. showing 277 ft instead of 214 ft) until a zoom reloads finer
    // tiles and re-clamps lower. Disabling the surface clamp keeps the camera at the photo's
    // real altitude. (agl=false likewise forces the position node to treat the stored
    // altitude as absolute rather than above-ground.)
    cameraNode.forceAboveSurface = false;

    if (cameraPositionNode) {
        if (cameraPositionNode.agl !== undefined) {
            cameraPositionNode.agl = false;
            // Keep the "Above Ground Level" GUI checkbox in sync with the change.
            cameraPositionNode.aglController?.updateDisplay?.();
        }
        cameraPositionNode.setLLA(placement.latitude, placement.longitude, altitudeMSL);
        applied.cameraPositionNode = cameraPositionNode.id ?? "fixedCameraPosition";
    } else if (cameraLat && cameraLon && cameraAlt) {
        cameraLat.setValue(placement.latitude, true);
        cameraLon.setValue(placement.longitude, true);
        if (cameraAlt.setValueWithUnits) {
            cameraAlt.setValueWithUnits(altitudeMSL, "metric", "small", true);
        } else {
            cameraAlt.setValue(m2f(altitudeMSL), true);
        }

        if (cameraLat.recalculateCascade) {
            cameraLat.recalculateCascade();
        }
    } else if (cameraNode.recalculateCascade) {
        cameraNode.startPosLLA = [placement.latitude, placement.longitude, altitudeHAE];
        camera.position.copy(importedCameraPosition);
        camera.updateMatrixWorld();
        cameraNode.recalculateCascade();
    }

    cameraNode.startPosLLA = [placement.latitude, placement.longitude, altitudeHAE];
    camera.position.copy(importedCameraPosition);
    camera.updateMatrixWorld();

    const locationSummary = summarizeLocation(metadata);
    applied.cameraPosition = locationSummary;
    applied.location = locationSummary;

    if (snapshot && cameraNode.snapshotCamera) {
        cameraNode.snapshotCamera();
    }

    if (render) {
        setRenderOne(true);
    }

    if (logResult) {
        console.log(`[EXIF] Applied EXIF camera position for ${filename}: ${locationSummary}`);
    }

    offerRelativeAltitude(placement, filename);

    return applied;
}

// ---------------------------------------------------------------------------------------------
// "Use Relative Altitude"
//
// A drone's absolute altitude is barometric, seeded from GPS at takeoff, and drifts. A DJI Mini
// 3 Pro shot measured here reported 239.9m while the terrain under it was 256.9m — the camera
// landed 17m UNDERGROUND, and 59m below where the file's own RelativeAltitude (42m above the
// takeoff point) said it was.
//
// We still place the camera exactly where the file says. Silently substituting a guessed
// altitude is how a reconstruction stops being checkable. So instead we say so, and offer the
// alternative as one click that the user chooses to make.
// ---------------------------------------------------------------------------------------------

let relativeAltitudeButton = null;
let relativeAltitudeOffer = null;

/**
 * Ground elevation in MSL directly below an ECEF point, or undefined if the elevation for this
 * spot has not loaded yet.
 *
 * The "not loaded yet" case is the whole reason this goes through getPointBelowWithTileInfo
 * rather than getPointBelow. With no elevation tile, the terrain quietly answers SEA LEVEL, and
 * a photo taken over ground 250m up would look like it was 250m in the air. tileZ is -1 until a
 * real tile is in, which is the only honest way to tell "the ground is at zero here" apart from
 * "I do not know where the ground is yet".
 */
function groundMSLBelow(ecefPoint) {
    const terrain = NodeMan.get("TerrainModel", false);
    if (!terrain?.getPointBelowWithTileInfo) return undefined;
    const info = terrain.getPointBelowWithTileInfo(ecefPoint.clone(), 0);
    if (!info || info.tileZ < 0) return undefined;
    const lla = ECEFToLLAVD_radii(info.point);   // (lat, lon, HAE)
    return lla.z - meanSeaLevelOffset(lla.x, lla.y);
}

/**
 * Wait for the elevation around the camera to STOP CHANGING, then measure the ground under it.
 *
 * The camera has just jumped to a new part of the world, and tiles stream in coarse first, fine
 * later. Measuring on the first tile that arrives is not merely early, it is wrong: the coarse
 * pass over this Libyan oasis reported the ground at 460m where the loaded terrain settles at
 * 257m, which would have accused a correctly-placed camera of being 220m underground.
 *
 * "No higher-zoom tile loaded" cannot tell finest from not-yet-arrived, so it does not help here.
 * The terrain does announce every elevation change though, so the honest test is quiescence: once
 * nothing has changed for a beat, what we can read is what we are going to get.
 */
function waitForGroundMSLBelow(cameraNode, {quietMs = 2000, timeoutMs = 30000} = {}) {
    return new Promise((resolve) => {
        let quietTimer = null;
        let hardTimer = null;
        let settled = false;

        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(quietTimer);
            clearTimeout(hardTimer);
            EventManager.removeEventListener("elevationChanged", onElevationChanged);
            resolve(cameraNode?.camera ? groundMSLBelow(cameraNode.camera.position) : undefined);
        };
        const armQuietTimer = () => {
            clearTimeout(quietTimer);
            quietTimer = setTimeout(finish, quietMs);
        };
        const onElevationChanged = () => armQuietTimer();

        EventManager.addEventListener("elevationChanged", onElevationChanged);
        hardTimer = setTimeout(finish, timeoutMs);
        armQuietTimer();
    });
}

function applyRelativeAltitude() {
    const offer = relativeAltitudeOffer;
    if (!offer) return;

    const cameraNode = NodeMan.get("lookCamera", false) ?? NodeMan.get("mainCamera", false);
    const positionNode = findAuthoritativeCameraPositionNode();
    if (!cameraNode?.camera || !positionNode) return;

    const groundMSL = groundMSLBelow(cameraNode.camera.position);
    if (groundMSL === undefined) {
        console.warn("[EXIF] Use Relative Altitude: no terrain loaded here yet, so there is " +
            "nothing to measure the height against. Try again once the ground has drawn in.");
        return;
    }

    const newAltitudeMSL = groundMSL + offer.relativeAltitude;
    positionNode.setLLA(offer.latitude, offer.longitude, newAltitudeMSL);
    setRenderOne(true);
    console.log(`[EXIF] Camera altitude set from RelativeAltitude: ground ` +
        `${groundMSL.toFixed(1)}m + ${offer.relativeAltitude}m = ${newAltitudeMSL.toFixed(1)}m MSL ` +
        `(the file's own absolute altitude was ${offer.absoluteAltitude.toFixed(1)}m)`);
}

/**
 * Offer the takeoff-relative height as an alternative when the photo's own altitude has buried
 * the camera under the terrain.
 *
 * Two ways in. The button in Camera > Location appears for any photo carrying the field, so the
 * swap is always available. The dialog only interrupts when the camera has actually ended up
 * underground, because that is the case the user cannot be expected to notice - the look view
 * just goes brown.
 *
 * It waits for the elevation before deciding. The camera has just jumped to a new part of the
 * world, and until a tile arrives the terrain answers sea level, which would either invent a
 * problem or hide one.
 */
async function offerRelativeAltitude(placement, filename = "") {
    const relativeAltitude = placement?.relativeAltitude;

    if (!placement?.hasLocation || relativeAltitude === undefined) {
        relativeAltitudeOffer = null;
        relativeAltitudeButton?.hide();
        return;
    }

    const offer = {
        latitude: placement.latitude,
        longitude: placement.longitude,
        absoluteAltitude: placement.altitude ?? 0,
        relativeAltitude,
    };
    relativeAltitudeOffer = offer;

    if (!relativeAltitudeButton && guiMenus?.cameraLocation) {
        relativeAltitudeButton = guiMenus.cameraLocation.add({
            useRelativeAltitude: () => applyRelativeAltitude(),
        }, "useRelativeAltitude").perm()
            .tooltip("Put the camera at the terrain height under it plus the height above " +
                "takeoff the photo recorded, instead of the absolute altitude the photo " +
                "claims.\n\nDrone absolute altitudes are barometric and drift, sometimes by " +
                "tens of metres — enough to bury the camera underground. The height above " +
                "takeoff is usually the more trustworthy of the two, but it assumes the ground " +
                "under the drone is level with where it took off.");
    }
    relativeAltitudeButton?.name(`Use Relative Altitude (${relativeAltitude} m)`).show();

    const cameraNode = NodeMan.get("lookCamera", false) ?? NodeMan.get("mainCamera", false);
    const groundMSL = await waitForGroundMSLBelow(cameraNode);

    // A later import took over while we waited, so this answer is about the wrong photo.
    if (relativeAltitudeOffer !== offer) return;

    if (groundMSL === undefined) {
        console.warn(`[EXIF] ${filename}: no elevation loaded here, so the camera's height above ` +
            `the ground could not be checked. "Use Relative Altitude" in Camera > Location is ` +
            `available if it turns out to be buried.`);
        return;
    }

    const {altitudeMSL} = getPlacementAltitudeInfo(placement);
    const below = groundMSL - altitudeMSL;
    if (below <= 0) return;

    const suggested = groundMSL + relativeAltitude;
    console.warn(`[EXIF] ${filename}: the camera is ${below.toFixed(1)}m BELOW the terrain. ` +
        `The photo's absolute altitude is ${altitudeMSL.toFixed(1)}m MSL but the ground here ` +
        `is ${groundMSL.toFixed(1)}m. Its RelativeAltitude says ${relativeAltitude}m above ` +
        `takeoff, which would put it at ${suggested.toFixed(1)}m.`);

    const choice = await showChoice(
        `"${filename}" puts the camera ${below.toFixed(1)} m BELOW the ground.\n\n` +
        `The photo's own altitude is ${altitudeMSL.toFixed(1)} m, but the terrain here is ` +
        `${groundMSL.toFixed(1)} m. Drone altitudes are barometric and drift.\n\n` +
        `The photo also records ${relativeAltitude} m above its takeoff point, which would ` +
        `put the camera at ${suggested.toFixed(1)} m.`,
        {
            title: "Camera is Underground",
            cancelValue: "keep",
            options: [
                {
                    label: `Use Relative Altitude (${relativeAltitude} m above ground)`,
                    description: `Move the camera to ${suggested.toFixed(1)} m. Assumes the ground here is level with the takeoff point.`,
                    value: "relative", primary: true, color: "#1976d2",
                },
                {
                    label: "Keep the Photo's Altitude",
                    description: `Leave it at ${altitudeMSL.toFixed(1)} m, underground, exactly as the file states.`,
                    value: "keep", cancel: true,
                },
            ],
        });

    // Still the current photo? The dialog can sit open across another import.
    if (choice === "relative" && relativeAltitudeOffer === offer) {
        applyRelativeAltitude();
    }
}

export function applyImportedImageCameraPosition(metadata, filename = "") {
    return applyImportedImageCameraPositionInternal(metadata, filename);
}

function applyImportedImageCaptureDateTime(metadata, filename = "", options = {}) {
    const {logResult = true, render = true} = options;
    const captureDate = metadata?.capture?.date;

    if (!captureDate || !GlobalDateTimeNode?.setStartDateTime) {
        return null;
    }

    const parsedDate = captureDate instanceof Date ? captureDate : new Date(captureDate);
    if (Number.isNaN(parsedDate.getTime())) {
        if (logResult) {
            console.log(`[EXIF] Ignored invalid capture date for ${filename}:`, captureDate);
        }
        return null;
    }

    GlobalDateTimeNode.setStartDateTime(parsedDate);
    // Dropped image's embedded EXIF date establishes the slider reset target.
    GlobalDateTimeNode.establishDateTimeDefaults();

    // Whether the instant is known or inferred is worth saying: with no
    // OffsetTime tag the time is only as good as the assumption that the
    // photograph was taken in this computer's timezone.
    if (logResult && metadata?.capture?.utcOffset === undefined) {
        console.log(`[EXIF] ${filename}: no OffsetTime tag — capture time assumed to be in `
            + `this computer's timezone (${Intl.DateTimeFormat().resolvedOptions().timeZone}). `
            + `If the photo was taken elsewhere, set the time by hand.`);
    }

    if (render) {
        setRenderOne(true);
    }

    const applied = {dateTime: parsedDate.toISOString()};
    if (logResult) {
        console.log(`[EXIF] Applied capture datetime for ${filename}: ${applied.dateTime}`);
    }
    return applied;
}

function applyImportedImageMainViewOverview(metadata, filename = "", options = {}) {
    const {logResult = true, render = true} = options;
    const placement = metadata?.placement ?? {};

    if (!placement.hasLocation) {
        return null;
    }

    const mainView = NodeMan.get("mainView", false);
    const mainCameraNode = NodeMan.get("mainCamera", false);
    if (!mainView?.camera) {
        return null;
    }

    const {altitudeHAE} = getPlacementAltitudeInfo(placement);
    const photoPosition = LLAToECEF(placement.latitude, placement.longitude, altitudeHAE);

    if (mainCameraNode?.goToPoint) {
        mainCameraNode.goToPoint(photoPosition, 2300000, 100000);
    } else {
        const up = getLocalUpVector(photoPosition);
        const south = getLocalNorthVector(photoPosition).multiplyScalar(-1);
        const overviewPosition = photoPosition.clone()
            .addScaledVector(up, 2300000)
            .addScaledVector(south, 100000);

        mainView.camera.position.copy(overviewPosition);
        mainView.camera.up.copy(up);
        mainView.camera.lookAt(photoPosition);
    }

    if (mainView.controls?.target) {
        mainView.controls.target.copy(photoPosition);
        mainView.controls.targetIsTerrain = false;
        mainView.controls.update?.(1);
    }

    if (render) {
        setRenderOne(true);
    }

    const applied = {
        mainViewOverview: summarizeLLA(placement.latitude, placement.longitude, placement.altitude ?? 0, placement.altitudeReference ?? "MSL"),
    };

    if (logResult) {
        console.log(`[EXIF] Moved main view above photo for ${filename}: ${applied.mainViewOverview}`);
    }

    return applied;
}

function applyImportedImageFrustumTarget(metadata, cameraNode, filename = "", options = {}) {
    const {logResult = true, render = true} = options;
    if (!cameraNode?.camera) {
        return null;
    }

    const placement = metadata?.placement ?? {};
    if (!placement.hasLocation || (placement.heading === undefined && placement.pitch === undefined)) {
        return null;
    }

    const camera = cameraNode.camera;
    camera.updateMatrixWorld();

    const forward = new Vector3();
    camera.getWorldDirection(forward);

    const surfaceHit = intersectSurface(camera.position, forward);
    const target = surfaceHit ?? camera.position.clone().add(forward.multiplyScalar(1000));
    const targetLLA = ECEFToLLAVD_radii(target);
    const targetAltitudeMSL = targetLLA.z - meanSeaLevelOffset(targetLLA.x, targetLLA.y);
    const targetNode = findAuthoritativeTargetPositionNode();
    const focusTrackNode = findPreferredFrustumFocusTrack();

    if (targetNode) {
        targetNode.setLLA(targetLLA.x, targetLLA.y, targetAltitudeMSL);
    }

    const mainView = NodeMan.get("mainView", false);
    if (mainView?.controls?.target) {
        mainView.controls.target.copy(target);
        mainView.controls.targetIsTerrain = surfaceHit !== null;
        mainView.camera?.lookAt?.(target);
        mainView.controls.update?.(1);
    }

    if (mainView && focusTrackNode) {
        mainView.focusTrackName = focusTrackNode.id;
    }

    if (render) {
        setRenderOne(true);
    }

    const applied = {
        frustumTarget: summarizeLLA(targetLLA.x, targetLLA.y, targetAltitudeMSL),
    };
    if (targetNode) {
        applied.targetPositionNode = targetNode.id ?? "fixedTargetPositionWind";
    }
    if (mainView?.controls?.target) {
        applied.viewTarget = mainView.id ?? "mainView";
    }
    if (focusTrackNode) {
        applied.focusTrack = focusTrackNode.id;
    }

    if (logResult) {
        console.log(`[EXIF] Applied frustum target for ${filename}: ${applied.frustumTarget}`);
    }

    return applied;
}

function applyImportedImageViewLayout(filename = "", options = {}) {
    const {logResult = true} = options;
    const views = {
        mainView: NodeMan.get("mainView", false),
        lookView: NodeMan.get("lookView", false),
        videoView: NodeMan.get("video", false) ?? NodeMan.get("videoView", false),
    };

    if (!views.mainView && !views.lookView && !views.videoView) {
        return null;
    }

    // A sitch with a video view already chose its layout, from the shared view PRESETS, when the
    // videoLoaded event fired - the same mechanism a dropped video goes through. Imposing this
    // table on top of that is what made a dropped image and a dropped video land differently:
    // the preset put the video top-right, and then this quietly moved it to the bottom-right
    // slot below, for images only, because a .MOV never passes through the EXIF importer.
    //
    // The remaining entries are still worth having for view configurations the preset system
    // does not cover (no video view at all), so this bails out rather than deleting the table.
    if (views.videoView) {
        // Still refresh the UI text: the import changed camera position, FOV and time even
        // though it moved nothing, and that refresh used to ride along at the end of this
        // function.
        forceUpdateUIText();
        if (logResult) {
            console.log(`[EXIF] ${filename}: leaving layout to the view preset`);
        }
        return null;
    }

    const layout = getImportedImageViewLayout(views);

    const successfulViews = [];
    for (const position of layout) {
        applyViewPosition(position);
        successfulViews.push(position.name);
    }

    if (successfulViews.length === 0) {
        return null;
    }

    forceUpdateUIText();

    const applied = {
        viewLayout: successfulViews.join(", "),
    };

    if (logResult) {
        console.log(`[EXIF] Applied view layout for ${filename}: ${applied.viewLayout}`);
    }

    return applied;
}

/**
 * Zero out the orientation/rotation fields in imported image metadata.
 *
 * Used for HEIC/HEIF: libheif applies the file's irot/imir orientation
 * transform while decoding, so the decoded pixels are already upright. The
 * EXIF Orientation tag describes that same rotation, so leaving it in the
 * metadata would make the downstream image pipeline (CVideoImageData / ground
 * overlay) rotate a second time. JPEG does NOT need this because new Image()
 * ignores EXIF orientation, so its rotation is applied exactly once downstream.
 */
export function stripImageRotationMetadata(metadata) {
    if (metadata?.image) {
        metadata.image.rotationDegrees = 0;
        metadata.image.mirroredX = false;
        metadata.image.mirroredY = false;
    }
    return metadata;
}

export async function extractJPEGImportMetadata(arrayBuffer, filename = "") {
    // JPEG and HEIC/HEIF both carry EXIF/XMP that exifr can parse (GPS location,
    // heading, focal length → FOV, orientation). Other formats are skipped.
    if (!/\.(jpe?g|heic|heif)$/i.test(filename)) {
        return null;
    }
    // Geotagged-image import computes MSL/HAE altitudes via the EGM96 geoid in the
    // synchronous apply* helpers that always run after this async extract step. Ensure
    // the lazily-fetched grid is loaded now so those sync calls have it (covers the
    // case of dropping a photo before any elevation-using sitch has loaded it).
    await ensureGeoidLoaded();

    const exifr = await getExifr();
    const [raw, rotation] = await Promise.all([
        exifr.parse(arrayBuffer, {
            gps: true,
            exif: true,
            ifd0: true,
            tiff: true,
            xmp: true,
        }),
        exifr.rotation(arrayBuffer),
    ]);

    if (!raw && !rotation) {
        return null;
    }

    const latitudeSource = pickNumber(raw, ["latitude", "GPSLatitude", "PoseLatitudeDegrees"]);
    const longitudeSource = pickNumber(raw, ["longitude", "GPSLongitude", "PoseLongitudeDegrees"]);
    const altitudeSource = pickNumber(raw, ["altitude", "GPSAltitude", "AbsoluteAltitude"]);
    const altitudeRefSource = pickNumber(raw, ["GPSAltitudeRef"]);
    // Height above the takeoff point, written by DJI and some other drones.
    const relativeAltitudeSource = pickNumber(raw, ["RelativeAltitude"]);
    const headingSource = pickNumber(raw, [
        "GPSImgDirection",
        "GPSDestBearing",
        "PoseHeadingDegrees",
        "CameraYaw",
        "GimbalYawDegree",
        "FlightYawDegree",
        "Yaw",
        "Heading",
    ]);
    const pitchSource = pickNumber(raw, [
        "PosePitchDegrees",
        "CameraPitch",
        "GimbalPitchDegree",
        "FlightPitchDegree",
        "Pitch",
        "Elevation",
    ]);
    const rollSource = pickNumber(raw, [
        "PoseRollDegrees",
        "CameraRoll",
        "GimbalRollDegree",
        "FlightRollDegree",
        "Roll",
    ]);

    const optics = {
        focalLengthMm: pickNumber(raw, ["FocalLength"])?.value,
        focalLength35mm: pickNumber(raw, ["FocalLengthIn35mmFormat"])?.value,
        digitalZoomRatio: pickNumber(raw, ["DigitalZoomRatio"])?.value,
        fNumber: pickNumber(raw, ["FNumber"])?.value,
        iso: pickNumber(raw, ["ISO", "RecommendedExposureIndex"])?.value,
    };

    if (optics.digitalZoomRatio === 0) {
        optics.digitalZoomRatio = undefined;
    }

    // Orientations 5-8 turn the frame a quarter turn, which is exactly the question the FOV
    // derivation has to answer: does the displayed frame stand on the sensor's short axis or its
    // long one. Both JPEG and HEIC end up upright on screen - JPEG because we rotate it
    // downstream, HEIC because libheif already did - so the swap applies to both, and
    // stripImageRotationMetadata (which only stops HEIC rotating twice) does not change that.
    //
    // Three independent signals, because getting this wrong costs half the vertical field and no
    // single one of them is always present: exifr's own flag, the rotation angle it reports (90
    // and 270 are the swapping ones, and this is equivalent to the flag by construction), and the
    // Orientation tag as exifr translates it.
    const dimensionSwapped =
        rotation?.dimensionSwapped === true
        || rotation?.deg === 90
        || rotation?.deg === 270
        || /rotate\s*(90|270)/i.test(String(raw?.Orientation ?? ""));

    const verticalFov = deriveVerticalFov(raw, optics, dimensionSwapped);
    if (verticalFov) {
        optics.verticalFovDeg = verticalFov.verticalFovDeg;
        optics.verticalFovSource = verticalFov.source;
        if (verticalFov.sensorWidthMm !== undefined) optics.sensorWidthMm = verticalFov.sensorWidthMm;
        if (verticalFov.sensorHeightMm !== undefined) optics.sensorHeightMm = verticalFov.sensorHeightMm;
    }

    const captureDate = pickValue(raw, ["DateTimeOriginal", "CreateDate", "ModifyDate"]);
    // EXIF timestamps carry no zone, so exifr reads them as wall-clock on THIS
    // machine. OffsetTimeOriginal is the zone the camera recorded; without it a
    // Berlin photo opened on a US machine lands nine hours out. See
    // exifCaptureTime.js.
    const utcOffset = pickExifUtcOffset(raw);
    const captureInstant = applyExifUtcOffset(captureDate?.value, utcOffset);
    const orientation = await exifr.orientation(arrayBuffer).catch(() => undefined);
    const signedAltitude = altitudeSource?.value !== undefined
        ? (altitudeRefSource?.value === 1 ? -altitudeSource.value : altitudeSource.value)
        : undefined;

    return {
        raw,
        camera: {
            make: raw?.Make,
            model: raw?.Model,
            lensModel: raw?.LensModel,
            serialNumber: raw?.SerialNumber,
        },
        capture: {
            date: captureInstant,
            dateSource: captureDate?.key,
            // Present only when the camera recorded a zone. Absent means the date
            // is a guess made in the viewer's timezone — which callers may want
            // to say out loud rather than present as fact.
            utcOffset,
            utcOffsetSource: utcOffset !== undefined ? "EXIF" : undefined,
            exposureTime: raw?.ExposureTime,
            shutterSpeedValue: raw?.ShutterSpeedValue,
            apertureValue: raw?.ApertureValue,
        },
        image: {
            orientation,
            rotationDegrees: rotation?.deg ?? 0,
            mirroredX: rotation?.scaleX === -1,
            mirroredY: rotation?.scaleY === -1,
            exifImageWidth: raw?.ExifImageWidth,
            exifImageHeight: raw?.ExifImageHeight,
        },
        optics,
        placement: {
            latitude: latitudeSource?.value,
            longitude: longitudeSource?.value,
            altitude: signedAltitude ?? 0,
            altitudeReference: altitudeSource ? "MSL" : undefined,
            heading: headingSource ? normalizeHeadingDegrees(headingSource.value) : undefined,
            pitch: pitchSource?.value,
            // The camera's roll and the EXIF orientation can describe the SAME physical turn, and
            // applying both lands it twice. A DJI Mini 3 Pro shooting vertical rotates its gimbal
            // a quarter turn: the file then says GimbalRollDegree -90 AND Orientation 8 ("rotate
            // 270 CW"). We already turn the IMAGE by the orientation, so rolling the 3D camera by
            // -90 as well left the view a quarter turn off the photo.
            //
            // Subtracting the display rotation removes exactly the turn already accounted for:
            // -90 - 270 = -360, i.e. level, which is what a gimbal-stabilised horizon should be.
            // It is a no-op for unrotated photos (deg 0) and also resolves the 180 degree case.
            roll: rollSource
                ? normalizeSignedDegrees(rollSource.value - (rotation?.deg ?? 0))
                : undefined,
            // Height above the takeoff point. Worth keeping even though we do NOT place with it:
            // a drone's absolute altitude is barometric and drifts, so this is often the only
            // trustworthy height in the file. See the below-terrain check in the apply step.
            relativeAltitude: relativeAltitudeSource?.value,
            locationSource: latitudeSource?.key && longitudeSource?.key ? `${latitudeSource.key}/${longitudeSource.key}` : undefined,
            altitudeSource: altitudeSource?.key,
            headingSource: headingSource?.key,
            pitchSource: pitchSource?.key,
            rollSource: rollSource?.key,
            hasLocation: latitudeSource?.value !== undefined && longitudeSource?.value !== undefined,
            hasOrientation: headingSource?.value !== undefined || pitchSource?.value !== undefined || rollSource?.value !== undefined,
        },
    };
}

export function applyImportedImageMetadata(metadata, filename = "") {
    if (!metadata) return null;

    console.log("[EXIF] applyImportedImageMetadata input", {
        filename,
        metadata,
        placement: metadata.placement,
        optics: metadata.optics,
        capture: metadata.capture,
        camera: metadata.camera,
        image: metadata.image,
    });

    const cameraNode = NodeMan.get("lookCamera", false) ?? NodeMan.get("mainCamera", false);
    if (!cameraNode?.camera) {
        console.log(`[EXIF] Parsed metadata for ${filename}, but no look/main camera exists to apply it`);
        return null;
    }

    const applied = {};
    const camera = cameraNode.camera;
    const placement = metadata.placement ?? {};
    const optics = metadata.optics ?? {};
    Object.assign(applied, applyImportedImageCameraPositionInternal(metadata, filename, {
        logResult: false,
        snapshot: false,
        render: false,
    }) ?? {});
    Object.assign(applied, applyImportedImageCaptureDateTime(metadata, filename, {
        logResult: false,
        render: false,
    }) ?? {});
    Object.assign(applied, applyImportedImageMainViewOverview(metadata, filename, {
        logResult: false,
        render: false,
    }) ?? {});

    const ptzController = findPTZController(cameraNode);
    const hasViewDirection = placement.heading !== undefined || placement.pitch !== undefined;
    const verticalFov = optics.verticalFovDeg;

    if (ptzController) {
        if (placement.heading !== undefined) {
            ptzController.az = placement.heading;
            applied.heading = `${placement.heading.toFixed(1)} deg`;
        }
        if (placement.pitch !== undefined) {
            ptzController.el = clamp(placement.pitch, -89, 89);
            applied.pitch = `${ptzController.el.toFixed(1)} deg`;
        }
        if (placement.roll !== undefined && ptzController.roll !== undefined) {
            ptzController.roll = normalizeSignedDegrees(placement.roll);
            applied.roll = `${ptzController.roll.toFixed(1)} deg`;
        }
        if (verticalFov !== undefined && ptzController.fov !== undefined) {
            ptzController.fov = clamp(verticalFov, 0.01, 179);
            applied.verticalFov = `${ptzController.fov.toFixed(2)} deg`;
        }
        ptzController.refresh();
    } else {
        if (verticalFov !== undefined) {
            camera.fov = clamp(verticalFov, 0.01, 179);
            camera.updateProjectionMatrix();
            applied.verticalFov = `${camera.fov.toFixed(2)} deg`;
        }

        if (hasViewDirection) {
            const {forward, up} = buildForwardVector(
                camera.position,
                placement.heading ?? 0,
                clamp(placement.pitch ?? 0, -89, 89)
            );
            camera.up.copy(up);

            const surfaceHit = intersectSurface(camera.position, forward);
            const target = surfaceHit ?? camera.position.clone().add(forward.clone().multiplyScalar(1000));
            camera.lookAt(target);
            if (placement.roll !== undefined) {
                camera.rotateZ(radians(normalizeSignedDegrees(placement.roll)));
                applied.roll = `${normalizeSignedDegrees(placement.roll).toFixed(1)} deg`;
            }
            camera.updateMatrixWorld();
            updateCameraLookState(cameraNode, camera, target);
            applied.heading = placement.heading !== undefined ? `${placement.heading.toFixed(1)} deg` : undefined;
            applied.pitch = placement.pitch !== undefined ? `${clamp(placement.pitch, -89, 89).toFixed(1)} deg` : undefined;
        }
    }

    Object.assign(applied, applyImportedImageViewLayout(filename, {
        logResult: false,
    }) ?? {});

    if (optics.digitalZoomRatio !== undefined && optics.digitalZoomRatio > 1 && verticalFov === undefined) {
        const videoZoom = NodeMan.get("videoZoom", false);
        if (videoZoom?.setValue) {
            videoZoom.setValue(optics.digitalZoomRatio * 100);
            applied.digitalZoom = `${optics.digitalZoomRatio.toFixed(2)}x`;
        }
    }

    if ((placement.hasLocation || hasViewDirection) && cameraNode.snapshotCamera) {
        cameraNode.snapshotCamera();
    }

    setRenderOne(true);

    const appliedEntries = Object.entries(applied).filter(([, value]) => value !== undefined);
    if (appliedEntries.length > 0) {
        const summary = appliedEntries.map(([key, value]) => `${key}=${value}`).join(", ");
        console.log(`[EXIF] Applied JPEG metadata for ${filename}: ${summary}`);
    } else {
        console.log(`[EXIF] Parsed JPEG metadata for ${filename}, but no placement/optic fields were usable`);
    }

    return applied;
}