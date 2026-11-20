import {fitManualPlate} from './StarManualFit';

// Both identification paths must use persistent detections. A short-lived noise
// track is not extra evidence just because the quad search did not identify it.
export function minimumIdentifyObservations(frames, still = false) {
    return still ? 1 : Math.min(25, Math.max(1, Math.ceil(0.15 * frames)));
}

/** A fitted triangle proposes names; it does not establish them. Require an
 * independent fourth match, a consistent fit of ALL matches, visible catalog
 * support, and separation from competing answers before changing the scene. */
export function assessBrightTripleIdentification(report, width, height) {
    const best = report?.best;
    if (!report?.ok || !best) return {accepted: false, reason: report?.reason ?? 'no matching star pattern'};
    if (best.nMatched < 4) return {accepted: false,
        reason: `only ${best.nMatched} matched stars; an independent fourth match is needed`};
    if (best.nMissing > Math.floor(best.nMatched / 2)) return {accepted: false,
        reason: `${best.nMissing} expected bright stars are missing from the candidate field`};
    const maxRms = Math.max(2, 0.002 * height);
    const fit = fitManualPlate(best.matches.map(({star, object}) => ({
        x: star.x, y: star.y, raDeg: object.raDeg, decDeg: object.decDeg,
    })), [width / 2, height / 2], width);
    if (!fit.ok || fit.mirrored || !Number.isFinite(fit.rmsPx) || fit.rmsPx > maxRms
        || fit.maxPx > 2 * maxRms) return {accepted: false,
        reason: 'the proposed star names do not fit the measured positions closely enough'};
    const competing = (report.candidates ?? []).slice(1).some(candidate =>
        candidate.nMatched >= best.nMatched && candidate.nMissing <= best.nMissing + 1
        && candidate.rmsPx <= Math.max(1, 2 * best.rmsPx));
    if (competing) return {accepted: false, reason: 'multiple star patterns fit about equally well'};
    return {accepted: true, fit};
}

export function unconfirmedIdentificationStatus(result, reason) {
    const extent = result.still ? 'in this image'
        : `after ${result.frame1 - result.frame0 + 1} frames${result.stoppedEarly ? ' (Enough)' : ''}`;
    return `No reliable star identification ${extent}: ${reason}. Camera, location and time unchanged. `
        + (result.still ? 'Label known stars or try a clearer image.' : 'Analyze more frames or label known stars.');
}
