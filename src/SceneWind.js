// SceneWind.js — the wind of the scene at a point, for generated tracks that
// drift or fly in it (the balloon and kite tracks).
//
// The wind nodes cannot be graph inputs of those tracks: targetWind's frame of
// reference can itself follow the target track, which would make a cycle (the
// same reason CNodeWind reads its originTrack outside the graph). So the tracks
// sample the wind here, and poll sceneWindFingerprint() to see it change.

import {NodeMan} from "./Globals";
import {metersPerSecondFromKnots, radians} from "./utils";

// Wind (u = east, v = north, m/s) at a position/altitude. Altitude-aware
// wind field first (sounding/GFS profiles), constant targetWind fallback.
export function sampleSceneWind(lat, lon, altMSL, f) {
    const wf = NodeMan.get("windField", false);
    if (wf && typeof wf.sampleWindAtAltitude === "function") {
        try {
            const s = wf.sampleWindAtAltitude(lat, lon, altMSL, f);
            if (s && Number.isFinite(s.u) && Number.isFinite(s.v)) {
                return s;
            }
        } catch (e) {
            // no usable profile data at this point — fall through
        }
    }
    const tw = NodeMan.get("targetWind", false);
    if (tw) {
        const hist = (typeof tw.trackWindAt === "function" && !tw.override) ? tw.trackWindAt(f) : null;
        const from = hist ? hist.from : tw.from;
        const knots = hist ? hist.knots : tw.knots;
        if (Number.isFinite(from) && Number.isFinite(knots)) {
            // meteorological FROM heading → blow-TO vector (same convention
            // as CNodeWind.getValueFrame)
            const speed = metersPerSecondFromKnots(knots);
            const toRad = radians(from + 180);
            return {u: Math.sin(toRad) * speed, v: Math.cos(toRad) * speed};
        }
    }
    return {u: 0, v: 0};
}

// Cheap change detection for the wind sources a track can't have as inputs.
// For a TRACK-DRIVEN targetWind, from/knots mirror the playhead's wind
// every rendered frame (CNodeWind.update) — but a bake already samples
// the historical wind per frame through trackWindAt(f), so only the
// identity of the driving track matters there; fingerprinting the live
// values would rebake the track every single frame.
export function sceneWindFingerprint() {
    const wf = NodeMan.get("windField", false);
    const tw = NodeMan.get("targetWind", false);
    // A Target Wind that reads a source shows the playhead's value in
    // From and Knots, so those must not be in the fingerprint (every
    // frame would rebake); windCacheKey names the source and its data.
    const twPart = !tw ? ""
        : typeof tw.windCacheKey === "function" ? tw.windCacheKey()
        : (tw.trackSource ? `track:${tw.trackSource}` : `${tw.from}|${tw.knots}`);
    // _windDataVersion/_lastDateCycle capture ASYNC wind-grid arrival
    // (GFS levels re-fetch after a sitch reload) — without them, a
    // reloaded track would stay baked against the constant-wind
    // fallback forever once the deferred fetch completes.
    //
    // sondeProfileSignature() does the same for SOUNDING sources: UWYO/IGRA2
    // soundings load asynchronously as tracks after a reload, and their
    // arrival changes NONE of the fields above — so without this a saved
    // track that baked before the soundings arrived would stay pinned to
    // the constant-wind fallback (its memoized bake never re-runs because the
    // fingerprint, hence the bake key, is unchanged).
    const profSig = (wf && typeof wf.sondeProfileSignature === "function")
        ? wf.sondeProfileSignature() : "";
    return `${wf?.source ?? ""}|${wf?.windAltFt ?? ""}`
        + `|${wf?._windDataVersion ?? ""}|${wf?._lastDateCycle ?? ""}|${twPart}|${profSig}`;
}
