// Satellite pass search for the traverse analyzer.
//
// Given the lines of sight and the sitch's date, ask: could a real LEO
// satellite (ISS, a Starlink, etc.) have been where the sensor was looking?
// We load the historical LEO catalogue for that date THROUGH THE SERVER
// (sitrecServer/proxyStarlink.php fetches from Space-Track with server-side
// credentials and caches the result permanently — slow the first time, instant
// after), propagate every satellite with SGP4, and find the one whose
// observer->satellite direction best tracks the sightlines.
//
// This is deliberately standalone (satellite.js only) so it works on any sitch,
// including ones with no night-sky node. See src/nodes/CSatellite.js for the
// interactive night-sky version of the same propagation.

import * as satellite from "satellite.js";
import {LLAToECEFRadians, ECEF2ENU_radii} from "./LLA-ECEF-ENU";
import {getGeocentricBodyPositionECEF} from "./CelestialMath";
import {SITREC_SERVER} from "./configUtils";

const DEG = 180 / Math.PI;
const EARTH_R = 6378137;   // m, mean equatorial radius (sunlit shadow test only)

// Propagate a satrec to a Date and return its ECEF position (metres) as a
// three.js Vector3, matching the frame of losNode.v(f).position — or null if
// SGP4 fails or the object is out of the LEO band. Pure (no scene state).
export function satelliteECEF(satrec, date) {
    const pv = satellite.propagate(satrec, date);
    if (!pv || !pv.position) return null;
    const gmst = satellite.gstime(date);
    const gd = satellite.eciToGeodetic(pv.position, gmst);
    const altM = gd.height * 1000;
    if (!(altM > 100000) || altM > 40000000) return null;   // reject decayed / junk
    return LLAToECEFRadians(gd.latitude, gd.longitude, altM);
}

// Parse a Space-Track "3le" catalogue (name / line1 / line2 triplets, the name
// line prefixed "0 ") into [{name, satrec}], dropping any that fail to parse.
function parse3LE(text) {
    const lines = text.split("\n");
    const out = [];
    for (let i = 0; i + 2 < lines.length; i++) {
        const l1 = lines[i + 1], l2 = lines[i + 2];
        if (!l1 || !l2 || l1[0] !== "1" || l2[0] !== "2") continue;
        let name = (lines[i] || "").trim();
        if (name.startsWith("0 ")) name = name.slice(2).trim();
        try {
            const satrec = satellite.twoline2satrec(l1, l2);
            if (satrec && !satrec.error) out.push({name: name || ("NORAD " + satrec.satnum), satrec});
        } catch (e) { /* skip malformed */ }
        i += 2;
    }
    return out;
}

/**
 * Fetch + parse the LEO satellite catalogue for a date through the server proxy.
 * Returns [{name, satrec}]. Throws on a network / server error so the caller can
 * report it. The proxy redirects to a cached .tle or .tle.zip; we detect the
 * ZIP magic and inflate it lazily.
 */
export async function loadLEOSatrecsForDate(date) {
    const dateStr = date.toISOString().slice(0, 10);
    const url = SITREC_SERVER + "proxyStarlink.php?request=" + dateStr + "&type=LEO";
    const resp = await fetch(url);
    if (!resp.ok) throw new Error("Satellite TLE fetch failed (HTTP " + resp.status + ")");
    const buf = await resp.arrayBuffer();
    const bytes = new Uint8Array(buf);
    // The proxy can also return a plain-text error body ("ERROR: ...") with 200.
    let text;
    if (bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b) {   // "PK" zip
        const {default: JSZip} = await import("jszip");
        const zip = await new JSZip().loadAsync(buf);
        const tleName = Object.keys(zip.files).find((n) => n.endsWith(".tle")) || Object.keys(zip.files)[0];
        text = await zip.files[tleName].async("string");
    } else {
        text = new TextDecoder().decode(buf);
    }
    if (/^\s*ERROR/i.test(text)) throw new Error(text.split("\n")[0].slice(0, 200));
    return parse3LE(text);
}

/**
 * Find the loaded satellite whose observer->satellite direction best matches the
 * sightlines. Coarse scan over `sampleCount` frames (SGP4 is cheap but we still
 * avoid every-frame × every-sat). frameDate(f) -> JS Date for frame f.
 * Returns {name, satrec, errDeg, satnum} of the best, or null if none.
 */
export function findBestSatellite(sats, losNode, frameDate, sampleCount = 12) {
    const n = losNode.frames;
    if (!n || !sats.length) return null;
    const NS = Math.min(n, Math.max(3, sampleCount));
    const samples = [];
    for (let k = 0; k < NS; k++) {
        const f = Math.round((n - 1) * k / (NS - 1));
        const los = losNode.v(f);
        samples.push({
            pos: los.position.clone(),
            hd: los.heading.clone().normalize(),
            date: frameDate(f),
        });
    }
    let best = null;
    for (const {name, satrec} of sats) {
        let sum = 0, ok = true;
        for (const s of samples) {
            const sat = satelliteECEF(satrec, s.date);
            if (!sat) { ok = false; break; }
            const dir = sat.sub(s.pos).normalize();
            let dot = dir.dot(s.hd);
            dot = dot > 1 ? 1 : dot < -1 ? -1 : dot;
            sum += Math.acos(dot);
        }
        if (!ok) continue;
        const errDeg = (sum / samples.length) * DEG;
        if (!best || errDeg < best.errDeg) best = {name, satrec, errDeg, satnum: satrec.satnum};
    }
    return best;
}

// Full-clip ENU track (Float64Array n*3, dataset frame) for a satrec, so it can
// ride the gallery plan view like any other hypothesis. Frames where SGP4 fails
// hold the previous position.
export function satelliteTrackENU(satrec, n, frameDate, originLat, originLon) {
    const track = new Float64Array(n * 3);
    let last = null;
    for (let f = 0; f < n; f++) {
        const ecef = satelliteECEF(satrec, frameDate(f));
        const enu = ecef ? ECEF2ENU_radii(ecef, originLat, originLon) : last;
        if (enu) {
            track[f * 3] = enu.x; track[f * 3 + 1] = enu.y; track[f * 3 + 2] = enu.z;
            last = enu;
        } else if (f > 0) {
            track[f * 3] = track[(f - 1) * 3];
            track[f * 3 + 1] = track[(f - 1) * 3 + 1];
            track[f * 3 + 2] = track[(f - 1) * 3 + 2];
        }
    }
    return track;
}

// Is the satellite sunlit at this date? (A visible pass needs the sat in
// sunlight while the observer is in darkness; we report the sat-sunlit half —
// the analyst supplies the observer-darkness context.) Cylindrical-shadow test:
// in shadow iff behind Earth along the sun line AND within Earth's radius of it.
export function satelliteSunlit(satEcef, date) {
    const sun = getGeocentricBodyPositionECEF("Sun", date);
    if (!sun || !satEcef) return null;
    const toSun = sun.clone().normalize();
    const behind = satEcef.dot(toSun) < 0;
    const along = toSun.clone().multiplyScalar(satEcef.dot(toSun));
    const perp = satEcef.clone().sub(along).length();
    return !(behind && perp < EARTH_R);
}
