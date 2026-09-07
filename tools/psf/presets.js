// Named starting points. Every one of these is a COMPLETE, fully editable spec - loading a
// preset fills the controls and nothing more, so any of them can be dragged into shape from
// there. Custom edits can be saved back as a new preset (see app.js), which is what makes
// this a set of starting points rather than a fixed menu.
//
// They are ordered from the simplest optics to the most involved, because the spike geometry
// is much easier to learn in that order: an unobstructed circle has none, one straight vane
// pair gives a hairline cross, and only then do apodisation and a second stop make sense.

import { DEFAULT_STOP } from "./aperture.js";
import { DEFAULT_SPEC } from "./psf.js";

/** Deep-clone a spec so a preset can never be mutated by the editor that loaded it. */
export function cloneSpec(spec) {
    return JSON.parse(JSON.stringify(spec));
}

/** Build a spec from partial overrides against the defaults, one level of stops deep. */
function spec(over = {}) {
    const s = cloneSpec(DEFAULT_SPEC);
    const { stops, spectrum, optics, ...rest } = over;
    Object.assign(s, rest);
    if (spectrum) Object.assign(s.spectrum, spectrum);
    if (optics) Object.assign(s.optics, optics);
    if (stops) {
        stops.forEach((st, i) => {
            if (!st) return;
            const { vanes, ...sr } = st;
            Object.assign(s.stops[i], sr);
            if (vanes) Object.assign(s.stops[i].vanes, vanes);
        });
    }
    return s;
}

const NO_VANES = { count: 0 };
/** A stop that only blocks - no obstruction, no vanes. Used for plain irises. */
const PLAIN = { obstruction: 0, vanes: NO_VANES };

