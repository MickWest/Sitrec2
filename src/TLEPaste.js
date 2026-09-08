// Import a TLE that was PASTED or TYPED rather than dropped in as a file.
//
// The point is to be able to take the two or three lines out of a forum post, an
// email, or your own notes, and have them land in the sitch exactly as a .tle
// file would: the same FileManager entry, the same merge/replace question, the
// same rehost when the sitch is saved. So what this builds IS a .tle file — a
// synthetic one, assembled in memory from the pasted elements and handed to
// FileManager.parseResult(), which is the same call the drag-and-drop path makes.
//
// WHY THE TEXT IS NOT PASSED STRAIGHT THROUGH. A TLE is a fixed-column format,
// and text that has been through a browser, a chat window, or a PDF rarely keeps
// its columns:
//
//   - the "G" (Go To) box is a single-line <input>, whose value sanitization
//     algorithm is "strip newlines" — so a pasted three-line TLE arrives as one
//     line, with the checksum ending each line stuck to the "1" or "2" starting
//     the next, and no lines left to take columns from at all;
//   - a forum post may indent every line, or use tabs, or add trailing spaces;
//   - a copy out of a PDF or an HTML table can collapse runs of spaces, which
//     shifts every field to the left of the column it is supposed to be in.
//
// So nothing here reads a column. The text is split into whitespace-separated
// TOKENS and matched against the field GRAMMAR of a TLE — which is unambiguous,
// since every field has a shape no neighbouring field shares — and then
// canonical 69-character lines are rebuilt from the values that were recognised,
// with the checksums recomputed. Whitespace only ever separates tokens, so no
// amount of it, and no lack of it, can change the result.
//
// The rebuilt lines are laid out to match the column offsets satellite.js reads
// in twoline2satrec(), which are the ones in the TLE specification.

import * as satellite from "satellite.js";
import {FileManager, NodeMan, markSitchDirty} from "./Globals";
import {showError} from "./showError";

// ── Field shapes ────────────────────────────────────────────────────────────

// Catalog number, plus the classification letter that shares its columns run on
// line 1 ("25544U", "44714C") and is absent on line 2 ("25544"). Alpha-5 — a
// letter then four digits — is the catalog's overflow scheme for numbers past
// 99999. Deliberately tight: this pattern is what tells a real element line
// apart from a satellite name that happens to start with "1" or "2".
const SATNUM = /^(\d{5}|[A-Z]\d{4})([A-Z])?$/;

// The epoch, YYDDD.DDDDDDDD. A short integer part is accepted so a day-of-year
// written without its leading zeros still reads.
const EPOCH = /^\d{3,5}\.\d+$/;

// A plain decimal, signed or not, with or without the leading integer zero:
// ".00070034", "-.00000000", "+0.00000363".
const DECIMAL = /^[-+]?\d*\.\d+$/;

// The TLE "assumed decimal point" exponent form: a mantissa whose decimal point
// sits before its first digit, then a signed exponent. "12052-1" is 0.12052e-1.
const EXPFORM = /^([-+])?(\d{1,5})([-+])(\d{1,2})$/;

// ── Tokenizing ──────────────────────────────────────────────────────────────

/**
 * Break the text into whitespace-separated tokens, remembering the line each
 * came from.
 *
 * The line number is used for exactly one decision (see readLine2), and only as
 * a hint — text that arrived as a single flattened line still parses.
 *
 * @param {string} text
 * @returns {{t: string, line: number}[]}
 */
function tokenize(text) {
    const tokens = [];
    const lines = unglueElementLines(text.replace(/\r\n?/g, "\n")).split("\n");
    for (let line = 0; line < lines.length; line++) {
        for (const t of lines[line].trim().split(/\s+/)) {
            if (t !== "") tokens.push({t, line});
        }
    }
    return tokens;
}

