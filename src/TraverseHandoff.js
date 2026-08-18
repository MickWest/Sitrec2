/**
 * TraverseHandoff.js — send a traverse analysis's CONSISTENT candidates (and,
 * on request, its WEAK ones) to a new Sitrec window, as ordinary tracks.
 *
 * TWO CALLERS, ONE IMPLEMENTATION. The live gallery (AnalyzeTraverse) and the
 * bulk bench (analysis/BotBenchUI) run the same battery over the same results
 * shape, so the selection, the naming and the CSV assembly are identical and
 * live here. They differ in exactly three things, which are therefore the
 * parameters:
 *
 *   the frame        A live analysis works in the loaded sitch's true local
 *                    tangent frame, so ENU->ECEF->LLA is right and its
 *                    altitudes are height above the ELLIPSOID. A BOT scenario
 *                    defines Z as the altitude directly on a flat plane, so
 *                    the full 3-D conversion would subtract a curvature term
 *                    the format never put in, and its altitudes are MSL. Each
 *                    caller passes its own converter and says which datum it
 *                    produced. Getting this wrong is not subtle: measured on a
 *                    BOT scenario, the wrong conversion put candidates 40 m
 *                    from a truth track the analysis scored at 2.8 m.
 *   the destination  The bench opens a NEW custom sitch, because a BOT file
 *                    carries its own geography and the current window's scene
 *                    is irrelevant to it. The gallery opens the SAME sitch, so
 *                    the candidates land in the scene they were computed in.
 *   what else travels  The bench also sends the scenario CSV and its notes.
 *
 * This module cannot live in either caller: BotBenchRunner already imports from
 * AnalyzeTraverse, so anything AnalyzeTraverse imported back would be a cycle.
 */

import {putFileHandoff} from "./FileHandoff";
import {rankAllHypotheses} from "./TraverseRanking";
import {SWEEP_VARIANTS} from "./TraverseBattery";
import {clipFrameDate} from "./TraverseHypotheses";
import {showError} from "./showError";
import {botLOSToAzEl} from "./TrackFiles/CTrackFileBOT";

// The curve-fitting strategies swept over polynomial order. TraverseHypotheses
// documents these as a METHOD DIAGNOSTIC and not a ranking — "a higher-order
// curve can always hug the sightlines more closely simply because it bends
// more" — and their RANGE comes from the search anchor rather than from the
// data, so a scene showing one must say where it really got its distance.
const DIAGNOSTIC_FAMILY_KEYS = new Set(SWEEP_VARIANTS.map((v) => v.key));

// Marker sphere radius for the tracks a handoff imports, in metres.
//
// TrackManager's default is 40 m, which is right for the widely-spaced tracks a
// user normally drops — an airliner 30 km away needs a marker you can see. A
// traverse handoff is the opposite case: several candidate reconstructions of
// the SAME object, often metres apart, where 40 m spheres merge into one blob
// and hide the very disagreement they were sent to show.
//
// 1 m makes the marker roughly the size of the OBJECT rather than a symbol for
// it, so two candidates that disagree by 3 m read as two things 3 m apart. The
// cost is that a 1 m sphere is invisible at any ordinary field of view, which
// is why the handoff also sends a framing request — see lookCameraFraming.
export const HANDOFF_TRACK_RADIUS_M = 1;

