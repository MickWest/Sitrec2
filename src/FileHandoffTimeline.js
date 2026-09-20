/** The exported analysis samples define the receiving scene's whole timeline. */
export function traverseHandoffTimeline(results, playbackFps = results?.dataset?.fps) {
    const dataset = results?.dataset;
    const frames = dataset?.n, sampleFps = dataset?.fps;
    const frame0 = dataset?.frame0 ?? 0;
    if (!Number.isSafeInteger(frames) || frames < 2
        || !Number.isFinite(sampleFps) || sampleFps <= 0
        || !Number.isFinite(playbackFps) || playbackFps <= 0
        || !Number.isSafeInteger(frame0) || frame0 < 0
        || !Number.isFinite(results?.clipStartMs)) return null;
    const start = new Date(results.clipStartMs + frame0 * 1000 / sampleFps);
    if (!Number.isFinite(start.valueOf())) return null;
    // CSVs contain only the analysis A–B window. Rebase its first sample to
    // frame zero, retaining its timestamp and effective sampling interval.
    return {frames, fps: playbackFps, simSpeed: playbackFps / sampleFps,
        startTime: start.toISOString()};
}

/** Apply before importing, so every resampled track is built at the full length. */
export function applyHandoffTimeline(timeline, sit, playback, dateTime) {
    if (!timeline || !dateTime) return false;
    const {frames, fps, simSpeed, startTime} = timeline;
    if (!Number.isSafeInteger(frames) || frames < 2
        || !Number.isFinite(fps) || fps <= 0
        || !Number.isFinite(simSpeed) || simSpeed <= 0
        || typeof startTime !== "string" || !Number.isFinite(Date.parse(startTime))) return false;
    sit.frames = frames;
    sit.fps = fps;
    sit.simSpeed = simSpeed;
    sit.aFrame = 0;
    sit.bFrame = frames - 1;
    playback.frame = 0;
    playback.paused = true;
    dateTime.setStartDateTime(new Date(startTime));
    const control = dateTime.guiSitchFrames;
    if (control && frames > control._max) {
        control._elasticMax = Math.max(control._elasticMax ?? frames, frames);
        control.max(frames);
        control.updateElasticStep();
    }
    dateTime.changedFrames();
    return true;
}
