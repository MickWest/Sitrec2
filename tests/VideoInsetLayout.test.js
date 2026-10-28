// The second video view as an inset: over the main view, else the look view, else centred.
import {computeVideoInsetRect, insetHostView, placeVideoInset, updateVideoInsets, INSET_MARGIN_PX}
    from "../src/VideoInsetLayout";

const W = 1920, H = 870;
const container = {width: W, height: H};
// Pixels of a rect from computeVideoInsetRect (aspect-locked: heightPx = widthPx × -height).
const px = rect => {
    const width = rect.width * W;
    return {left: rect.left * W, top: rect.top * H, width, height: width * -rect.height};
};

describe("computeVideoInsetRect", () => {
    const leftHalf = {left: 0, top: 0, width: 0.5, height: 1};   // 960 × 870 px

    test("a wide video's width is 75% of the host's shorter side, in its bottom-right corner", () => {
        const inset = px(computeVideoInsetRect(container, leftHalf, 1280, 720));
        expect(inset.width).toBeCloseTo(0.75 * 870);
        expect(inset.height).toBeCloseTo(0.75 * 870 * 720 / 1280);
        expect(inset.left + inset.width).toBeCloseTo(960 - INSET_MARGIN_PX);
        expect(inset.top + inset.height).toBeCloseTo(870 - INSET_MARGIN_PX);
    });

    test("a tall video's height is 75% of the host's shorter side", () => {
        const inset = px(computeVideoInsetRect(container, leftHalf, 720, 1280));
        expect(inset.height).toBeCloseTo(0.75 * 870);
        expect(inset.width).toBeCloseTo(0.75 * 870 * 720 / 1280);
    });

    test("the height is aspect-locked, so the shape holds when the window is resized", () => {
        const rect = computeVideoInsetRect(container, leftHalf, 1280, 720);
        expect(rect.width).toBeGreaterThan(0);
        expect(rect.height).toBeCloseTo(-720 / 1280);
    });

    test("in a host away from the origin, the inset stays inside it", () => {
        const bottomRight = {left: 0.5, top: 0.5, width: 0.5, height: 0.5};   // 960 × 435 px
        const inset = px(computeVideoInsetRect(container, bottomRight, 1280, 720));
        expect(inset.width).toBeCloseTo(0.75 * 435);
        expect(inset.left).toBeGreaterThanOrEqual(960);
        expect(inset.top).toBeGreaterThanOrEqual(435);
        expect(inset.left + inset.width).toBeCloseTo(1920 - INSET_MARGIN_PX);
        expect(inset.top + inset.height).toBeCloseTo(870 - INSET_MARGIN_PX);
    });

    test("with no host it is centred, fitted into 30% of the screen", () => {
        const wide = px(computeVideoInsetRect(container, null, 1280, 720));
        expect(wide.height).toBeCloseTo(0.3 * 870);   // the screen's height limits a wide video here
        expect(wide.width).toBeLessThanOrEqual(0.3 * 1920 + 1e-9);
        expect(wide.left + wide.width / 2).toBeCloseTo(960);
        expect(wide.top + wide.height / 2).toBeCloseTo(435);

        const veryWide = px(computeVideoInsetRect(container, null, 4000, 1000));
        expect(veryWide.width).toBeCloseTo(0.3 * 1920);
    });

    test("an unknown video size uses 16:9", () => {
        expect(computeVideoInsetRect(container, leftHalf, 0, 0).height).toBeCloseTo(-9 / 16);
    });
});

