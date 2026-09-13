// Import a TLE that was PASTED or TYPED rather than dropped in as a file.
//
// The point is to be able to take the two or three lines out of a forum post, an
// email, or your own notes, and have them land in the sitch exactly as a .tle
// file would: the same FileManager entry, the same merge/replace question, the
// same rehost when the sitch is saved. So what this builds IS a .tle file — a
// synthetic one, assembled in memory from the pasted elements and handed to
// FileManager.parseResult(), which is the same call the drag-and-drop path makes.
//
// Reading the elements is TLEGrammar.js, which the TLE file loader shares; this
// module is what happens after that.

import {parsePastedTLE} from "./TLEGrammar";
import {FileManager, NodeMan, markSitchDirty} from "./Globals";
import {showError} from "./showError";

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
