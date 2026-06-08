import {par} from "./par";
import {GlobalDateTimeNode, Globals, isFrameAdvanceBlocked, requiresSingleFrameMode, setRenderOne, Sit} from "./Globals";
import {isKeyHeld, keyHeldTime, KeyMan} from "./KeyBoardHandler";
import {updateFrameSlider} from "./nodes/CNodeFrameSlider";
import {UpdatePRFromEA} from "./JetStuff";
import {Frame2Az, Frame2El} from "./JetUtils";
import {clampSitFrameRange} from "./UpdateSitFrames";


let hookedKeys = false;

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

    // Render-on-demand keeps the loop asleep while paused. The held-arrow
    // playback below is polled, so it only runs if updateFrame() is called
    // every tick. Re-arm renderOne while any playback arrow is held so the
    // loop keeps ticking; without this a held arrow advanced only a single
    // frame (the onDown step) before the loop slept. Releasing the key stops
    // the re-arm and the loop sleeps again.
    if (isKeyHeld('arrowup') || isKeyHeld('arrowdown') || isKeyHeld('arrowleft') || isKeyHeld('arrowright')) {
        setRenderOne(true);
    }

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
