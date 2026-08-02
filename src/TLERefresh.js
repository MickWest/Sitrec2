// Offer to refresh the satellite data baked into a saved sitch.
//
// Saving a sitch rehosts the loaded TLE/OMM set as a static file, so reloading
// that sitch always replays the exact elements it was saved with. That is what
// makes an old sitch reproducible, and it must stay that way — nothing here
// deletes or overwrites the original file.
//
// The catch is that Space-Track publishes elements AFTER their epoch. A set
// downloaded within a couple of days of the date it covers holds only what had
// been published by then; measured on a real date, a same-day download captured
// 8.9% of the window and a next-day one 40.6%. A sitch saved soon after the
// event it analyses therefore bakes in a partial catalogue, and can be missing
// hundreds of satellites — including, potentially, the one the analysis is
// about.
//
// So on loading a sitch of your OWN, if its satellite data is detectably
// truncated, offer to fetch the rest and MERGE it in. Merge, not replace: the
// user may have combined several sets deliberately, and replacing would discard
// that. Merging by catalog number keeps every satellite already present and
// adds the ones that were missing.

import {FileManager, NodeMan, Globals, getEffectiveUserID} from "./Globals";
import {extractSitrecObjectKey} from "./SitrecObjectResolver";
import {isGPSetIncomplete, GP_QUERY_WINDOW_DAYS} from "./TLEUtils";
import {showChoice} from "./showError";
import {SITREC_SERVER} from "./configUtils";

// A dated satellite file is named for the date it covers, e.g.
// "starLink_2025-09-15.tle.tle" (CSatellite.loadDatedTLEWithRetry builds
// "starLink_<date>.tle", and processTLEData appends a second extension).
const DATED_TLE_NAME = /starLink[_-](\d{4}-\d{2}-\d{2})/i;

/**
 * Is the currently loaded sitch one this user saved?
 *
 * Sitch references are "<ownerUserID>/<name>/<file>", so the owner is the first
 * path segment. Only the owner is offered a refresh: it rewrites what the sitch
 * loads, and re-saving is the natural follow-up, neither of which makes sense
 * for someone else's sitch.
 */
function isOwnLoadedSitch() {
    const key = extractSitrecObjectKey(FileManager.loadURL);
    if (!key) return false;
    const owner = String(key).split("/")[0];
    const me = getEffectiveUserID();
    return !!me && String(me) === owner;
}

/**
 * The baked satellite file to consider, or null if the sitch has none that can
 * be refreshed.
 *
 * Only dated historical sets qualify. The live "current Starlink" feed is not
 * refreshable this way — it has no date window, and reloading it would fetch a
 * catalogue for today rather than for the sitch.
 */
function findDatedTLEEntry() {
    for (const id of Object.keys(FileManager.list)) {
        const entry = FileManager.list[id];
        if (!entry || !entry.isTLE) continue;
        const source = tleSourceFor(id, entry);
        if (source) return {id, entry, source};
    }
    return null;
}

/**
 * Where a baked set came from: {date, type}.
 *
 * Prefers the tleSource recorded at save time, which reproduces the original
 * request exactly. Falls back to reading the date out of the filename and
 * INFERRING the query type from the elements themselves — each query is defined
 * by filters that leave a signature in the data (see CTLEData.inferQueryType),
 * so sitches saved before tleSource existed can still be refreshed.
 */
function tleSourceFor(id, entry) {
    const saved = FileManager.loadedFilesMetadata?.[id]?.tleSource;
    if (saved?.date && saved?.type) {
        return {date: saved.date, type: saved.type, inferred: false};
    }

    const match = DATED_TLE_NAME.exec(entry.filename || id || "");
    if (!match) return null;

    const tleData = getLoadedTLEData();
    const type = tleData ? tleData.inferQueryType() : "UNKNOWN";
    if (type === "UNKNOWN") return null;

    // The default (Starlink-only) query is requested with an empty type.
    return {date: match[1], type: type === "STARLINK" ? "" : type, inferred: true};
}

function getLoadedTLEData() {
    if (!NodeMan.exists("NightSkyNode")) return null;
    return NodeMan.get("NightSkyNode").satellites?.TLEData ?? null;
}

/**
 * Check the loaded sitch's satellite data and, if it was captured before
 * Space-Track had finished publishing, offer to merge in what was missing.
 *
 * Safe to call unconditionally after a sitch loads: it returns quietly unless
 * every condition holds.
 */
export async function checkAndOfferTLERefresh() {
    try {
        if (Globals.validationMode) return;          // no user to ask
        if (!isOwnLoadedSitch()) return;             // not ours to re-save

        const tleData = getLoadedTLEData();
        if (!tleData || tleData.satData.length === 0) return;

        const found = findDatedTLEEntry();
        if (!found) return;

        const setDate = new Date(found.source.date + "T00:00:00Z");
        if (isNaN(setDate.getTime())) return;
        if (!isGPSetIncomplete(tleData, setDate)) return;

        await offerRefresh(tleData, setDate, found);
    } catch (e) {
        // A refresh is an optional improvement; never let it break a sitch load.
        console.warn("TLE refresh check failed:", e);
    }
}