/**
 * Put a space back where a newline was REMOVED rather than replaced by one.
 *
 * The HTML value sanitization algorithm for a single-line input is "strip
 * newlines", so a pasted TLE can arrive with its lines run together: the name
 * stuck to the "1" beginning line 1 ("ISS (ZARYA)1 25544U ..."), and the
 * checksum ending line 1 stuck to the "2" beginning line 2 ("...0  99952 44713
 * 53.0546"). That is the one place where missing whitespace changes the tokens
 * rather than just moving them, so it is the one place worth repairing before
 * tokenizing.
 *
 * ONLY when there are no newlines left to read. Text that still has its line
 * structure needs no repair, and repairing it anyway can only do harm: no
 * pattern can tell a name that has the shape of an element line start
 * ("MISSION-1 25544U TEST") from the real thing, so a text that had already told
 * us where its lines were would have that answer overwritten by a guess.
 *
 * Within the one flattened line the guess is unavoidable, so each pattern asks
 * for enough of what follows to be sure it is a line: line 1 by the
 * classification letter its catalog number carries, line 2 by the inclination
 * that follows its catalog number. A guess that still goes wrong costs only the
 * name — parsePastedTLE treats anything that fails to parse as a record as name
 * text and carries on scanning.
 */
function unglueElementLines(text) {
    if (text.trim().includes("\n")) return text;
    return text
        .replace(/(\S)(1[ \t]+(?:\d{5}|[A-Z]\d{4})[A-Z](?=[ \t]|$))/g, "$1 $2")
        .replace(/(\S)(2[ \t]+(?:\d{5}|[A-Z]\d{4})[ \t]+\d{1,3}\.\d)/g, "$1 $2");
}

const tok = (tokens, i) => tokens[i]?.t ?? "";

/** Does an element line start here? The "1"/"2" alone is not enough — a name
 *  line can hold a bare number — so the catalog number has to follow it. */
function isLineStart(tokens, i, which) {
    return tok(tokens, i) === which && SATNUM.test(tok(tokens, i + 1));
}

const isRecordStart = (tokens, i) =>
    isLineStart(tokens, i, "1") || isLineStart(tokens, i, "2");

// ── Field formatting ────────────────────────────────────────────────────────

/**
 * The TLE checksum: every digit in columns 1-68 added up, with a minus sign
 * counting as 1 and everything else as 0, modulo 10.
 *
 * We always recompute it rather than carrying the pasted one across. For a real
 * TLE the two agree; for a hand-written one, recomputing is what makes the file
 * we save valid for whatever reads it next.
 *
 * @param {string} line The first 68 characters of the line
 * @returns {number} 0-9
 */
export function tleChecksum(line) {
    let sum = 0;
    for (const c of line.slice(0, 68)) {
        if (c >= "0" && c <= "9") sum += c.charCodeAt(0) - 48;
        else if (c === "-") sum += 1;
    }
    return sum % 10;
}

/**
 * A right-justified fixed-point field, e.g. the inclination in columns 9-16.
 * @returns {string|null} null (and an entry in errors) if it will not fit
 */
function fixedField(t, decimals, width, label, errors) {
    const v = Number(t);
    if (!Number.isFinite(v)) {
        errors.push(`${label} is not a number ("${t}")`);
        return null;
    }
    const s = v.toFixed(decimals);
    if (s.length > width) {
        errors.push(`${label} is too large for the TLE format ("${t}")`);
        return null;
    }
    return s.padStart(width, " ");
}

/**
 * The first derivative of mean motion, columns 34-43: a sign, then the fraction
 * with its leading zero dropped — " .00070034", "-.00000000".
 *
 * The sign is read off the TEXT rather than the value, because "-.00000000"
 * parses to negative zero, and (-0 < 0) is false.
 */
function ndotField(t, errors) {
    const v = Number(t);
    if (!Number.isFinite(v) || Math.abs(v) >= 1) {
        errors.push(`first derivative of mean motion is not a fraction ("${t}")`);
        return null;
    }
    return (t.trim().startsWith("-") ? "-" : " ") + Math.abs(v).toFixed(8).slice(1);
}

/**
 * One of the two assumed-decimal-point fields — the second derivative of mean
 * motion (columns 45-52) and BSTAR (columns 54-61). Eight characters: sign,
 * five mantissa digits, exponent sign, exponent digit.
 *
 * Both spellings are accepted. The TLE's own "12052-1" is kept as written, since
 * re-deriving it through a float could only lose a digit. A plain decimal —
 * which is what a hand-written TLE tends to carry — is converted.
 */
