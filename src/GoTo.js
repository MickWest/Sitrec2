// One text box's worth of navigation: a frame number, a date and/or time, a
// coordinate in any supported format, or a place name. Lives here rather than in
// the "G" key handler because pasting or dropping text onto the app goes through
// exactly the same chain — whatever you can type into Go To, you can paste.

import {par} from "./par";
import {GlobalDateTimeNode, Sit, setRenderOne} from "./Globals";
import {updateFrameSlider} from "./nodes/CNodeFrameSlider";
import {lastSitFrame} from "./UpdateSitFrames";
import {EventManager} from "./CEventManager";
import {goToLatLon, resolveLocationString} from "./CoordinateInput";
import {applyDateTimeString} from "./DateTimeParser";

// A single bare number - anything else is treated as a location, not a frame.
// Decimals are accepted (and truncated) because the old number-only prompt did
// the same.
const BARE_NUMBER = /^[-+]?\d+(\.\d+)?$/;

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
 * Act on a line of Go To text: frame, then date/time, then coordinate, then
 * place name.
 *
 * @param {string} text
 * @returns {Promise<boolean>} false only when nothing recognised it, so the
 *   caller can report that in its own words. A request that was superseded by a
 *   later one reports true: it was understood, it just lost the race.
 */
export async function applyGoToString(text) {
    if (typeof text !== "string") return false;
    text = text.trim();
    if (text === "") return false;

    // A single bare number can only be a frame — every other form has two
    // values, or letters/symbols, in it.
    if (BARE_NUMBER.test(text)) {
        goToFrame(parseInt(text, 10));
        return true;
    }

    // A date and/or time, applied as if typed into the Time menu. Safe to try
    // before coordinates: the parser requires the whole string to be date/time
    // tokens, and no coordinate format is (they all carry °, ′, ″, N/S/E/W,
    // several decimals, or three numbers).
    if (applyDateTimeString(text, GlobalDateTimeNode)) return true;

    // A place name costs a network round trip, so two requests in quick
    // succession can resolve out of order and leave the camera at the FIRST
    // place instead of the second. Only the newest location request is allowed
    // to land. Frame and date/time commands never take a ticket, so they don't
    // cancel a place lookup the user also asked for.
    const ticket = ++locationRequestSeq;
    const location = await resolveLocationString(text);
    if (ticket !== locationRequestSeq) return true;
    if (location === null) return false;

    goToLatLon(location.lat, location.lon, undefined, undefined, location.alt ?? 0);
    return true;
}