/**
 * READABLE TRACK NAMES, SEPARATE FROM THE HYPOTHESIS KEYS.
 *
 * A candidate track used to be named straight from `h.key`, which produced
 * `w_plausible`, `w_saddle` and `w_gfpolyals` in the scene. Those are internal
 * identifiers, not labels: "plausible" reads as a VERDICT when the hypothesis
 * only claims to be the smoothest path, "saddle" is jargon from the shape of
 * the cost surface, and "gfpolyals" is not a word.
 *
 * THE KEYS CANNOT SIMPLY BE RENAMED. They are persisted identity — they appear
 * verbatim in the benchmark's exported records (benchmarks/botbench/results/
 * *.jsonl) and in the per-folder result cache, and code branches on them
 * (TraverseRanking's RAY_KEYS, the switches in AnalyzeTraverse). Renaming one
 * is a data-format change that breaks comparison against every stored result.
 * So the key stays the identity and this is the label; the two jobs were being
 * done by one string.
 *
 * NAMING THE DISPLAY NAME INSTEAD WOULD NOT WORK EITHER. A key is a FAMILY and
 * a display name is a MEMBER: the polynomial sweep runs one variant at five
 * orders, all sharing key `gfPolyALS` but each named "… (order 5)". The
 * one-track-per-family collapse keys on the family, so a per-member name would
 * either split the family into five near-identical tracks or label the family
 * with one arbitrary member's order.
 *
 * WIDTH IS A REAL CONSTRAINT, so these are checked rather than guessed. The
 * tightest place a track name appears is the camera/target dropdown in the
 * menus: a 240 px panel with 4 px padding and a 36% name column leaves about
 * 132 px of widget, and lil-gui renders it at 11 px. Measured in the browser,
 * the longest entry here (`w_minimum_acceleration`) comes to 125 px. Anything
 * much longer is silently clipped, which is worse than an abbreviation because
 * the reader cannot tell it happened.
 *
 * Unlisted keys fall back to the sanitized key, so a new hypothesis is merely
 * unlovely rather than broken — and handoffTrackSlugsAreUsable (tested) keeps
 * this table unique and inside the width.
 */
export const HANDOFF_TRACK_SLUGS = {
    constAir:      "constant_air_speed",
    constAlt:      "constant_altitude",
    plausible:     "minimum_acceleration",
    saddle:        "minimum_speed",
    aircraft:      "fixed_wing_aircraft",
    lantern:       "sky_lantern_balloon",
    quadcopter:    "quadcopter",
    droneControl:  "drone_flown_inputs",
    ground:        "ground_object",
    groundVehicle: "ground_vehicle",
    fixedPoint:    "stationary_point",
    satellite:     "satellite",
    // The curve-fitting sweep (SWEEP_VARIANTS). "Global Fit" is the battery's
    // own word for them; what a reader needs to know is that they are curves
    // fitted through the sightlines, which is why each says so.
    gfMC1:         "monte_carlo_fit_1",
    gfMC2:         "monte_carlo_fit_2",
    gfPolyALS:     "polynomial_curve_fit",
};

// The measured budget from the comment above: the dropdown widget at the menu's
// default width, less the select's own arrow and padding.
export const HANDOFF_TRACK_NAME_MAX_PX = 132;

// Fraction of the look view's WIDTH the closest marker should span.
//
// Small on purpose: the point is to see the candidates SEPARATED, not to fill
// the frame with one of them. At 3% a 1 m sphere is unmistakably visible while
// leaving room for the spread between candidates, which is the thing worth
// looking at.
export const HANDOFF_LOOK_WIDTH_FRACTION = 0.03;

