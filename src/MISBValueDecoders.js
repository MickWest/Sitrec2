// Human-readable decoders for MISB ST 0601 fields whose value is a
// bitfield, an enumeration, or otherwise not self-explanatory as a number.
// Used by the timing-analysis report (and could be reused by any future
// UI that displays raw MISB values to humans).
//
// References: MISB ST 0601.8 et seq. — bit and enum assignments are taken
// from the published standard. If your camera follows a vendor extension
// or a different revision, individual bit labels may vary; the structure
// is set up so additions/overrides are just data.

import {MISB} from "./MISBFields";

export const MISBValueDecoders = {
    // Tag 11 — Image Source Sensor. Free-form vendor string. We don't
    // attempt to decode it but the entry is listed for completeness.
    [MISB.ImageSourceSensor]: { type: "string" },

    // Tag 12 — Image Coordinate System. Typically one of "Geodetic WGS84",
    // "Geocentric WGS84", etc. Free-form per spec.
    [MISB.ImageCoordinateSystem]: { type: "string" },

    // Tag 34 — Icing Detected.
    [MISB.IcingDetected]: {
        type: "enum",
        values: { 0: "Detector off", 1: "No icing", 2: "Icing detected" },
    },

    // Tag 47 — Generic Flag Data 01. 1-byte bitfield.
    [MISB.GenericFlagData]: {
        type: "bitfield",
        size: 8,
        bits: [
            { bit: 0, name: "Laser Range",   values: ["off",     "on"] },
            { bit: 1, name: "Auto-Track",    values: ["off",     "on"] },
            { bit: 2, name: "IR Polarity",   values: ["white-hot","black-hot"] },
            { bit: 3, name: "Icing Status",  values: ["no icing","icing"] },
            { bit: 4, name: "Slant Range",   values: ["calculated","measured"] },
            { bit: 5, name: "Image Invalid", values: ["valid",   "invalid"] },
            { bit: 6, name: "Reserved-6" },
            { bit: 7, name: "Reserved-7" },
        ],
    },

    // Tag 62 — Laser PRF Code. Integer 1-99999 (PRF code from the laser
    // designator/rangefinder). 0 typically means "no active code." Decoded
    // as a plain number; we surface the on/off interpretation for the
    // common case.
    [MISB.LaserPRFCode]: {
        type: "interpretedInt",
        zeroLabel: "no active PRF",
        nonZeroLabel: (n) => `PRF code ${n}`,
    },

    // Tag 63 — Sensor Field of View Name. Discrete zoom-level enum.
    [MISB.SensorFieldofViewName]: {
        type: "enum",
        values: {
            0: "Ultranarrow", 1: "Narrow", 2: "Medium", 3: "Wide",
            4: "Ultrawide", 5: "Narrow Medium", 6: "2× Ultranarrow",
            7: "4× Ultranarrow", 8: "Continuous Zoom",
        },
    },

    // Tag 77 — Operational Mode.
    [MISB.OperationalMode]: {
        type: "enum",
        values: {
            0: "Other", 1: "Operational", 2: "Training", 3: "Exercise",
            4: "Maintenance", 5: "Test",
        },
    },
};

// Format `s` for display next to `other` such that the first point at
// which they differ is visible. Picks a display window of up to ~60 chars
// centered on the divergence point; uses ellipses to mark elision on
// either side. Pure formatting — `other` is read but not modified.
function formatDivergent(s, other) {
    const MAX = 60;
    if (s.length <= MAX && other.length <= MAX) return s;

    // Find the first index where the two strings differ. If one is a
    // pure prefix of the other, the differing index is the shorter
    // length (where one runs out).
    let div = 0;
    const minLen = Math.min(s.length, other.length);
    while (div < minLen && s[div] === other[div]) div++;

    // Show roughly 8 chars before the divergence and the rest after,
    // capped at MAX, so the change point is always inside the visible
    // window. If the divergence is near the start, showing from 0 is
    // fine; if near the end, we need to slide left.
    let start = Math.max(0, div - 8);
    let end = Math.min(s.length, start + MAX);
    if (end - start < MAX) start = Math.max(0, end - MAX);
    let out = s.slice(start, end);
    if (start > 0) out = "…" + out;
    if (end < s.length) out = out + "…";
    return out;
}

