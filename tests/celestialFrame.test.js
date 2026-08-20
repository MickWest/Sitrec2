// Guards the EQJ (J2000/ICRS) → ECEF transform used to draw the celestial
// sphere and to point the camera at celestial objects.
//
// History: the sphere used to be rotated by a bare Rz(-GMST). GMST is measured
// from the mean equinox OF DATE, so pairing it with J2000 coordinates omitted
// precession entirely — the whole sky sat 22 arcmin off the terrain by 2026,
// growing ~50"/yr. It went unnoticed for years because the sky stayed
// self-consistent: stars agreed with planets, so only sky-vs-ground alignment
// exposed it. These tests fail loudly if anything reintroduces that pairing.

import {Matrix4, Vector3} from 'three';
import * as Astronomy from 'astronomy-engine';
import {
    applyAnnualAberration,
    getECEFToEQJMatrix,
    getEQJToECEFMatrix,
    raDec2Celestial,
} from '../src/CelestialMath';

const D2R = Math.PI / 180, R2D = 180 / Math.PI;

// The observation that exposed the bug: the Moon rising over Malmö's Turning
// Torso, seen from Amager Strandpark in Copenhagen.
const SITE = {lat: 55.640518563099654, lon: 12.653300416260622, alt: 39.55914922058582};
const EPOCH = new Date('2026-08-01T20:06:45.000Z');

function ecefToAzEl(v, latDeg, lonDeg) {
    const la = latDeg * D2R, lo = lonDeg * D2R;
    const u = v.clone().normalize();
    const east = new Vector3(-Math.sin(lo), Math.cos(lo), 0);
    const north = new Vector3(-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la));
    const up = new Vector3(Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la));
    let az = Math.atan2(u.dot(east), u.dot(north)) * R2D;
    if (az < 0) az += 360;
    return {az, el: Math.asin(u.dot(up)) * R2D};
}

function sepArcmin(a, b) {
    const v = ({az, el}) => new Vector3(
        Math.cos(el * D2R) * Math.cos(az * D2R),
        Math.cos(el * D2R) * Math.sin(az * D2R),
        Math.sin(el * D2R));
    return Math.acos(Math.min(1, Math.max(-1, v(a).dot(v(b))))) * R2D * 60;
}

// Where Sitrec actually puts a body: EQJ coordinates carried through the
// matrix under test.
function renderedAzEl(body, date, observer, site) {
    const eqj = Astronomy.Equator(body, date, observer, /*ofdate=*/false, /*aberration=*/true);
    const dir = raDec2Celestial(eqj.ra / 24 * 2 * Math.PI, eqj.dec * D2R, 1)
        .applyMatrix4(getEQJToECEFMatrix(date));
    return ecefToAzEl(dir, site.lat, site.lon);
}

// The independent answer: equator-of-date coordinates through astronomy-engine's
// own horizon solve, which shares no code with getEQJToECEFMatrix.
function truthAzEl(body, date, observer) {
    const eqd = Astronomy.Equator(body, date, observer, /*ofdate=*/true, /*aberration=*/true);
    const h = Astronomy.Horizon(date, observer, eqd.ra, eqd.dec, null);
    return {az: h.azimuth, el: h.altitude};
}