/**
 * The CONSISTENT candidates, as importable CSV tracks.
 *
 * WHAT "CONSISTENT" MEANS HERE. The ranker's `eligible` flag, which is the same
 * quantity the executive verdict counts: passes the broad screen, no parameter
 * pinned against a search bound, no optimizer warning. `consistent-several`
 * means several of these; `consistent-one` means one. Ineligible candidates are
 * left out on purpose — a fit that ran to a bound is not a reading of the data,
 * and putting it in the scene beside the real ones would say it was.
 *
 * ONE TRACK PER TYPE, named c_<key> after the hypothesis — c_drone,
 * c_quadcopter, c_lantern. Where a family has several eligible members the
 * best-ranked one stands for it. That matters for exactly one family in
 * practice: the polynomial sweep enters five members, one per order, and they
 * differ only in how much the curve bends because their RANGE all comes from
 * the same anchor. Five near-identical tracks would fill the scene while
 * showing one interpretation, so the collapse is reported in `alsoRan` rather
 * than done silently.
 *
 * WEAK CANDIDATES, on request. With `includeWeak` a second band travels too,
 * named w_<key>: candidates that PASSED THE BROAD SCREEN (rank >= 1) but
 * failed the consistency screen — a parameter pinned at a search bound, an
 * incomplete optimizer run, or a fit tier below the screen. These are the
 * solutions the analysis found and then declined to endorse (the dash
 * scenario's bound-pinned solve is the motivating case), and the only way to
 * judge one is to look at it in the scene. Kinematically-extreme and invalid
 * candidates (rank < 1) stay out even here — those are not readings of the
 * data at any strength. The one-track-per-family rule spans both bands: the
 * ranking is best-first and every eligible candidate precedes every weak one,
 * so a family with a consistent member gets c_ and its weak members are
 * counted in that entry's `alsoRan`, never doubled as a w_ twin.
 *
 * WHY CUSTOM1 AND NOT THE BOT FORMAT. A BOT interchange row is a sensor
 * position plus a sightline; it describes an OBSERVATION. A candidate is a
 * reconstructed object path with no sightline of its own, so it belongs in an
 * ordinary track format. CUSTOM1 is the app's general lat/lon/alt CSV and needs
 * only time, latitude and longitude to be recognised.
 *
 * @param results  a traverse analysis result (either caller's — same shape)
 * @param toLLA    (x, y, z) => [latDeg, lonDeg, altM] in the caller's frame
 * @param altitudeIsHAE  true if toLLA returns height above the ellipsoid. The
 *                 column is named TPHAE when it does, which is the one header
 *                 ParseCustom1CSV reads as already-HAE so it skips the geoid
 *                 add; a plain ALTITUDE is read as mean sea level.
 * @param startMs  epoch of CLIP frame 0. The dataset may be an A-B window of
 *                 the clip (dataset.frame0 > 0); timestamps are built through
 *                 clipFrameDate, which applies that offset, so the handed-off
 *                 tracks land in the analyzed window rather than at the start
 *                 of the clip.
 * @param exclude  hypotheses to leave out — the gallery's "set aside" tiles,
 *                 which the reader has explicitly pushed out of consideration
 *                 and must not get back by another door.
 * @param includeWeak  also send the weak band, named w_<key> — see above.
 */
export function consistentTrackCSVs(results, {
    toLLA, altitudeIsHAE = false, startMs, exclude = null, includeWeak = false,
} = {}) {
    const dataset = results?.dataset;
    if (!dataset || typeof toLLA !== "function") return [];
    if (!(dataset.n > 0) || !(dataset.fps > 0) || !Number.isFinite(startMs)) return [];

    // Blind ranking, and the `false` must be explicit — rankAllHypotheses is
    // truth-AWARE unless told otherwise, and an omitted option is not a false
    // one. Truth must not decide which candidates a reader gets to look at.
    const ranked = rankAllHypotheses(results.hypotheses ?? [], {useTruth: false});

    const out = [];
    const byKey = new Map();   // family key -> its out entry (first seen = best)
    for (const {h, r} of ranked) {
        if (exclude?.has(h)) continue;
        const track = h?.track;
        if (!track || track.length < dataset.n * 3 || h.atInfinity) continue;

        // Band membership. Consistent = the ranker's eligible flag, as before.
        // Weak = passed the broad screen but failed eligibility; the reason is
        // kept because the notes must say WHY this track is not an endorsement.
        let prefix, weakReason = null;
        if (r?.eligible) {
            prefix = "c_";
        } else if (includeWeak && r && r.rank >= 1) {
            prefix = "w_";
            weakReason = r.boundaryLimited ? "pinned at a search bound"
                : r.optimizerWarnings?.length ? "optimizer incomplete"
                : `fit tier "${r.label}"`;
        } else {
            continue;
        }

        const key = String(h.key ?? "candidate").replace(/[^a-z0-9]+/gi, "_").toLowerCase();
        // The ranked list is best-first, so the first member of a key is the
        // one that stands for its family. Later members are counted, not kept
        // — across BOTH bands, so a family never fields a c_ and a w_ twin.
        const prev = byKey.get(key);
        if (prev) { prev.alsoRan++; continue; }

        // The FAMILY is keyed on `key` above and stays so; only the label
        // changes here — see HANDOFF_TRACK_SLUGS for why the two are separate.
        const name = prefix + (HANDOFF_TRACK_SLUGS[h.key] ?? key);
        let csv = `TIME,LAT,LONG,${altitudeIsHAE ? "TPHAE" : "ALTITUDE"},CALLSIGN\n`;
        for (let f = 0; f < dataset.n; f++) {
            const x = track[f * 3], y = track[f * 3 + 1], z = track[f * 3 + 2];
            const lla = toLLA(x, y, z);
            if (!lla) continue;
            // clipFrameDate, not a bare startMs + f/fps: the dataset can be an
            // A-B window and its frame0 offset must reach the timestamps.
            const iso = clipFrameDate(startMs, dataset, f).toISOString();
            csv += `${iso},${lla[0].toFixed(9)},${lla[1].toFixed(9)},`
                + `${lla[2].toFixed(3)},${name}\n`;
        }
        const entry = {
            name, text: csv, hypothesis: h.name, errDeg: h.errDeg, tier: r.label,
            weak: prefix === "w_", weakReason,
            // What decides how big a marker on this candidate looks — see
            // lookCameraFraming.
            closestRangeM: closestRangeToSensor(dataset, track),
            alsoRan: 0, rangeBlind: DIAGNOSTIC_FAMILY_KEYS.has(h.key),
        };
        byKey.set(key, entry);
        out.push(entry);
    }
    return out;
}

