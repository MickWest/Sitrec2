// One text box's worth of navigation: a frame number, a date and/or time, a
// coordinate in any supported format, a place name, or a TLE. Lives here rather
// than in the "G" key handler because pasting or dropping text onto the app goes
// through exactly the same chain — whatever you can type into Go To, you can
// paste.

import {par} from "./par";
import {GlobalDateTimeNode, Globals, NodeMan, Sit, setRenderOne} from "./Globals";
import {updateFrameSlider} from "./nodes/CNodeFrameSlider";
import {lastSitFrame} from "./UpdateSitFrames";
import {EventManager} from "./CEventManager";
import {goToLatLon, resolveLocationString} from "./CoordinateInput";
import {applyDateTimeString, parseDateTimeString, resolveDateTimeString} from "./DateTimeParser";
import {parseGoToString} from "./GoToParser";
import {lookupTimeZone} from "./TimeZoneLookup";
import {importPastedTLE} from "./TLEPaste";
import {FeatureManager} from "./CFeatureManager";
import {canPlaceInitialCamera, TEXT_LOCATION_HEIGHT_METERS, withInitialCameraPlacement} from "./InitialCameraPosition";
import {meanSeaLevelOffset} from "./EGM96Geoid";

// Bumped for each request that reaches a place lookup, so a slow one can tell it
// has been superseded (see applyGoToString).
let locationRequestSeq = 0;

// Jump to a frame and pause there.
export function goToFrame(f) {
    if (!Number.isFinite(f)) return;
    // Clamp to the sitch's frame count (can't scrub past the sitch).
    f = Math.max(0, Math.min(f, lastSitFrame()));
    // Expand the In/Out range if the target frame falls outside it.
    const abChanged = f < Sit.aFrame || f > Sit.bFrame;
    if (f < Sit.aFrame) Sit.aFrame = f;
    if (f > Sit.bFrame) Sit.bFrame = f;
    par.frame = f;
    par.paused = true;
    GlobalDateTimeNode.liveMode = false;
    updateFrameSlider();
    // The A-B-windowed live fit nodes refresh on this event — mutating
    // Sit.aFrame/bFrame without it leaves them rendering the previous window
    // (same contract as the frame slider's marker drag and the I/O keys).
    if (abChanged) {
        EventManager.dispatchEvent("abFrameChanged");
    }
    setRenderOne(true);
}

/**
 * Act on a line of Go To text: frame, then TLE, then date/time, then coordinate,
 * then place name.
 *
 * @param {string} text
 * @returns {Promise<boolean>} false only when nothing recognised it, so the
 *   caller can report that in its own words. A request that was superseded by a
 *   later one reports true: it was understood, it just lost the race.
 */
export async function applyGoToString(text) {
    return (await executeGoToRequest(parseGoToString(text))).success;
}

// Resolve the destination's wall clock using the offset on the requested date,
// including daylight saving changes. Explicit UTC/offsets still take priority.
function destinationTime(text, zone, baseDate, location) {
    return resolveDateTimeString(text, {baseDate, timeZone: zone, location});
}

/** Execute the same parsed request for the dialog, paste, and chat. Nothing in
 * a combined request changes until both its place and its time are resolved. */
export async function executeGoToRequest(request, target = {}) {
    const failure = {success: false, needsLLM: true, error: "Go To could not understand or find that destination."};
    if (!request) return failure;
    if (request.kind === "frame") {
        goToFrame(request.frame);
        return {success: true, message: `Jumped to frame ${par.frame}`};
    }
    if (request.kind === "tle") {
        return {success: await importPastedTLE(request.text), message: "Satellite data processed"};
    }
    const namedTime = request.time && parseDateTimeString(request.time)?.namedTime;
    if (request.kind === "time" && !namedTime && !target.getLocation) {
        return applyDateTimeString(request.time, GlobalDateTimeNode)
            ? {success: true, message: "Time updated"} : failure;
    }

    const ticket = ++locationRequestSeq;
    const node = GlobalDateTimeNode;
    const superseded = () => ticket !== locationRequestSeq || node !== GlobalDateTimeNode || target.isCurrent?.() === false;
    const cancelled = {success: true, message: "Replaced by a newer navigation request"};
    try {
        const location = request.kind === "time" ? (target.getLocation?.() ?? node?.getTimeLocation?.()) : await resolveLocationString(request.location);
        if (superseded()) return cancelled;
        if (!location) return failure;
        const zone = node && await lookupTimeZone(location.lat, location.lon);
        if (superseded()) return cancelled;
        if (node && !zone) return failure;
        const date = request.time && node ? destinationTime(request.time, zone, node.dateNow, location) : null;
        if (request.time && !date) return namedTime
            ? {...failure, error: `No ${namedTime} time is available for that date and location.`} : failure;

        if (request.kind === "location") {
            if (target.moveToLocation) target.moveToLocation(location);
            else {
                const position = NodeMan.get("fixedCameraPosition", false);
                if (canPlaceInitialCamera(position, NodeMan.get("cameraTrackSwitch", false)?.choice,
                    NodeMan.get("lookCamera", false)?.freeLook)) {
                    // A typed altitude is HAE, and a camera height that is not AGL is MSL.
                    const alt = location.alt === undefined ? TEXT_LOCATION_HEIGHT_METERS
                        : location.alt - meanSeaLevelOffset(location.lat, location.lon);
                    // Like geolocation, this initial placement does not establish the sitch, so a
                    // track or video dropped next still sets the time, camera and location.
                    // A requested time establishes it below, through editTime().
                    const established = Globals.sitchEstablished;
                    const byTrackImport = Globals.sitchEstablishedByTrackImport;
                    try {
                        withInitialCameraPlacement(position, () => position.gotoLLA(location.lat, location.lon,
                            alt, location.alt === undefined));
                    } finally {
                        Globals.sitchEstablished = established;
                        Globals.sitchEstablishedByTrackImport = byTrackImport;
                    }
                }
                goToLatLon(location.lat, location.lon, undefined, undefined, location.alt ?? 0);
            }
        }
        if (node) {
            // The requested calendar date determines the zone's offset, not
            // the previous sitch date. Select it before applying the clock.
            node.useTimeZone = true;
            node.setTimeZoneFromZone(zone, date ?? node.dateNow);
            if (date) node.editTime(date);
        }
        if (request.kind === "time") return {success: true, message: `Time set to ${request.time}`};
        FeatureManager.addLocationPin({...location, name: request.location});
        return {success: true, message: `Moved to ${request.location}${date ? `; time set to ${request.time}` : ""}`};
    } catch (error) {
        if (superseded()) return cancelled;
        return {...failure, error: `Go To failed: ${error.message}`};
    }
}