export const PRESETS = [
    {
        id: "airy",
        name: "Unobstructed circle (Airy)",
        note: "The reference case: a clean round aperture and nothing else. No spikes at all - "
            + "just the Airy core and its rings. Every spike in the other presets is something "
            + "ADDED to this by an obstruction.",
        spec: spec({
            fill: 0.22,
            stops: [{ shape: "circle", ...PLAIN }, { enabled: false }],
        }),
    },
    {
        id: "newtonian",
        name: "Newtonian, 4 straight vanes",
        note: "The classic amateur-telescope look. Four vanes 90 degrees apart are two "
            + "COLLINEAR pairs, so they throw 4 spikes, not 8. Straight edges give hairline "
            + "spikes - compare with the apodised presets below.",
        spec: spec({
            fill: 0.45,
            stops: [{
                shape: "circle", obstruction: 0.22,
                vanes: { count: 4, rotationDeg: 45, width: 0.012, taper: 1, apodize: "none" },
            }, { enabled: false }],
        }),
    },
    {
        id: "cass3",
        name: "Cassegrain, 3 vanes",
        note: "Three vanes 120 degrees apart are NOT collinear, so each throws its own spike "
            + "pair: 6 spikes from 3 vanes. The rule is 2N spikes for odd N, N for even N.",
        spec: spec({
            fill: 0.45,
            stops: [{
                shape: "circle", obstruction: 0.30,
                vanes: { count: 3, rotationDeg: 90, width: 0.016, taper: 1, apodize: "none" },
            }, { enabled: false }],
        }),
    },
    {
        id: "iris6",
        name: "Camera iris, 6 blades",
        note: "No obstruction and no vanes - the spikes come from the straight blade edges of "
            + "the diaphragm itself. An even blade count gives N spikes (opposite blades are "
            + "parallel and share one); an odd count gives 2N.",
        spec: spec({
            fill: 0.42,
            stops: [{ shape: "polygon", sides: 6, rotationDeg: 0, ...PLAIN }, { enabled: false }],
        }),
    },
    {
        id: "squareIris",
        name: "Square iris only",
        note: "A square stop throws one hard vertical and one hard horizontal spike, each "
            + "with the sinc side lobes of a straight edge. This is the SECOND stop of the "
            + "Chandelier model, on its own.",
        spec: spec({
            fill: 0.40,
            stops: [{ shape: "square", rotationDeg: 0, ...PLAIN }, { enabled: false }],
        }),
    },
    {
        id: "segmented",
        name: "Segmented hexagon + 3 vanes",
        note: "A hexagonal pupil throws 6 spikes from its own edges; three vanes add another "
            + "6, and where the two sets coincide they reinforce. The familiar look of a "
            + "segmented space telescope.",
        spec: spec({
            fill: 0.42,
            stops: [{
                shape: "polygon", sides: 6, rotationDeg: 0, obstruction: 0.16,
                vanes: { count: 3, rotationDeg: 90, width: 0.014, taper: 1, apodize: "none" },
            }, { enabled: false }],
        }),
    },
    {
        id: "apodised",
        name: "Apodised vanes (feathered spikes)",
        note: "The same 4 vanes, but with a serrated edge. A wavy edge has no single "
            + "orientation, so its spike smears sideways into a broad FEATHER instead of a "
            + "hairline. This one feature is what the PDF had to add before its model "
            + "resembled the real image.",
        spec: spec({
            fill: 0.55,
            stops: [{
                shape: "circle", obstruction: 0.28,
                vanes: {
                    count: 4, rotationDeg: 45, width: 0.05, taper: 1.0,
                    // Measured: amplitude past ~0.4 fans the spike wide enough that it falls
                    // below the background between the spikes and vanishes entirely. 0.25 keeps
                    // a clear spike with a visible feather around it.
                    apodize: "sawtooth", apodAmplitude: 0.25, apodPeriod: 0.28,
                    edgeMode: "width", oppositePhase: false,
                },
            }, { enabled: false }],
        }),
    },
    {
        id: "chandelier",
        name: "Chandelier (housing window + iris)",
        note: "The two-stop model from the Metabunk analysis. Stop 1 is the housing window - "
            + "a circle with flat top and bottom - carrying a central obstruction and four "
            + "APODISED vanes at 45 degrees, which produce the diagonal arrows and feathers. "
            + "Stop 2 is a square iris nearer the sensor, adding the vertical and horizontal "
            + "spikes the vanes alone cannot explain. Their PSFs are summed, not intersected: "
            + "the two stops sit in different planes (see the Combine note).",
        spec: spec({
            n: 512, fill: 0.62, combine: "sumPSF",
            optics: { apertureM: 0.40, focalM: 3.0 },
            spectrum: { nm0: 350, nm1: 780, steps: 32, kind: "flat" },
            stops: [
                {
                    enabled: true, weight: 1,
                    shape: "truncatedCircle", flatTop: 0.86, flatSide: 1.0,
                    rotationDeg: 0, obstruction: 0.30,
                    vanes: {
                        count: 4, rotationDeg: 45, width: 0.045, taper: 1.15,
                        apodize: "sawtooth", apodAmplitude: 0.22, apodPeriod: 0.30,
                        apodPhase: 0, edgeMode: "width", oppositePhase: false,
                    },
                },
                {
                    enabled: true, weight: 1,
                    shape: "square", rotationDeg: 0, obstruction: 0,
                    vanes: NO_VANES,
                },
            ],
        }),
    },
];

export function presetById(id) {
    const p = PRESETS.find((x) => x.id === id);
    return p ? { ...p, spec: cloneSpec(p.spec) } : null;
}

// ── User presets ────────────────────────────────────────────────────────────────
// Saved in localStorage so an edited stop survives a reload. Kept deliberately separate
// from PRESETS: a built-in can never be overwritten, only used as the basis for a new one.

const LS_KEY = "sitrec.psf.userPresets.v1";

export function loadUserPresets() {
    try {
        const raw = localStorage.getItem(LS_KEY);
        const list = raw ? JSON.parse(raw) : [];
        return Array.isArray(list) ? list : [];
    } catch {
        return [];   // private window, cleared storage, or a corrupt entry - all recoverable
    }
}

export function saveUserPreset(name, spec) {
    const list = loadUserPresets().filter((p) => p.name !== name);
    list.push({ id: "user:" + name, name, note: "Saved preset.", spec: cloneSpec(spec) });
    try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch { /* storage disabled */ }
    return list;
}

export function deleteUserPreset(id) {
    const list = loadUserPresets().filter((p) => p.id !== id);
    try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch { /* storage disabled */ }
    return list;
}