/**
 * The candidates for a handoff that gets ONE link rather than a choice:
 * the consistent band, or — when nothing passed the consistency screen — the
 * weak band in its place.
 *
 * WHY A FALLBACK EXISTS AT ALL. A scenario where nothing passed is the
 * "unresolved" verdict, and it is precisely the row a reader most wants to
 * open — yet it was the one that arrived carrying nothing but the scenario
 * track, because every candidate had been declined. In an empty scene
 * "nothing to show" and "nothing survived the screen" look identical, and
 * only one of them is true: the analysis did find solutions, it just would
 * not endorse them. The weak band is those solutions.
 *
 * WHY IT IS A FALLBACK AND NOT AN ADDITION. Sending the weak band alongside
 * consistent candidates would dilute the very distinction the c_ prefix
 * exists to draw — a bound-pinned solve standing in the scene beside an
 * endorsed one reads as its peer. With the consistent band empty there is no
 * endorsement left to dilute, and the w_ prefix plus candidateNotes' "WEAK
 * CANDIDATES IN THIS SCENE" section still say what these are.
 *
 * TWO PASSES, DELIBERATELY. Asking for both bands at once and filtering
 * afterwards would give the same tracks but different `alsoRan` counts — a
 * consistent entry would silently start counting the weak members of its
 * family among the peers it stands for. Running the consistent pass on its
 * own keeps the ordinary case bit-for-bit what it always was; the second pass
 * only ever runs when the first returned nothing.
 *
 * The live gallery deliberately does NOT use this: it offers Open Consistent
 * and Open Consistent+Weak as separate buttons, because a reader looking at
 * the tiles can see what they are asking for. This is for callers with one
 * link and no such context.
 *
 * @param results  a traverse analysis result
 * @param opts     as consistentTrackCSVs, minus includeWeak (this sets it)
 */
export function handoffCandidateCSVs(results, opts = {}) {
    const consistent = consistentTrackCSVs(results, {...opts, includeWeak: false});
    if (consistent.length) return consistent;
    return consistentTrackCSVs(results, {...opts, includeWeak: true});
}

