// Magnification changes focal length, so scale tan(FOV/2), not the angle.
export function videoLensAtFrame(hfov, vfov, plan, frame) {
    let magnification = 1;
    for (const event of plan.zoomEvents ?? []) {
        if (frame >= Math.round(event.timeSeconds * plan.fps)) magnification = event.magnification;
    }
    const zoom = angle => 2 * Math.atan(Math.tan(angle * Math.PI / 360) / magnification) * 180 / Math.PI;
    return {hfov: zoom(hfov), vfov: zoom(vfov), magnification};
}
