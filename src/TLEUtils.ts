import {assert} from "./assert";
import * as satellite from 'satellite.js';
import {showError} from "./showError";

interface SatRec {
    epochyr: number;
    epochdays: number;
    satnum: string;
    [key: string]: unknown;
}

interface SatData {
    name: string;
    number: number;
    visible: boolean;
    satrecs: SatRec[];
    // PAYLOAD / ROCKET BODY / DEBRIS / TBA, from OMM CSV only. Undefined for
    // TLE-format data, which has no such field.
    objectType?: string;
}

// One row of an OMM CSV: the elements SGP4 needs, plus the two set-level
// columns used to work out where the data came from and how complete it is.
interface OMMRecord {
    name: string;
    number: number;
    satrec: SatRec;
    objectType?: string;
    creationDate?: string;
}

/** Which proxyStarlink.php query a set of elements came from. */
export type GPQueryType = "LEO" | "LEOALL" | "SLOW" | "STARLINK" | "UNKNOWN";

// given an array of satrecs, return the one that best matches the date
// ie the one that is closest to the date, but before it
// if there are none before it, then return the first one after

export function bestSat(sats: SatRec[], date: Date): SatRec {
    assert(sats !== undefined && sats.length > 0, "No satellite records provided");

    // if it's the only one, then return it
    // a reasonably common case, and 100% of the "current" satellites
    // only historical ones will have more than one
    if (sats.length === 1) {
        return sats[0];
    }

    // Convert the date object to the TLE format and then to a number for comparison.
    const tleDate = dateToTLE(date);
    const dateNum = Number(tleDate);

    let bestBefore: SatRec | null = null;
    let bestBeforeDate = -Infinity; // So that any valid satDate will be greater.
    let bestAfter: SatRec | null = null;
    let bestAfterDate = Infinity;

    for (const sat of sats) {
        const satDate = sat.epochyr * 1000 + sat.epochdays;
        if (satDate <= dateNum && satDate > bestBeforeDate) {
            bestBefore = sat;
            bestBeforeDate = satDate;
        } else if (satDate > dateNum && satDate < bestAfterDate) {
            bestAfter = sat;
            bestAfterDate = satDate;
        }
    }

    // Prefer a record that is before (or equal) to the target date.
    if (bestBefore !== null) {
        return bestBefore;
    }
    // If none is before, return the earliest after.
    return bestAfter || sats[0];
}

/**
 * Converts a Date object to a TLE formatted date string (YYDDD.DDDDDD).
 * @param {Date} date - The date to convert.
 * @returns {string} A string representing the TLE epoch.
 */
export function dateToTLE(date: Date): string {
    // Extract the last two digits of the UTC full year.
    const year = date.getUTCFullYear() % 100;

    // Calculate the day of the year.
    // Create a Date object representing the start of the year in UTC.
    const startOfYear = new Date(Date.UTC(date.getUTCFullYear(), 0, 0));
    // Compute the difference in milliseconds.
    const diff = date.getTime() - startOfYear.getTime();
    const oneDay = 1000 * 60 * 60 * 24;
    // Floor the result to get an integer day count. (January 1st will yield 1.)
    const dayOfYear = Math.floor(diff / oneDay);

    // Compute the fractional part of the day.
    // (The remainder of milliseconds in the current day divided by total ms per day.)
    const fractionalDay = (diff % oneDay) / oneDay;

    // Format the parts:
    // Year: ensure two digits.
    const yearStr = year.toString().padStart(2, '0');
    // Day of year: ensure three digits.
    const dayStr = dayOfYear.toString().padStart(3, '0');
    // Fraction: formatted to six decimal places (includes the leading "0" before the decimal point).
    // We remove the leading zero to have just the ".DDDDDD" portion.
    const fractionStr = fractionalDay.toFixed(6).substring(1);

    return `${yearStr}${dayStr}${fractionStr}`;
}

// from the TLE spec, line 1 has 9 combined fields seprated by a single space
// but some might have leading spaces and some might have trailing spaces
// here's the END index of each combo field:
// note these are 1-indexed, so we need to subtract 1 to get the actual index
// we use 1-indexed because that's how the TLE spec is written
// see: https://en.wikipedia.org/wiki/Two-line_element_set
// we actually use this as the length of the string ending with this field
const tleComboFieldEnds1 = [1, 8, 17, 32, 43, 52, 61, 63, 69]
const tleComboFieldEnds2 = [1, 7, 16, 25, 33, 42, 51, 69]

