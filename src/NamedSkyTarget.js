import {Globals, NodeMan, Sit} from "./Globals";
import {getCelestialDirection, getStarDirectionECEF} from "./CelestialMath";
import {LLAToECEF} from "./LLA-ECEF-ENU";
import {bestSat, isBeforeLaunch, satRecToDate} from "./TLEUtils";
import {satelliteECEF} from "./SatelliteBrightness";

// Numeric identifiers also let chat recognize a satellite request before its
// catalog is loaded, so the API can explain what is missing.
export function satelliteTargetIdentifier(name) {
    const text = String(name ?? "").trim().replace(/^the\s+/i, "");
    if (/^(?:ISS(?:\s*\(ZARYA\))?|International Space Station)$/i.test(text)) return 25544;
    const number = /^(?:NORAD\s*#?\s*)?(\d+)$/i.exec(text);
    return number ? Number(number[1]) : text;
}

export function findLoadedSatellite(name) {
    // Simulated constellations have no real catalog identities.
    const catalog = NodeMan?.get("NightSkyNode", false)?.TLEData;
    if (!catalog) return null;
    const identifier = satelliteTargetIdentifier(name);
    if (!identifier) return null;
    return (typeof identifier === "number"
        ? catalog.getRecordFromNORAD(identifier)
        : catalog.getRecordFromName(identifier)) ?? null;
}

// Geometric direction shared by the camera API and the Celestial Lock menu.
// Refraction is applied by the caller, once, just as it is for the drawn sky.
export function getNamedSkyDirection(name, date, position) {
    const text = String(name ?? "").trim();
    if (!text) return null;
    const body = getCelestialDirection(text, date, position);
    if (body) return body;
    const sky = NodeMan?.get("NightSkyNode", false);
    const star = sky?.starField?.findStarByName(text);
    if (star) return getStarDirectionECEF(star.ra, star.dec, date);

    const satellite = findLoadedSatellite(text);
    if (!satellite?.satrecs?.length || isBeforeLaunch(satellite, +date)) return null;
    const satrec = bestSat(satellite.satrecs, date);
    // Match the renderer's limit on obsolete elements.
    if (Math.abs(+date - +satRecToDate(satrec)) > 90 * 86400000) return null;
    const target = satelliteECEF(satrec, date, Globals.equatorRadius, Globals.polarRadius);
    if (!target) return null;
    const observer = position ?? NodeMan?.get("lookCamera", false)?.camera?.position
        ?? LLAToECEF(Sit.lat, Sit.lon, 0);
    target.sub(observer);
    if (!Number.isFinite(target.lengthSq()) || target.lengthSq() < 1) return null;
    return target.normalize();
}
