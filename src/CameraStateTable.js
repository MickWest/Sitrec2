// CameraStateTable.js
//
// Per-frame camera state as a gimbal camera recording shows it in its own
// symbology: the sensor mode, the focal length as displayed, the digital zoom
// and the image polarity. Each row is one change, keyed by sitch frame, read
// from a CSV whose first row names the columns:
//
//    Frame     sitch frame of the change, a whole number, increasing    required
//    Mode      sensor mode as displayed, e.g. "IR", "EOW", "EON"         required
//    FL        focal length in mm as displayed - the optical focal
//              length, not a 35 mm equivalent                           required
//    Zoom      digital zoom factor, 1 or more ("2", "2.0X"); blank = 1  optional
//    Polarity  B / W, BH / WH, black / white, blackHot / whiteHot;
//              blank = the value of the row before                      optional
//
// Header names are matched without regard to case. Columns with an empty name
// or any other name are ignored, so a file can carry notes beside the data.
// Polarity is null until the first row that gives one: "not stated", so the
// consumer keeps its own saved polarity.
//
// Hold rule: row i covers frames [frame_i, frame_i+1); the last row covers the
// rest of the sitch, and frames before the first row use the first row.
// Fractional (playback) frames round down. Apart from the frames before the
// first row (where the older per-frame lookup returned null) this is the rule
// that lookup applies to the same kind of file, so the two agree.
//
// Pure: no Sitrec imports, so tests and offline scripts can use it directly.

export const CAMERA_STATE_VERSION = 1;

const REQUIRED_COLUMNS = ["frame", "mode", "fl"];
const OPTIONAL_COLUMNS = ["zoom", "polarity"];

// A mode is infrared when its text starts with one of these; any other mode is
// an electro-optical (visible) channel.
const IR_MODE = /^(IR|MWIR|LWIR)/i;

const POLARITY_NAMES = {
    b: "blackHot", bh: "blackHot", black: "blackHot", blackhot: "blackHot",
    w: "whiteHot", wh: "whiteHot", white: "whiteHot", whitehot: "whiteHot",
};

/** "IR" for a mode that starts with IR, MWIR or LWIR (any case), else "EO". */
export function cameraBand(mode) {
    return IR_MODE.test(String(mode ?? "").trim()) ? "IR" : "EO";
}

