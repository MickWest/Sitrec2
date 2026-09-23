import {GlobalDateTimeNode, Sit} from "./Globals";
import {assert} from "./assert";
import {par} from "./par";

export function lastSitFrame() {
    const frames = Number.isFinite(Sit.frames) ? Math.floor(Sit.frames) : 1;
    return Math.max(0, frames - 1);
}

export function clampSitFrameRange() {
    const lastFrame = lastSitFrame();

    const aFrame = Number.isFinite(Sit.aFrame) ? Math.floor(Sit.aFrame) : 0;
    const bFrame = Number.isFinite(Sit.bFrame) ? Math.floor(Sit.bFrame) : lastFrame;

    Sit.aFrame = Math.max(0, Math.min(aFrame, lastFrame));
    Sit.bFrame = Math.max(0, Math.min(bFrame, lastFrame));

    if (Sit.aFrame > Sit.bFrame) {
        Sit.aFrame = Sit.bFrame;
    }

    const frame = Number.isFinite(par.frame) ? par.frame : Sit.aFrame;
    const clampedFrame = Math.max(Sit.aFrame, Math.min(frame, Sit.bFrame));
    if (par.frame !== clampedFrame) {
        par.frame = clampedFrame;
    }

    if (par._frameOverride !== undefined) {
        if (Number.isFinite(par._frameOverride)) {
            const clampedOverride = Math.max(Sit.aFrame, Math.min(par._frameOverride, Sit.bFrame));
            if (par._frameOverride !== clampedOverride) {
                par._frameOverride = clampedOverride;
            }
        } else {
            par._frameOverride = undefined;
        }
    }
}

// A video sets Sit.fps from its own header when it finishes loading - but a rate the
// user typed in (the "Video fps" field, or the fps-mismatch dialog) wins, and is saved
// with the sitch as Sit.fpsOverride. The loaders finish asynchronously, often AFTER the
// saved Sit values are restored, so every one of them must come through here or the
// restored rate is silently replaced by the header rate.
//
// A hand-set rate belongs to the video it was set for. A NEW import on the timeline is
// tagged clearsFpsOverride (CNodeVideoWebCodecView.uploadFile), and the override is
// dropped only here, when that video has actually loaded - so an import that is
// cancelled, rejected or fails leaves the current video's rate alone.
export function setSitFpsFromVideo(fps, videoData) {
    if (videoData?.clearsFpsOverride) {
        videoData.clearsFpsOverride = false;
        Sit.fpsOverride = undefined;
    }
    Sit.fps = Number.isFinite(Sit.fpsOverride) && Sit.fpsOverride > 0 ? Sit.fpsOverride : fps;
}

export function updateSitFrames() {
    if (Sit.framesFromVideo) {
        const oldLastFrame = lastSitFrame();
        const bFrameWasAtOldEnd = Number.isFinite(Sit.bFrame) && Sit.bFrame === oldLastFrame;


        console.log(`updateSitFrames() setting Sit.frames to Sit.videoFrames=${Sit.videoFrames}`)
        assert(Sit.videoFrames !== undefined, "Sit.videoFrames is undefined")
        Sit.frames = Sit.videoFrames;

        if (bFrameWasAtOldEnd) {
            Sit.bFrame = lastSitFrame();
        }

        clampSitFrameRange();
    }
    // NodeMan.updateSitFramesChanged();
    // updateGUIFrames();
    // updateFrameSlider();
    GlobalDateTimeNode.changedFrames();
}