function fixTLELine(line: string, ends: number[]): string {

    assert(line !== undefined, "TLE line is undefined");

    // chop any trailing whitespace from the line, tle files typically just have a \t
    line = line.trimEnd()

    // if it's exactly 69 characters, we don't need to do anything
    if (line.length === 69) {
        return line
    }


    const expectedFields = ends.length;

    // split the line into the 9 fields
    // separating by whitespace
    let fields = line.split(/\s+/)


//     if (fields.length < expectedFields) {
// // possibly missing the second field,
// //         0 TBA - TO BE ASSIGNED
// //         1 81078U          24333.88851049 +.00000363 +00000+0 +12052-1 0  9994
// //         2 81078  65.1110 138.6809 0185351  89.7284  63.0761 11.22232541452104
//         // so just patch it in
//
//         const line2 = line.slice(0,9) + '24001A'.padEnd(8) + line.slice(17);
//         fields = line2.split(/\s+/)
//
//
//     }


    // if we have expectedFields, we are good
    if (expectedFields === 9) {
        // line 1
        // pad field 2 (the third) with spaces to 8 characters
        fields[2] = fields[2].padEnd(8, " ")
    } else {
        // line 2 should have 8 fields
        // however there might be a space in the last one which would make it 9
        // if so, we need to combine the last two fields
        // including enough spaces to make it the last field 6 charters
        if (fields.length > 8) {
            // only one extra allowed, so assert before we pop it
            assert(fields.length === 9, "TLE line 2 has too many fields: " + line + " " + fields.length + " " + expectedFields);
            fields[7] = fields[7] + fields[8].padStart(6, " ");
            fields.pop() // remove the last field
        }
    }

    assert(fields.length === expectedFields, "TLE line does not have the right number of fields: " + line + " " + fields.length + " " + expectedFields)


    // make a new line so the ENDS of the fields are on the 1-indexed boundaries we want
    let newLine = ""
    for (let i = 0; i < expectedFields; i++) {
        // this is how long we want it to be
        let expectedLength = ends[i]
        let field = fields[i]
        // this is how long it would be if we just added this string
        let actualLength = newLine.length + field.length
        // if it's too short, pad the start of it with spaces
        if (actualLength < expectedLength) {
            // add expectedLength-actualLength spaces to the start of the field
            field = " ".repeat(expectedLength - actualLength) + field
        }
        // if it's too long, that's an error
        if (actualLength > expectedLength) {
            showError("TLE field " + i + " is too long: " + field)
        }
        newLine += field
        assert(newLine.length === expectedLength, "TLE field " + i + " is not the right length: " + newLine)
    }
//   console.log(line);
//   console.log(newLine);
    return newLine
}


function tleEpochToDate(epochYr: number, epochDays: number): Date {
    // Convert 2-digit year to 4-digit year
    const fullYear = (epochYr < 57) ? 2000 + epochYr : 1900 + epochYr;

    // Calculate milliseconds since start of year
    // TLE day 1.0 = Jan 1, so use Dec 31 of prior year as base (matching dateToTLE)
    const startOfYear = new Date(Date.UTC(fullYear, 0, 0));
    const msSinceStart = epochDays * 24 * 60 * 60 * 1000;

    return new Date(startOfYear.getTime() + msSinceStart);
}

export function satRecToDate(satrec: SatRec): Date {
    // Convert the TLE epoch to a Date object
    return tleEpochToDate(satrec.epochyr, satrec.epochdays);
}

// The OMM (CCSDS Orbit Mean-Elements Message) fields that satellite.js's
// json2satrec actually reads, plus OBJECT_NAME for the display name.
// CSV data from CelesTrak/Space-Track uses exactly these column names.
const OMM_FIELDS = [
    "OBJECT_NAME", "NORAD_CAT_ID", "EPOCH", "MEAN_MOTION", "ECCENTRICITY",
    "INCLINATION", "RA_OF_ASC_NODE", "ARG_OF_PERICENTER", "MEAN_ANOMALY",
    "BSTAR", "MEAN_MOTION_DOT", "MEAN_MOTION_DDOT",
] as const;

// Columns that are not orbital elements but say something about the SET rather
// than the satellite: which Space-Track query produced it, and whether it had
// finished publishing when we downloaded it. Only present in OMM CSV.
const OMM_EXTRA_FIELDS = ["OBJECT_TYPE", "CREATION_DATE"] as const;

// Is this an OMM CSV file (as opposed to TLE/2LE/3LE)? The first non-blank line
// of an OMM CSV is a header naming the OMM keywords. NORAD_CAT_ID is mandatory
// in every OMM, so its presence in a comma-separated first line is decisive —
// no TLE line can contain it.
export function isOMMCSV(firstLine: string): boolean {
    return firstLine.includes(",") && firstLine.includes("NORAD_CAT_ID");
}

/**
 * Days a historical query spans: proxyStarlink.php asks for a two-day window,
 * [D, D+2], so a complete set reaches almost exactly D+2 - in whichever field
 * that query filters on. See gpQueryFilterField().
 */
export const GP_QUERY_WINDOW_DAYS = 2;

/** Which field bounds the window a query asked for. */
export type GPQueryFilter = "epoch" | "creation" | "unknown";

/**
 * What a proxyStarlink.php query filters on, and therefore which field's
 * coverage says whether the download caught everything.
 *
 * The queries are NOT uniform in this, which is the whole reason completeness
 * has to be judged per type (read them in sitrecServer/proxyStarlink.php):
 *
 *   ""/STARLINK  CREATION_DATE/D--D+2  plus OBJECT_NAME/STARLINK~~
 *   ALL          CREATION_DATE/D--D+2
 *   LEO/LEOALL   EPOCH/D--D+2          plus mean-motion and payload filters
 *   SLOW         EPOCH/D--D+2
 *   CUSTOM       an external URL with the date substituted in - filters unknown
 */
