// Choosing Motion (Background) settings from Analyse Object's measurements.
//
// Each tried setting has two measurements at the seed: `score`, how strongly the object stands
// out in a tight gate around the seed, and `ratio`, how far it beats the strongest competing
// peak within the tracker's own search gate. The tracker accepts a detection only when it beats
// that competitor by ACCEPT_RATIO, so a setting that makes the object strong but leaves clutter
// almost as strong is one the tracker will keep refusing.
//
// Measured on the Rubber Duck clip at frame 0: Feature Size 2 scored 15.0 with a competitor at
// 9.6 (ratio 1.77), Feature Size 4 scored 14.8 with a competitor at 1.3 (ratio 14). Ranking by
// score alone chose size 2, which lost the object by frame 650; size 4 tracks the whole clip.

// The tracker's own ambiguity test (score >= 1.6 x runner-up) in CObjectTracking.trackMotion.
export const ACCEPT_RATIO = 1.6;
// A one-frame measurement must pass that test with room to spare, because the clutter around
// the object changes from frame to frame.
export const CLEAR_RATIO = 2 * ACCEPT_RATIO;
// "Comparable" is the same limit Analyse Object uses to list close alternatives.
export const COMPARABLE_SCORE = 0.6;

/**
 * Pick the setting to commit to.
 *
 * Strength still decides, as before. Separation is a veto: only when the strongest setting is
 * ambiguous, and a comparably strong setting is clearly separated, is the clearer one chosen.
 * Where no comparable setting is clearer, the strongest is kept, so clips without the problem
 * are unaffected.
 *
 * @param {Array<{score:number, ratio?:number}>} tried
 * @param {number} [minScore] a clearer setting must still be a detection (Motion Threshold)
 * @returns {object|null} the chosen entry, with `clearer: true` if the veto changed the choice
 */
export function chooseMotionCalibration(tried, minScore = 0) {
    let best = null;
    for (const entry of tried) if (!best || entry.score > best.score) best = entry;
    if (!best || !(best.ratio < CLEAR_RATIO)) return best;
    let clearer = null;
    for (const entry of tried) {
        if (entry === best || !(entry.ratio >= CLEAR_RATIO)) continue;
        if (entry.score < COMPARABLE_SCORE * best.score || entry.score < minScore) continue;
        if (!clearer || entry.score > clearer.score) clearer = entry;
    }
    return clearer ? {...clearer, clearer: true} : best;
}
