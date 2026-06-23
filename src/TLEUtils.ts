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
}

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

// this is the TLE data for the satellites
// A CTLEData object is created from a TLE file and consists of just
// a satData array, which is an array of objects
// each object has a name, a visible flag, and an array of satrecs
// the satrec is a satellite record created from a single line of a TLE file
// there can be several satrecs with the same name, so we need to store them in an array
// and pick the best one based on the playback date/time
export class CTLEData {
    satData: SatData[];
    noradIndex: (SatData | undefined)[];
    startDate: Date;
    endDate: Date;
    loadError?: string;
    rawText: string;

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
            this.noradIndex = [];
            this.startDate = new Date("2100");
            this.endDate = new Date("1950");
            this.loadError = trimmedData;
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
                    satrecName = lines[i]

                    // if it starts with "0 ", then strip that off
                    if (satrecName.startsWith("0 ")) {
                        satrecName = satrecName.substring(2)
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

        // after building the arrays of multiple satrecs using the number as the key,
        // convert to an indexed array (i.e. just and array with no keys other than the position in the array, which is meaningless)
        // we do this so that we can iterate over the satData array easily
        this.satData = Object.values(satDataByKey);

        // we are going to find the start and end dates of the TLE data
        this.startDate = new Date("2100");
        this.endDate = new Date("1950");

        // now create an array of the satData indexed by the NORAD number
        // so we can quickly look up a satellite by its NORAD number
        this.noradIndex = []
        for (let i = 0; i < this.satData.length; i++) {

            const satData = this.satData[i];
            // add the satrec to the noradIndex array
            // indexed by the NORAD number
            this.noradIndex[satData.number] = satData;

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

        console.log("CTLEData: loaded " + this.satData.length + " satellites with max " +
            this.noradIndex.length + " NORAD numbers, start date: " + this.startDate.toISOString() +
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
            const existing = this.noradIndex[otherSat.number];
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
                this.noradIndex[newSat.number] = newSat;
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

        // Append raw text for export
        this.rawText += "\n" + other.rawText;

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

    getRecordFromNORAD(norad: number): SatData | null {
        if (this.noradIndex[norad] === undefined) {
            return null;
        }
        return this.noradIndex[norad]!;
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