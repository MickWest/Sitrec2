// One front door for every place the user can type or paste a coordinate:
// the Lat/Lon boxes in the Camera and Terrain menus, the Lookup box, and the
// "G" (Go To) prompt. They all go through the same parser, so any format that
// works in one works in all of them.
//
//   attachCoordinateInput()  - makes a lil-gui numeric field accept any format
//   resolveLocationString()  - text -> lat/lon, falling back to a place lookup
//   moveTerrainTo()          - re-centre the terrain tiles
//   goToLatLon()             - move the main camera (and terrain) to a location

import {parseLatLonPair, parseSingleCoordinate} from "./CoordinateParser";
import {customLocationFunction} from "./runtimeConfig";
import {NodeMan} from "./Globals";
import {LLAToECEF} from "./LLA-ECEF-ENU";

// A plain decimal number is exactly what lil-gui's own input handler already
// parses correctly, so we leave those alone and its clamping/elastic-range
// behaviour is untouched.
const PLAIN_NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

export function isPlainNumber(text) {
    return PLAIN_NUMBER.test(text.trim());
}

/**
 * Let a lil-gui numeric controller accept any coordinate the user might type or
 * paste: decimal degrees, D M, D M S, hemisphere letters, degree symbols, MGRS
 * — and, when setPair is supplied, a whole "lat lon" pair dropped into the
 * latitude box.
 *
 * lil-gui's own handler starts with parseFloat() and bails on anything it can't
 * read ("N40 26.767" gives NaN), so we listen on the same 'input' event and take
 * over whenever the text is not a plain number. Its updateDisplay() deliberately
 * skips a focused field, so we write the resolved value back ourselves.
 *
 * @param {object} controller - lil-gui controller with a $input text field
 * @param {object} [handlers]
 * @param {(lat:number, lon:number) => number} [handlers.setPair] - apply a
 *        pasted pair; returns the value this field should now show.
 * @param {(value:number) => void} [handlers.setSingle] - apply a single
 *        coordinate. Defaults to controller.setValue(), which fires the
 *        controller's normal onChange.
 * @returns {object} the controller, for chaining
 */
export function attachCoordinateInput(controller, {setPair, setSingle} = {}) {
    const $input = controller?.$input;
    if (!$input) return controller;

    const applySingle = setSingle ?? ((value) => controller.setValue(value));

    // What was actually entered. We can't just read $input.value when we come to
    // use it: lil-gui rewrites the field from inside its own handlers —
    // updateDisplay() on 'input' (whenever the field isn't focused) and again on
    // 'blur' — replacing "45.5, -122.5" with its numeric parse "45.5" and
    // silently dropping the longitude. A capture-phase listener runs before any
    // target-phase listener regardless of registration order, so this sees the
    // text first, every time.
    let entered = "";
    $input.addEventListener("input", () => { entered = $input.value; }, true);

    const apply = (committed) => {
        const raw = entered;
        if (!raw || !raw.trim() || isPlainNumber(raw)) return;

        if (setPair) {
            const pair = parseLatLonPair(raw);
            if (pair) {
                // Mid-typing, "45.5, -1" is a valid pair but the user is still
                // going. Only split (and rewrite the box out from under them)
                // once they paste it in one go or commit with Enter/blur.
                if (!committed) return;
                $input.value = setPair(pair.lat, pair.lon);
                // The field now holds a plain number, so a following
                // change/blur is a no-op rather than a repeat application.
                entered = $input.value;
                return;
            }
        }

        const single = parseSingleCoordinate(raw);
        // No rewrite here: "45 30" must stay editable so the user can go on to
        // type the seconds. lil-gui normalises the text on blur.
        if (single !== null) applySingle(single);
    };

    // Deliberately the bubble phase, so lil-gui's handler has already run: it
    // owns the plain-number path (clamping, elastic ranges), and we only correct
    // the value afterwards when the text was something it couldn't read.
    $input.addEventListener("input", (e) => {
        const pasted = e.inputType === "insertFromPaste" || e.inputType === "insertFromDrop";
        apply(pasted);
    });
    // Enter or blur - the user is done, so a typed-out pair can be split now.
    $input.addEventListener("change", () => apply(true));

    return controller;
}

/**
 * Wire a Lat box and a Lon box together: both accept any coordinate format, and
 * a complete pair pasted into either one fills in both. This is the shape every
 * lat/lon menu in Sitrec wants, so they all call this rather than rolling their
 * own.
 *
 * @param {object} latController
 * @param {object} lonController
 * @param {(lat:number, lon:number) => void} [onPair] - extra work after a pair
 *        lands (e.g. kicking off a terrain reload)
 */
export function attachLatLonInputs(latController, lonController, onPair) {
    const setBoth = (lat, lon) => {
        latController.setValue(lat);
        lonController.setValue(lon);
        if (onPair) onPair(lat, lon);
    };
    attachCoordinateInput(latController, {setPair: (lat, lon) => (setBoth(lat, lon), lat)});
    attachCoordinateInput(lonController, {setPair: (lat, lon) => (setBoth(lat, lon), lon)});
}

/**
 * Turn whatever the user typed into a lat/lon. Every coordinate format the
 * parser knows is tried first — decimal degrees, D M, D M S, hemisphere
 * letters, degree symbols, MGRS, and whitespace-separated pairs — and only if
 * none of them match do we spend a network round trip asking the geocoder to
 * look it up as a place name.
 *
 * @param {string} text
 * @returns {Promise<{lat:number, lon:number, isCoordinate:boolean}|null>}
 */
export async function resolveLocationString(text) {
    if (typeof text !== "string" || !text.trim()) return null;

    const pair = parseLatLonPair(text, {loose: true});
    if (pair) return {lat: pair.lat, lon: pair.lon, isCoordinate: true};

    // Serverless builds have no geocoder, so a non-coordinate is simply unknown.
    if (customLocationFunction === undefined) return null;

    const location = await customLocationFunction(text.trim());
    if (!location) return null;
    return {lat: location[0], lon: location[1], isCoordinate: false};
}

// Re-centre the terrain tiles on a location. Without this, going somewhere far
// from the current terrain patch just shows the bare grey sphere.
export function moveTerrainTo(lat, lon) {
    if (!NodeMan.exists("terrainUI")) return;
    const terrainUI = NodeMan.get("terrainUI");
    terrainUI.lat = lat;
    terrainUI.lon = lon;
    terrainUI.flagForRecalculation();
    terrainUI.startLoading = true;
}

/**
 * Move the main camera to look at a lat/lon, bringing the terrain with it.
 * Defaults match the "Go To" button in the position menus.
 */
export function goToLatLon(lat, lon, above = 100000, back = 100) {
    moveTerrainTo(lat, lon);
    // Tolerant lookup: the Go To key is global, and not every sitch has a main
    // camera to fly.
    NodeMan.get("mainCamera", false)?.goToPoint?.(LLAToECEF(lat, lon, 0), above, back);
}
