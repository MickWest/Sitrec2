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
const COLOR_TRAFFIC = 0xff9e2c;    // amber — road incidents

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
        labels: true,
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
        labels: true,
        label: 'Marine Traffic (AIS)',
        tooltip: 'Live ship positions worldwide, streamed from aisstream.io.\n'
            + 'Needs your own free AISStream key — Settings, API Keys.\n'
            + 'Data: aisstream.io',
        attribution: 'aisstream.io',
        coverage: 'Worldwide (needs a key)',
        // The stream pushes; this is only how often the markers are rebuilt from
        // whatever has arrived.
        pollMs: 5000,
        color: COLOR_SHIP,
        shape: 'box',
        keyProvider: 'aisstream',
        transport: 'websocket',
        needsLocation: true,

        /**
         * AISStream wants a bounding box, not a centre and radius, and it wants
         * the first subscription within 3 seconds of the socket opening.
         *
         * The box is clamped: latitude to the poles, and a maximum span so that a
         * fully zoomed-out camera does not subscribe to the entire ocean traffic
         * of the planet and drown the browser in messages.
         */
        buildSocket(key, center) {
            const span = 5;   // degrees each way — a few hundred km
            const minLat = Math.max(-90, center.lat - span);
            const maxLat = Math.min(90, center.lat + span);
            const minLon = center.lon - span;
            const maxLon = center.lon + span;
            return {
                url: 'wss://stream.aisstream.io/v0/stream',
                subscribe: {
                    APIKey: key,
                    BoundingBoxes: [[[minLat, minLon], [maxLat, maxLon]]],
                    FilterMessageTypes: ['PositionReport'],
                },
            };
        },

        /**
         * One websocket message into a marker, or null to ignore it.
         *
         * MetaData carries the normalised position and is preferred; the raw
         * PositionReport is the fallback. Returning a marker keyed by MMSI lets
         * the layer replace a vessel's previous position rather than accumulate
         * one marker per report — a ship transmits every few seconds, so
         * appending would grow without bound.
         */
        onMessage(msg) {
            if (msg?.MessageType !== 'PositionReport') return null;
            const meta = msg.MetaData || {};
            const report = msg.Message?.PositionReport || {};
            const lat = num(meta.Latitude ?? report.Latitude);
            const lon = num(meta.Longitude ?? report.Longitude);
            if (lat === null || lon === null) return null;
            const mmsi = meta.MMSI ?? report.UserID;
            const sog = num(report.Sog);
            const cog = num(report.Cog);
            return {
                id: 'mmsi' + mmsi,
                lat,
                lon,
                altitudeM: null,
                altitudeIsHAE: false,
                label: (meta.ShipName || '').trim() || ('MMSI ' + mmsi),
                detail: [
                    sog !== null ? `${sog.toFixed(1)} kt` : null,
                    cog !== null ? `course ${Math.round(cog)}\u00b0` : null,
                ].filter(Boolean).join(' \u00b7 '),
                // 360 and 511 are the AIS "not available" sentinels for course;
                // drawn literally they would point every unknown ship due north.
                headingDeg: (cog !== null && cog < 360) ? cog : null,
            };
        },
    },

    {
        id: 'webcams',
        labels: true,
        label: 'Webcams',
        tooltip: 'Live webcams near where you are looking, worldwide.\n'
            + 'Needs your own free Windy key — Settings, API Keys.\n'
            + 'Click a camera to open its current image.\nData: Windy.com',
        attribution: 'Windy.com',
        coverage: 'Worldwide (needs a key)',
        pollMs: 300000,
        color: COLOR_WEBCAM,
        shape: 'octahedron',
        keyProvider: 'windy',
        transport: 'rest',
        needsLocation: true,

        // Windy authenticates with a header rather than a query parameter, which
        // is why its CORS preflight has to allow x-windy-api-key — it does.
        buildRequest(key, center) {
            const params = new URLSearchParams({
                nearby: `${center.lat.toFixed(3)},${center.lon.toFixed(3)},250`,
                limit: '50',
                include: 'location,images',
            });
            return {
                url: 'https://api.windy.com/webcams/api/v3/webcams?' + params.toString(),
                headers: {'x-windy-api-key': key},
            };
        },

        parse(json) {
            const out = [];
            for (const w of (Array.isArray(json?.webcams) ? json.webcams : [])) {
                const lat = num(w?.location?.latitude);
                const lon = num(w?.location?.longitude);
                if (lat === null || lon === null) continue;
                out.push({
                    id: 'windy' + w.webcamId,
                    lat,
                    lon,
                    altitudeM: null,
                    altitudeIsHAE: false,
                    label: w.title || w.location?.city || 'webcam',
                    detail: [w.location?.city, w.location?.country].filter(Boolean).join(', ')
                        || 'Click to open the current image',
                    imageURL: w.images?.current?.preview || w.images?.daylight?.preview || null,
                });
            }
            return out;
        },
    },

    {
        id: 'traffic',
        labels: false,
        label: 'Road Traffic Incidents',
        tooltip: 'Live jams, closures and roadworks near where you are looking, worldwide.\n'
            + 'Needs your own free TomTom key — Settings, API Keys.\nData: TomTom',
        attribution: 'TomTom',
        coverage: 'Worldwide (needs a key)',
        pollMs: 120000,
        color: COLOR_TRAFFIC,
        shape: 'cone',
        keyProvider: 'tomtom',
        transport: 'rest',
        needsLocation: true,

        buildRequest(key, center) {
            // TomTom takes a bounding box as minLon,minLat,maxLon,maxLat — the
            // opposite order from the lat-first pairs used everywhere else here.
            const span = 0.5;
            const bbox = [
                (center.lon - span).toFixed(4), (center.lat - span).toFixed(4),
                (center.lon + span).toFixed(4), (center.lat + span).toFixed(4),
            ].join(',');
            const params = new URLSearchParams({
                key,
                bbox,
                fields: '{incidents{type,geometry{type,coordinates},properties{iconCategory,events{description}}}}',
                language: 'en-GB',
            });
            return {
                url: 'https://api.tomtom.com/traffic/services/5/incidentDetails?' + params.toString(),
                headers: {},
            };
        },

        parse(json) {
            const out = [];
            for (const inc of (Array.isArray(json?.incidents) ? json.incidents : [])) {
                const g = inc?.geometry;
                if (!g) continue;
                // An incident is a Point for a spot event and a LineString for a
                // stretch of road; the first vertex locates both well enough for a
                // marker, and drawing the whole line is not what this layer is for.
                const c = g.type === 'Point' ? g.coordinates
                    : (Array.isArray(g.coordinates) ? g.coordinates[0] : null);
                if (!Array.isArray(c) || c.length < 2) continue;
                const lon = num(c[0]);
                const lat = num(c[1]);
                if (lat === null || lon === null) continue;
                const events = inc.properties?.events || [];
                out.push({
                    id: 'inc' + (inc.id ?? `${lat},${lon}`),
                    lat,
                    lon,
                    altitudeM: null,
                    altitudeIsHAE: false,
                    label: events[0]?.description || 'incident',
                    detail: events.slice(1).map(e => e.description).filter(Boolean).join(' \u00b7 ')
                        || (inc.properties?.iconCategory !== undefined
                            ? `category ${inc.properties.iconCategory}` : ''),
                });
            }
            return out;
        },
    },

    {
        id: 'balloons',
        labels: true,
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
        labels: true,
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
        labels: true,
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
