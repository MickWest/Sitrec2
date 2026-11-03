// The name Sitrec shows for a track from a KLV stream in a TS file:
//
//   "S1 LS7 AF00371"         the platform track of stream 1
//   "S1 LS7 Frame Center"    a track derived from that stream
//   "S0 LS5 Platform"        the platform track of a stream with no tail number
//
//   S<n>    the stream's number in the TS: ffprobe's "#0:<n>", the number ffmpeg -map uses
//   LS<v>   tag 65, UAS Datalink LS Version Number: the number users call the "local set"
//   tail    tag 4, Platform Tail Number, on the platform track only. "Platform" when there is none.
//   kind    on a derived track, in place of the tail number: Frame Center, Target Location, Truth
//
// It is a DISPLAY name only. The short name, which node ids, switch options and saved mods are
// keyed by, does not change. The Timing Analysis report prints these parts to explain each name
// (renderTrackNames in analysis/MisbTimingStats.js).

import {MISB} from "./MISBFields";

// The first value of a column, or null.
function firstValue(rows, column) {
    for (const row of rows) {
        const value = row?.[column];
        if (value !== null && value !== undefined && value !== "") return value;
    }
    return null;
}

// The parts of the name: {stream, version, tail, kind}, each null when not known. null when the
// rows are not from a TS stream. misb: the stream's MISB rows, with the klvPid and
// klvStreamIndex that the demux puts on them. kind: a derived track's kind, else null.
export function streamTrackNameParts(misb, kind = null) {
    if (misb?.klvPid == null) return null;
    const tail = kind ? null : firstValue(misb, MISB.PlatformTailNumber);
    return {
        stream: Number.isInteger(misb.klvStreamIndex) ? misb.klvStreamIndex : null,
        version: firstValue(misb, MISB.UASDatalinkLSVersionNumber),
        tail: tail === null ? null : String(tail),
        kind,
    };
}

// The name of each derived kind in a track name. The keys are CTrackFileMISB's derived track
// types, which also prefix the short names ("Center_N123"), so they stay as they are.
export const DERIVED_KIND_NAMES = {Center: "Frame Center", Target: "Target Location", Truth: "Truth"};

// The word for a platform track that has no tail number.
export const PLATFORM_NAME = "Platform";

// The name from its parts: "S1 LS7 AF00371", "S0 LS5 Platform", "S0 LS5 Frame Center".
export function streamTrackName({stream, version, tail, kind}) {
    return [
        stream === null ? null : `S${stream}`,
        version === null ? null : `LS${version}`,
        kind ? (DERIVED_KIND_NAMES[kind] ?? kind) : (tail ?? PLATFORM_NAME),
    ].filter(part => part !== null && part !== "").join(" ");
}
