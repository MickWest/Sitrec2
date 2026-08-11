import {CNodeVideoView} from "./CNodeVideoView";

export class CNodeMirrorVideoView extends CNodeVideoView {
    // Answered from the prototype so it is already true while the base constructor runs,
    // before this.in.mirror has been wired up. See CNodeVideoView.isMirrorView.
    get isMirrorView() { return true; }

    constructor(v) {
        super(v);
        this.input("mirror")

        // a mirror video just shows the same frames as another video view
        // so we are just reusing the data, and should not have to recalculate anything.

        this.videoData = this.in.mirror.videoData;
        
        // Mirror videos are overlays and should not intercept pointer events
        // This allows touch/mouse events to pass through to the underlying 3D view
        this.ignoreMouseEvents();
    }

    // update just checks to see if the video has changed
    // use the new video if it has, and sync pan offset
    update() {
        if (this.in.mirror.videoData !== this.videoData) {
            this.videoData = this.in.mirror.videoData;
        }
        // Sync pan offset from mirrored view so overlay matches
        this.panOffsetX = this.in.mirror.panOffsetX ?? 0;
        this.panOffsetY = this.in.mirror.panOffsetY ?? 0;

        // Full A-B Echo / Blend / Exposure accumulate the WHOLE A-B range into one composite, and
        // that composite is per-view state, living on whichever video node actually ran the
        // accumulation — always the main video view, because the Video Processing GUI binds its
        // buttons to the first video node that built it (addFiltersToVideoNode) while the flag
        // NODES themselves are shared singletons every video view reads.
        //
        // So without this the mirror saw the flag as on but its own result as null, took the
        // rolling-echo branch in getAdjustedVideoFrameSource instead, and overlaid the look view
        // with an "Echo Frames"-deep smear while the video view showed the full range. The two are
        // meant to be the same picture — that is the entire point of an overlay.
        this._fullABEchoResult = this.in.mirror._fullABEchoResult ?? null;
        // Mirrored too, because it selects between the two ways the composite is shown: while the
        // accumulation is still running it IS the frame, and once finished it is composited over
        // the live frame at the A-B Echo Opacity. Copying only the result would show a finished
        // pass as if it were still accumulating.
        this._fullABEchoRunning = this.in.mirror._fullABEchoRunning ?? false;
    }
}