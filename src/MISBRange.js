import {MISB} from "./MISBFields";

// Keep the source picker tied to the MISB schema (currently tags 21 and 57).
export const MISB_RANGE_COLUMNS = Object.entries(MISB)
    .filter(([name]) => name.endsWith("Range"))
    .map(([name, column]) => ({column, name: name.replace(/([a-z])([A-Z])/g, "$1 $2")}));

export const isValidRange = value => typeof value === "number" && Number.isFinite(value) && value >= 0;

export function misbRangeSources(tracks) {
    const sources = [];
    for (const track of tracks) {
        const data = track.trackDataNode;
        if (!data?.misb || !track.trackNode) continue;
        for (const {column, name} of MISB_RANGE_COLUMNS) {
            const first = data.misb.find(row => isValidRange(row?.[column]));
            if (!first) continue;
            sources.push({
                key: JSON.stringify([data.id, column]),
                label: `${track.menuText ?? data.shortName ?? data.id} / ${name} (m)`,
                column, trackNode: track.trackNode, firstRange: first[column],
            });
        }
    }
    return sources;
}

// Read the SAME time brackets as the imported position/angle track. This
// retains its clock offsets, skew correction and video PTS pairing. Range is
// linear, never circular (a change of >180 metres is not an angular wrap).
export function sampleMISBRange(entry, column) {
    const a = entry?.misbRow?.[column];
    const b = entry?.misbNextRow?.[column];
    const t = entry?.misbFraction;
    if (!Number.isFinite(t)) return {range: isValidRange(a) ? a : null, held: false};
    // Hold endpoints instead of extrapolating a slope into negative ranges.
    if (t <= 0) return {range: isValidRange(a) ? a : null, held: t < 0};
    if (t >= 1) return {range: isValidRange(b) ? b : null, held: t > 1};
    if (isValidRange(a) && isValidRange(b)) return {range: a + (b - a) * t, held: false};
    return {range: isValidRange(a) ? a : null, held: true};
}

// A missing/invalid reading is not zero metres. Hold the previous valid
// reading; a leading gap holds the first valid reading. Mark every hold so
// the traverse can disclose it rather than silently inventing a measurement.
export function rangeSamplesForFrames(entries, column, frames, firstRange) {
    const samples = Array.from({length: frames}, (_, f) => sampleMISBRange(entries[f], column));
    let previous = samples.find(s => isValidRange(s.range))?.range ?? firstRange;
    for (const sample of samples) {
        if (isValidRange(sample.range)) previous = sample.range;
        else {
            sample.range = previous;
            sample.held = true;
        }
    }
    return samples;
}