// Decode a single MISB value. Returns either a string description or null
// if the field has no decoder. Numeric/string values that don't match the
// decoder shape return null so callers can fall back to raw display.
export function decodeMISBValue(fieldIndex, value) {
    const dec = MISBValueDecoders[fieldIndex];
    if (!dec) return null;

    if (dec.type === "string") {
        return value === undefined || value === null ? "(none)" : String(value);
    }

    if (dec.type === "enum") {
        const n = Number(value);
        if (!isFinite(n)) return null;
        return dec.values[n] || `unknown (${n})`;
    }

    if (dec.type === "interpretedInt") {
        const n = Number(value);
        if (!isFinite(n)) return null;
        if (n === 0 && dec.zeroLabel) return dec.zeroLabel;
        return dec.nonZeroLabel ? dec.nonZeroLabel(n) : String(n);
    }

    if (dec.type === "bitfield") {
        const n = Number(value);
        if (!isFinite(n)) return null;
        const set = [];
        for (const b of dec.bits) {
            if (b.name.startsWith("Reserved")) continue;
            const isOn = (n & (1 << b.bit)) !== 0;
            if (b.values) {
                set.push(`${b.name}=${b.values[isOn ? 1 : 0]}`);
            } else if (isOn) {
                set.push(b.name);
            }
        }
        return set.join(", ");
    }
    return null;
}

// Decode a transition between two values for a field. Returns a string
// describing what changed (in human terms) or null if no decoder exists.
// For bitfields, lists which bits were set / cleared rather than re-listing
// every bit's state — that's what's diagnostic at a state-change boundary.
export function decodeMISBTransition(fieldIndex, before, after) {
    const dec = MISBValueDecoders[fieldIndex];
    if (!dec) return null;

    if (dec.type === "string") {
        const b = before === undefined || before === null ? "(none)" : String(before);
        const a = after === undefined || after === null ? "(none)" : String(after);
        if (b === a) return null;
        // For strings, the *change* is what's diagnostic — naive head-
        // truncation can hide the difference when both strings share a
        // long common prefix (e.g., long sensor IDs that differ only in
        // a trailing serial number). Expand the window centered on the
        // first divergence point so the difference is always visible.
        return `"${formatDivergent(b, a)}" → "${formatDivergent(a, b)}"`;
    }

    if (dec.type === "enum") {
        const bn = Number(before), an = Number(after);
        if (!isFinite(bn) || !isFinite(an)) return null;
        const bLabel = dec.values[bn] || `unknown(${bn})`;
        const aLabel = dec.values[an] || `unknown(${an})`;
        if (bLabel === aLabel) return null;
        return `${bLabel} → ${aLabel}  (${bn} → ${an})`;
    }

    if (dec.type === "interpretedInt") {
        const bn = Number(before), an = Number(after);
        if (!isFinite(bn) || !isFinite(an)) return null;
        if (bn === an) return null;
        const fmt = (v) => (v === 0 && dec.zeroLabel ? dec.zeroLabel
                          : dec.nonZeroLabel ? dec.nonZeroLabel(v) : String(v));
        return `${fmt(bn)} → ${fmt(an)}`;
    }

    if (dec.type === "bitfield") {
        const bn = Number(before), an = Number(after);
        if (!isFinite(bn) || !isFinite(an)) return null;
        if (bn === an) return null;
        const setBits = [], clearBits = [];
        for (const b of dec.bits) {
            if (b.name.startsWith("Reserved")) continue;
            const wasOn = (bn & (1 << b.bit)) !== 0;
            const isOn = (an & (1 << b.bit)) !== 0;
            if (wasOn && !isOn) {
                clearBits.push(b.values ? `${b.name} (${b.values[1]} → ${b.values[0]})` : b.name);
            } else if (!wasOn && isOn) {
                setBits.push(b.values ? `${b.name} (${b.values[0]} → ${b.values[1]})` : b.name);
            }
        }
        const parts = [];
        if (setBits.length > 0) parts.push(`set: ${setBits.join(", ")}`);
        if (clearBits.length > 0) parts.push(`cleared: ${clearBits.join(", ")}`);
        if (parts.length === 0) return null;  // shouldn't happen if bn !== an
        return `${parts.join("; ")}  (raw ${bn} → ${an})`;
    }

    return null;
}