function expField(t, label, errors) {
    const m = EXPFORM.exec(t.trim());
    if (m) {
        const [, sign, mantissa, expSign, exponent] = m;
        if (Number(exponent) > 9) {
            errors.push(`${label} has an exponent the TLE format cannot hold ("${t}")`);
            return null;
        }
        // The decimal point sits before the mantissa's FIRST digit, so a short
        // mantissa is a field missing its tail: pad the END to keep its value.
        return (sign === "-" ? "-" : " ") + mantissa.padEnd(5, "0")
            + expSign + Number(exponent);
    }
    if (DECIMAL.test(t) || /^[-+]?0+$/.test(t)) {
        return decimalToExpField(Number(t));
    }
    errors.push(`${label} is not in a form a TLE can hold ("${t}")`);
    return null;
}

/** 0.00012052 → " 12052-3". Returns the 8-character field. */
function decimalToExpField(v) {
    if (!Number.isFinite(v) || v === 0) return " 00000+0";
    const sign = v < 0 ? "-" : " ";
    let a = Math.abs(v);
    let exponent = 0;
    while (a >= 1) { a /= 10; exponent += 1; }
    while (a < 0.1) { a *= 10; exponent -= 1; }
    let mantissa = Math.round(a * 1e5);
    if (mantissa >= 1e5) { mantissa = Math.round(mantissa / 10); exponent += 1; }
    if (exponent < -9 || exponent > 9) return " 00000+0";
    return sign + String(mantissa).padStart(5, "0")
        + (exponent < 0 ? "-" : "+") + Math.abs(exponent);
}

/**
 * The eccentricity, columns 27-33: seven digits with the decimal point assumed
 * before the first of them. "0064598" is 0.0064598.
 */
function eccentricityField(t, errors) {
    if (/^\d{1,7}$/.test(t)) {
        // Short means the field lost its tail, not its head — pad the end.
        return t.padEnd(7, "0");
    }
    const v = Number(t);
    if (!Number.isFinite(v) || v < 0 || v >= 1) {
        errors.push(`eccentricity is not a fraction ("${t}")`);
        return null;
    }
    return String(Math.round(v * 1e7)).padStart(7, "0");
}

/** The epoch, columns 19-32: YY, a three-digit day of year, then the fraction. */
function epochField(t) {
    const dot = t.indexOf(".");
    const whole = t.slice(0, dot);
    const fraction = t.slice(dot + 1).replace(/\D/g, "");
    return whole.slice(0, 2) + whole.slice(2).padStart(3, "0")
        + "." + fraction.slice(0, 8).padEnd(8, "0");
}

/**
 * The finished line, with its checksum.
 *
 * Every field above is built to a fixed width, so the 68 characters before the
 * checksum are an invariant rather than a hope — and one worth checking, because
 * a field that overflowed its columns would otherwise produce a line that still
 * looks like a TLE and parses as a different orbit.
 */
function finishLine(line, errors) {
    if (line.length !== 68) {
        errors.push(`the elements do not fit the TLE format (built ${line.length + 1} `
            + `columns, not 69)`);
        return null;
    }
    return line + tleChecksum(line);
}

// ── Reading a record ────────────────────────────────────────────────────────

/**
 * Read the epoch at token j, gluing the two halves back together if a space
 * landed between the year and the day of year ("26 097.12475694").
 *
 * @returns {{raw: string, next: number}|null}
 */
function readEpoch(tokens, j) {
    const a = tok(tokens, j);
    if (EPOCH.test(a)) return {raw: a, next: j + 1};
    const b = tok(tokens, j + 1);
    if (/^\d{2}$/.test(a) && /^\d{1,3}\.\d+$/.test(b)) {
        const dot = b.indexOf(".");
        return {raw: a + b.slice(0, dot).padStart(3, "0") + b.slice(dot), next: j + 2};
    }
    return null;
}

/**
 * Line 1: catalog number, international designator, epoch, the two derivatives
 * of mean motion, BSTAR, ephemeris type, element set number.
 *
 * The epoch is the anchor. It is the only field with five integer digits and a
 * decimal point, so finding it settles where the international designator ends —
 * which matters because that designator is optional, and a TLE that omits it
 * would otherwise shift everything after it by one token.
 *
 * @returns {{line: string, satnum: string, next: number}|null}
 */