export function gpQueryFilterField(queryType: string): GPQueryFilter {
    switch (queryType) {
        case "":
        case "STARLINK":        // what inferQueryType() calls the default query
        case "ALL":
            return "creation";
        case "LEO":
        case "LEOALL":
        case "SLOW":
            return "epoch";
        default:
            return "unknown";
    }
}

/**
 * How far short of the window end an EPOCH-filtered set may fall and still
 * count as complete.
 *
 * Elements are dense near the end of the window - a LEO date carries tens of
 * thousands across two days, so a complete set's newest epoch lands within
 * seconds of the boundary (measured on three real LEO dates: 0.1 s, 2.7 s,
 * 0.6 s). An hour is far beyond that, while still catching a set that was cut
 * short.
 */
const GP_EPOCH_TOLERANCE_MS = 60 * 60 * 1000;

/**
 * The same, for a CREATION_DATE-filtered set measured on its own field.
 *
 * Much wider than the epoch one, for two measured reasons. Both come from the
 * 2025-09-05 Starlink set (32,783 element sets, 8,231 satellites, refetched
 * long after it had settled, so it is known-complete).
 *
 * 1. Publication arrives in bursts, not continuously, so a complete set's
 *    newest CREATION_DATE sits at the last burst before the window closed,
 *    not at the boundary. That set published in 37 bursts: median gap 0.50 h,
 *    but with quiet periods of 8.3, 6.4 and 5.2 h. Sampling every moment of
 *    the window as a hypothetical boundary, the share of complete sets a given
 *    tolerance would wrongly flag runs 41% at 2 h, 17% at 4 h, 5.6% at 6 h,
 *    0.7% at 8 h, 0% at 12 h. A false flag is not a one-off annoyance either:
 *    refreshing a complete set adds nothing and cannot move its newest
 *    CREATION_DATE, so it would ask again on every single load.
 *
 * 2. There is almost nothing to gain by tightening it, because a satellite is
 *    lost only when a download precedes the FIRST publication covering it, and
 *    the median publication lag is ~7 h. Reconstructing what a download at each
 *    moment would have held:
 *
 *      download at  element sets   satellites missing
 *      end - 24 h      19,579            103
 *      end - 18 h      26,076              9
 *      end - 12 h      32,779              0
 *      end -  0 h      32,783              0
 *
 *    Twelve hours is where satellite loss begins, so the tolerance sits at the
 *    point that catches every download that actually costs a satellite - which
 *    is what this prompt is for - and no closer. Below it, the only thing
 *    recoverable is a handful of element sets that a satellite already in the
 *    set would be propagated from a few hours more accurately.
 */
const GP_CREATION_TOLERANCE_MS = 12 * 60 * 60 * 1000;

/**
 * Was this set downloaded before Space-Track had finished publishing for it?
 *
 * Judged from COVERAGE of the window the query asked for, and specifically of
 * the field that query filtered on - which differs by type. Using the wrong
 * field flags complete sets forever: the Starlink query selects CREATION_DATE
 * in [D, D+2], and an element is published AFTER its epoch, so even a fully
 * settled set's newest EPOCH stops short of D+2. Measured on the 2025-09-05
 * Starlink set: 2.17 h short, across 32,783 element sets whose publication lag
 * ran from 0.46 h to 9.6 days. Tested against the epoch window that set looks
 * truncated on every load, however long ago the event was.
 *
 * EPOCH-filtered (LEO, LEOALL, SLOW): download too early and the elements for
 * the later part of the window have not been published yet, so the set is
 * truncated and its newest epoch falls short. Measured on a real date, by
 * reconstructing what a download at each moment would have contained:
 *
 *   download at D+0.2d ->   13 elements,  8.9% of the window
 *   download at D+1.0d -> 33,129,        40.6%
 *   download at D+2.0d -> 53,495,        96.8%
 *   download at D+2.5d -> 73,204,       100.0%   (complete)
 *
 * CREATION_DATE-filtered (the default Starlink query, and ALL): here the filter
 * bounds publication itself. Once the window has closed nothing published later
 * can ever match it, so such a set is complete the moment it is downloaded at
 * or after D+2, and truncated only if it was downloaded before that. The newest
 * CREATION_DATE says which, being when the download happened, near enough.
 * That is NOT a usable test for the epoch-filtered queries, where publication
 * keeps adding elements for days after the window closes, and an early
 * CREATION_DATE cannot be told from publication having simply finished early.
 * Under a query that filters on it, it is exact.
 *
 * TLE-format data under a CREATION_DATE query carries no publication times, so
 * it falls back to epoch coverage - but read against the CREATION_DATE
 * tolerance, never the epoch one. A complete set's epoch shortfall there is the
 * trailing publication gap plus the lag of its own freshest element, measured
 * as 0.56 + 1.61 = 2.17 h, while a download 12 h early already shows 14.7 h,
 * one 18 h early 23.6 h. Twelve hours sits in that gap. This is the only test
 * available for the legacy .tle bakes older saved sitches hold.
 *
 * A set whose query we do not define (CUSTOM) gets no test at all: with nothing
 * to judge from, say nothing.
 *
 * @param tleData   The loaded set.
 * @param setDate   The date the set was requested for (start of the window).
 * @param queryType The proxyStarlink.php type it was requested with.
 */