// The sensor path AND the sightlines it recorded, as a MISB-column CSV.
//
// Written in MISB columns because that is the shape Sitrec already turns into a
// track plus an "Angles_<name>" heading source — CTrackFileMISB does it on
// import, so the receiving window needs no special case and the handoff needs
// no new file format.
//
// Platform heading/pitch/roll are all ZERO and the direction rides entirely in
// the sensor-relative pair. That is not a simplification, it is the convention
// botLOSToAzEl already returns and CNodeLOSTrackMISB already reads: with a
// level platform frame, azimuth IS the compass bearing and elevation IS the
// angle above the horizon. Splitting the same direction across a platform
// attitude and a gimbal offset would encode one fact twice.
//
// Returns null when the dataset cannot supply a direction, so the caller falls
// back to the plain position track rather than emitting a file with no pointing
// in pointing-shaped columns.
function buildSensorWithAngles(dataset, toLLA, altitudeIsHAE, startMs, originLat, originLon) {
    if (!dataset.D || dataset.D.length < dataset.n * 3) return null;
    if (!Number.isFinite(originLat) || !Number.isFinite(originLon)) return null;
    const origin = {latDeg: originLat * 180 / Math.PI, lonDeg: originLon * 180 / Math.PI};
    const altCol = altitudeIsHAE ? "SensorEllipsoidHeight" : "SensorTrueAltitude";
    let csv = `UnixTimeStamp,SensorLatitude,SensorLongitude,${altCol},`
        + `PlatformHeadingAngle,PlatformPitchAngle,PlatformRollAngle,`
        + `SensorRelativeAzimuthAngle,SensorRelativeElevationAngle,`
        + `SensorRelativeRollAngle,CALLSIGN\n`;
    let rows = 0;
    for (let f = 0; f < dataset.n; f++) {
        const b = f * 3;
        const lla = toLLA(dataset.S[b], dataset.S[b + 1], dataset.S[b + 2]);
        if (!lla) continue;
        const {az, el} = botLOSToAzEl(
            [dataset.D[b], dataset.D[b + 1], dataset.D[b + 2]], lla[0], lla[1], origin);
        if (!Number.isFinite(az) || !Number.isFinite(el)) continue;
        // Microseconds: parseMISB1CSV reads UnixTimeStamp verbatim and decides
        // the unit per value, and the KLV era it came from is microseconds.
        const us = Math.round(clipFrameDate(startMs, dataset, f).valueOf() * 1000);
        csv += `${us},${lla[0].toFixed(9)},${lla[1].toFixed(9)},${lla[2].toFixed(3)},`
            + `0,0,0,${az.toFixed(6)},${el.toFixed(6)},0,platform\n`;
        rows++;
    }
    return rows > 1 ? {name: "platform", text: csv} : null;
}

/**
 * The CONTEXT tracks: where the sensor was, and — where the analysis had one —
 * what the object actually did.
 *
 * WHY THE GALLERY NEEDS THESE AND THE BENCH DOES NOT. Candidates on their own
 * are unreadable: they are reconstructions of an object seen from somewhere,
 * and without the somewhere there is no way to tell a near-miss from a wild
 * one. The bench sends the scenario CSV, which already carries the sensor path
 * and the truth track, so adding them there would import each twice. The live
 * gallery has no such file — its sightlines come from the loaded scene, and
 * the new window only gets whatever the URL names, which for an imported track
 * is nothing. So they have to travel.
 *
 * Same CSV shape as a candidate, so nothing downstream needs to know the
 * difference.
 */
export function contextTrackCSVs(results, {toLLA, altitudeIsHAE = false, startMs} = {}) {
    const dataset = results?.dataset;
    if (!dataset || typeof toLLA !== "function" || !Number.isFinite(startMs)) return [];

    const build = (name, positions, valid = null) => {
        if (!positions || positions.length < dataset.n * 3) return null;
        let csv = `TIME,LAT,LONG,${altitudeIsHAE ? "TPHAE" : "ALTITUDE"},CALLSIGN\n`;
        let rows = 0;
        for (let f = 0; f < dataset.n; f++) {
            if (valid && !valid[f]) continue;      // truth may not cover the whole clip
            const lla = toLLA(positions[f * 3], positions[f * 3 + 1], positions[f * 3 + 2]);
            if (!lla) continue;
            // Same A-B window offset as the candidates — see consistentTrackCSVs.
            const iso = clipFrameDate(startMs, dataset, f).toISOString();
            csv += `${iso},${lla[0].toFixed(9)},${lla[1].toFixed(9)},`
                + `${lla[2].toFixed(3)},${name}\n`;
            rows++;
        }
        return rows > 1 ? {name, text: csv} : null;
    };

    // THE SENSOR TRAVELS WITH ITS POINTING, not just its path. A bare position
    // CSV gives the new window a camera track and nothing to aim it with: the
    // Camera Heading menu offers only Manual, because TrackManager creates an
    // "Angles_<name>" option from a file's OWN pointing and there was none in
    // the file. The reader then sees the candidates from a camera pointing
    // wherever the last sitch left it, which is the one view that cannot show
    // what the analysis did.
    //
    // Aiming at the truth track instead would be close but not right: the
    // sightlines are the sensor's RECORDED directions, and where the operator
    // drifted off the target those are not the same rays. Sending the angles
    // reproduces the analysis exactly; sending a target reproduces it only for
    // a perfect operator.
    const out = [];
    const platform = buildSensorWithAngles(dataset, toLLA, altitudeIsHAE, startMs,
        results.originLat, results.originLon) ?? build("platform", dataset.S);
    if (platform) out.push(platform);
    // Only when the analysis actually had a usable reference — an absent truth
    // track is the normal case on real data and must not produce an empty file.
    const truth = results.truth;
    if (truth?.usable && truth.track) {
        const t = build("truth", truth.track, truth.valid);
        if (t) out.push(t);
    }
    return out;
}

