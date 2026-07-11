// Unit tests for the pure wind-math helpers in CNodeDisplayWindField.

import {
    WIND_LEVEL_TABLE,
    bracketingLevels,
    levelToAltFeet,
    sampleJSONGrid,
    fromDirSpeedToUV,
    fromDirSpeedKnotsToUV,
    fromUVToDirKnots,
    greatCircleDistanceDeg,
    compassFromDeg,
    windDirFromBearing,
    normalizeWindTimestampMs,
} from '../src/nodes/WindHelpers';

describe('normalizeWindTimestampMs', () => {
    const epochMs = Date.UTC(2026, 6, 9, 12, 34, 56);

    test('normalizes seconds, milliseconds, and MISB microseconds identically', () => {
        expect(normalizeWindTimestampMs(epochMs / 1000)).toBe(epochMs);
        expect(normalizeWindTimestampMs(epochMs)).toBe(epochMs);
        expect(normalizeWindTimestampMs(epochMs * 1000)).toBe(epochMs);
    });

    test('accepts Date and ISO inputs and rejects absent values', () => {
        const date = new Date(epochMs);
        expect(normalizeWindTimestampMs(date)).toBe(epochMs);
        expect(normalizeWindTimestampMs(date.toISOString())).toBe(epochMs);
        expect(Number.isNaN(normalizeWindTimestampMs(null))).toBe(true);
    });
});

describe('bracketingLevels', () => {
    test('clamps below the first entry', () => {
        const r = bracketingLevels(-100);
        expect(r.lo.level).toBe('surface');
        expect(r.hi.level).toBe('surface');
        expect(r.t).toBe(0);
    });
    test('clamps above the last entry', () => {
        const last = WIND_LEVEL_TABLE[WIND_LEVEL_TABLE.length - 1];
        const r = bracketingLevels(last.ft + 10000);
        expect(r.lo.level).toBe(last.level);
        expect(r.hi.level).toBe(last.level);
    });
    test('exact match at an entry returns t=1 via the upper side', () => {
        const r = bracketingLevels(360); // top of surface→1000 range
        expect(r.lo.level).toBe('surface');
        expect(r.hi.level).toBe('1000');
        expect(r.t).toBeCloseTo(1, 6);
    });
    test('interpolates between 925 and 850', () => {
        // 925 -> 2500 ft, 850 -> 4800 ft. Midpoint (~3650) should give t=0.5
        const r = bracketingLevels(3650);
        expect(r.lo.level).toBe('925');
        expect(r.hi.level).toBe('850');
        expect(r.t).toBeCloseTo(0.5, 3);
    });
});

describe('levelToAltFeet', () => {
    test('surface is 33 ft', () => {
        expect(levelToAltFeet('surface')).toBe(33);
    });
    test('known pressure level', () => {
        expect(levelToAltFeet('500')).toBe(18300);
    });
    test('unknown level returns 0', () => {
        expect(levelToAltFeet('xyz')).toBe(0);
    });
    test('parses blended "Nft" labels', () => {
        expect(levelToAltFeet('3650ft')).toBe(3650);
        expect(levelToAltFeet('500ft')).toBe(500);
        expect(levelToAltFeet('33ft')).toBe(33);
    });
});

describe('fromDirSpeedToUV / fromUVToDirKnots round trip', () => {
    test('north wind (from=0) blows south → v negative', () => {
        const {u, v} = fromDirSpeedToUV(0, 10);
        expect(u).toBeCloseTo(0, 6);
        expect(v).toBeCloseTo(-10, 6);
    });
    test('east wind (from=90) blows west → u negative', () => {
        const {u, v} = fromDirSpeedToUV(90, 5);
        expect(u).toBeCloseTo(-5, 6);
        expect(v).toBeCloseTo(0, 6);
    });
    test('south wind (from=180) blows north → v positive', () => {
        const {u, v} = fromDirSpeedToUV(180, 7);
        expect(u).toBeCloseTo(0, 6);
        expect(v).toBeCloseTo(7, 6);
    });
    test('round trip preserves direction and magnitude', () => {
        for (const from of [0, 37, 90, 180, 271, 359]) {
            const speedMS = 12.5;
            const {u, v} = fromDirSpeedToUV(from, speedMS);
            const {from: back, knots} = fromUVToDirKnots(u, v);
            // 12.5 m/s -> ~24.3 knots
            expect(knots).toBeCloseTo(speedMS / 0.514444, 3);
            expect(((back - from + 540) % 360) - 180).toBeCloseTo(0, 3);
        }
    });
    test('knots/m_s conversion in fromDirSpeedKnotsToUV', () => {
        // from=0, 10 knots ≈ 5.14444 m/s → v ≈ -5.14444
        const {u, v} = fromDirSpeedKnotsToUV(0, 10);
        expect(u).toBeCloseTo(0, 6);
        expect(v).toBeCloseTo(-5.14444, 4);
    });
});

describe('greatCircleDistanceDeg', () => {
    test('identical points → 0', () => {
        expect(greatCircleDistanceDeg(40, -120, 40, -120)).toBeCloseTo(0, 6);
    });
    test('antipodes → 180°', () => {
        expect(greatCircleDistanceDeg(0, 0, 0, 180)).toBeCloseTo(180, 4);
    });
    test('equator 1° apart → 1°', () => {
        expect(greatCircleDistanceDeg(0, 0, 0, 1)).toBeCloseTo(1, 4);
    });
    test('pole to equator → 90°', () => {
        expect(greatCircleDistanceDeg(90, 0, 0, 0)).toBeCloseTo(90, 4);
    });
});