function readLine1(tokens, i, errors) {
    const m = SATNUM.exec(tok(tokens, i + 1));
    const satnum = m[1];
    const classification = m[2] ?? "U";
    let j = i + 2;

    // Everything between the catalog number and the epoch is the international
    // designator. Joined without spaces, since a space in there is a space
    // INSIDE one field ("26 001A"), not a separator.
    const designator = [];
    while (j < tokens.length && !readEpoch(tokens, j) && !isRecordStart(tokens, j)
           && designator.length < 3) {
        designator.push(tok(tokens, j));
        j++;
    }

    const epoch = readEpoch(tokens, j);
    if (epoch === null) {
        errors.push(`no epoch found on line 1 of satellite ${satnum}`);
        return null;
    }
    j = epoch.next;

    const epochText = epochField(epoch.raw);
    const ndot = ndotField(tok(tokens, j++), errors);
    const nddot = expField(tok(tokens, j++), "second derivative of mean motion", errors);
    const bstar = expField(tok(tokens, j++), "BSTAR drag term", errors);
    if (ndot === null || nddot === null || bstar === null) return null;

    // Ephemeris type and element set number are the last two fields, and both
    // are plain runs of digits — which is also what the next record's leading
    // "1" looks like. Take them only while they are not starting a record.
    let ephemerisType = "0";
    if (/^\d$/.test(tok(tokens, j)) && !isRecordStart(tokens, j)) {
        ephemerisType = tok(tokens, j++);
    }
    // Element set number and checksum, run together as they are in the file
    // (columns 65-68 and 69). The checksum is dropped: we recompute it.
    let elementNumber = "0";
    if (/^\d{1,5}$/.test(tok(tokens, j)) && !isRecordStart(tokens, j)) {
        const both = tok(tokens, j++);
        elementNumber = both.length > 1 ? both.slice(0, -1) : "0";
    }

    const line =
        "1 " +                                              // 1-2
        padSatnum(satnum) + classification +                // 3-8
        " " +                                               // 9
        designator.join("").padEnd(8, " ").slice(0, 8) +    // 10-17
        " " +                                               // 18
        epochText +                                         // 19-32
        " " +                                               // 33
        ndot +                                              // 34-43
        " " +                                               // 44
        nddot +                                             // 45-52
        " " +                                               // 53
        bstar +                                             // 54-61
        " " +                                               // 62
        ephemerisType +                                     // 63
        " " +                                               // 64
        String(Number(elementNumber)).padStart(4, " ");     // 65-68

    const finished = finishLine(line, errors);
    if (finished === null) return null;
    return {line: finished, satnum, next: j};
}

/**
 * Line 2: inclination, right ascension of the ascending node, eccentricity,
 * argument of perigee, mean anomaly, mean motion, revolution number.
 *
 * @returns {{line: string, satnum: string, next: number}|null}
 */
function readLine2(tokens, i, errors) {
    const satnum = SATNUM.exec(tok(tokens, i + 1))[1];
    let j = i + 2;

    const inclination = fixedField(tok(tokens, j++), 4, 8, "inclination", errors);
    const raan = fixedField(tok(tokens, j++), 4, 8, "right ascension of the ascending node", errors);
    const eccentricity = eccentricityField(tok(tokens, j++), errors);
    const argOfPerigee = fixedField(tok(tokens, j++), 4, 8, "argument of perigee", errors);
    const meanAnomaly = fixedField(tok(tokens, j++), 4, 8, "mean anomaly", errors);
    if (inclination === null || raan === null || eccentricity === null
        || argOfPerigee === null || meanAnomaly === null) return null;

    // Mean motion (columns 53-63), revolution number (64-68) and checksum (69)
    // have no separator between them in the file, so how many tokens they arrive
    // as depends on how wide the revolution number happens to be:
    // "16.19406394    04" is two tokens, "11.22232541452104" is one.
    const tail = tok(tokens, j++);
    if (!/^\d{1,3}\.\d+$/.test(tail)) {
        errors.push(`mean motion is not a number ("${tail}")`);
        return null;
    }
    const glued = /^(\d{1,3}\.\d{8})(\d+)$/.exec(tail);
    let meanMotion = tail;
    let revolution = "0";
    if (glued) {
        meanMotion = glued[1];
        revolution = glued[2].length > 1 ? glued[2].slice(0, -1) : "0";
    } else if (/^\d{1,6}$/.test(tok(tokens, j)) && !isRecordStart(tokens, j)
               && tokens[j].line === tokens[j - 1].line) {
        // Same line as the mean motion, so it is that line's tail rather than
        // the next record's name. (Text flattened to one line loses that
        // distinction, but all that is at stake is the revolution number, which
        // nothing propagates from.)
        const both = tok(tokens, j++);
        revolution = both.length > 1 ? both.slice(0, -1) : "0";
    }

    const meanMotionField = fixedField(meanMotion, 8, 11, "mean motion", errors);
    if (meanMotionField === null) return null;

    const line =
        "2 " +                                              // 1-2
        padSatnum(satnum) +                                 // 3-7
        " " +                                               // 8
        inclination +                                       // 9-16
        " " +                                               // 17
        raan +                                              // 18-25
        " " +                                               // 26
        eccentricity +                                      // 27-33
        " " +                                               // 34
        argOfPerigee +                                      // 35-42
        " " +                                               // 43
        meanAnomaly +                                       // 44-51
        " " +                                               // 52
        meanMotionField +                                   // 53-63
        String(Number(revolution)).padStart(5, " ");        // 64-68

    const finished = finishLine(line, errors);
    if (finished === null) return null;
    return {line: finished, satnum, next: j};
}