/** "blackHot" / "whiteHot" for a polarity name (see the table above), or null. */
export function polarityFromText(text) {
    const key = String(text ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
    return POLARITY_NAMES[key] ?? null;
}

/** A table with no rows: what a camera state node holds before data is loaded. */
export function emptyCameraStateTable() {
    return {version: CAMERA_STATE_VERSION, sourceName: null, rows: []};
}

// A header cell as a column name. The first cell may start with a byte-order
// mark: a browser's TextDecoder removes it, Node's readFileSync does not.
function columnName(cell, index) {
    const name = String(cell ?? "");
    return (index === 0 ? name.replace(/^﻿/, "") : name).trim().toLowerCase();
}

/**
 * True when the first row names the Frame, Mode and FL columns. Only the
 * header is checked; parseCameraStateCSV validates the rows.
 */
export function isCameraStateCSV(rows) {
    const header = Array.isArray(rows) ? rows[0] : null;
    if (!Array.isArray(header)) return false;
    const names = header.map(columnName);
    return REQUIRED_COLUMNS.every(name => names.includes(name));
}

// Blank is not zero: Number("") and Number(" ") are both 0.
function numberFrom(text) {
    return text === "" ? NaN : Number(text);
}

/**
 * Parse CSV rows (an array of arrays, header first) into a camera state table:
 *
 *   {version, sourceName, rows: [{frame, mode, band, focalLengthMm, zoom, polarity}]}
 *
 * band is "IR" or "EO" (cameraBand); polarity is "blackHot", "whiteHot" or
 * null. Lines with only blank cells are skipped. Throws an Error that names the
 * file line and the problem for anything it cannot read.
 */
export function parseCameraStateCSV(rows, {sourceName = null} = {}) {
    if (!isCameraStateCSV(rows)) {
        throw new Error("Camera data needs a header row that names the Frame, Mode and FL columns");
    }

    const column = {};
    rows[0].forEach((cell, index) => {
        const name = columnName(cell, index);
        if (!REQUIRED_COLUMNS.includes(name) && !OPTIONAL_COLUMNS.includes(name)) return;
        if (column[name] !== undefined) {
            throw new Error(`Camera data header names the "${name}" column twice`);
        }
        column[name] = index;
    });

    const out = [];
    let polarity = null;
    for (let r = 1; r < rows.length; r++) {
        const cells = rows[r];
        if (!Array.isArray(cells) || cells.every(cell => String(cell ?? "").trim() === "")) continue;

        // The header is line 1 of the file. The CSV parser keeps blank lines
        // as rows, so row index + 1 is the line a user sees in an editor.
        const fail = (message) => {
            throw new Error(`Camera data line ${r + 1}: ${message}`);
        };
        const cell = (name) => column[name] === undefined ? "" : String(cells[column[name]] ?? "").trim();

        const frame = numberFrom(cell("frame"));
        if (!Number.isInteger(frame) || frame < 0) {
            fail(`the frame "${cell("frame")}" is not a whole number of 0 or more`);
        }
        const previous = out[out.length - 1];
        if (previous && frame <= previous.frame) {
            fail(`frame ${frame} does not come after frame ${previous.frame}; frames must increase`);
        }

        const mode = cell("mode");
        if (mode === "") fail(`the mode is blank`);

        const focalLengthMm = numberFrom(cell("fl"));
        if (!Number.isFinite(focalLengthMm) || focalLengthMm <= 0) {
            fail(`the focal length "${cell("fl")}" is not a number above 0`);
        }

        // "2.0X" is how the symbology shows it, so a trailing X is accepted.
        const zoomText = cell("zoom").replace(/x$/i, "").trim();
        const zoom = zoomText === "" ? 1 : numberFrom(zoomText);
        if (!Number.isFinite(zoom) || zoom < 1) {
            fail(`the zoom "${cell("zoom")}" is not a number of 1 or more`);
        }

        const polarityText = cell("polarity");
        if (polarityText !== "") {
            polarity = polarityFromText(polarityText);
            if (polarity === null) {
                fail(`the polarity "${polarityText}" is not one of B, W, BH, WH, black, white, blackHot, whiteHot`);
            }
        }

        out.push({frame, mode, band: cameraBand(mode), focalLengthMm, zoom, polarity});
    }

    if (out.length === 0) throw new Error("Camera data has a header row but no data rows");
    return {version: CAMERA_STATE_VERSION, sourceName, rows: out};
}

/**
 * The row that applies at a frame, as {index, ...row}, or null for an empty
 * table or a frame that is not a number. See the hold rule above.
 */
export function cameraStateAt(table, frame) {
    const rows = table?.rows;
    if (!rows || rows.length === 0) return null;
    const f = Math.floor(Number(frame));
    if (Number.isNaN(f)) return null;

    // Binary search for the last row that starts at or before f.
    let lo = 0;
    let hi = rows.length - 1;
    if (f >= rows[hi].frame) {
        lo = hi;
    } else {
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (rows[mid].frame <= f) lo = mid;
            else hi = mid - 1;
        }
    }
    return {index: lo, ...rows[lo]};
}

/** Each distinct mode, in order of first use, with its band: [{mode, band}]. */
export function cameraStateModes(table) {
    const seen = new Map();
    for (const row of table?.rows ?? []) {
        if (!seen.has(row.mode)) seen.set(row.mode, row.band);
    }
    return [...seen].map(([mode, band]) => ({mode, band}));
}

/**
 * The compact form a sitch saves: one [frame, mode, focalLengthMm, zoom,
 * polarity] array per row. band is not saved; it follows from the mode.
 */
export function cameraStateToSaved(table) {
    return {
        version: CAMERA_STATE_VERSION,
        sourceName: table.sourceName ?? null,
        rows: table.rows.map(row => [row.frame, row.mode, row.focalLengthMm, row.zoom, row.polarity]),
    };
}

/**
 * Rebuild a table from cameraStateToSaved output, with the same checks as a
 * CSV import (a damaged save throws rather than driving the view wrongly).
 */
export function cameraStateFromSaved(saved) {
    if (!saved || saved.version !== CAMERA_STATE_VERSION || !Array.isArray(saved.rows)) {
        throw new Error(`Saved camera data has version ${saved?.version}; this build reads version ${CAMERA_STATE_VERSION}`);
    }
    const rows = [["Frame", "Mode", "FL", "Zoom", "Polarity"]];
    for (const row of saved.rows) {
        const [frame, mode, focalLengthMm, zoom, polarity] = Array.isArray(row) ? row : [];
        rows.push([String(frame), String(mode ?? ""), String(focalLengthMm), String(zoom), polarity ?? ""]);
    }
    return parseCameraStateCSV(rows, {sourceName: saved.sourceName ?? null});
}
