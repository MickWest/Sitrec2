// exportKml.js — round-2 sitch bridge: emit a generated BotScenario as a KML
// file with two gx:Track placemarks (sensor platform + target truth), loadable
// straight into a Sitrec custom sitch via drag/drop or DragDropHandler.uploadURL.
//
// ENU -> LLA via the proper ECEF basis at the site origin (not flat-earth
// degrees-per-metre). Altitudes are written as absolute metres above the
// ellipsoid-ish datum the site ground defines; for the flat-proxy sites
// (ground 0 m) KML <gx:coord> altitude equals the scenario's z. Timestamps
// start at the scenario epoch so track timing is real.

import {Vector3} from "three";
import {LLAToECEF, ECEFToLLAVD_radii} from "../../../src/LLA-ECEF-ENU";
import {enuBasisAt} from "../../../src/TrackExportMath";

function enuToLLA(site, x, y, z) {
    const o = LLAToECEF(site.latDeg, site.lonDeg, site.groundElevationMSL);
    const {east, north, up} = enuBasisAt(site.latDeg, site.lonDeg);
    const p = new Vector3(
        o.x + east.x * x + north.x * y + up.x * z,
        o.y + east.y * x + north.y * y + up.y * z,
        o.z + east.z * x + north.z * y + up.z * z,
    );
    const lla = ECEFToLLAVD_radii(p);   // Vector3: x=lat deg, y=lon deg, z=alt m
    return [lla.x, lla.y, lla.z];
}

function gxTrack(name, site, positionENU, times, epochMs) {
    const n = times.length;
    const whens = [];
    const coords = [];
    for (let f = 0; f < n; f++) {
        const [lat, lon, alt] = enuToLLA(site,
            positionENU[f * 3], positionENU[f * 3 + 1], positionENU[f * 3 + 2]);
        whens.push(`<when>${new Date(epochMs + times[f] * 1000).toISOString()}</when>`);
        coords.push(`<gx:coord>${lon.toFixed(8)} ${lat.toFixed(8)} ${alt.toFixed(2)}</gx:coord>`);
    }
    return `<Placemark><name>${name}</name><gx:Track>
<altitudeMode>absolute</altitudeMode>
${whens.join("\n")}
${coords.join("\n")}
</gx:Track></Placemark>`;
}

function kmlDoc(name, trackXml) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
<Document>
<name>${name}</name>
${trackXml}
</Document>
</kml>
`;
}

// Returns SEPARATE KML texts for the platform and target tracks. One file per
// track: Sitrec's KML tree-walk treats sibling placemarks in one Document as
// SEGMENTS of a single flight and concatenates them (verified live — a
// two-placemark file imported as one 1,202-point track). Direction-kind truth
// (venus) has no finite track and is rejected — use a PTZ/celestial setup.
export function scenarioToKMLPair(scenario, {label = scenario.scenarioId} = {}) {
    if (scenario.target.kind !== "track") {
        throw new Error("botbench: scenarioToKMLPair needs a finite-track target");
    }
    const site = scenario.site;
    const epochMs = Date.parse(site.epochISO);
    return {
        platformKml: kmlDoc(`${label}-platform`, gxTrack(`${label}-platform`, site,
            scenario.platform.positionENU, scenario.times, epochMs)),
        targetKml: kmlDoc(`${label}-target`, gxTrack(`${label}-target`, site,
            scenario.target.positionENU, scenario.times, epochMs)),
    };
}
