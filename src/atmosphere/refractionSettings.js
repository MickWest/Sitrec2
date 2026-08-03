// The View > Atmospheric Refraction folder: one master switch, two halves.
//
// Sitrec models refraction in two places with different physics — the
// whole-atmosphere Saemundsson bend for celestial objects (./refraction.js) and
// the range-dependent bend for the solid scene (./terrestrialRefraction.js).
// They share the same air, so you rarely want one without the other; the master
// switch is what couples them, and the two checkboxes only exist to take one
// half back out when you are deliberately isolating an effect.
//
// The folder is built here rather than in the nodes that own each half, because
// either node may be absent: a star-only sitch has no CNodeTerrainUI, a
// terrain-only one has no CNodeDisplayNightSky. Both call setupRefractionGUI()
// and whichever runs first builds the whole folder.
//
// Sit.refractionEnabled and Sit.terrestrialRefraction stay the flags every
// consumer reads. They are now DERIVED from the master and their checkbox, so
// nothing downstream had to change.

import {guiMenus, setRenderOne, Sit} from "../Globals";
import {REFRACTION_DEFAULTS} from "./refraction";
import {resolveTerrestrialK, TERRESTRIAL_REFRACTION_DEFAULTS} from "./terrestrialRefraction";

let lapseRateController = null;
let terrestrialKController = null;

// Fill in defaults, and migrate a sitch saved before the master existed.
export function ensureRefractionSettings() {
    if (Sit.refraction === undefined) {
        // Pre-master sitches carry only the old single "Atmospheric Refraction"
        // checkbox, which drove the sky. Promote it to the master and switch
        // both halves on: a sitch that wanted a refracted sky wants refracted
        // ground under it, which is the whole point of the coupling.
        Sit.refraction = Sit.refractionEnabled ?? REFRACTION_DEFAULTS.enabled;
        Sit.refractionSky = true;
        Sit.refractionTerrain = true;
    }
    if (Sit.refractionPressure === undefined) Sit.refractionPressure = REFRACTION_DEFAULTS.pressureHPa;
    if (Sit.refractionTemp === undefined) Sit.refractionTemp = REFRACTION_DEFAULTS.tempC;
    if (Sit.terrestrialLapseRate === undefined) {
        Sit.terrestrialLapseRate = TERRESTRIAL_REFRACTION_DEFAULTS.lapseRateKPerKm;
    }
    if (Sit.terrestrialRefractionOverrideK === undefined) {
        Sit.terrestrialRefractionOverrideK = TERRESTRIAL_REFRACTION_DEFAULTS.overrideK;
    }
    if (Sit.terrestrialRefractionK === undefined) {
        Sit.terrestrialRefractionK = TERRESTRIAL_REFRACTION_DEFAULTS.k;
    }
    applyRefractionMaster();
}

// Fold the master into the two flags the rest of the app reads.
export function applyRefractionMaster() {
    Sit.refractionEnabled = !!(Sit.refraction && Sit.refractionSky);
    Sit.terrestrialRefraction = !!(Sit.refraction && Sit.refractionTerrain);
}

// Grey out whichever of the two ways to set k is not in force, so the folder can
// never offer an editable gradient AND an editable k at once.
export function updateRefractionGUIState() {
    const override = !!Sit.terrestrialRefractionOverrideK;
    if (lapseRateController) override ? lapseRateController.disable() : lapseRateController.enable();
    if (terrestrialKController) override ? terrestrialKController.enable() : terrestrialKController.disable();
}

export function setupRefractionGUI() {
    ensureRefractionSettings();

    const folder = guiMenus.refraction;
    if (!folder) return;
    // The folder is a permanent shell whose contents are destroyed between
    // sitches, so an empty one means this sitch has not built it yet. Whichever
    // of the two owning nodes is created first does the work.
    if (folder.controllers && folder.controllers.length > 0) return;

    const changed = () => { applyRefractionMaster(); setRenderOne(true); };

    folder.add(Sit, "refraction").listen()
        .name("Enable Refraction")
        .onChange(changed)
        .tooltip("Master switch for atmospheric refraction. Off means light travels in straight lines — geometrically simple, but not what a camera sees near the horizon.");

    folder.add(Sit, "refractionTerrain").listen()
        .name("Terrain and Buildings")
        .onChange(changed)
        .tooltip("Loft distant terrain, buildings and the sea by k*d/(2R) — about 0.7' at 20 km, 3.4' at 100 km. Display only: ground elevations, line-of-sight and altitude readouts stay geometric.");

    folder.add(Sit, "refractionSky").listen()
        .name("Sky")
        .onChange(changed)
        .tooltip("Bend Sun/Moon/planet/star apparent positions toward the zenith via Saemundsson's formula — about 29' at the horizon.");

    folder.add(Sit, "refractionPressure", 800, 1100, 1).listen()
        .name("Refraction Pressure (hPa)")
        .onChange(() => setRenderOne(true))
        .tooltip("Atmospheric pressure. Feeds BOTH halves. Stellarium default: 1010 hPa");

    folder.add(Sit, "refractionTemp", -40, 50, 1).listen()
        .name("Refraction Temperature (°C)")
        .onChange(() => setRenderOne(true))
        .tooltip("Air temperature. Feeds BOTH halves. Stellarium default: 10 °C");

    lapseRateController = folder.add(Sit, "terrestrialLapseRate", -35, 50, 0.5).listen()
        .name("Surface Temp Gradient (K/km)")
        .onChange(() => setRenderOne(true))
        .tooltip("Temperature change with height in the air the sight line passes through. -6.5 is the standard lapse rate; -9.8 dry adiabatic; -13.7 reproduces the traditional surveying k=0.13 (a sun-warmed land surface). POSITIVE is an inversion — routine over water at night, and it raises k sharply.");

    // One k row doing both jobs. The proxy reads back whatever is actually in
    // force, so with the override off it tracks the derived value live (and is
    // disabled), and with it on the same row edits the stored one.
    const kProxy = {
        get k() { return resolveTerrestrialK(Sit); },
        set k(v) { Sit.terrestrialRefractionK = v; },
    };
    terrestrialKController = folder.add(kProxy, "k", 0, 0.6, 0.005).listen()
        .name("Refraction Coefficient k")
        .onChange(() => setRenderOne(true))
        .tooltip("k = 503 * (P/T^2) * (0.0342 + dT/dh) — derived from the pressure and temperature above plus the gradient, so it is NOT independent of them. Tick Override to type it in directly instead.");

    folder.add(Sit, "terrestrialRefractionOverrideK").listen()
        .name("Override k")
        .onChange(() => { updateRefractionGUIState(); setRenderOne(true); })
        .tooltip("Set k by hand instead of deriving it from pressure, temperature and gradient — for fitting k directly to a measured target. The derived inputs then stop affecting it.");

    updateRefractionGUIState();
}
