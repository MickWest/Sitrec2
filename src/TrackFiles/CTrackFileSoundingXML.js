import {CTrackFileSonde} from "./CTrackFileSonde";
import {findSoundingXML, soundingXMLLayoutsFromEnv} from "../ParseSoundingXML";
import {reconstructTrajectory} from "../SondeTrajectory";
import {GlobalDateTimeNode, Globals} from "../Globals";

/**
 * Track file handler for a vertical wind profile in an XML file whose layout the
 * installation describes with SITREC_CUSTOM_SOUNDING_<NAME>_* settings.
 *
 * From here on it is an ordinary sounding: a CTrackFileSonde with one profile,
 * which becomes a CNodeAtmosphericProfile that the Manual Soundings wind source
 * reads. With no layout configured this handler matches nothing.
 */
export class CTrackFileSoundingXML extends CTrackFileSonde {

    /**
     * @param {string} filename
     * @param {Object} data - parseXml() output
     * @param {string} [sourceText] - the file as text; a layout's _FILE_CONTAINS
     *        substrings are looked for in it
     */
    static canHandle(filename, data, sourceText = "") {
        // detectTrackFile also offers this class JSON objects and row arrays;
        // only a parsed .xml file is walked.
        if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
        if (!/\.xml$/i.test(String(filename).split(/[?#]/)[0])) return false;
        return readSounding(data, sourceText) !== null;
    }

    constructor(data, sourceText = "") {
        // super() runs _parse, which has only this.data to go on, so the read is
        // done (and cached) here first, while the text is in hand.
        readSounding(data, sourceText);
        super(data);
    }

    _parse() {
        const sonde = readSounding(this.data);
        if (!sonde) return;
        this.format = "xml";
        this.soundings.push(sonde);
        this.trajectories.push(reconstructTrajectory(sonde));
    }

    // Named after the file: the layout name and the sitch start time are the same
    // for every file an installation loads, so they do not tell two profiles apart.
    getShortName(trackIndex = 0, trackFileName = "") {
        if (trackFileName) {
            return trackFileName.replace(/\.[^/.]+$/, "");
        }
        return super.getShortName(trackIndex, trackFileName);
    }
}

// canHandle, the constructor and _parse all need the read, on the same object.
const soundingCache = new WeakMap();

function readSounding(xml, sourceText = "") {
    if (soundingCache.has(xml)) return soundingCache.get(xml);
    const layouts = soundingXMLLayoutsFromEnv(Globals.env);
    // A file with no time of its own takes the start of the sitch.
    const defaultDate = GlobalDateTimeNode ? GlobalDateTimeNode.frameToDate(0) : new Date();
    const sonde = layouts.length > 0 ? findSoundingXML(xml, layouts, defaultDate, sourceText) : null;
    soundingCache.set(xml, sonde);
    return sonde;
}
