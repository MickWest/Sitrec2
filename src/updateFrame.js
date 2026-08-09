import {par} from "./par";
import {GlobalDateTimeNode, Globals, isFrameAdvanceBlocked, requiresSingleFrameMode, setRenderOne, Sit} from "./Globals";
import {isKeyHeld, keyHeldTime, KeyMan} from "./KeyBoardHandler";
import {updateFrameSlider} from "./nodes/CNodeFrameSlider";
import {UpdatePRFromEA} from "./JetStuff";
import {Frame2Az, Frame2El} from "./JetUtils";
import {clampSitFrameRange, lastSitFrame} from "./UpdateSitFrames";
import {showError, showPrompt} from "./showError";
import {EventManager} from "./CEventManager";
import {goToLatLon, resolveLocationString} from "./CoordinateInput";
import {applyDateTimeString} from "./DateTimeParser";


let hookedKeys = false;

// A single bare number - anything else the Go To prompt treats as a location,
// not a frame. Decimals are accepted (and truncated) because the old number-only
// prompt did the same.
const BARE_NUMBER = /^[-+]?\d+(\.\d+)?$/;

// Bumped for each Go To that reaches a place lookup, so a slow one can tell it
// has been superseded (see the Go To handler).
let locationRequestSeq = 0;

// Jump to a frame and pause there.
function goToFrame(f) {
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

// given the elapsed time since this was last called,
// update the frame number and time based on the current state of the controls
export function updateFrame(elapsed) {

    if (!hookedKeys) {
        if (KeyMan) {
            KeyMan.key('arrowright').onDown(() => {
                par.frame  = Math.floor(par.frame) + 1;
                if (par.frame > Sit.frames - 1) par.frame = Sit.frames - 1;

            });

            KeyMan.key('arrowleft').onDown(() => {
                par.frame = Math.floor(par.frame) - 1;
                if (par.frame < 0) par.frame = 0;

            });

            // "G" = Go To: one prompt that takes a frame number, a date and/or
            // time, a coordinate in any supported format, or a place name —
            // tried in that order.
            // The initKeyboard() dispatch bails on text-input focus, so this only
            // fires outside input fields (and the prompt's own field is isolated).
            KeyMan.key('g').onDown((e) => {
                // showPrompt focuses its input synchronously, so without this the
                // browser's default action types the "g" that opened the dialog
                // straight into it.
                e?.preventDefault();
                // Opens blank: the box takes places, coordinates and times as
                // well as frames, so pre-filling the current frame number would
                // just be something to clear.
                showPrompt("Frame, date/time, coordinates, or place name:", {
                    title: "Go To",
                }).then(async (result) => {
                    if (result === null || result.trim() === "") return;
                    const text = result.trim();

                    // A single bare number can only be a frame — every other form
                    // has two values, or letters/symbols, in it.
                    if (BARE_NUMBER.test(text)) {
                        goToFrame(parseInt(text, 10));
                        return;
                    }

                    // A date and/or time, applied as if typed into the Time menu.
                    // Safe to try before coordinates: the parser requires the whole
                    // string to be date/time tokens, and no coordinate format is
                    // (they all carry °, ′, ″, N/S/E/W or several decimals).
                    if (applyDateTimeString(text, GlobalDateTimeNode)) return;

                    // A place name costs a network round trip, so two Go Tos in
                    // quick succession can resolve out of order and leave the
                    // camera at the FIRST place instead of the second. Only the
                    // newest location request is allowed to land. Frame and
                    // date/time commands never take a ticket, so they don't
                    // cancel a place lookup the user also asked for.
                    const ticket = ++locationRequestSeq;
                    const location = await resolveLocationString(text);
                    if (ticket !== locationRequestSeq) return;
                    if (location === null) {
                        showError(`Go To: "${text}" is not a frame number, a date/time, a coordinate, or a place we could find.`);
                        return;
                    }
                    goToLatLon(location.lat, location.lon);
                });
            });

            hookedKeys = true;
        }
    }


    const dt = elapsed;

    clampSitFrameRange();
    const A = Sit.aFrame;
    let B = Sit.bFrame;

    // dt is in milliseconds, so divide by 1000 to get seconds
    // then multiply by the frames per second to get the number of frames
    // to advance
    let frameStep = dt / 1000 * Sit.fps;

    if (isKeyHeld('arrowup')) {
        par.frame -= 10 * frameStep;
        par.paused = true;
        GlobalDateTimeNode.liveMode = false;
    } else if (isKeyHeld('arrowdown')) {
        par.frame += 10 * frameStep;
        par.paused = true;
        GlobalDateTimeNode.liveMode = false;
    } else if (keyHeldTime('arrowleft')>100) {
        par.frame -= frameStep
        par.paused = true;
        GlobalDateTimeNode.liveMode = false;
    } else if (keyHeldTime('arrowright')>100) {
        par.frame += frameStep
        par.paused = true;
        GlobalDateTimeNode.liveMode = false;
    } else if (!par.paused && !par.noLogic) {
        // Frame advance with no controls (i.e. just playing)
        // time is advanced based on frames in the video
        // Sit.simSpeed is how much the is speeded up from reality
        // so 1.0 is real time, 0.5 is half speed, 2.0 is double speed
        // par.frame is the frame number in the video
        // (par.frame * Sit.simSpeed) is the time (based on frame number) in reality

        // Use single-frame mode when blockers require it (e.g., motion analysis with incomplete cache)
        const singleFrameMode = requiresSingleFrameMode();
        // par.playbackSpeed (Time menu slider, 0.25–10, default 1) only
        // scales the elapsed-time-driven advance — not single-frame mode,
        // which is gated on cache state and must remain one frame per tick.
        const advance = singleFrameMode ? par.direction : frameStep * par.direction * (par.playbackSpeed ?? 1);
        let nextFrame = Math.floor(par.frame) + (par.direction > 0 ? 1 : -1);
        
        // Handle wrapping for nextFrame calculation (so blockers see the correct target)
        if (nextFrame > B) {
            nextFrame = par.pingPong ? B : A;
        } else if (nextFrame < A) {
            nextFrame = par.pingPong ? A : B;
        }
        
        // Check if any blockers prevent advancing to the next frame
        if (isFrameAdvanceBlocked(Math.floor(par.frame), nextFrame)) {
            // Stay on current frame, request another render to check again
            setRenderOne(true);
        } else {
            if (singleFrameMode) {
                par.frame = nextFrame;
                // Handle ping-pong direction change
                if (par.pingPong) {
                    if (nextFrame >= B) par.direction = -1;
                    else if (nextFrame <= A) par.direction = 1;
                }
            } else {
                par.frame += advance;
                // A-B wrapping for non-single-frame mode
                if (par.frame > B) {
                    if (par.pingPong) {
                        par.frame = B;
                        par.direction = -par.direction;
                    } else {
                        par.frame = A;
                    }
                }
            }
        }
    }

    if (par.frame > B) {
        par.frame = B;
        if (par.pingPong) par.direction = -par.direction
    }
    if (par.frame < A) {
        par.frame = A;
        if (par.pingPong) par.direction = -par.direction
    }

    const beforeSliderFrame = par.frame;

    updateFrameSlider();

    // Orbit preview: par.frame is the orbit shot index. Apply the camera pose
    // and time for that shot before the node update cascade reads par.frame.
    if (Globals.orbitPreviewApply) {
        Globals.orbitPreviewApply();
    }

    // if the the frame was changed by the slider, turn off live mode
    if (par.frame !== beforeSliderFrame) {
        GlobalDateTimeNode.liveMode = false;
    }

    // par time no longer controls things, but we update it for the UI display
    par.time = par.frame / Sit.fps

    // legacy code for gimbal, etc. Most sitches should NOT have an azSlider.
    if (Sit.azSlider) {
        const oldAz = par.az;
        const oldEl = par.el;
        par.az = Frame2Az(par.frame)
        par.el = Frame2El(par.frame)
        if (par.az !== oldAz || par.el !== oldEl || par.needsGimbalBallPatch) {
            UpdatePRFromEA()
        }

    }
}