describe('compassFromDeg', () => {
    test('cardinal directions land on the right name', () => {
        expect(compassFromDeg(0)).toBe('N');
        expect(compassFromDeg(90)).toBe('E');
        expect(compassFromDeg(180)).toBe('S');
        expect(compassFromDeg(270)).toBe('W');
    });
    test('intercardinals at 45° steps', () => {
        expect(compassFromDeg(45)).toBe('NE');
        expect(compassFromDeg(135)).toBe('SE');
        expect(compassFromDeg(225)).toBe('SW');
        expect(compassFromDeg(315)).toBe('NW');
    });
    test('22.5° step boundaries — half-way snaps to next bin', () => {
        // 11.25° is the bin boundary; just below stays N, just above is NNE.
        expect(compassFromDeg(11)).toBe('N');
        expect(compassFromDeg(12)).toBe('NNE');
        expect(compassFromDeg(33)).toBe('NNE');
        expect(compassFromDeg(34)).toBe('NE');
    });
    test('handles negative and >360 inputs via modulo', () => {
        expect(compassFromDeg(-90)).toBe('W');
        expect(compassFromDeg(450)).toBe('E');
        expect(compassFromDeg(-1)).toBe('N');  // -1 → 359 → bin "N"
    });
    test('returns one of the 16 known points for any input', () => {
        const set = new Set(['N','NNE','NE','ENE','E','ESE','SE','SSE',
                              'S','SSW','SW','WSW','W','WNW','NW','NNW']);
        for (let d = 0; d < 360; d += 1) {
            expect(set.has(compassFromDeg(d))).toBe(true);
        }
    });
});

describe('windDirFromBearing', () => {
    // Helper: build a Vector3-like that records what set() was called with
    function makeOut() {
        const out = {x: 0, y: 0, z: 0};
        out.set = function(x, y, z) { this.x = x; this.y = y; this.z = z; };
        return out;
    }

    test('writes into out and returns it when out.set is provided', () => {
        const out = makeOut();
        const r = windDirFromBearing(0, 0, 0, out);
        expect(r).toBe(out);
        // At lat=0, lon=0, FROM-bearing 0 = north wind blowing south.
        // Local north at (0,0) ECEF = (0, 0, 1). TO direction = -north = (0, 0, -1).
        expect(out.x).toBeCloseTo(0, 6);
        expect(out.y).toBeCloseTo(0, 6);
        expect(out.z).toBeCloseTo(-1, 6);
    });
    test('returns plain object when no out provided', () => {
        const r = windDirFromBearing(0, 0, 0);
        expect(r.x).toBeCloseTo(0, 6);
        expect(r.y).toBeCloseTo(0, 6);
        expect(r.z).toBeCloseTo(-1, 6);
    });
    test('east bearing at (0,0) → flow westward in ECEF', () => {
        // FROM east (90°), wind blows TO west.
        // Local east at (0,0) = (0, 1, 0). TO direction = -east = (0, -1, 0).
        const r = windDirFromBearing(0, 0, Math.PI / 2);
        expect(r.x).toBeCloseTo(0, 6);
        expect(r.y).toBeCloseTo(-1, 6);
        expect(r.z).toBeCloseTo(0, 6);
    });
    test('returned vector is unit-length', () => {
        for (const [lat, lon, bearDeg] of [[0,0,0],[45,30,90],[-30,150,200],[60,-120,17]]) {
            const r = windDirFromBearing(lat, lon, bearDeg * Math.PI / 180);
            const m = Math.sqrt(r.x*r.x + r.y*r.y + r.z*r.z);
            expect(m).toBeCloseTo(1, 6);
        }
    });
});

describe('sampleJSONGrid', () => {
    // 2×2 grid at the corner (0,0)-(0,1)-(1,0)-(1,1) in lat/lon for easy testing.
    // Layout: lat0=1, lat1=0 (dlat=-1), lon0=0, lon1=1 (dlon=1)
    // Flat array row-major, j*nx + i, j=0 is north (lat=1), j=1 south (lat=0).
    function makeGrid() {
        return {
            nx: 2, ny: 2,
            lon0: 0, lat0: 1,
            dlon: 1, dlat: -1,
            // Grid values: NW=10, NE=20, SW=30, SE=40
            u: [10, 20, 30, 40],
            v: [0, 0, 0, 0],
        };
    }
    test('samples the NW corner exactly', () => {
        const r = sampleJSONGrid(makeGrid(), 1, 0);
        expect(r.u).toBeCloseTo(10, 6);
    });
    test('samples the center of the cell', () => {
        // Center of cell = average of all four corners = 25
        const r = sampleJSONGrid(makeGrid(), 0.5, 0.5);
        expect(r.u).toBeCloseTo(25, 6);
    });
    test('wraps longitude', () => {
        // lon=360 should wrap to lon=0 → NW corner value
        const r = sampleJSONGrid(makeGrid(), 1, 360);
        expect(r.u).toBeCloseTo(10, 6);
    });
    test('clamps latitude', () => {
        // lat=99 is out of range but should clamp to 90, which maps beyond the
        // grid — handled by j0 = min(j0, ny-2). Should return the north row.
        const r = sampleJSONGrid(makeGrid(), 99, 0);
        // Clamped lat=90. fj = (90-1)/(-1) = -89. j0 = floor = -89, sj = 0.
        // j0 is clamped to min(max(-89, 0), ny-2) = 0. j1=1. sj=0 so north row.
        expect(r.u).toBeCloseTo(10, 6);
    });
});
