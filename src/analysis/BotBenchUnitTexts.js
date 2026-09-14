/**
 * Stored fit units as they travel to a fitter: blob text in, decoded units out.
 *
 * The main thread reads a folder's blobs and hands the TEXT over, because decoding
 * a battery's worth of fits is tens of milliseconds a file and a run has thousands
 * of files; the worker decodes. The main-thread fallback (a host that blocks
 * workers) decodes the same way, through this one function, so both paths hand
 * TraverseBattery the same thing.
 *
 *   texts = {
 *     plan:            the unit ids wanted, in any order
 *     cached:          {unitId: {text}}  schema-3 unit blobs
 *     legacy:          the schema-2 battery blob's text, or null
 *     legacyElapsedMs: that battery's recorded fit time
 *   }
 *
 *     legacyUnits:     the units the schema-2 blob may be used for (its other
 *                      units are split out too, for storing, but not used)
 *
 * Returns {cached, migrated, legacyHeld}: `cached` is {unitId: {result, failures}}
 * for the battery; `migrated` lists every unit split out of the schema-2 blob, to
 * be written back as units of their own; `legacyHeld` names the units that blob
 * held, so the caller knows when it has nothing left to give.
 */
import {legacyUnitsFromBattery, readUnitBlob} from "./BotBenchCacheIndex";
import {unpackFromCache} from "./BotBenchCacheCodec";

export function unitsFromTexts(texts) {
    const cached = {};
    const migrated = {};
    let legacyHeld = [];
    if (!texts) return {cached, migrated, legacyHeld};
    for (const [unitId, entry] of Object.entries(texts.cached ?? {})) {
        if (!entry || typeof entry.text !== "string") continue;
        const {meta, result} = readUnitBlob(entry.text);
        cached[unitId] = {result, failures: meta?.failures ?? []};
    }
    if (typeof texts.legacy === "string") {
        const battery = unpackFromCache(JSON.parse(texts.legacy));
        const legacy = legacyUnitsFromBattery(battery, {elapsedMs: texts.legacyElapsedMs ?? null});
        legacyHeld = Object.keys(legacy);
        const allowed = new Set(texts.legacyUnits ?? texts.plan ?? legacyHeld);
        for (const unitId of legacyHeld) {
            migrated[unitId] = legacy[unitId];
            if (cached[unitId] || !allowed.has(unitId)) continue;
            cached[unitId] = {result: legacy[unitId].result, failures: legacy[unitId].failures};
        }
    }
    return {cached, migrated, legacyHeld};
}
