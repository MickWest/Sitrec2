// ParseSoundingXML.js — Reader for a vertical wind profile held in an XML file
// whose layout the installation describes with SITREC_CUSTOM_SOUNDING_<NAME>_*
// settings (see config/shared.env.example).
//
// The reader itself is tools/xml-wind/soundingLayout.js: the XML Wind Profile
// Analyzer tool runs the same code in its page, and a tool is served unbundled, so
// the code lives on that side. This module only gives it Sitrec's coordinate
// reader, which also takes degrees, minutes and seconds.

import {parseSingleCoordinate} from "./CoordinateParser";
import {
    findSoundingXML as findSoundingXMLWith,
    parseSoundingXML as parseSoundingXMLWith,
    soundingXMLLayoutsFromEnv,
} from "../tools/xml-wind/soundingLayout.js";

export {soundingXMLLayoutsFromEnv};

/**
 * Read one position and one vertical profile from a parsed XML file.
 *
 * @param {Object} xml - parseXml() output
 * @param {Object} layout - one entry from soundingXMLLayoutsFromEnv()
 * @param {Date} [defaultDate]
 * @returns {import('./ParseSonde').SondeData|null}
 */
export function parseSoundingXML(xml, layout, defaultDate) {
    return parseSoundingXMLWith(xml, layout, defaultDate, parseSingleCoordinate);
}

/**
 * Find the layout that identifies a file (or, failing that, fits it) and read it.
 *
 * @param {Object} xml - parseXml() output
 * @param {Object[]} layouts - from soundingXMLLayoutsFromEnv()
 * @param {Date} [defaultDate]
 * @param {string} [sourceText] - the file as text, for _FILE_CONTAINS
 * @returns {import('./ParseSonde').SondeData|null}
 */
export function findSoundingXML(xml, layouts, defaultDate, sourceText = "") {
    return findSoundingXMLWith(xml, layouts, defaultDate, sourceText, parseSingleCoordinate);
}
