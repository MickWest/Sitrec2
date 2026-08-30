/**
 * LiveFeedRegistry — every keyless live data feed Sitrec can overlay, as one table.
 *
 * Adding a feed is an entry here plus a row in sitrecServer/proxyLiveFeed.php.
 * Nothing else changes: the menu, the marker layer, the status readout and the
 * attribution are all driven from this table. That is the same shape as
 * BYOKProviders — one place describes a provider, so the next one is a table
 * entry rather than a new subsystem.
 *
 * WHY EVERY FEED GOES THROUGH THE PROXY. None of these upstreams can be read
 * from a browser: some send no CORS headers at all, Digitraffic requires request
 * headers a browser will not let a page set, and adsb.lol answers 403 to a
 * request with no User-Agent. The proxy also holds the cache and the rate limit,
 * so a hundred Sitrec tabs are one upstream fetch rather than a hundred.
 *
 * LICENCES. Every feed here is fetched live and NEVER bundled — the attribution
 * string below is shown in the UI, and is the thing that makes that legitimate.
 * Two deliberate exclusions, both from the God's Eye View review:
 *   - OpenSky: non-commercial, and REST use in production needs their agreement.
 *   - TeleGeography cables: CC BY-NC-SA, which is copyleft data and against
 *     Sitrec's data-licensing policy.
 *
 * Each parse() returns a flat array of markers:
 *   {id, lat, lon, altitudeM|null, altitudeIsHAE, label, detail, color?, url?, imageURL?}
 * altitudeM null means "put it on the terrain" — used for anything at ground or
 * sea level, where a hardcoded 0 would be wrong nearly everywhere.
 */

import {normalizeAircraft} from "../ADSBLiveFetch";

// Marker colours. Chosen to stay distinct from the ADS-B altitude ramp (reds
// through violet), so a screen with several layers on does not read as one
// undifferentiated confetti.
const COLOR_MIL = 0xff4fd8;        // magenta — military aircraft
const COLOR_SHIP = 0x2ee6c0;       // teal — vessels
const COLOR_WEBCAM = 0xffffff;     // white — cameras
const COLOR_BALLOON = 0xffe86b;    // pale yellow — radiosondes
const COLOR_LAUNCH = 0xff7a3d;     // orange — launch sites
const COLOR_QUAKE = 0xff3b3b;      // red — earthquakes

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/**
 * Pull [lon, lat, alt?] out of a GeoJSON Point feature.
 *
 * GeoJSON is longitude-FIRST, which is the reverse of how every latitude/longitude
 * pair elsewhere in Sitrec is written. Getting it backwards does not throw — it
 * silently puts European shipping in the Indian Ocean — so the swap happens here,
 * once, rather than at each call site.
 */
function geoJSONPoint(feature) {
    const c = feature?.geometry?.coordinates;
    if (!Array.isArray(c) || c.length < 2) return null;
    const lon = num(c[0]);
    const lat = num(c[1]);
    if (lat === null || lon === null) return null;
    return {lat, lon, alt: c.length > 2 ? num(c[2]) : null};
}

