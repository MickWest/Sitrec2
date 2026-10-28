// Where a video view goes when it is shown as an inset over another view: the "Extra Video
// View" drop choice, and every view preset that does not place the second video view itself.
//
// The host is the main view, else the look view, whichever is visible (and not hidden by
// another view's fullscreen). The inset keeps the video's shape; its longer side is
// INSET_HOST_FRACTION of the host's shorter side, and it sits in the host's bottom-right
// corner (the compass is bottom-left). With no host it is centred on the screen, fitted into
// INSET_SCREEN_FRACTION of the screen's width and height.
//
// The inset stays fitted: updateVideoInsets, called every frame, places it again when the
// screen, the host or the video's size changes, until the user moves or resizes it or
// something else (a view preset) places the view.

export const INSET_HOST_FRACTION = 0.75;
export const INSET_SCREEN_FRACTION = 0.3;
export const INSET_MARGIN_PX = 10;

const INSET_HOST_IDS = ["mainView", "lookView"];

export function insetHostView(viewMan) {
    for (const id of INSET_HOST_IDS) {
        const view = viewMan.get(id, false);
        if (!view?.visible) continue;
        // Fullscreen hides the views it covered when it was entered (CViewManager._computeEV).
        if (viewMan.fullscreenView && viewMan.fullscreenSuppressed?.has(view)) continue;
        return view;
    }
    return null;
}

/**
 * The inset's rect as fractions of the container. `height` is negative: the aspect-locked
 * encoding (heightPx = widthPx × -height, see CNodeView.updateWH), so the shared-edge layout
 * (CLayoutManager) leaves it out of its seams.
 * @param {{width: number, height: number}} container - The container size in pixels
 * @param {{left: number, top: number, width: number, height: number}|null} host - The host's
 *     rect as fractions of the container, or null to centre the inset on the screen
 * @param {number} videoWidth - The video's width in pixels; 0 if not known yet
 * @param {number} videoHeight - The video's height in pixels; 0 if not known yet
 * @returns {{left: number, top: number, width: number, height: number}}
 */
export function computeVideoInsetRect(container, host, videoWidth, videoHeight) {
    const W = container.width, H = container.height;
    const aspect = videoWidth > 0 && videoHeight > 0 ? videoWidth / videoHeight : 16 / 9;
    let widthPx, heightPx, leftPx, topPx;
    if (host) {
        const hostLeft = host.left * W, hostTop = host.top * H;
        const hostWidth = host.width * W, hostHeight = host.height * H;
        const side = INSET_HOST_FRACTION * Math.min(hostWidth, hostHeight);
        widthPx = aspect >= 1 ? side : side * aspect;
        heightPx = aspect >= 1 ? side / aspect : side;
        leftPx = Math.max(hostLeft, hostLeft + hostWidth - INSET_MARGIN_PX - widthPx);
        topPx = Math.max(hostTop, hostTop + hostHeight - INSET_MARGIN_PX - heightPx);
    } else {
        widthPx = Math.min(INSET_SCREEN_FRACTION * W, INSET_SCREEN_FRACTION * H * aspect);
        heightPx = widthPx / aspect;
        leftPx = (W - widthPx) / 2;
        topPx = (H - heightPx) / 2;
    }
    return {left: leftPx / W, top: topPx / H, width: widthPx / W, height: -heightPx / widthPx};
}

const RECT_KEYS = ["left", "top", "width", "height"];
const sameRect = (a, b) => RECT_KEYS.every(key => Math.abs(a[key] - b[key]) < 1e-9);

function hostRectOf(hostView, W, H) {
    return {
        left: hostView.left, top: hostView.top,
        // A negative width or height is the aspect-locked encoding; use the pixels then.
        width: hostView.width > 0 ? hostView.width : hostView.widthPx / W,
        height: hostView.height > 0 ? hostView.height : hostView.heightPx / H,
    };
}

// Everything the inset was fitted to, so updateVideoInsets can tell when to fit it again.
function insetState(view, viewMan) {
    const W = viewMan.widthPx, H = viewMan.heightPx;
    const hostView = insetHostView(viewMan);
    return {
        W, H,
        hostId: hostView?.id ?? null,
        host: hostView ? hostRectOf(hostView, W, H) : null,
        videoWidth: view.videoWidth, videoHeight: view.videoHeight,
    };
}

function sameState(a, b) {
    return a.W === b.W && a.H === b.H && a.hostId === b.hostId
        && (a.host === null || sameRect(a.host, b.host))
        && a.videoWidth === b.videoWidth && a.videoHeight === b.videoHeight;
}

/**
 * Show a video view as an inset over the host view (see the top of this file).
 * @param {CNodeVideoView} view - The view to place, normally "video2"
 * @param {CViewManager} viewMan - ViewMan
 */
export function placeVideoInset(view, viewMan) {
    const state = insetState(view, viewMan);
    if (!(state.W > 0 && state.H > 0)) return;
    const rect = computeVideoInsetRect({width: state.W, height: state.H}, state.host,
        state.videoWidth, state.videoHeight);
    Object.assign(view, rect);
    view.insetAnchor = {rect, state};
    view.setVisible(true);
    view.updateWH();
}

/**
 * Called every frame (indexRender). Places each inset again when the screen, the host or the
 * video's size has changed since it was placed. A view that no longer has the rect it was
 * given (the user moved or resized it, or a preset placed it), or is hidden, is not an inset
 * any more and is left alone.
 * @param {CViewManager} viewMan - ViewMan
 */
export function updateVideoInsets(viewMan) {
    viewMan.iterate((id, view) => {
        const anchor = view.insetAnchor;
        if (!anchor) return;
        if (!view.visible || !sameRect(view, anchor.rect)) {
            view.insetAnchor = null;
            return;
        }
        if (!sameState(insetState(view, viewMan), anchor.state)) {
            placeVideoInset(view, viewMan);
        }
    });
}