function describeShortfall(tleData, setDate) {
    const windowEnd = new Date(setDate.getTime() + GP_QUERY_WINDOW_DAYS * 86400000);
    const coveredMs = tleData.endDate.getTime() - setDate.getTime();
    const totalMs = windowEnd.getTime() - setDate.getTime();
    const pct = Math.max(0, Math.min(100, (coveredMs / totalMs) * 100));
    return {
        windowEnd,
        percent: pct,
        lastEpoch: tleData.endDate,
    };
}

async function offerRefresh(tleData, setDate, found) {
    const {percent, lastEpoch} = describeShortfall(tleData, setDate);
    const dateStr = found.source.date;
    const typeLabel = found.source.type === "" ? "Starlink" : found.source.type;

    const message =
        `This sitch's satellite data was saved before Space-Track had finished ` +
        `publishing for ${dateStr}.\n\n` +
        `It holds ${tleData.satData.length.toLocaleString()} satellites, with elements ` +
        `up to ${lastEpoch.toISOString().slice(0, 16).replace("T", " ")} UTC — about ` +
        `${percent.toFixed(0)}% of the ${GP_QUERY_WINDOW_DAYS}-day window the data covers. ` +
        `Space-Track has since published the rest.\n\n` +
        `Refreshing fetches the ${typeLabel} set for ${dateStr} again and MERGES it in, ` +
        `keeping every satellite already loaded and adding the ones that were missing. ` +
        `The original file is left untouched, so the saved sitch keeps working as-is ` +
        `until you choose to save.` +
        (found.source.inferred
            ? `\n\n(The set type was inferred from the data as "${typeLabel}", since this ` +
              `sitch predates recording it.)`
            : "");

    const choice = await showChoice(message, {
        title: "Satellite data may be incomplete",
        options: [
            {label: "Refresh satellite data", value: "refresh", primary: true, color: "#1976d2",
             description: "Fetch the rest and merge it in"},
            {label: "Keep as saved", value: "keep", cancel: true, color: "#757575",
             description: "Leave this sitch exactly as it was saved"},
        ],
    });

    if (choice !== "refresh") return;
    await performRefresh(setDate, found);
}

async function performRefresh(setDate, found) {
    const dateStr = found.source.date;
    const url = SITREC_SERVER + "proxyStarlink.php?request=" + dateStr
        + "&type=" + encodeURIComponent(found.source.type);

    const before = getLoadedTLEData();
    const satsBefore = before ? before.satData.length : 0;

    let buffer;
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error("HTTP " + response.status);
        buffer = await response.arrayBuffer();
    } catch (e) {
        await showChoice(
            `Could not fetch the satellite data for ${dateStr}.\n\n${e.message}\n\n` +
            `The sitch is unchanged and still has the data it was saved with.`,
            {title: "Refresh failed", options: [{label: "OK", value: "ok", primary: true}]});
        return;
    }

    // A distinct id, so the refreshed set is added alongside the baked one
    // rather than replacing it in FileManager — the original stays available
    // and the saved sitch keeps working until the user chooses to re-save.
    const refreshedId = `starLink_${dateStr}-refreshed.tle`;
    FileManager.remove(refreshedId);
    await FileManager.parseResult(refreshedId, buffer, null, {trackOptions: {tleAction: "merge"}});

    const entry = FileManager.list[refreshedId];
    if (entry) {
        entry.staticURL = null;      // fetched live: must be rehosted on save
        entry.dynamicLink = true;
        entry.isTLE = true;
        entry.tleMerged = true;
        entry.tleSource = {date: dateStr, type: found.source.type};
    }

    const after = getLoadedTLEData();
    const gained = (after ? after.satData.length : 0) - satsBefore;

    await offerSave(dateStr, gained, after ? after.satData.length : 0);
}

async function offerSave(dateStr, gained, total) {
    const summary = gained > 0
        ? `Merged in ${gained.toLocaleString()} additional satellite${gained === 1 ? "" : "s"} ` +
          `for ${dateStr}. The sitch now has ${total.toLocaleString()}.`
        : `The refreshed set for ${dateStr} added no satellites beyond the ` +
          `${total.toLocaleString()} already loaded.`;

    const choice = await showChoice(
        `${summary}\n\n` +
        `This is loaded but not yet saved. You can save now to lock it in, or look ` +
        `things over first and save later from the File menu — the sitch as it was ` +
        `saved is untouched either way.`,
        {
            title: "Satellite data refreshed",
            options: [
                {label: "Save sitch now", value: "save", primary: true, color: "#1976d2",
                 description: "Write the merged data into this sitch"},
                {label: "I'll check it first", value: "later", cancel: true, color: "#757575",
                 description: "Keep the refreshed data loaded without saving"},
            ],
        });

    if (choice === "save") {
        await FileManager.saveSitchFromMenu();
    }
}
