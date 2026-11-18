import {Vector3} from "three";
import {findNightView} from "../src/starTrack/StarNightView";
import {getECEFToEQJMatrix, getGeocentricBodyPositionECEF} from "../src/CelestialMath";

const date = new Date("2026-11-18T08:00:00Z");
const sun = getGeocentricBodyPositionECEF("Sun", date).normalize().transformDirection(getECEFToEQJMatrix(date));

test("a night field gets an unobstructed viewing location without changing the date", () => {
    const center = sun.clone().negate();
    const result = findNightView([center, center.clone().add(new Vector3(0.1, 0, 0)).normalize()], date);
    expect(result.date).toEqual(date);
    expect(result.sunAltitude).toBeLessThan(-18);
    expect(result.minAltitude).toBeGreaterThan(70);
    expect(Math.abs(result.latitude)).toBeLessThanOrEqual(90);
    expect(Math.abs(result.longitude)).toBeLessThanOrEqual(180);
});

test("a field near the Sun requires an explicitly allowed date change", () => {
    const fixed = findNightView([sun], date);
    expect(fixed.date).toEqual(date);
    expect(fixed.minAltitude).toBeLessThan(0);
    const changed = findNightView([sun], date, true);
    expect(changed.date).not.toEqual(date);
    expect(changed.minAltitude).toBeGreaterThanOrEqual(15);
    expect(changed.sunAltitude).toBeLessThanOrEqual(-18 + 1e-8);
});
