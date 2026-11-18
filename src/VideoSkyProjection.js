// The look camera's attitude projected into the source picture, before the
// video's own crop, zoom, pan and stabilization. Shared by all celestial overlays.
import {NodeMan} from "./Globals";
import {withDisplayedCamera} from "./ViewUtils";
import {applyAffine, viewStabilizationMatrix} from "./CVideoData";
import {getFlowAlignRotation} from "./FlowAlignment";
import {isPanoramicCamera, panoramic} from "./PanoramicCamera";
import {fisheyeViewToNDC, isFisheyeCamera} from "./FisheyeProjection";
import {panoramaFrame, panoramaProject} from "./rendering/PanoramaMath";

export function videoSkyProjection(video, frame) {
    const look = NodeMan.get("lookView", false);
    const width = video.videoWidth, height = video.videoHeight;
    if (!look?.camera || !(width > 0 && height > 0)) return null;
    const fov = look._lodSavedFov ?? look.camera.fov;
    const camera = withDisplayedCamera(look, live => {
        const copy = live.clone();
        copy._fisheyeProxyFor = live;
        copy._panoramaProxyFor = live;
        return copy;
    });
    camera.fov = fov;
    camera._videoSky = true;
    camera.aspect = width / height;
    camera.zoom = 1;
    camera.clearViewOffset?.();
    camera.updateProjectionMatrix();
    video.getSourceAndDestCoords();
    const {sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight} = video;
    if (!(sWidth > 0 && sHeight > 0 && dWidth > 0 && dHeight > 0)) return null;
    const scaleX = dWidth / sWidth, scaleY = dHeight / sHeight;
    const stabilization = viewStabilizationMatrix(video, frame, width, height);
    const rect = {x: dx - sx * scaleX, y: dy - sy * scaleY, w: width * scaleX, h: height * scaleY};
    const toCanvas = (x, y) => {
        if (stabilization) [x, y] = applyAffine(stabilization, x, y);
        return [dx + (x - sx) * scaleX, dy + (y - sy) * scaleY];
    };
    return {camera, rect, clipRect: {x: dx, y: dy, w: dWidth, h: dHeight}, toCanvas,
        labelXY: ndc => toCanvas((ndc.x + 1) * width / 2, (1 - ndc.y) * height / 2),
        begin(ctx, canvasWidth, canvasHeight) {
            ctx.save();
            const rotation = getFlowAlignRotation(frame);
            if (rotation) {
                ctx.translate(canvasWidth / 2, canvasHeight / 2);
                ctx.rotate(rotation);
                ctx.translate(-canvasWidth / 2, -canvasHeight / 2);
            }
            ctx.beginPath();
            ctx.rect(dx, dy, dWidth, dHeight);
            ctx.clip();
        },
    };
}

// Unlike the look pane, a video's panorama has the source picture's aspect.
export function projectSkyPoint(pos, camera) {
    if (camera._videoSky) {
        if (isPanoramicCamera(camera) || isFisheyeCamera(camera)) {
            pos.applyMatrix4(camera.matrixWorldInverse);
            if (isPanoramicCamera(camera)) {
                panoramaProject(pos, panoramic.hfov, panoramaFrame(panoramic.hfov, camera.aspect, 1).vfov);
                pos.z = 0;
            } else if (fisheyeViewToNDC(pos, camera.aspect)) pos.z = 0;
            else pos.z = 2;
            return pos;
        }
    }
    return null;
}
