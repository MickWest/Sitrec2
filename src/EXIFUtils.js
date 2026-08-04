import {Vector3} from "three";
import {ViewMan} from "./CViewManager";
import {ECEFToLLAVD_radii, LLAToECEF} from "./LLA-ECEF-ENU";
import {meanSeaLevelOffset, ensureGeoidLoaded} from "./EGM96Geoid";
import {GlobalDateTimeNode, NodeMan, setRenderOne} from "./Globals";
import {forceUpdateUIText} from "./nodes/CNodeViewUI";
import {intersectSurface} from "./threeExt";
import {getLocalNorthVector, getLocalUpVector} from "./SphericalMath";
import {atan, degrees, m2f, radians} from "./utils";
import {applyExifUtcOffset, pickExifUtcOffset} from "./exifCaptureTime";

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

function deriveSensorSize(raw) {
    const xResolution = toFiniteNumber(raw?.FocalPlaneXResolution);
    const yResolution = toFiniteNumber(raw?.FocalPlaneYResolution);
    const imageWidth = toFiniteNumber(raw?.ExifImageWidth);
    const imageHeight = toFiniteNumber(raw?.ExifImageHeight);
    const unit = toFiniteNumber(raw?.FocalPlaneResolutionUnit);

    if (!xResolution || !yResolution || !imageWidth || !imageHeight || !unit) {
        return null;
    }

    let mmPerUnit;
    switch (unit) {
        case 2:
            mmPerUnit = 25.4;
            break;
        case 3:
            mmPerUnit = 10;
            break;
        case 4:
            mmPerUnit = 1;
            break;
        case 5:
            mmPerUnit = 0.001;
            break;
        default:
            return null;
    }

    return {
        sensorWidthMm: imageWidth / xResolution * mmPerUnit,
        sensorHeightMm: imageHeight / yResolution * mmPerUnit,
        source: "focalPlaneResolution"
    };
}

function deriveVerticalFov(raw, optics) {
    const zoomRatio = optics.digitalZoomRatio ?? 1;
    const focal35 = optics.focalLength35mm;
    if (focal35 !== undefined && focal35 > 0) {
        const effectiveFocal35 = focal35 * zoomRatio;
        return {
            verticalFovDeg: degrees(2 * atan(24 / (2 * effectiveFocal35))),
            source: "35mmEquivalent"
        };
    }

    const focalLength = optics.focalLengthMm;
    const sensor = deriveSensorSize(raw);
    if (focalLength !== undefined && focalLength > 0 && sensor?.sensorHeightMm) {
        const effectiveFocalLength = focalLength * zoomRatio;
        return {
            verticalFovDeg: degrees(2 * atan(sensor.sensorHeightMm / (2 * effectiveFocalLength))),
            sensorWidthMm: sensor.sensorWidthMm,
            sensorHeightMm: sensor.sensorHeightMm,
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

    return applied;
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

    const verticalFov = deriveVerticalFov(raw, optics);
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
            roll: rollSource ? normalizeSignedDegrees(rollSource.value) : undefined,
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