/**
 * FileHandoff.js — hand local files to a NEW Sitrec window.
 *
 * THE PROBLEM. A file picked with the folder picker, or dragged onto a dialog,
 * exists only as an in-memory Blob in the tab that received it. There is no
 * path on disk a URL could name, so "open this file in a fresh Sitrec" cannot
 * be an ordinary link — the new window has no way to reach the bytes.
 *
 * WHY NOT THE OTHER MECHANISMS. Three were considered and rejected:
 *
 *   blob: URL         Same-origin and readable, but tied to the OPENER's
 *                     lifetime: the URL dies when that document unloads, so
 *                     the new window breaks the moment the user closes or
 *                     navigates the dialog it came from.
 *   postMessage       Requires both windows alive and a handshake, and a
 *                     reload of the new window loses the payload for good.
 *   sessionStorage    Strings only, so a megabyte CSV must be base64'd (a
 *                     third larger), and it is not shared with a window opened
 *                     by window.open in every browser.
 *
 * IndexedDB stores Blobs directly, survives the opener closing, and survives a
 * reload of the receiving window — which matters because Sitrec's startup is
 * long enough that a user may well reload it.
 *
 * IT USES THE EXISTING STORE. src/IndexedDBManager.js already runs a keyed
 * cache with a time-to-live and lazy expiry, which is exactly these semantics,
 * so this file is a thin naming and File-reconstruction layer over it rather
 * than a second database. Blobs survive its structured clone unchanged.
 *
 * THE RECORD IS NOT DELETED ON READ, so a reload of the receiving window still
 * finds it; the TTL is what removes it.
 */

import {indexedDBManager} from "./IndexedDBManager";

// Long enough that a user can reload the receiving window, read the file, and
// come back to it; short enough that a day of benchmarking does not leave
// hundreds of megabytes of scenario CSVs in the browser's profile.
export const HANDOFF_TTL_MS = 60 * 60 * 1000;

const KEY_PREFIX = "handoff:";

/**
 * Store files for a new window to collect. Returns the key to put in its URL.
 *
 * @param files  File or Blob objects. A Blob needs an explicit name, since the
 *               importer routes on the filename and a nameless Blob would be
 *               unidentifiable at the far end.
 * @param meta   Anything structured-cloneable the receiver should also see.
 *               Kept small — this is a handoff, not a cache.
 */
export async function putFileHandoff(files, meta = {}) {
    const list = (Array.isArray(files) ? files : [files]).filter(Boolean);
    if (!list.length) throw new Error("putFileHandoff: no files");
    for (const f of list) {
        if (!f.name) throw new Error("putFileHandoff: every file needs a name");
    }

    const id = crypto.randomUUID ? crypto.randomUUID()
        : `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

    // Stored as {name, type, blob} rather than as File objects: structured
    // clone preserves a File in every browser that matters, but the name is
    // the part the importer routes on, and keeping it as an explicit field
    // means a browser that degrades File to Blob cannot silently lose it.
    await indexedDBManager.cacheData(KEY_PREFIX + id, {
        meta,
        files: list.map((f) => ({name: f.name, type: f.type ?? "", blob: f.slice(0, f.size, f.type)})),
    }, HANDOFF_TTL_MS);

    return id;
}

/**
 * Collect files a previous window stored. Returns null when the key is unknown
 * or expired, which is the normal outcome for a stale link and must be handled
 * as "nothing to load" rather than as an error.
 */
export async function takeFileHandoff(id) {
    if (!id) return null;
    let rec;
    try {
        rec = await indexedDBManager.getCachedData(KEY_PREFIX + id);
    } catch (e) {
        // id passed as its own argument, not concatenated: console.warn reads the first
        // argument as a format string, so an id containing %s or %c would rewrite the line.
        console.warn("FileHandoff: could not read handoff", id, e);
        return null;
    }
    if (!rec || !Array.isArray(rec.files) || !rec.files.length) return null;
    return {
        meta: rec.meta ?? {},
        files: rec.files.map((f) => new File([f.blob], f.name, {type: f.type || ""})),
    };
}
