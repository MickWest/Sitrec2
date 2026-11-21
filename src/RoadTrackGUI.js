import {markSitchDirty, setRenderOne} from "./Globals";
import {isAGLLockActive} from "./AltitudeLock";
import {trackGroundCache} from "./TrackGround";

export function addRoadTrackControls(folder, lock, track) {
    lock.groundTrack = track;
    lock.roadTrack ??= false;
    lock.roadWidth ??= 8;
    lock.roadSmoothing ??= 20;
    for (const field of ["roadTrack", "roadWidth", "roadSmoothing"]) lock.addSimpleSerial(field);
    const refresh = () => { lock.recalculateCascade(); markSitchDirty(); setRenderOne(true); update(); };
    const enabled = folder.add(lock, "roadTrack").name("Road Track").listen()
        .tooltip("Smooth the 3D road surface and this ground-locked track together. The camera follows the smoothed road grade.")
        .onChange(refresh);
    const width = folder.add(lock, "roadWidth", 2, 30, 0.5).name("Road Width (m)").listen()
        .tooltip("Width of the smoothed road. Blend back into the original terrain across the shoulders.")
        .onFinishChange(refresh);
    const smoothing = folder.add(lock, "roadSmoothing", 2, 100, 1).name("Road Smoothing (m)").listen()
        .tooltip("Distance along the road used to smooth its height. Larger values remove more bumps while retaining hills and grades.")
        .onFinishChange(refresh);
    const update = () => {
        // Road Track works on the track ground cache, which only Google 3D tiles have.
        // The camera follows the road slope under the same rule (isRoadTrackActive).
        const available = isAGLLockActive(lock) && !!trackGroundCache();
        enabled.show(available);
        width.show(available && lock.roadTrack);
        smoothing.show(available && lock.roadTrack);
    };
    // The lock node's visibleGroundChanged handler calls this when the ground changes.
    lock.updateRoadTrackControls = update;
    const restore = lock.modDeserialize?.bind(lock);
    if (restore) lock.modDeserialize = data => { restore(data); update(); };
    update();
    return {update};
}
