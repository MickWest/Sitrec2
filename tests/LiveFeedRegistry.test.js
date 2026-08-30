// Tests for the live-feed parsers. These are pure functions over real upstream
// response shapes, and they are where the silent errors live: a swapped
// coordinate pair or a misread altitude field puts a marker in the wrong place
// without throwing anything.

import {LIVE_FEEDS, getLiveFeed} from '../src/livefeeds/LiveFeedRegistry';

const feed = (id) => getLiveFeed(id);

describe('registry shape', () => {
    it('gives every feed the fields the menu and layer read', () => {
        for (const f of LIVE_FEEDS) {
            expect(typeof f.id).toBe('string');
            expect(typeof f.label).toBe('string');
            // A websocket feed handles messages instead of parsing a response body.
            if (f.transport === 'websocket') {
                expect(typeof f.onMessage).toBe('function');
                expect(typeof f.buildSocket).toBe('function');
            } else {
                expect(typeof f.parse).toBe('function');
            }
            // A keyed feed must be able to build its own request, because its key
            // goes straight from the browser to the provider and never through
            // Sitrec's proxy.
            if (f.keyProvider) expect(typeof f.buildRequest === 'function' || f.transport === 'websocket').toBe(true);
            expect(typeof f.pollMs).toBe('number');
            expect(typeof f.color).toBe('number');
            // Coverage and attribution are shown to the user, and the attribution
            // is what makes using these feeds legitimate at all.
            expect(typeof f.coverage).toBe('string');
            expect(typeof f.attribution).toBe('string');
        }
    });

    it('has unique ids, since they key the nodes and the proxy rows', () => {
        const ids = LIVE_FEEDS.map(f => f.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('returns an empty list rather than throwing on junk', () => {
        for (const f of LIVE_FEEDS.filter(x => x.transport !== 'websocket')) {
            expect(f.parse(null)).toEqual([]);
            expect(f.parse({})).toEqual([]);
        }
    });

    it('ignores a junk websocket message rather than throwing', () => {
        for (const f of LIVE_FEEDS.filter(x => x.transport === 'websocket')) {
            expect(f.onMessage(null)).toBeNull();
            expect(f.onMessage({})).toBeNull();
        }
    });
});

describe('ships (AISStream websocket)', () => {
    const f = feed('ships');
    const msg = {
        MessageType: 'PositionReport',
        MetaData: {MMSI: 368207620, Latitude: 25.7617, Longitude: -80.1918, ShipName: 'EVER GIVEN  '},
        Message: {PositionReport: {UserID: 368207620, Sog: 12.4, Cog: 86.7}},
    };

    it('reads position, name, speed and course out of a position report', () => {
        const m = f.onMessage(msg);
        expect(m.lat).toBeCloseTo(25.7617, 4);
        expect(m.lon).toBeCloseTo(-80.1918, 4);
        expect(m.label).toBe('EVER GIVEN');
        expect(m.headingDeg).toBeCloseTo(86.7, 1);
        expect(m.detail).toContain('12.4 kt');
    });

    it('keys the marker by MMSI so repeated reports replace rather than accumulate', () => {
        // A vessel transmits every few seconds; appending would grow without bound.
        expect(f.onMessage(msg).id).toBe('mmsi368207620');
    });

    it('treats the AIS not-available course sentinels as no course', () => {
        // 360 and 511 mean "not available". Drawn literally they point every
        // unknown vessel due north, which looks like a fleet under way.
        for (const cog of [360, 511]) {
            const m = f.onMessage({...msg, Message: {PositionReport: {UserID: 1, Cog: cog}}});
            expect(m.headingDeg).toBeNull();
        }
    });

    it('ignores message types other than position reports', () => {
        expect(f.onMessage({MessageType: 'ShipStaticData', MetaData: {Latitude: 1, Longitude: 2}}))
            .toBeNull();
    });

    it('builds a bounding box around the camera, lat first, clamped to the poles', () => {
        const {url, subscribe} = f.buildSocket('KEY', {lat: 89.0, lon: -80});
        expect(url).toBe('wss://stream.aisstream.io/v0/stream');
        expect(subscribe.APIKey).toBe('KEY');
        const [[sw, ne]] = subscribe.BoundingBoxes;
        expect(sw[0]).toBeCloseTo(84, 6);
        expect(ne[0]).toBe(90);          // clamped, not 94
        expect(subscribe.FilterMessageTypes).toEqual(['PositionReport']);
    });
});

describe('webcams (Windy)', () => {
    const f = feed('webcams');

    it('sends the key as a header, which is what Windy CORS-allows', () => {
        const {url, headers} = f.buildRequest('KEY123', {lat: 34.05, lon: -118.25});
        expect(headers['x-windy-api-key']).toBe('KEY123');
        // The key must NOT be in the URL: URLs end up in logs and referrers.
        expect(url).not.toContain('KEY123');
        expect(url).toContain('nearby=34.050%2C-118.250%2C250');
    });

    it('parses location and the current preview image', () => {
        const [cam] = f.parse({webcams: [{
            webcamId: 1234, title: 'Santa Monica Pier',
            location: {latitude: 34.008, longitude: -118.498, city: 'Santa Monica', country: 'US'},
            images: {current: {preview: 'https://images.windy.com/1234.jpg'}},
        }]});
        expect(cam.lat).toBeCloseTo(34.008, 3);
        expect(cam.imageURL).toBe('https://images.windy.com/1234.jpg');
        expect(cam.detail).toBe('Santa Monica, US');
    });

    it('skips a webcam with no coordinates', () => {
        expect(f.parse({webcams: [{webcamId: 1, title: 'nowhere'}]})).toHaveLength(0);
    });
});

describe('traffic (TomTom)', () => {
    const f = feed('traffic');

    it('builds a bbox in TomTom order: minLon,minLat,maxLon,maxLat', () => {
        // The opposite order from the lat-first pairs used everywhere else, which
        // is exactly the kind of thing that silently queries the wrong continent.
        const {url} = f.buildRequest('K', {lat: 34, lon: -118});
        const bbox = decodeURIComponent(new URL(url).searchParams.get('bbox'));
        expect(bbox).toBe('-118.5000,33.5000,-117.5000,34.5000');
    });

    it('takes the first vertex of a LineString incident', () => {
        const [inc] = f.parse({incidents: [{
            geometry: {type: 'LineString', coordinates: [[-118.4, 34.02], [-118.3, 34.05]]},
            properties: {iconCategory: 6, events: [{description: 'Queuing traffic'}]},
        }]});
        expect(inc.lat).toBeCloseTo(34.02, 3);
        expect(inc.lon).toBeCloseTo(-118.4, 3);
        expect(inc.label).toBe('Queuing traffic');
    });

    it('handles a Point incident too', () => {
        const [inc] = f.parse({incidents: [{
            geometry: {type: 'Point', coordinates: [-118.1, 33.9]},
            properties: {events: [{description: 'Roadworks'}]},
        }]});
        expect(inc.lat).toBeCloseTo(33.9, 3);
    });
});

describe('balloons (SondeHub)', () => {
    // A map of maps: serial -> ISO timestamp -> telemetry frame.
    const json = {
        Y0342055: {
            '2026-08-30T03:30:00.000Z': {lat: 48.0, lon: 10.0, alt: 20000, type: 'RS41'},
            '2026-08-30T03:36:00.000Z': {lat: 48.9, lon: 10.02, alt: 26809, type: 'RS41',
                manufacturer: 'Vaisala', vel_v: 6.9},
        },
    };

    it('uses only the LATEST frame per sonde', () => {
        // An hour of history would otherwise draw a smear of stale positions along
        // each balloon's path and count one balloon many times.
        const out = feed('balloons').parse(json);
        expect(out).toHaveLength(1);
        expect(out[0].lat).toBeCloseTo(48.9, 3);
        expect(out[0].altitudeM).toBe(26809);
    });

    it('flags sonde altitude as HAE', () => {
        // It comes straight off the sonde's GPS, so it is height above the
        // ellipsoid. Treating it as MSL would add the geoid separation twice.
        expect(feed('balloons').parse(json)[0].altitudeIsHAE).toBe(true);
    });

    it('describes vertical direction in words', () => {
        expect(feed('balloons').parse(json)[0].detail).toContain('climbing');
        const falling = {S1: {'2026-08-30T03:36:00.000Z': {lat: 1, lon: 2, alt: 100, vel_v: -3.1}}};
        expect(feed('balloons').parse(falling)[0].detail).toContain('descending');
    });
});

describe('quakes (USGS GeoJSON)', () => {
    const json = {
        features: [{
            id: 'us1000',
            geometry: {type: 'Point', coordinates: [-27.0031, -56.4583, 135.686]},
            properties: {mag: 5.1, place: 'South Sandwich Islands region', time: 1756526100000,
                url: 'https://example.invalid/us1000'},
        }],
    };

    it('does NOT use the third coordinate as an altitude', () => {
        // USGS's third value is DEPTH IN KILOMETRES, positive down. Honouring it
        // literally buries the marker 136 km inside the Earth, where it cannot be
        // seen from any viewpoint outside it.
        const [q] = feed('quakes').parse(json);
        expect(q.altitudeM).toBeNull();
    });

    it('reports depth in the detail line instead', () => {
        const [q] = feed('quakes').parse(json);
        expect(q.detail).toContain('136 km deep');
        expect(q.detail).toContain('South Sandwich');
        expect(q.label).toBe('M5.1');
    });

    it('scales the marker by magnitude', () => {
        const [q] = feed('quakes').parse(json);
        expect(q.sizeScale).toBeGreaterThan(1);
    });
});

describe('launches (Launch Library 2)', () => {
    const json = {
        results: [{
            id: 'abc', name: 'Falcon 9 Block 5 | Starlink Group 15-22',
            net: '2026-08-26T09:35:11Z',
            status: {abbrev: 'Success'},
            pad: {name: 'SLC-4E', latitude: '34.632', longitude: '-120.611'},
            url: 'https://example.invalid/abc',
        }],
    };

    it('places the marker at the PAD and reads its string coordinates as numbers', () => {
        const [l] = feed('launches').parse(json);
        expect(l.lat).toBeCloseTo(34.632, 3);
        expect(l.lon).toBeCloseTo(-120.611, 3);
        expect(l.detail).toContain('2026-08-26 09:35 UTC');
        expect(l.url).toBe('https://example.invalid/abc');
    });

    it('skips a launch whose pad has no coordinates', () => {
        expect(feed('launches').parse({results: [{name: 'x', pad: {}}]})).toHaveLength(0);
    });
});

describe('mil (adsb.lol v2)', () => {
    it('reuses the ADS-B normaliser, including its altitude datum handling', () => {
        const [a] = feed('mil').parse({
            ac: [{hex: 'AE1234', flight: 'RCH123  ', lat: 34.0, lon: -118.0,
                alt_baro: 30000, alt_geom: 30500, gs: 450, t: 'C17'}],
        });
        expect(a.hex).toBe('ae1234');
        expect(a.label).toBe('RCH123');
        // Geometric preferred and flagged, exactly as the civil layer does.
        expect(a.altitudeIsHAE).toBe(true);
        expect(a.detail).toContain('C17');
    });

    it('drops an aircraft with no position', () => {
        expect(feed('mil').parse({ac: [{hex: 'ae1', alt_baro: 1000}]})).toHaveLength(0);
    });
});
