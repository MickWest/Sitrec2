// ExportObjectKMZ.js — the track half of the Object menu's "Export to KMZ with Track".
//
// CNode3DObject writes the object itself as a <Model> Placemark with a COLLADA file,
// as it always did. These helpers add the track the object rides: one sample per
// second of sitch time, written as a time-stamped <gx:Track>, so Google Earth draws
// the path, plays it on its time slider, and Sitrec reads the file back as a track.
// They take the track and the clock as arguments and touch no globals, so they can
// be tested without a sitch.

import {ECEFToLLAVD_radii} from "./LLA-ECEF-ENU";
import {meanSeaLevelOffset} from "./EGM96Geoid";
import {escapeXML} from "./utils";

// toFixed, with "-0.000" written as "0.000".
const fixed = (v, d) => {
    const s = Number(v).toFixed(d);
    return /^-0(\.0*)?$/.test(s) ? s.slice(1) : s;
};

/**
 * One sample per whole second of sitch time: the frame nearest k·fps for k = 0, 1, 2, …
 * while that frame lies inside the track. Each entry is {frame, timeMS, lat, lon, altMSL},
 * or null for a second at which the track has no finite position — a constant-altitude
 * traverse, for one, has none where the line of sight never comes down to that altitude.
 * The clip's last partial second is not sampled, so a 20 s clip gives 20 points (0–19 s).
 */
export function sampleTrackAtOneHertz(track, {frames, fps, frameToMS}) {
    const samples = [];
    if (!(fps > 0) || !(frames > 0)) return samples;
    for (let second = 0; ; second++) {
        const frame = Math.round(second * fps);
        if (frame >= frames) break;
        samples.push(sampleFrame(track, frame, frameToMS));
    }
    return samples;
}

function sampleFrame(track, frame, frameToMS) {
    const value = track.v(frame);
    const position = value?.position ?? value;
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)
        || !Number.isFinite(position.z)) {
        return null;
    }
    const lla = ECEFToLLAVD_radii(position);
    // KML "absolute" altitude is MSL (the EGM96 geoid); the track is HAE.
    const altMSL = lla.z - meanSeaLevelOffset(lla.x, lla.y);
    const timeMS = frameToMS(frame);
    if (!Number.isFinite(altMSL) || !Number.isFinite(timeMS)) return null;
    return {frame, timeMS, lat: lla.x, lon: lla.y, altMSL};
}

// An XML NCName made from any string: letters, digits, "-" and "." kept, every other
// run of characters (underscores included, so "(Truth)_ob" does not double up) replaced
// by one "_", and a leading character that may not start a name prefixed with "_".
// Used for the ids inside an exported COLLADA file.
export function colladaSafeId(text) {
    const safe = String(text ?? "").replace(/[^A-Za-z0-9.-]+/g, "_");
    return /^[A-Za-z_]/.test(safe) ? safe : `_${safe}`;
}

/** KML colors are aabbggrr, so a CSS "#rrggbb" becomes alpha + bb + gg + rr. */
export function kmlColorFromHex(hex, alpha = "ff") {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex ?? ""));
    return m ? `${alpha}${m[3]}${m[2]}${m[1]}`.toLowerCase() : `${alpha}ffffff`;
}

// Consecutive valid samples; a null ends the run.
function splitRuns(samples) {
    const runs = [];
    let run = [];
    for (const sample of samples) {
        if (sample) {
            run.push(sample);
        } else if (run.length) {
            runs.push(run);
            run = [];
        }
    }
    if (run.length) runs.push(run);
    return runs;
}

// Child order is the order the KML schema requires: altitudeMode, when, gx:coord.
function gxTrackXML(run, indent) {
    const whens = run.map(sample => `${indent}\t<when>${new Date(sample.timeMS).toISOString()}</when>`);
    const coords = run.map(sample => `${indent}\t<gx:coord>${fixed(sample.lon, 8)} `
        + `${fixed(sample.lat, 8)} ${fixed(sample.altMSL, 3)}</gx:coord>`);
    return `${indent}<gx:Track>
${indent}\t<altitudeMode>absolute</altitudeMode>
${whens.join("\n")}
${coords.join("\n")}
${indent}</gx:Track>`;
}

/**
 * A Placemark carrying the samples as a time-stamped <gx:Track>, or "" when no sample
 * has a position. A gap (a null sample) ends one <gx:Track> and starts the next, inside
 * a <gx:MultiTrack> with interpolation off, so Google Earth does not draw a line across
 * the seconds where the track had no position. `color` is a KML aabbggrr string.
 */
export function trackPlacemarkXML(samples, {name, color = "ff00ffff"}) {
    const runs = splitRuns(samples);
    if (runs.length === 0) return "";
    const geometry = runs.length === 1
        ? gxTrackXML(runs[0], "\t\t")
        : `\t\t<gx:MultiTrack>
\t\t\t<gx:interpolate>0</gx:interpolate>
${runs.map(run => gxTrackXML(run, "\t\t\t")).join("\n")}
\t\t</gx:MultiTrack>`;
    return `\t<Placemark>
\t\t<name>${escapeXML(name)}</name>
\t\t<Style>
\t\t\t<LineStyle>
\t\t\t\t<color>${color}</color>
\t\t\t\t<width>3</width>
\t\t\t</LineStyle>
\t\t</Style>
${geometry}
\t</Placemark>
`;
}

/**
 * One line for the balloon and the console: the points written, the seconds they span,
 * and the seconds that had no position; a sentence when none had one; "" for no samples.
 */
export function describeTrackSamples(samples) {
    if (!samples.length) return "";
    const valid = samples.filter(Boolean);
    if (!valid.length) return "The track had no position on any sampled frame, so none was written.";
    const span = (valid[valid.length - 1].timeMS - valid[0].timeMS) / 1000;
    const gaps = samples.length - valid.length;
    return `${valid.length} point${valid.length === 1 ? "" : "s"} at 1 Hz over ${fixed(span, 1)} s`
        + (gaps ? `, ${gaps} second${gaps === 1 ? "" : "s"} with no position` : "");
}
