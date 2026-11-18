// A saved photo calibration, independent of the live solver and of every viewing camera.
import {gnomonic, unGnomonic} from "./StarIdentify";
import {applyTransform, IDENTITY, invertTransform} from "./StarMatch";
import {frameToRef, refToFrame, qConj, qMul, qRotate} from "./StarSphere";
import {lensToRay, rayToPixel} from "../CameraLens";

export function makeSkyPhotoPlate(result, frame = result.frame0) {
    if (!result.identify?.solved?.ok || !(result.videoW > 0 && result.videoH > 0)) return null;
    const i = Math.max(0, Math.round(frame - result.frame0));
    const state = result.lensInfo?.states?.[i];
    const plate = {version: 1, width: result.videoW, height: result.videoH};
    if (result.lensFit && state) {
        plate.lens = result.lensFit.lens;
        plate.q = qMul(state.q, result.lensFit.q);
    } else {
        plate.model = result.identify.solved.model;
        if (!plate.model) return null;
        if (result.identify.chart) {
            if (!state) return null;
            plate.chart = result.identify.chart;
            plate.state = state;
            plate.lens = result.lensInfo.lens;
        } else {
            plate.transform = result.solved.transforms?.[i] ?? IDENTITY;
        }
    }
    // No closures, mutable solver arrays, or typed arrays cross the save boundary.
    return JSON.parse(JSON.stringify(plate));
}

export function photoPixelToSky(plate, x, y) {
    const size = [plate.width, plate.height];
    if (plate.q) {
        const ray = lensToRay(plate.lens, x, y, size);
        return ray && qRotate(qConj(plate.q), ray);
    }
    if (plate.chart) {
        const ray = frameToRef(plate.state, plate.lens, x, y, size);
        if (!ray) return null;
        const c = plate.chart;
        const p = gnomonic(ray, c.centre, {e: c.e1, n: c.e2});
        if (!p) return null;
        [x, y] = p.map(v => v * c.focalPx + c.offset);
    } else {
        const inverse = invertTransform(plate.transform);
        if (!inverse) return null;
        [x, y] = applyTransform(inverse, x, y);
    }
    const {T, c0, b0, mirrored} = plate.model;
    const p = applyTransform(T, x, mirrored ? -y : y);
    return unGnomonic(p[0], p[1], c0, b0);
}

export function skyToPhotoPixel(plate, direction) {
    const size = [plate.width, plate.height];
    if (plate.q) return rayToPixel(plate.lens, qRotate(plate.q, direction), size);
    const {T, c0, b0, mirrored} = plate.model;
    const p = gnomonic(direction, c0, b0);
    const inverse = invertTransform(T);
    if (!p || !inverse) return null;
    let [x, y] = applyTransform(inverse, ...p);
    if (mirrored) y = -y;
    if (plate.chart) {
        const c = plate.chart;
        const ray = unGnomonic((x - c.offset) / c.focalPx, (y - c.offset) / c.focalPx,
            c.centre, {e: c.e1, n: c.e2});
        return refToFrame(plate.state, plate.lens, ray, size);
    }
    return applyTransform(plate.transform, x, y);
}