/** Catalog numbers are zero-filled to five columns; alpha-5 ones already are. */
function padSatnum(satnum) {
    return /^\d+$/.test(satnum) ? satnum.padStart(5, "0") : satnum.padEnd(5, " ");
}

/**
 * Try to read a whole record starting at token i.
 *
 * @returns {{line1: string, line2: string, satnum: string, next: number}|null}
 *   null if there is no record here — either because no element line starts at
 *   i, or because what looked like one did not hold up. Anything the caller
 *   should hear about is pushed onto errors.
 */
function readRecord(tokens, i, errors) {
    if (!isLineStart(tokens, i, "1")) {
        // A lone "2 ..." is a two-line set that lost its first line.
        if (isLineStart(tokens, i, "2")) {
            errors.push(`a line 2 with no line 1 before it (satellite ${tok(tokens, i + 1)})`);
        }
        return null;
    }
    const line1 = readLine1(tokens, i, errors);
    if (line1 === null) return null;

    if (!isLineStart(tokens, line1.next, "2")) {
        errors.push(`satellite ${line1.satnum} has a line 1 but no line 2`);
        return null;
    }
    const line2 = readLine2(tokens, line1.next, errors);
    if (line2 === null) return null;

    return {line1: line1.line, line2: line2.line, satnum: line1.satnum, next: line2.next};
}

/**
 * The name for the record that follows these tokens.
 *
 * It is what was on the LAST line before line 1. Anything above that is
 * something else — the sentence in a forum post that introduced the TLE, say —
 * and would make a poor satellite name. (Text flattened into one line has only
 * that line, so it keeps everything.)
 */
function nameFrom(tokens, satnum) {
    const nameLine = tokens.length > 0 ? tokens[tokens.length - 1].line : 0;
    let name = tokens.filter(n => n.line === nameLine).map(n => n.t).join(" ").trim();
    // Space-Track writes an unnamed object's name line as "0 TBA - ...", the "0"
    // being the line number the format never otherwise uses.
    if (name.startsWith("0 ")) name = name.slice(2).trim();
    // A name is optional — that is what makes a set "two-line" — so stand in for
    // a missing one rather than leaving the record nameless: the loader reads
    // names positionally, three lines per record, and would otherwise take the
    // next satellite's line 1 for this one's name.
    return name === "" ? "SAT " + satnum : name;
}

// ── The public parser ───────────────────────────────────────────────────────

/**
 * Read whatever TLE records are in a piece of pasted text.
 *
 * @param {string} text
 * @returns {{records: {name: string, line1: string, line2: string}[], text: string,
 *            warning?: string}
 *           | {error: string}
 *           | null}
 *   null when the text holds no element lines at all — it is not a TLE, and the
 *   caller should go on and try to read it as something else. An `error` when it
 *   plainly IS a TLE but could not be read, which is worth saying out loud. A
 *   `warning` when records were found but something else in the text looked like
 *   a record and was not one.
 */
