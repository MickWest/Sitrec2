/**
 * ADSBTraceFetch — "Import ADS-B Track..." dialog.
 *
 * Prompts for an aircraft's ICAO 24-bit hex address, fetches its readsb
 * "trace_full" JSON (roughly the last 24 hours of positions) from adsb.lol,
 * and hands the result to the normal file-import pipeline, where
 * CTrackFileADSBTrace turns it into a track exactly as if the file had been
 * dropped in.
 *
 * Server builds route through sitrecServer/proxyADSBTrace.php (caching, rate
 * limiting, serve-stale). Serverless builds fetch adsb.lol directly — it
 * serves permissive CORS headers — mirroring the SondeFetch UWYO/IGRA2
 * pattern of choosing a CORS-direct path rather than showing a dead control.
 *
 * Data license: adsb.lol data is ODbL — credit "adsb.lol" when publishing
 * imagery made with it. The data is fetched live, never bundled.
 */

import {SITREC_SERVER, isServerless} from "./configUtils";
import {FileManager} from "./Globals";
import {promptForText} from "./TextPrompt";
import {showError} from "./showError";

// adsb.lol keeps current traces under the LAST two hex digits:
//   https://adsb.lol/data/traces/{last2}/trace_full_{hex}.json
export function adsbLolTraceURL(hex) {
    return "https://adsb.lol/data/traces/" + hex.slice(-2) + "/trace_full_" + hex + ".json";
}

export function normalizeIcaoHex(text) {
    return String(text ?? "").trim().toLowerCase();
}

export function isValidIcaoHex(hex) {
    return /^[0-9a-f]{6}$/.test(hex);
}

/**
 * Show the import dialog, fetch the trace, and feed it to the import
 * pipeline. Resolves true when a track file was fetched and queued for
 * parsing, false on cancel or failure (failure is reported via showError).
 */
export async function importADSBTraceDialog() {
    const entered = await promptForText({
        title: "Import ADS-B Track",
        message: "Enter the aircraft's ICAO 24-bit hex address (e.g. a1b2c3). "
            + "The last ~24 hours of positions are fetched from adsb.lol (ODbL data).",
        defaultValue: "",
        confirmLabel: "Import",
        validate: (v) => {
            if (!isValidIcaoHex(normalizeIcaoHex(v))) {
                return "Enter exactly six hex digits (0-9, a-f)";
            }
            return null;
        },
    });
    if (entered === null) return false; // cancelled
    return await importADSBTraceByHex(normalizeIcaoHex(entered));
}

/**
 * Fetch one aircraft's trace by hex and hand it to the import pipeline.
 *
 * Split out of the dialog above so the live-traffic layer can promote a clicked
 * aircraft to a real track without putting a dialog in front of the user asking
 * for a hex address they just clicked on.
 *
 * Resolves true when a track file was fetched and queued for parsing, false on
 * failure (which is reported through showError).
 */
export async function importADSBTraceByHex(hex) {
    if (!isValidIcaoHex(hex)) {
        showError("ADS-B trace import failed", new Error("Not a valid ICAO hex address: " + hex));
        return false;
    }
    const url = isServerless
        ? adsbLolTraceURL(hex)
        : SITREC_SERVER + "proxyADSBTrace.php?hex=" + encodeURIComponent(hex);

    try {
        // Without a deadline a stalled host leaves the caller waiting forever —
        // and the live-traffic layer shows "importing <callsign>…" for as long as
        // this is outstanding, so a hung fetch means a status line that never
        // resolves and a user who cannot tell whether it worked.
        const response = await fetch(url, {signal: AbortSignal.timeout(20000)});
        if (!response.ok) {
            if (response.status === 404) {
                throw new Error("No trace found for " + hex
                    + " — adsb.lol has no positions for this aircraft in the last day.");
            }
            const text = await response.text().catch(() => "");
            throw new Error(text || ("HTTP " + response.status));
        }
        const buffer = await response.arrayBuffer();
        // Synthetic filename with the canonical trace name, so the JSON branch
        // and CTrackFileADSBTrace.canHandle pick it up like a dropped file.
        await FileManager.parseResult("trace_full_" + hex + ".json", buffer);
        return true;
    } catch (e) {
        const message = (e?.name === "TimeoutError" || e?.name === "AbortError")
            ? new Error("adsb.lol did not respond in time. It may be down — try again shortly.")
            : e;
        showError("ADS-B trace import failed", message);
        return false;
    }
}