export function isGPSetIncomplete(tleData: CTLEData, setDate: Date, queryType: string): boolean {
    if (!tleData || tleData.satData.length === 0) {
        return false;
    }
    const windowEnd = setDate.getTime() + GP_QUERY_WINDOW_DAYS * 86400000;

    switch (gpQueryFilterField(queryType)) {
        case "epoch":
            if (!(tleData.endDate instanceof Date)) return false;
            return tleData.endDate.getTime() < windowEnd - GP_EPOCH_TOLERANCE_MS;

        case "creation":
            if (tleData.latestCreationDate instanceof Date) {
                return tleData.latestCreationDate.getTime() < windowEnd - GP_CREATION_TOLERANCE_MS;
            }
            // TLE format: no publication times, so read the epochs instead, at
            // the tolerance this query type needs rather than the epoch one.
            if (!(tleData.endDate instanceof Date)) return false;
            return tleData.endDate.getTime() < windowEnd - GP_CREATION_TOLERANCE_MS;

        default:
            return false;
    }
}

// A TLE element line — "1 ..." or "2 ...". Used to spot where a TLE block
// resumes after a CSV block in a file that concatenates both formats.
function isTLEElementLine(line: string): boolean {
    return /^[12] /.test(line);
}

/**
 * Split one CSV row into fields, honouring RFC 4180 quoting.
 *
 * The two upstreams do NOT format their CSV the same way, and a plain
 * split(",") only works for one of them:
 *
 *   CelesTrak    19 columns, nothing quoted.
 *   Space-Track  40 columns, header unquoted but EVERY data field quoted,
 *                including a free-text COMMENT column.
 *
 * Split naively, a Space-Track catalog number arrives as the 7-character
 * string "44714" — quote marks and all — which Number() reads as NaN, so
 * every row is rejected and the whole historical set loads as zero
 * satellites. Doubled quotes ("") are the RFC's escape for a literal quote.
 */
export function splitCSVRow(line: string): string[] {
    // Tolerate CRLF: the trailing \r would otherwise stick to the last field.
    if (line.endsWith("\r")) {
        line = line.slice(0, -1);
    }

    const fields: string[] = [];
    let field = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQuotes) {
            if (c === '"') {
                if (line[i + 1] === '"') {   // "" -> a literal quote
                    field += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                field += c;
            }
        } else if (c === '"') {
            inQuotes = true;
        } else if (c === ",") {
            fields.push(field);
            field = "";
        } else {
            field += c;
        }
    }
    fields.push(field);
    return fields;
}

/**
 * Parse OMM CSV lines (header row first) into flat records.
 *
 * This is the only format that can carry the whole catalogue: the TLE format
 * cannot express catalog numbers above 99999, which the catalogue passed on
 * 2026-07-11. It also keeps the full-precision epoch that TLE rounds.
 *
 * Returns null if the header is missing the fields SGP4 needs, so callers can
 * distinguish "not usable" from "no satellites in it".
 */
export function parseOMMCSVLines(lines: string[]): OMMRecord[] | null {
    // Resolve columns by NAME, never by position: CelesTrak sends 19 columns
    // and Space-Track 40, in a different order, and both are valid OMM.
    const header = splitCSVRow(lines[0]).map(h => h.trim());

    // Resolve the column index of each field we need, once.
    const col: Record<string, number> = {};
    for (const f of OMM_FIELDS) {
        col[f] = header.indexOf(f);
    }
    for (const f of OMM_EXTRA_FIELDS) {
        col[f] = header.indexOf(f);
    }
    if (col.NORAD_CAT_ID < 0 || col.EPOCH < 0 || col.MEAN_MOTION < 0) {
        console.warn("parseOMMCSVLines: OMM CSV is missing required columns " +
            "(NORAD_CAT_ID / EPOCH / MEAN_MOTION), header was: " + lines[0].slice(0, 200));
        return null;
    }

    const out: OMMRecord[] = [];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === "") continue;
        const v = splitCSVRow(line);
        // A short row is a truncated download; skip it rather than
        // manufacturing a satellite from undefined fields.
        if (v.length < header.length) continue;

        const omm: Record<string, string> = {};
        for (const f of OMM_FIELDS) {
            if (col[f] >= 0) omm[f] = v[col[f]];
        }

        // Guards the case where two CSV downloads have been concatenated (a
        // merge of the current and historical catalogues): the second file's
        // header row arrives here as data, and would otherwise become a
        // satellite whose every element is NaN.
        const number = parseInt(omm.NORAD_CAT_ID);
        if (!Number.isFinite(number)) continue;

        const extra: Record<string, string> = {};
        for (const f of OMM_EXTRA_FIELDS) {
            if (col[f] >= 0) extra[f] = v[col[f]];
        }

        out.push({
            name: (omm.OBJECT_NAME ?? "").trim() || ("NORAD " + omm.NORAD_CAT_ID),
            number: number,
            satrec: satellite.json2satrec(omm as never) as unknown as SatRec,
            objectType: (extra.OBJECT_TYPE ?? "").trim() || undefined,
            creationDate: (extra.CREATION_DATE ?? "").trim() || undefined,
        });
    }
    return out;
}