/**
 * The framing request that rides with a handoff: make the CLOSEST marker span
 * a fixed fraction of the look view's width.
 *
 * WHY IT IS NOT A FIELD OF VIEW. The angle depends on the receiving window's
 * ASPECT RATIO — a fraction of WIDTH is a horizontal quantity and a camera's
 * fov is vertical — and the sending window has no idea how the receiving one
 * is laid out. So this sends the physical facts (how big the marker is, how
 * close it comes) and the receiver does the trigonometry against its own
 * viewport. Computing a degree value here would bake in this window's aspect
 * and be wrong by however much the two differ.
 *
 * Returns null when no candidate reported a range, in which case the receiver
 * simply leaves the camera alone.
 */
export function lookCameraFraming(results, candidates = [], sphereRadiusM = HANDOFF_TRACK_RADIUS_M) {
    let closestRangeM = Infinity;
    const consider = (d) => {
        if (Number.isFinite(d) && d > 0 && d < closestRangeM) closestRangeM = d;
    };

    // RANGE-BLIND CANDIDATES DO NOT GET A VOTE.
    //
    // A curve fitted through the sightlines sits wherever the search anchor put
    // it, which the notes already say is not a measurement — and on a real file
    // that is not a small effect: measured on the dash scenario, the polynomial
    // sat at 500 m while truth was at 20 km, so letting it set the scale gave a
    // field of view forty times too narrow and made everything real invisible.
    // Framing the camera on a position we tell the reader to distrust would be
    // the same mistake in a different place.
    for (const c of candidates) if (!c.rangeBlind) consider(c.closestRangeM);

    // TRUTH COUNTS TOO, and on most files it is the only thing that does. An
    // `unresolved` verdict means NO candidate passed the screen — 8 of the 10
    // real-arm scenarios — so a framing drawn from candidates alone simply
    // never happened on exactly the files a reader most wants to open and look
    // at. The truth marker carries a radius like any other, so it can set the
    // scale.
    const truth = results?.truth;
    if (truth?.usable && truth.track) {
        consider(closestRangeToSensor(results.dataset, truth.track, truth.valid));
    }

    // The PLATFORM is deliberately not considered. Its marker sits on the
    // camera, so its range is zero and it would demand an infinite field of
    // view; it is the observer, not an observation.

    // Last resort. If the ONLY thing in the scene is range-blind, a framing
    // built on it still beats none at all — the reader gets something to look
    // at, and the notes already say what its distance is worth.
    if (!Number.isFinite(closestRangeM)) {
        for (const c of candidates) consider(c.closestRangeM);
    }
    if (!Number.isFinite(closestRangeM)) return null;
    return {sphereRadiusM, closestRangeM, widthFraction: HANDOFF_LOOK_WIDTH_FRACTION};
}

/**
 * Closest approach of a track to the sensor, which is what decides how big a
 * marker on it looks. Null when the two cannot be compared.
 */
