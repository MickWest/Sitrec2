import {Vector3} from 'three';
import {getECEFToEQJMatrix, getEQJToECEFMatrix, getGeocentricBodyPositionECEF} from '../src/CelestialMath';
import {findTemplateNightView, identifiedStarDirections, solvedFieldDirections} from '../src/starTrack/StarTemplateView';

const DEG = Math.PI / 180;
const upAt = (lat, lon) => new Vector3(Math.cos(lat * DEG) * Math.cos(lon * DEG),
    Math.cos(lat * DEG) * Math.sin(lon * DEG), Math.sin(lat * DEG));
const zenithField = (lat, lon, date) => {
    const center = upAt(lat, lon).transformDirection(getECEFToEQJMatrix(date));
    return [center, center.clone().add(new Vector3(0.08, 0.03, 0.02)).normalize()];
};
function expectVisible(result, field) {
    expect(result).not.toBeNull();
    const up = upAt(result.latitude, result.longitude);
    const sun = getGeocentricBodyPositionECEF('Sun', result.date).normalize();
    expect(Math.asin(sun.dot(up)) / DEG).toBeLessThanOrEqual(-18 + 1e-8);
    const matrix = getEQJToECEFMatrix(result.date);
    for (const direction of field) expect(Math.asin(direction.clone().transformDirection(matrix).dot(up)) / DEG).toBeGreaterThanOrEqual(10 - 1e-8);
}

test('a known instant is unchanged while the solved field selects a US viewpoint', () => {
    const date = new Date('2026-01-15T04:00:00.123Z'), field = zenithField(39, -105, date);
    const result = findTemplateNightView(field, {date, timeKnown: true});
    expectVisible(result, field);
    expect(result.date.getTime()).toBe(date.getTime());
    expect(result.region).toBe('United States');
    expect(result.minAltitude).toBeGreaterThan(70);
});

test('Europe is preferred when no US point has a clear dark view at the known instant', () => {
    const date = new Date('2026-01-15T21:00:00Z'), field = zenithField(48, 10, date);
    const result = findTemplateNightView(field, {date, timeKnown: true});
    expectVisible(result, field);
    expect(result.region).toBe('Europe');
    expect(result.date.getTime()).toBe(date.getTime());
});

test('a known location is exact while time is chosen from the star field', () => {
    const original = new Date('2026-01-15T18:00:00Z');
    const field = zenithField(39.1234, -105.1234, new Date('2026-01-15T04:00:00Z'));
    const location = {latitude: 39.1234, longitude: -105.1234};
    const result = findTemplateNightView(field, {date: original, location});
    expectVisible(result, field);
    expect(result.latitude).toBe(location.latitude);
    expect(result.longitude).toBe(location.longitude);
    expect(result.date).not.toEqual(original);
});

test('with neither input known, select a clear US evening instead of retaining the template values', () => {
    const date = new Date('2026-01-15T12:00:00Z'), field = zenithField(39, -105, new Date('2026-01-15T04:00:00Z'));
    const result = findTemplateNightView(field, {date});
    expectVisible(result, field);
    expect(result.region).toBe('United States');
    expect(result.localSolarHour).toBeGreaterThanOrEqual(18);
    expect(result.localSolarHour).toBeLessThan(24);
    expect(result.date).not.toEqual(date);
});

test('an impossible fixed location is not replaced, and a southern field can fall back beyond Europe', () => {
    const date = new Date('2026-06-15T03:00:00Z');
    const field = [new Vector3(0.1, 0, -1).normalize()];
    expect(findTemplateNightView(field, {date, location: {latitude: 70, longitude: 10}})).toBeNull();
    const result = findTemplateNightView(field, {date, timeKnown: true});
    expectVisible(result, field);
    expect(result.region).toBe('Elsewhere');
});

test('the field footprint includes corners and rejects unusable poses', () => {
    const field = solvedFieldDirections({centre: {raDeg: 0, decDeg: 0}, above: {raDeg: 0, decDeg: 1}}, 60, 2);
    expect(field).toHaveLength(5);
    expect(field[0]).toEqual(new Vector3(1, 0, 0));
    expect(field.every(d => Math.abs(d.length() - 1) < 1e-12)).toBe(true);
    expect(solvedFieldDirections(null, 60)).toEqual([]);
    expect(findTemplateNightView([], {date: new Date()})).toBeNull();
    expect(findTemplateNightView(field, {date: new Date('invalid')})).toBeNull();
});

test('a known location gets a dark time for a low southern field whose lower frame never rises', () => {
    // From latitude 40 N, the lower corners of this field (Dec -43) never rise above 7 degrees.
    const field = solvedFieldDirections({centre: {raDeg: 195, decDeg: -30}, above: {raDeg: 195, decDeg: -29}}, 40, 1.5);
    const stars = identifiedStarDirections([{raDeg: 190, decDeg: -24}, {raDeg: 196, decDeg: -33},
        {raDeg: 201, decDeg: -28}, {raDeg: 193, decDeg: -21}, {label: 'no position'}]);
    expect(stars).toHaveLength(4);
    const location = {latitude: 40, longitude: -100};
    const date = new Date('2026-11-21T12:00:00Z');
    const result = findTemplateNightView(field, {date, location, stars});
    expect(result).not.toBeNull();
    expect(result.latitude).toBe(location.latitude);
    expect(result.longitude).toBe(location.longitude);
    expect(result.lowFrame).toBe(true);
    expect(result.fieldMinAltitude).toBeLessThan(10);
    const up = upAt(result.latitude, result.longitude);
    const sun = getGeocentricBodyPositionECEF('Sun', result.date).normalize();
    expect(Math.asin(sun.dot(up)) / DEG).toBeLessThanOrEqual(-18 + 1e-8);
    const matrix = getEQJToECEFMatrix(result.date);
    const altitudes = stars.map(d => Math.asin(d.clone().transformDirection(matrix).dot(up)) / DEG);
    expect(Math.min(...altitudes)).toBeGreaterThanOrEqual(10 - 1e-8);
    expect(result.minAltitude).toBeCloseTo(Math.min(...altitudes), 8);

    // Without identified stars, the frame centre must clear 10 degrees instead.
    const centreOnly = findTemplateNightView(field, {date, location});
    expect(centreOnly?.lowFrame).toBe(true);
    expect(Math.asin(field[0].clone().transformDirection(getEQJToECEFMatrix(centreOnly.date))
        .dot(up)) / DEG).toBeCloseTo(centreOnly.minAltitude, 8);
    // With the time known as well, nothing is searched, so the whole frame must still clear.
    expect(findTemplateNightView(field, {date: result.date, location, stars, timeKnown: true})).toBeNull();
});