export const LIVE_FEEDS = [
    {
        id: 'mil',
        label: 'Military Aircraft',
        tooltip: 'Aircraft adsb.lol flags as military or government, worldwide.\n'
            + 'Shown wherever they are, not only near you.\nData: adsb.lol (ODbL)',
        attribution: 'adsb.lol (ODbL)',
        coverage: 'Worldwide',
        pollMs: 10000,
        color: COLOR_MIL,
        shape: 'dart',
        // The military endpoint returns the same v2 aircraft records as the civil
        // area query, so the normaliser is shared rather than reimplemented —
        // including its geometric-vs-barometric altitude handling, which is the
        // part that is easy to get subtly wrong.
        parse(json) {
            const out = [];
            for (const raw of (Array.isArray(json?.ac) ? json.ac : [])) {
                const a = normalizeAircraft(raw);
                if (!a) continue;
                out.push({
                    id: a.hex,
                    lat: a.lat,
                    lon: a.lon,
                    altitudeM: a.altitudeM,
                    altitudeIsHAE: a.altitudeIsHAE,
                    label: a.callsign || a.registration || a.hex.toUpperCase(),
                    detail: [a.typeCode, a.registration,
                        a.altitudeM !== null ? `${Math.round(a.altitudeM / 0.3048)} ft` : null,
                        a.groundSpeedKt !== null ? `${Math.round(a.groundSpeedKt)} kt` : null,
                    ].filter(Boolean).join(' · '),
                    hex: a.hex,
                });
            }
            return out;
        },
    },

    {
        id: 'ships',
        label: 'Marine Traffic (AIS)',
        tooltip: 'Live vessel positions from AIS.\n'
            + 'COVERAGE IS THE BALTIC ONLY — it is the one live AIS stream that needs\n'
            + 'no key and no data-sharing agreement.\nData: Fintraffic / Digitraffic (CC BY 4.0)',
        attribution: 'Fintraffic Digitraffic (CC BY 4.0)',
        coverage: 'Baltic Sea',
        pollMs: 20000,
        color: COLOR_SHIP,
        shape: 'box',
        parse(json) {
            const out = [];
            for (const f of (Array.isArray(json?.features) ? json.features : [])) {
                const p = geoJSONPoint(f);
                if (!p) continue;
                const props = f.properties || {};
                const sog = num(props.sog);
                const cog = num(props.cog);
                out.push({
                    id: 'mmsi' + (props.mmsi ?? f.id),
                    lat: p.lat,
                    lon: p.lon,
                    // At sea level. Left null rather than 0 so the layer puts the
                    // marker on the terrain/sea surface, which is not the same as
                    // the ellipsoid.
                    altitudeM: null,
                    altitudeIsHAE: false,
                    label: 'MMSI ' + (props.mmsi ?? '?'),
                    detail: [
                        sog !== null ? `${sog.toFixed(1)} kt` : null,
                        cog !== null ? `course ${Math.round(cog)}°` : null,
                    ].filter(Boolean).join(' · '),
                    // Course over ground, so the marker can point where it is going.
                    headingDeg: cog,
                });
            }
            return out;
        },
    },

    {
        id: 'webcams',
        label: 'Webcams',
        tooltip: 'Roadside cameras, with a live image on click.\n'
            + 'COVERAGE IS FINLAND ONLY — global webcam APIs all require a key.\n'
            + 'Data: Fintraffic / Digitraffic (CC BY 4.0)',
        attribution: 'Fintraffic Digitraffic (CC BY 4.0)',
        coverage: 'Finland',
        // The station LIST barely changes; the images it points at are what
        // update, and those are fetched on click.
        pollMs: 900000,
        color: COLOR_WEBCAM,
        shape: 'octahedron',
        parse(json) {
            const out = [];
            for (const f of (Array.isArray(json?.features) ? json.features : [])) {
                const p = geoJSONPoint(f);
                if (!p) continue;
                const props = f.properties || {};
                // Only cameras actually collecting have a current image; a marker
                // for a decommissioned camera is a click that leads nowhere.
                if (props.collectionStatus && props.collectionStatus !== 'GATHERING') continue;
                const preset = (props.presets || []).find(x => x.inCollection) || (props.presets || [])[0];
                if (!preset) continue;
                out.push({
                    id: 'cam' + (props.id ?? f.id),
                    lat: p.lat,
                    lon: p.lon,
                    altitudeM: null,
                    altitudeIsHAE: false,
                    label: props.name || props.id || 'camera',
                    detail: 'Click to open the current image',
                    // Digitraffic serves the latest frame for a preset at a stable
                    // URL, so no second API call is needed to show a picture.
                    imageURL: `https://weathercam.digitraffic.fi/${preset.id}.jpg`,
                });
            }
            return out;
        },
    },

    {
        id: 'balloons',
        label: 'Weather Balloons',
        tooltip: 'Radiosondes currently aloft, worldwide, from the SondeHub network.\n'
            + 'A balloon aloft is one of the standard mundane explanations, so this\n'
            + 'answers "was there actually one up there?".\nData: SondeHub',
        attribution: 'SondeHub',
        coverage: 'Worldwide',
        pollMs: 60000,
        color: COLOR_BALLOON,
        shape: 'sphere',
        /**
         * SondeHub returns {serial: {isoTimestamp: telemetry, ...}, ...} — a map of
         * maps, not a list. Only the LATEST frame per sonde is wanted: the hour of
         * history in between would draw a smear of stale positions along each
         * balloon's path and count each one many times over.
         */
        parse(json) {
            const out = [];
            if (!json || typeof json !== 'object') return out;
            for (const [serial, frames] of Object.entries(json)) {
                if (!frames || typeof frames !== 'object') continue;
                const times = Object.keys(frames).sort();
                const latest = frames[times[times.length - 1]];
                if (!latest) continue;
                const lat = num(latest.lat);
                const lon = num(latest.lon);
                if (lat === null || lon === null) continue;
                const alt = num(latest.alt);
                out.push({
                    id: 'sonde' + serial,
                    lat,
                    lon,
                    altitudeM: alt,
                    // Radiosonde altitude is straight off the sonde's GPS, so it is
                    // height above the ellipsoid, not MSL.
                    altitudeIsHAE: true,
                    label: latest.type ? `${latest.type} ${serial}` : serial,
                    detail: [
                        alt !== null ? `${Math.round(alt)} m (${Math.round(alt / 0.3048)} ft)` : null,
                        latest.manufacturer,
                        num(latest.vel_v) !== null
                            ? (latest.vel_v >= 0 ? `climbing ${latest.vel_v.toFixed(1)} m/s`
                                                 : `descending ${Math.abs(latest.vel_v).toFixed(1)} m/s`)
                            : null,
                    ].filter(Boolean).join(' · '),
                });
            }
            return out;
        },
    },

    {
        id: 'launches',
        label: 'Rocket Launches',
        tooltip: 'Recent and upcoming orbital launches, at their launch pads.\n'
            + '"Was there a launch near this time?" is a recurring mundane explanation.\n'
            + 'Data: Launch Library 2 (The Space Devs)',
        attribution: 'Launch Library 2 (The Space Devs)',
        coverage: 'Worldwide',
        pollMs: 1800000,
        color: COLOR_LAUNCH,
        shape: 'cone',
        parse(json) {
            const out = [];
            for (const r of (Array.isArray(json?.results) ? json.results : [])) {
                const lat = num(r?.pad?.latitude);
                const lon = num(r?.pad?.longitude);
                if (lat === null || lon === null) continue;
                const when = r.net ? new Date(r.net) : null;
                out.push({
                    id: 'launch' + (r.id ?? r.name),
                    lat,
                    lon,
                    altitudeM: null,
                    altitudeIsHAE: false,
                    label: r.name || 'launch',
                    detail: [
                        when ? when.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : null,
                        r.status?.abbrev,
                        r.pad?.name,
                    ].filter(Boolean).join(' · '),
                    url: r.url || null,
                    // The pad, not the rocket: this marks WHERE a launch happened or
                    // will happen, and the time is in the detail line. Drawing a
                    // trajectory would be inventing one.
                });
            }
            return out;
        },
    },

    {
        id: 'quakes',
        label: 'Earthquakes',
        tooltip: 'Magnitude 2.5+ earthquakes in the last 24 hours.\n'
            + 'Data: USGS (public domain)',
        attribution: 'USGS',
        coverage: 'Worldwide',
        pollMs: 300000,
        color: COLOR_QUAKE,
        shape: 'octahedron',
        parse(json) {
            const out = [];
            for (const f of (Array.isArray(json?.features) ? json.features : [])) {
                const p = geoJSONPoint(f);
                if (!p) continue;
                const props = f.properties || {};
                const mag = num(props.mag);
                out.push({
                    id: 'quake' + (f.id ?? props.code),
                    lat: p.lat,
                    lon: p.lon,
                    // Drawn at the EPICENTRE, on the surface — not at the
                    // hypocentre. USGS's third coordinate is depth in kilometres
                    // (positive down), and honouring it literally buries the marker:
                    // the first sample was a South Sandwich quake 136 km down, which
                    // is inside the Earth and invisible from any viewpoint outside
                    // it. Every earthquake map shows the epicentre for this reason,
                    // and the depth is carried in the detail line instead, where it
                    // can actually be read.
                    altitudeM: null,
                    altitudeIsHAE: false,
                    label: `M${mag !== null ? mag.toFixed(1) : '?'}`,
                    detail: [
                        props.place,
                        p.alt !== null ? `${Math.round(p.alt)} km deep` : null,
                        props.time ? new Date(props.time).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : null,
                    ].filter(Boolean).join(' · '),
                    url: props.url || null,
                    // Bigger quakes get bigger markers; magnitude is logarithmic, so
                    // a linear size ramp on it is already a strong visual signal.
                    sizeScale: mag !== null ? Math.max(0.6, Math.min(3, mag / 3)) : 1,
                });
            }
            return out;
        },
    },
];

export function getLiveFeed(id) {
    return LIVE_FEEDS.find(f => f.id === id) || null;
}