export function closestRangeToSensor(dataset, track, valid = null) {
    const S = dataset?.S;
    if (!S || !track || !(dataset.n > 0)) return null;
    if (track.length < dataset.n * 3 || S.length < dataset.n * 3) return null;
    let best = Infinity;
    for (let f = 0; f < dataset.n; f++) {
        if (valid && !valid[f]) continue;
        const d = Math.hypot(track[f * 3] - S[f * 3],
            track[f * 3 + 1] - S[f * 3 + 1], track[f * 3 + 2] - S[f * 3 + 2]);
        if (d > 0 && d < best) best = d;
    }
    return Number.isFinite(best) ? best : null;
}

/** The candidate list as the lines that go in the sitch Notes. */
export function candidateNotes(candidates) {
    const line = (c) =>
        `  ${c.name}  ${c.hypothesis} — ${c.errDeg?.toFixed(3) ?? "?"}°, ${c.tier}`
        + (c.alsoRan ? `, standing for ${c.alsoRan + 1} members of its family` : "")
        + (c.weakReason ? `  [${c.weakReason}]` : "")
        + (c.rangeBlind ? "  [RANGE-BLIND]" : "")
        + "\n";

    const consistent = candidates.filter((c) => !c.weak);
    const weak = candidates.filter((c) => c.weak);

    let notes = "CONSISTENT CANDIDATES IN THIS SCENE\n";
    if (!consistent.length) {
        notes += "  None. No candidate passed the screen without a bound pin or an\n"
            + "  optimizer warning, which is what an \"unresolved\" verdict means.\n";
        if (!weak.length) return notes;
    } else {
        for (const c of consistent) notes += line(c);
    }
    if (weak.length) {
        notes += "WEAK CANDIDATES IN THIS SCENE (w_ prefix)\n";
        for (const c of weak) notes += line(c);
        notes += "A weak candidate passed the broad screen but failed the consistency\n"
            + "screen for the bracketed reason. It is the solution the analysis found\n"
            + "and declined to endorse — context to look at, not a finding.\n";
    }
    notes += "Each is a reconstructed object path, not an observation: a candidate\n"
        + "consistent with the sightlines, at the range its own model implies.\n";
    if (candidates.some((c) => c.rangeBlind)) {
        notes += "RANGE-BLIND marks a curve fitted through the sightlines. It has no\n"
            + "independent distance — its range comes from the search anchor — so\n"
            + "where it sits in this scene is not a measurement.\n";
    }
    return notes;
}

/**
 * Open a new Sitrec window holding these files.
 *
 * THE WINDOW IS CLAIMED SYNCHRONOUSLY, before anything is awaited. A browser
 * only honours window.open while the click's transient activation is live, and
 * that does not survive an await — so opening after the store write meant the
 * control silently did nothing. The placeholder is replaced once the handoff
 * key exists.
 *
 * @param buildFiles  async () => {files, meta} — the expensive part, run after
 *                    the window is claimed. It returns the meta as well as the
 *                    files because the notes describe the tracks, so they are
 *                    only known once the tracks have been built.
 * @param urlFor      (key) => string — the destination. The bench sends a fresh
 *                    custom sitch; the gallery sends the current one.
 */
export function openHandoffWindow({buildFiles, urlFor, onDone}) {
    const w = window.open("", "_blank");
    if (!w) {
        showError("The new Sitrec window was blocked by the browser's popup blocker. "
            + "Allow popups for this site and try again.");
        onDone?.();
        return;
    }
    w.document.open();
    w.document.write("<!doctype html><meta charset=\"utf-8\">"
        + "<title>Opening in Sitrec…</title>"
        + "<body style=\"font:14px system-ui;padding:24px;background:#12161c;color:#cfd8e3\">"
        + "Handing the tracks to a new Sitrec window…");

    (async () => {
        try {
            const {files, meta = {}} = await buildFiles();
            if (!files?.length) throw new Error("there is nothing to send");
            const key = await putFileHandoff(files, {
                trackObjectRadiusM: HANDOFF_TRACK_RADIUS_M, ...meta,
            });
            w.location.href = urlFor(key);
        } catch (e) {
            try { w.close(); } catch (_) { /* already gone */ }
            showError("Could not open a new window with these tracks: " + (e && e.message), e);
        } finally {
            onDone?.();
        }
    })();
}