export function parsePastedTLE(text) {
    if (typeof text !== "string" || text.trim() === "") return null;

    const tokens = tokenize(text);
    const records = [];
    const errors = [];
    let name = [];
    let i = 0;

    while (i < tokens.length) {
        const record = readRecord(tokens, i, errors);
        if (record !== null) {
            records.push({
                name: nameFrom(name, record.satnum),
                line1: record.line1,
                line2: record.line2,
            });
            name = [];
            i = record.next;
            continue;
        }
        // Either not an element line, or something that only looked like one: a
        // name such as "MISSION-1 25544U TEST" has the exact shape of a line 1
        // start. Both are name text as far as the scan is concerned, and it
        // carries on — an ambiguous name must not cost us the record after it.
        name.push(tokens[i]);
        i++;
    }

    // Nothing even looked like an element line, so this is not TLE text at all.
    if (records.length === 0 && errors.length === 0) return null;
    if (records.length === 0) return {error: errors[0]};

    // Everything satellite.js will reject, it rejects at initialization: an
    // eccentricity of 1, a mean motion of 0, an orbit already below the ground.
    // Catching it here means the paste is refused with a reason, rather than
    // loading a satellite that silently never appears.
    for (const r of records) {
        const satrec = satellite.twoline2satrec(r.line1, r.line2);
        if (satrec.error) {
            return {error: `the elements for "${r.name}" do not describe a usable orbit `
                + `(SGP4 error ${satrec.error})`};
        }
    }

    return {
        records,
        text: records.map(r => `${r.name}\n${r.line1}\n${r.line2}\n`).join(""),
        // Something else in the text had the shape of a record and did not read
        // as one. Usually that is an ambiguous NAME and nothing is wrong, but it
        // is also what a paste with one truncated record among several looks
        // like — which would otherwise be dropped in silence.
        ...(errors.length > 0 ? {warning: errors[0]} : {}),
    };
}

// ── Importing ───────────────────────────────────────────────────────────────

/** A free "pasted-tle-N.tle". */
function uniqueTLEFilename() {
    let n = 1;
    while (FileManager.exists(`pasted-tle-${n}.tle`)) n++;
    return `pasted-tle-${n}.tle`;
}

/**
 * Import pasted TLE text as a synthetic .tle file.
 *
 * Everything past the parse is the drop path: parseResult() registers the file,
 * asks the merge-or-replace question if satellites are already loaded, and hands
 * the elements to the night sky. Marking the entry as a dynamic link with no
 * static URL is what tells the save code to rehost it, so the sitch that gets
 * saved carries the pasted elements the same way it carries a dropped file.
 *
 * @param {string} text
 * @returns {Promise<boolean>} true if the text was TLE data (whether or not the
 *   import went on to succeed), so a caller offering several readings of the
 *   same text knows to stop here.
 */
export async function importPastedTLE(text) {
    const parsed = parsePastedTLE(text);
    if (parsed === null) return false;

    if (parsed.error) {
        showError("That looks like a TLE, but it could not be read: " + parsed.error);
        return true;
    }

    // The TLE branch of the parser reaches straight into the night sky, so
    // without one there is nowhere for this to go. Say so, rather than letting
    // the missing node assert.
    if (!NodeMan.exists("NightSkyNode")) {
        showError("This sitch has no night sky, so there is nowhere to load satellite data.");
        return true;
    }

    const filename = uniqueTLEFilename();
    const buffer = new TextEncoder().encode(parsed.text).buffer;

    // One paste is one import batch, the same as one drop is (see
    // DragDropHandler.checkDropQueue, which resets these for the same reason).
    // "Merge all the rest" latches for the batch it was answered in, and a first
    // paste into a sitch with no satellites latches it too — so without this a
    // second paste would silently merge instead of asking.
    FileManager._tleMergeAll = false;
    FileManager._tleReplacedInBatch = false;

    console.log(`Importing ${parsed.records.length} pasted TLE record(s) as ${filename}: `
        + parsed.records.map(r => r.name).join(", "));
    // Logged rather than shown: the commonest cause is a satellite name that
    // reads like an element line, where the import is correct and a dialog would
    // just be wrong. It still needs to be somewhere for the case where it means
    // a record really was skipped.
    if (parsed.warning) {
        console.warn(`Part of the pasted text looked like a TLE record but was `
            + `not one, and was read as text: ${parsed.warning}`);
    }

    // A null static URL leaves it a dynamic link, i.e. one that has to be
    // rehosted on save — which is right, since these bytes exist nowhere else.
    await FileManager.parseResult(filename, buffer, null);

    const entry = FileManager.list[filename];
    if (!entry?.isTLE) {
        // The import was cancelled at the merge-or-replace dialog. Drop the
        // half-registered entry so it is not saved into the sitch.
        FileManager.remove(filename);
        return true;
    }
    entry.dynamicLink = true;
    entry.staticURL = null;
    markSitchDirty();
    return true;
}
