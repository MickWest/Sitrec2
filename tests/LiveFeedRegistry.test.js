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
            expect(typeof f.parse).toBe('function');
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
        for (const f of LIVE_FEEDS) {
            expect(f.parse(null)).toEqual([]);
            expect(f.parse({})).toEqual([]);
        }
    });
});

describe('ships (Digitraffic AIS GeoJSON)', () => {
    // Real response shape, trimmed.
    const json = {
        features: [{
            mmsi: 273380040,
            type: 'Feature',
            geometry: {type: 'Point', coordinates: [28.381667, 59.704263]},
            properties: {mmsi: 273380040, sog: 12.5, cog: 42.6, navStat: 0},
        }],
    };

    it('reads GeoJSON as [lon, lat], not [lat, lon]', () => {
        // The whole point. Getting this backwards does not throw — it silently
        // puts a Gulf of Finland vessel in the Indian Ocean, and 28N/59E is a
        // real place, so nothing downstream would flag it either.
        const [ship] = feed('ships').parse(json);
        expect(ship.lat).toBeCloseTo(59.704263, 6);
        expect(ship.lon).toBeCloseTo(28.381667, 6);
    });

    it('puts vessels at the surface rather than at ellipsoid zero', () => {
        const [ship] = feed('ships').parse(json);
        expect(ship.altitudeM).toBeNull();
    });

    it('carries course over ground so the marker can point along it', () => {
        const [ship] = feed('ships').parse(json);
        expect(ship.headingDeg).toBe(42.6);
        expect(ship.detail).toContain('12.5 kt');
    });
});

describe('webcams', () => {
    const station = (id, status, presets) => ({
        type: 'Feature',
        id,
        geometry: {type: 'Point', coordinates: [23.99616, 60.05374, 0.0]},
        properties: {id, name: 'kt51_Inkoo', collectionStatus: status, presets},
    });

    it('builds a working image URL from the first collecting preset', () => {
        const [cam] = feed('webcams').parse({
            features: [station('C01503', 'GATHERING', [
                {id: 'C0150301', inCollection: false},
                {id: 'C0150302', inCollection: true},
            ])],
        });
        expect(cam.imageURL).toBe('https://weathercam.digitraffic.fi/C0150302.jpg');
        expect(cam.lat).toBeCloseTo(60.05374, 5);
    });

    it('drops cameras that are not collecting', () => {
        // A marker for a decommissioned camera is a click that leads nowhere.
        const out = feed('webcams').parse({
            features: [station('C1', 'REMOVED_TEMPORARILY', [{id: 'C1_1', inCollection: true}])],
        });
        expect(out).toHaveLength(0);
    });

    it('drops a station with no presets at all', () => {
        const out = feed('webcams').parse({features: [station('C2', 'GATHERING', [])]});
        expect(out).toHaveLength(0);
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
