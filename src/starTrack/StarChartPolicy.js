export function shouldAnalyzeImportedStarImage({template, automatic, established, restoring, primary, hasWork}) {
    return primary && !restoring && !established && !hasWork
        && (automatic ?? template?.trim().toLowerCase() === "star tracker");
}

export function canUseSharedStarLabels(result, heading, fov) {
    const solved = result?.identify?.solved;
    return !!(solved?.ok && !solved.mirrored && !result.identify.partial
        && Number.isFinite(solved.rmsPx) && solved.rmsPx <= Math.max(2, result.videoW * 0.005)
        && heading === "Star Track" && (result.identify.chart || fov === "Star Track"));
}