describe('EQJ → ECEF celestial frame', () => {
    const observer = new Astronomy.Observer(SITE.lat, SITE.lon, SITE.alt);

    test.each(['Moon', 'Sun', 'Mars', 'Jupiter'])(
        '%s lands where a rigorous topocentric solve puts it', (body) => {
            const sep = sepArcmin(
                renderedAzEl(body, EPOCH, observer, SITE),
                truthAzEl(body, EPOCH, observer));
            // Sub-arcsecond. The two paths share only the ephemeris, not the
            // frame transform, so this pins precession, nutation and GAST.
            expect(sep * 60).toBeLessThan(1);
        });

    // The historic entries are not padding. Precession from J2000 reaches 1.45 deg
    // by 1896 - over three lunar diameters - so a sky drawn without it is not
    // slightly wrong at these dates, it is somewhere else. 1700 and 2200 are the
    // ends of astronomy-engine's fitted range, and of what the Time menu allows.
    test.each([
        ['1700-01-01T00:00:00.000Z'],
        ['1897-04-10T01:30:00.000Z'],
        ['1918-06-08T22:00:00.000Z'],
        ['2000-01-01T12:00:00.000Z'],
        ['2010-06-15T03:00:00.000Z'],
        ['2035-12-25T18:30:00.000Z'],
        ['2200-01-01T00:00:00.000Z'],
    ])('holds at %s, not just the epoch it was written for', (iso) => {
        const date = new Date(iso);
        const sep = sepArcmin(
            renderedAzEl('Moon', date, observer, SITE),
            truthAzEl('Moon', date, observer));
        expect(sep * 60).toBeLessThan(1);
    });

    test('is NOT a bare sidereal rotation — precession is really applied', () => {
        // Reproduce the old behaviour and confirm it is wrong by the amount
        // precession predicts. If someone "simplifies" the matrix back to a Z
        // rotation, the test above fails and this one explains why.
        const JD = EPOCH / 86400000 + 2440587.5;
        let gmst = (280.46061837 + 360.98564736629 * (JD - 2451545.0)) % 360;
        if (gmst < 0) gmst += 360;

        const eqj = Astronomy.Equator('Moon', EPOCH, observer, false, true);
        const spinOnly = raDec2Celestial(eqj.ra / 24 * 2 * Math.PI, eqj.dec * D2R, 1)
            .applyMatrix4(new Matrix4().makeRotationZ(-gmst * D2R));

        const off = sepArcmin(
            ecefToAzEl(spinOnly, SITE.lat, SITE.lon),
            truthAzEl('Moon', EPOCH, observer));

        // ~26.6 years of precession at ~50"/yr.
        expect(off).toBeGreaterThan(21);
        expect(off).toBeLessThan(24);
    });

    test('the inverse matrix is an exact inverse', () => {
        const fwd = getEQJToECEFMatrix(EPOCH);
        const inv = getECEFToEQJMatrix(EPOCH);
        const v = new Vector3(0.3, -0.7, 0.5).normalize();
        const round = v.clone().applyMatrix4(fwd).applyMatrix4(inv);
        expect(round.x).toBeCloseTo(v.x, 12);
        expect(round.y).toBeCloseTo(v.y, 12);
        expect(round.z).toBeCloseTo(v.z, 12);
    });

    test('memoisation does not leak state between epochs', () => {
        const a = getEQJToECEFMatrix(EPOCH).clone();
        getEQJToECEFMatrix(new Date('2010-01-01T00:00:00.000Z'));
        const again = getEQJToECEFMatrix(EPOCH);
        expect(again.elements).toEqual(a.elements);
    });

    test('writes into a caller-supplied target rather than a shared instance', () => {
        const a = new Matrix4(), b = new Matrix4();
        getEQJToECEFMatrix(EPOCH, a);
        getEQJToECEFMatrix(new Date('2010-01-01T00:00:00.000Z'), b);
        expect(a.elements).not.toEqual(b.elements);
    });
});

describe('annual aberration', () => {
    test('displaces a star by at most ~20.5 arcsec, and by a real amount', () => {
        // Sample widely: the shift is v/c·sin(angle to the apex of Earth's motion).
        let max = 0;
        for (let ra = 0; ra < 2 * Math.PI; ra += 0.3) {
            for (let dec = -1.4; dec < 1.4; dec += 0.3) {
                const raw = raDec2Celestial(ra, dec, 1);
                const shifted = applyAnnualAberration(raw.clone(), EPOCH);
                const sep = Math.acos(Math.min(1, raw.dot(shifted))) * R2D * 3600;
                max = Math.max(max, sep);
            }
        }
        expect(max).toBeGreaterThan(15);
        expect(max).toBeLessThan(20.6);
    });

    test('preserves vector length, so it can be applied to sphere positions', () => {
        const v = raDec2Celestial(1.1, 0.4, 100);
        expect(applyAnnualAberration(v, EPOCH).length()).toBeCloseTo(100, 9);
    });

    test('is not applied to planets — those arrive already aberrated', () => {
        // Regression guard for the double-count: getEQJToECEFMatrix must not
        // secretly aberrate, or Astronomy.Equator(aberration=true) bodies would
        // be shifted twice.
        const observer = new Astronomy.Observer(SITE.lat, SITE.lon, SITE.alt);
        const sep = sepArcmin(
            renderedAzEl('Jupiter', EPOCH, observer, SITE),
            truthAzEl('Jupiter', EPOCH, observer));
        expect(sep * 60).toBeLessThan(1);
    });
});