describe("insetHostView, placeVideoInset and updateVideoInsets", () => {
    const viewMan = (views) => ({
        widthPx: W, heightPx: H,
        get: (id) => views[id],
        iterate: (callback) => Object.entries(views).forEach(([id, view]) => callback(id, view)),
    });
    const videoView = () => ({videoWidth: 1280, videoHeight: 720, visible: false,
        setVisible: jest.fn(function (visible) { this.visible = visible; }), updateWH: jest.fn()});
    const leftHalfMain = () => ({id: "mainView", visible: true, left: 0, top: 0, width: 0.5, height: 1});
    const rightEdge = view => px(view).left + px(view).width;

    test("the host is the main view, else the look view, else none", () => {
        const mainView = {visible: true}, lookView = {visible: true};
        expect(insetHostView(viewMan({mainView, lookView}))).toBe(mainView);
        expect(insetHostView(viewMan({mainView: {visible: false}, lookView}))).toBe(lookView);
        expect(insetHostView(viewMan({mainView: {visible: false}, lookView: {visible: false}}))).toBeNull();
        expect(insetHostView(viewMan({}))).toBeNull();
    });

    test("a view hidden by another view's fullscreen is not a host", () => {
        const mainView = {visible: true}, lookView = {visible: true}, video = {visible: true};
        const views = viewMan({mainView, lookView, video});
        views.fullscreenView = lookView;
        views.fullscreenSuppressed = new Set([mainView, video]);
        expect(insetHostView(views)).toBe(lookView);
        views.fullscreenView = video;
        views.fullscreenSuppressed = new Set([mainView, lookView]);
        expect(insetHostView(views)).toBeNull();
    });

    test("stays in the host's bottom-right corner when the window is resized", () => {
        const video2 = videoView();
        const views = viewMan({mainView: leftHalfMain(), video2});
        placeVideoInset(video2, views);
        views.widthPx = 1200;
        views.heightPx = 1000;
        updateVideoInsets(views);
        const width = video2.width * 1200;
        expect(width).toBeCloseTo(0.75 * 600);
        expect(video2.left * 1200 + width).toBeCloseTo(600 - INSET_MARGIN_PX);
        expect(video2.top * 1000 + width * -video2.height).toBeCloseTo(1000 - INSET_MARGIN_PX);
    });

    test("follows the host when it is resized, and takes the shape of a newly loaded video", () => {
        const video2 = videoView();
        const mainView = leftHalfMain();
        const views = viewMan({mainView, video2});
        placeVideoInset(video2, views);
        mainView.width = 0.4;
        updateVideoInsets(views);
        expect(rightEdge(video2)).toBeCloseTo(0.4 * W - INSET_MARGIN_PX);

        video2.videoWidth = 720;
        video2.videoHeight = 1280;
        updateVideoInsets(views);
        expect(video2.height).toBeCloseTo(-1280 / 720);
    });

    test("a view the user moved, or a preset placed, is left alone", () => {
        const video2 = videoView();
        const views = viewMan({mainView: leftHalfMain(), video2});
        placeVideoInset(video2, views);
        // Like the Two Videos preset placing video2 while a dropped video still loads.
        Object.assign(video2, {left: 0.5, top: 0, width: 0.5, height: 1});
        video2.videoWidth = 720;
        video2.videoHeight = 1280;
        views.widthPx = 1200;
        updateVideoInsets(views);
        expect([video2.left, video2.top, video2.width, video2.height]).toEqual([0.5, 0, 0.5, 1]);
        expect(video2.insetAnchor).toBeNull();
    });

    test("places the view over the look view when the main view is hidden, and shows it", () => {
        const view = videoView();
        placeVideoInset(view, viewMan({
            mainView: {visible: false},
            lookView: {visible: true, left: 0, top: 0.5, width: 1, height: 0.5},
        }));
        const inset = px(view);
        expect(inset.width).toBeCloseTo(0.75 * 435);
        expect(inset.top).toBeGreaterThanOrEqual(435);
        expect(view.setVisible).toHaveBeenCalledWith(true);
        expect(view.updateWH).toHaveBeenCalled();
    });

    test("a host with an aspect-locked width is measured in pixels", () => {
        const view = videoView();
        placeVideoInset(view, viewMan({
            mainView: {visible: true, left: 0, top: 0, width: -1, height: 1, widthPx: 870, heightPx: 870},
        }));
        expect(px(view).left + px(view).width).toBeCloseTo(870 - INSET_MARGIN_PX);
    });
});