// this is the TLE data for the satellites
// A CTLEData object is created from a TLE file OR an OMM CSV file and consists
// of just a satData array, which is an array of objects
// each object has a name, a visible flag, and an array of satrecs
// the satrec is a satellite record created from a single line of a TLE file
// there can be several satrecs with the same name, so we need to store them in an array
// and pick the best one based on the playback date/time
//
// NOTE ON FORMATS: the TLE format cannot express catalog numbers above 99999,
// and the catalog passed that limit on 2026-07-11. CelesTrak and Space-Track
// therefore omit those objects from TLE feeds entirely — they are only
// available in OMM (CSV/JSON/XML). We prefer CSV; TLE parsing is kept so that
// old cached files, saved sitches, and user-supplied .tle files still load.
export class CTLEData {
    satData: SatData[];
    // Keyed by NORAD catalog number. A Map, not an array: catalog numbers are
    // now up to 9 digits, and a sparse array indexed at ~8e8 would report a
    // .length of 800 million.
    noradIndex: Map<number, SatData>;
    startDate: Date;
    endDate: Date;
    loadError?: string;
    rawText: string;
    // What this data was parsed from, used when exporting so the saved file
    // gets an extension its own importer will route correctly. "mixed" is a
    // file holding both formats, which merging an imported .tle into a
    // downloaded CSV catalogue produces.
    format: "omm-csv" | "tle" | "mixed";
    // Newest CREATION_DATE seen, i.e. when Space-Track last published an
    // element in this set. Undefined for TLE-format data, which omits it.
    // Compare against the set's own date to tell whether it was captured
    // before publication had finished - see isGPSetIncomplete().
    latestCreationDate?: Date;

    // constructor is passed in a string that contains the TLE file as \n separated lines
    // extracts in into
    constructor(fileData: string) {

        // fileData is a string that contains the TLE file as \n separated lines
        assert(fileData !== undefined, "CTLEData: fileData is undefined");
        assert(typeof fileData === "string", "CTLEData: fileData is not a string");

        this.rawText = fileData;

        // Check for server error messages before trying to parse as TLE
        const trimmedData = fileData.trim();
        if (trimmedData.startsWith("ERROR:")) {
            showError("TLE Loading Error: " + trimmedData);
            this.satData = [];
            this.noradIndex = new Map();
            this.startDate = new Date("2100");
            this.endDate = new Date("1950");
            this.loadError = trimmedData;
            this.format = "tle";
            console.error("CTLEData: Server returned error: " + trimmedData);
            return;
        }

        // split the stringified fileData into an array of lines
        let lines = fileData.split('\n');

        // Strip leading and trailing blank lines (some TLE files have extra blank lines)
        while (lines.length > 0 && lines[0].trim() === '') {
            lines.shift();
        }
        while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
            lines.pop();
        }

