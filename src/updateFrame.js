import {par} from "./par";
import {Sit} from "./Globals";
import {isKeyHeld} from "./KeyBoardHandler";
import {updateFrameSlider} from "./nodes/CNodeFrameSlider";
import {UpdatePRFromEA} from "./JetStuff";
import {Frame2Az, Frame2El} from "./JetUtils";


// given the elapsed time since this was last called,
// update the frame number and time based on the current state of the controls
export function updateFrame(elapsed) {

    const dt = elapsed;

    const A = Sit.aFrame;
    let B = Sit.bFrame ?? Sit.frames-1;

    // dt is in milliseconds, so divide by 1000 to get seconds
    // then multiply by the frames per second to get the number of frames
    // to advance
    let frameStep = dt / 1000 * Sit.fps;

    if (isKeyHeld('arrowup')) {
        par.frame -= 10 * frameStep;
        par.paused = true;
    } else if (isKeyHeld('arrowdown')) {
        par.frame += 10 * frameStep;
        par.paused = true;
    } else if (isKeyHeld('arrowleft')) {
        par.frame -= frameStep
        par.paused = true;
    } else if (isKeyHeld('arrowright')) {
        par.frame += frameStep
        par.paused = true;
    } else if (!par.paused && !par.noLogic) {
        // Frame advance with no controls (i.e. just playing)
        // time is advanced based on frames in the video
        // Sit.simSpeed is how much the is speeded up from reality
        // so 1.0 is real time, 0.5 is half speed, 2.0 is double speed
        // par.frame is the frame number in the video
        // (par.frame * Sit.simSpeed) is the time (based on frame number) in reality

        const advance = frameStep * par.direction;
        par.frame += advance;
//        console.log("par.frame = "+par.frame+" par.time = "+par.time+" advance = "+advance+" dt = "+dt+" Sit.fps = "+Sit.fps+" par.direction = "+par.direction);

        // A-B wrapping. We have a seperate check he so we can loop is just playing without keyboard controls
        if (par.frame > B) {
            if (par.pingPong) {
                par.frame = B;
                par.direction = -par.direction
            } else {
                par.frame = 0;  // wrap if auto playing
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

    updateFrameSlider();

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