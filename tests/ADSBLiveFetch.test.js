// Tests for the live ADS-B feed's normalisation: the part that decides what
// altitude datum an aircraft is reporting and which records are usable at all.
// The fetch itself needs the PHP proxy and a live upstream, so it is verified in
// the browser rather than here.

import {normalizeAircraft, normalizeResponse, adsbLiveURL} from '../src/ADSBLiveFetch';

// Feet to metres, to state expectations in the units the feed uses.
const FT = 0.3048;

describe('normalizeAircraft', () => {
    const base = {hex: 'A40D3E', lat: 34.4, lon: -119.1};

    it('prefers geometric altitude and flags it as HAE', () => {
        const a = normalizeAircraft({...base, alt_baro: 4700, alt_geom: 4750});
        expect(a.altitudeIsHAE).toBe(true);
        expect(a.altitudeM).toBeCloseTo(4750 * FT, 6);
    });

    it('falls back to barometric and does NOT flag it as HAE', () => {
        // Barometric is conventionally MSL. Reporting it as HAE would make the
        // caller skip the geoid correction, putting the aircraft tens of metres
        // off vertically.
        const a = normalizeAircraft({...base, alt_baro: 4700});
        expect(a.altitudeIsHAE).toBe(false);
        expect(a.altitudeM).toBeCloseTo(4700 * FT, 6);
    });

    it('treats alt_baro "ground" as on-ground with no altitude', () => {
        // "ground" is a string, and Number("ground") is NaN — a truthiness check
        // would accept it and a bare Number() would produce NaN metres.
        const a = normalizeAircraft({...base, alt_baro: 'ground'});
        expect(a.onGround).toBe(true);
        expect(a.altitudeM).toBeNull();
    });

    it('drops a record with no position', () => {
        // A bare Mode-S track is heard but not positioned. Drawing it would put
        // it at null island.
        expect(normalizeAircraft({hex: 'abc123', alt_baro: 3000})).toBeNull();
        expect(normalizeAircraft({...base, lat: null})).toBeNull();
        expect(normalizeAircraft(null)).toBeNull();
    });

    it('lowercases the hex and trims the space-padded callsign', () => {
        const a = normalizeAircraft({...base, flight: 'N360KS  '});
        expect(a.hex).toBe('a40d3e');
        expect(a.callsign).toBe('N360KS');
    });

    it('reports a blank callsign as null rather than an empty string', () => {
        expect(normalizeAircraft({...base, flight: '        '}).callsign).toBeNull();
        expect(normalizeAircraft(base).callsign).toBeNull();
    });

    it('falls back to calc_track when the aircraft transmits no heading', () => {
        expect(normalizeAircraft({...base, track: 210.5}).trackDeg).toBe(210.5);
        expect(normalizeAircraft({...base, calc_track: 21}).trackDeg).toBe(21);
        expect(normalizeAircraft(base).trackDeg).toBeNull();
    });

    it('keeps a zero heading rather than treating it as missing', () => {
        // Due north is 0, which is falsy. A truthiness check here would send
        // every northbound aircraft to the calc_track fallback.
        expect(normalizeAircraft({...base, track: 0, calc_track: 180}).trackDeg).toBe(0);
    });

    it('carries the position age through', () => {
        expect(normalizeAircraft({...base, seen_pos: 43.9}).positionAgeSec).toBe(43.9);
        expect(normalizeAircraft(base).positionAgeSec).toBeNull();
    });
});

describe('normalizeResponse', () => {
    it('drops positionless records but reports the feed\'s own total', () => {
        const out = normalizeResponse({
            ac: [
                {hex: 'a', lat: 34, lon: -118, alt_baro: 1000},
                {hex: 'b', alt_baro: 2000},          // no position
            ],
            now: 1756512000,
            total: 2,
        });
        expect(out.aircraft).toHaveLength(1);
        expect(out.reportedTotal).toBe(2);
        // The feed's clock, not the browser's: ages are relative to the server's
        // view, and a skewed client clock would age every aircraft out.
        expect(out.nowSec).toBe(1756512000);
    });

    it('handles a response with no aircraft array at all', () => {
        expect(normalizeResponse({}).aircraft).toEqual([]);
        expect(normalizeResponse(null).aircraft).toEqual([]);
    });
});

describe('adsbLiveURL', () => {
    it('rounds the radius and fixes the position precision', () => {
        const url = adsbLiveURL(34.05, -118.25, 49.6);
        expect(url).toContain('lat=34.050000');
        expect(url).toContain('lon=-118.250000');
        expect(url).toContain('radius=50');
    });
});