        const satDataByKey: Record<string | number, SatData> = {};
        this.parseSegments(lines, satDataByKey);
        this.finish(satDataByKey, fileData);
    }

    /**
     * Parse the file as a sequence of same-format blocks.
     *
     * Usually there is exactly one block and this is just "sniff the format".
     * But mergeFrom() concatenates the raw text of the sets it merges, and a
     * user can merge an imported .tle into a downloaded CSV catalogue (or the
     * reverse), so an exported file can legitimately contain both formats. If
     * we sniffed only the first line, one of the two blocks would be fed to the
     * wrong parser — CSV rows to the TLE parser produce garbage, and TLE lines
     * handed to the CSV parser are silently dropped. Either way the user loses
     * satellites on reload. Reading block by block keeps every record.
     */
    private parseSegments(lines: string[], satDataByKey: Record<string | number, SatData>): void {
        let sawCSV = false;
        let sawTLE = false;
        let i = 0;

        while (i < lines.length) {
            if (isOMMCSV(lines[i])) {
                // An OMM header, then its data rows. TLE element lines carry no
                // commas, so a comma-free line ends the block — as does another
                // header, which starts a new one.
                const block: string[] = [lines[i]];
                let j = i + 1;
                while (j < lines.length && !isOMMCSV(lines[j])
                       && !isTLEElementLine(lines[j]) && lines[j].includes(",")) {
                    block.push(lines[j]);
                    j++;
                }
                this.parseOMMCSV(block, satDataByKey);
                sawCSV = true;
                i = j;
            } else {
                // Everything up to the next OMM header is TLE. Pass it as one
                // block so the existing 2LE-vs-3LE detection still sees whole
                // records rather than a line at a time.
                const block: string[] = [];
                while (i < lines.length && !isOMMCSV(lines[i])) {
                    block.push(lines[i]);
                    i++;
                }
                // Drop blank lines at the block edges: the 3LE-vs-2LE test
                // reads lines[1] and lines[2], so a leading blank would make a
                // named 3LE set look like an unnamed 2LE one and misparse it.
                while (block.length > 0 && block[0].trim() === "") block.shift();
                while (block.length > 0 && block[block.length - 1].trim() === "") block.pop();
                if (block.length > 0) {
                    this.parseTLELines(block, satDataByKey);
                    sawTLE = true;
                }
            }
        }

        this.format = (sawCSV && sawTLE) ? "mixed" : (sawCSV ? "omm-csv" : "tle");
    }

    // Parse OMM data in CSV form (CelesTrak FORMAT=csv, Space-Track format/csv).
    // Unlike TLE this carries the full-precision epoch and unrestricted catalog
    // numbers, so it is the only format in which post-2026-07-11 objects appear.
    private parseOMMCSV(lines: string[], satDataByKey: Record<string | number, SatData>): void {
        // A null return is a parse failure, not a server error — finish()
        // reports it via loadError, as it does for an unreadable TLE file.
        const records = parseOMMCSVLines(lines);
        if (records === null) {
            return;
        }

        for (const {name, number, satrec, objectType, creationDate} of records) {
            // The newest CREATION_DATE says when Space-Track last published
            // anything in this set - which is how we later tell whether the set
            // was downloaded before publication for its date had finished.
            if (creationDate !== undefined) {
                const d = new Date(creationDate.endsWith("Z") ? creationDate : creationDate + "Z");
                if (!isNaN(d.getTime()) && (this.latestCreationDate === undefined
                        || d > this.latestCreationDate)) {
                    this.latestCreationDate = d;
                }
            }

            // Group by catalog number: one satellite can appear several times
            // in a historical set, once per epoch, and bestSat() picks between
            // them at playback time.
            if (satDataByKey[number] === undefined) {
                satDataByKey[number] = {
                    name: name,
                    number: number,
                    visible: true,
                    satrecs: [satrec],
                    objectType: objectType,
                };
            } else {
                satDataByKey[number].satrecs.push(satrec);
            }
        }
    }

    // Parse the legacy fixed-width TLE / 2LE / 3LE formats.
    private parseTLELines(lines: string[], satDataByKey: Record<string | number, SatData>): void {
        let satrecName: string | null = null;
        // determine if it's a two line element (no names, lines are labeled 1 and 2) or three (line 0 = name)
        if (lines.length < 3 || !lines[1].startsWith("1") || !lines[2].startsWith("2")) {
            for (let i = 0; i < lines.length; i += 2) {
                const tleLine1 = lines[i + 0];
                const tleLine2 = lines[i + 1];
                if (tleLine1 !== undefined && tleLine2 !== undefined) {
                    const satrec = satellite.twoline2satrec(tleLine1, tleLine2) as unknown as SatRec;
                    // no name in a two line element, so create one.
                    satrecName = "TLE_" + i

                    // a "satrec" is a satellite record created from a single line of a TLE file
                    // there might be multiple satrecs with the same name, so we need to store them in an array
                    // and later pick the best one based on the playback date/time
                    // each entry in satDataByKey is an object that has an array of satrecs with the same name
                    if (satDataByKey[satrecName] === undefined) {
                        // it's a new satData entry
                        // so create a new one with the name and the satrec array, which has one satrec
                        satDataByKey[satrecName] = {
                            name: satrecName,
                            number: parseInt(satrec.satnum),
                            visible: true,
                            satrecs: [satrec]
                        };
                    } else {
                        // entry already exists, so just add the satrec to the array
                        satDataByKey[satrecName].satrecs.push(satrec);
                    }

                }
            }
        } else {
            // console.log("CTLEData: TLE file has three lines per satellite. Num of lines: " + lines.length);


            for (let i = 0; i < lines.length; i += 3) {

                if (lines[i + 1] !== undefined && lines[i + 2] !== undefined) {
                    //console.log(lines[i])
                    const tleLine1 = fixTLELine(lines[i + 1], tleComboFieldEnds1);
                    const tleLine2 = fixTLELine(lines[i + 2], tleComboFieldEnds2);

                    const satrec = satellite.twoline2satrec(tleLine1, tleLine2) as unknown as SatRec;
                    // The name line is padded to a fixed width in TLE files.
                    // Trim it so names match those from the OMM CSV parser —
                    // the two formats feed the same name lookups downstream.
                    satrecName = lines[i].trim()

                    // if it starts with "0 ", then strip that off
                    if (satrecName.startsWith("0 ")) {
                        satrecName = satrecName.substring(2).trim()
                    }

                    const satrecNumber = parseInt(satrec.satnum);

                    // there are multiple satellites that have the same name, but diferent numbers.
                    // E.g.
                    // 0 ATLAS 5 CENTAUR R/B
                    // is 40978, 39575, and 31702
                    // So we need to use the NORAD number as the key

                    if (satDataByKey[satrecNumber] === undefined) {
                        //console.log(satrecName + " " + satrec.satnum + " ");
                        // it's a new satData entry
                        // so create a new one with the name and the satrec array, which has one satrec
                        satDataByKey[satrecNumber] = {
                            name: satrecName,
                            number: satrecNumber,
                            visible: true,
                            satrecs: [satrec]
                        };
                    } else {
                        // entry already exists, so just add the satrec to the array
                        satDataByKey[satrecNumber].satrecs.push(satrec);
                    }


                }
            }
        }

    }

    // Common post-processing for both formats: flatten the by-NORAD map into an
    // iterable array, build the lookup index, and find the epoch range.
    private finish(satDataByKey: Record<string | number, SatData>, fileData: string): void {

        // after building the arrays of multiple satrecs using the number as the key,
        // convert to an indexed array (i.e. just and array with no keys other than the position in the array, which is meaningless)
        // we do this so that we can iterate over the satData array easily
        this.satData = Object.values(satDataByKey);

        // we are going to find the start and end dates of the TLE data
        this.startDate = new Date("2100");
        this.endDate = new Date("1950");

        // now index the satData by NORAD number so we can look a satellite up quickly
        this.noradIndex = new Map()
        for (let i = 0; i < this.satData.length; i++) {

            const satData = this.satData[i];
            this.noradIndex.set(satData.number, satData);

            // iterate over the satrecs in this satData entry


            for (const satrec of satData.satrecs) {
                const satrecDate = satRecToDate(satrec)
                if (satrecDate < this.startDate) {
                    this.startDate = satrecDate;
                }
                if (satrecDate > this.endDate) {
                    this.endDate = satrecDate;
                }
            }


        }

        console.log("CTLEData: loaded " + this.satData.length + " satellites from " +
            this.format + ", start date: " + this.startDate.toISOString() +
            ", end date: " + this.endDate.toISOString());

        // Warn if no satellites were loaded (possible parsing error or invalid data)
        if (this.satData.length === 0) {
            const preview = fileData.substring(0, 200).replace(/\n/g, ' ');
            console.warn("CTLEData: No satellites loaded from TLE data. Preview: " + preview);
            this.loadError = "No satellites loaded from TLE data";
        }

    }

    // Merge satellites from another CTLEData into this one.
    // Satellites with matching NORAD numbers get their satrecs combined.
    // New NORAD numbers are added as new entries.
    mergeFrom(other: CTLEData): void {
        let added = 0;
        let merged = 0;

        for (const otherSat of other.satData) {
            const existing = this.noradIndex.get(otherSat.number);
            if (existing) {
                // Combine satrecs for the same satellite
                existing.satrecs.push(...otherSat.satrecs);
                merged++;
            } else {
                // New satellite -- add it
                const newSat: SatData = {
                    name: otherSat.name,
                    number: otherSat.number,
                    visible: otherSat.visible,
                    satrecs: [...otherSat.satrecs],
                };
                this.satData.push(newSat);
                this.noradIndex.set(newSat.number, newSat);
                added++;
            }
        }

        // Recompute date range
        this.startDate = new Date("2100");
        this.endDate = new Date("1950");
        for (const satData of this.satData) {
            for (const satrec of satData.satrecs) {
                const d = satRecToDate(satrec);
                if (d < this.startDate) this.startDate = d;
                if (d > this.endDate) this.endDate = d;
            }
        }

        // The merged set was published as recently as the newer of the two.
        // This is what isGPSetIncomplete() reads for a CREATION_DATE-filtered
        // query, and a refreshed sitch reloads as the baked set merged with the
        // refreshed one - so without this the merge would keep the stale
        // publication time and go on reporting the set as truncated.
        if (other.latestCreationDate !== undefined
            && (this.latestCreationDate === undefined
                || other.latestCreationDate > this.latestCreationDate)) {
            this.latestCreationDate = other.latestCreationDate;
        }

        // Append raw text for export. Two OMM CSVs are folded into ONE csv by
        // dropping the second header — the columns are fixed by the OMM
        // standard, so the first header describes both. Unlike formats are just
        // concatenated; parseSegments() reads the result block by block, so the
        // export still round-trips with every satellite intact.
        if (this.format === "omm-csv" && other.format === "omm-csv") {
            const otherLines = other.rawText.split("\n");
            const body = isOMMCSV(otherLines[0] ?? "") ? otherLines.slice(1) : otherLines;
            this.rawText = this.rawText.replace(/\n+$/, "") + "\n" + body.join("\n");
        } else {
            this.rawText = this.rawText.replace(/\n+$/, "") + "\n" + other.rawText;
            if (this.format !== other.format) {
                this.format = "mixed";
            }
        }

        console.log(`CTLEData.mergeFrom: added ${added} new satellites, merged satrecs for ${merged} existing. Total: ${this.satData.length}`);
    }

    // given a satellite name or number in s, convert it into a valid NORAD number that
    // exists in the TLE database
    // return null if it doesn't exist
    getNORAD(s: string | number | null | undefined): number | null {
        if (s === undefined || s === null || s === "") {
            return null
        }

        const satDataArray = this.satData;
        if (satDataArray === undefined) {
            console.warn("CNodeSatelliteTrack: no satData Array found")
            return null
        }

        const numSatData = satDataArray.length;
        if (numSatData === 0) {
            console.warn("CNodeSatelliteTrack: satData Array is empty")
            return null
        }

        // The satDatArray is an array of objects
        // which have a name (string) and a number (integer number)

        // if it's a number or a string that resolves into a number, the use that number
        if (typeof s === "number" || typeof s === "string" && !isNaN(Number(s))) {
            const satNum = typeof s === "number" ? s : parseInt(s)
            // now see if it exists in the TLE database
            for (let i = 0; i < numSatData; i++) {
                const satData = satDataArray[i]
                if (satData.number === satNum) {
                    //                  console.log("CNodeSatelliteTrack: found satellite " + satData.name + " with number " + satNum)
                    return satNum
                }
            }
//            console.warn("CNodeSatelliteTrack: no satellite found for number" + s)
        }

        // if it's a string, try to find it in the TLE database, first try to match the name exactly
        if (typeof s === "string") {

            // upper case it, as all the TLE data is upper case
            s = s.toUpperCase()

            for (let i = 0; i < numSatData; i++) {
                const satData = satDataArray[i]
                // check if the name is the same as the string
                if (satData.name === s) {
//                    console.log("CNodeSatelliteTrack: found satellite " + satData.name + " with number " + satData.number)
                    return satData.number
                }
            }

            // then try string starting with this, just return the first one, e.g. "ISS" or "HST"
            for (let i = 0; i < numSatData; i++) {
                const satData = satDataArray[i]
                // check if the name starts with the string
                if (satData.name.startsWith(s)) {
//                    console.log("CNodeSatelliteTrack: found satellite " + satData.name + " with number " + satData.number)
                    return satData.number
                }
            }

            // then try string containing this, just return the first one, e.g.
            for (let i = 0; i < numSatData; i++) {
                const satData = satDataArray[i]
                // check if the name contains the string
                if (satData.name.includes(s)) {
//                    console.log("CNodeSatelliteTrack: found satellite " + satData.name + " with number " + satData.number)
                    return satData.number
                }
            }


            console.warn("CNodeSatelliteTrack: no satellite found for name" + s)
        }


        if (typeof s !== "number" && typeof s !== "string") {
            showError("CNodeSatelliteTrack: not number or string " + s)
        }

        return null


    }

    /**
     * Work out which proxyStarlink.php query produced this set, from its
     * contents alone.
     *
     * A saved sitch bakes in the elements but not the request that fetched
     * them - the filename carries the date, never the type. Each query is
     * defined by filters though, and those leave an exact signature (see the
     * URLs in sitrecServer/proxyStarlink.php):
     *
     *   STARLINK  OBJECT_NAME/STARLINK~~        every name starts STARLINK
     *   SLOW      MEAN_MOTION/<11.26            nothing orbits faster
     *   LEO       MEAN_MOTION/>11.25 + payload  all fast, all PAYLOAD
     *   LEOALL    MEAN_MOTION/>11.25            all fast, mixed object types
     *
     * LEO and LEOALL are only distinguishable when OBJECT_TYPE is present,
     * which means OMM CSV. For a TLE-format set that pair is ambiguous, and
     * the caller should prefer the narrower LEO: refreshing merges, so a
     * narrower query can only under-repair, whereas a broader one would add
     * debris the user never had.
     */
    inferQueryType(): GPQueryType {
        if (this.satData.length === 0) {
            return "UNKNOWN";
        }

        if (this.satData.every(s => s.name.toUpperCase().startsWith("STARLINK"))) {
            return "STARLINK";
        }

        // satrec.no is radians/minute; the queries are in revolutions/day.
        const REV_PER_DAY = (2 * Math.PI) / 1440;
        const meanMotions = this.satData
            .map(s => s.satrecs[0]?.no)
            .filter((n): n is number => typeof n === "number" && Number.isFinite(n))
            .map(n => n / REV_PER_DAY);
        if (meanMotions.length === 0) {
            return "UNKNOWN";
        }

        if (meanMotions.every(n => n < 11.26)) {
            return "SLOW";
        }
        if (!meanMotions.every(n => n > 11.25)) {
            return "UNKNOWN";      // spans both bands - not one of our queries
        }

        const typed = this.satData.filter(s => s.objectType !== undefined);
        if (typed.length === 0) {
            return "LEO";          // TLE-format: ambiguous, take the narrower
        }
        return typed.every(s => s.objectType!.toUpperCase() === "PAYLOAD") ? "LEO" : "LEOALL";
    }

    getRecordFromNORAD(norad: number): SatData | null {
        return this.noradIndex.get(norad) ?? null;
    }

    getRecordFromName(name: string): SatData | null {
        const NORAD = this.getNORAD(name);
        if (NORAD === null) {
            return null;
        }
        return this.getRecordFromNORAD(NORAD);
    }

    // get array of NORAD numbers whose name starts with the given prefix.
    // Matching is case-insensitive. "SL-" is accepted as a shorthand for
    // Starlink and expands to the catalog's "STARLINK-" prefix — while still
    // matching any literal "SL-..." names (e.g. Soviet "SL-16 R/B" rocket bodies).
    getMatchingRecords(name: string): number[] {
        if (this.satData === null) {
            return [];
        }

        const prefix = name.trim().toUpperCase();
        const prefixes = [prefix];
        if (prefix.startsWith("SL-")) {
            prefixes.push("STARLINK-" + prefix.slice(3));
        }

        // now get all the records that match this NORAD number
        const records = [];
        for (const satData of this.satData) {
            const upperName = satData.name.toUpperCase();
            if (prefixes.some(p => upperName.startsWith(p))) {
                records.push(satData.number);
            }
        }
        return records;
    }


}