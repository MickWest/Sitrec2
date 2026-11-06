import {Vector3} from "three";
import {buildRayTable, groundY, normalizeSettings} from "../src/refraction/RefractionPhysics";
import {projectRayEndpoint, projectRayRelative, unprojectRayRelative} from "../src/refraction/RayGeometryProjection";

const rad = Math.PI / 180;

test("a 443 km summit hidden geometrically projects through the standard-atmosphere ray", () => {
    const radius = 6376170.987254119, distance = 443548.10284497, summit = 3883, height = 2828;
    const x = (radius + summit) * Math.sin(distance / radius);
    const y = (radius + summit) * Math.cos(distance / radius) - radius - height;
    const table = buildRayTable({settings: {maxDistance: 500000, distanceSamples: 512,
        step: 200, humidity: 0}, height, radius, minAngle: -1.7 * rad, maxAngle: -1.4 * rad, rows: 128});
    const projected = projectRayEndpoint(table, x, y);
    expect(projected.reached).toBe(true);
    // Independent Snell-law integration, same spherical/standard-atmosphere assumptions.
    expect(Math.abs(projected.angle / rad - -1.54218590197) * 3600).toBeLessThan(0.2);
    expect(projected.angle - Math.atan2(y, x)).toBeGreaterThan(0.3 * rad);
    const ctx = {rayTable: table, zenith: new Vector3(0, 1, 0)};
    const physical = new Vector3(x, y, 0), apparent = projectRayRelative(ctx, physical);
    expect(unprojectRayRelative(ctx, apparent).distanceTo(physical)).toBeLessThan(0.02);
    expect(projectRayEndpoint(table, 500001, y)).toBeNull();
});

test("zero refractivity preserves reachable geometry and old saves keep screen-space mode", () => {
    expect(normalizeSettings({}).projectionMode).toBe("screen");
    const table = buildRayTable({settings: {bend: false, flat: true, maxDistance: 10000,
        distanceSamples: 64, step: 500}, height: 1000, radius: 6371000,
        minAngle: -0.01, maxAngle: 0.01, rows: 64});
    for (const distance of [1, 300, 9999]) {
        const result = projectRayEndpoint(table, distance, distance * 0.001);
        expect(result.reached).toBe(true);
        expect(result.vertical).toBeCloseTo(distance * 0.001, 6);
    }
    table.diagnostics.foldedPairs = 1;
    expect(projectRayEndpoint(table, 1000, 1)).toBeNull();
});

test("the last live segment ends at ground impact, not the later frozen column", () => {
    const table = buildRayTable({settings: {bend: false, flat: true, maxDistance: 10000,
        distanceSamples: 64, step: 200}, height: 10, radius: 6371000,
        minAngle: -0.011, maxAngle: -0.009, rows: 3});
    // The middle ray hits at ~999.967 m, between the stored 909.55/1007.81 m
    // columns. Until impact, straight light must preserve its exact slope.
    for (const d of [980, 995, 999]) {
        const result = projectRayEndpoint(table, d, d * Math.tan(-0.01));
        expect(Math.abs(result.angle + 0.01)).toBeLessThan(1e-9);
    }
});

test("hidden heights stay separated and projection is continuous at the trace range", () => {
    const radius = 6376171, height = 2827.6, max = 500000;
    const table = buildRayTable({settings: {maxDistance: max, distanceSamples: 128, step: 500},
        height, radius, minAngle: -0.0302734375, maxAngle: -0.0234375, rows: 128});
    const d = 443000, ground = groundY(d, radius) - height;
    const low = projectRayEndpoint(table, d, ground), high = projectRayEndpoint(table, d, ground + 2000);
    expect(low.reached).toBe(false); expect(high.reached).toBe(false);
    // Previously both heights were collapsed to precisely the same horizon.
    expect(high.vertical - low.vertical).toBeCloseTo(2000, 6);
    const ctx = {rayTable: table, zenith: new Vector3(0, 1, 0)};
    for (const distance of [443000, max - 0.01, max + 0.01]) {
        const physical = new Vector3(distance, groundY(distance, radius) - height, 0);
        expect(unprojectRayRelative(ctx, projectRayRelative(ctx, physical)).distanceTo(physical)).toBeLessThan(1e-6);
    }
    const before = projectRayRelative(ctx, new Vector3(max - 0.01, groundY(max - 0.01, radius) - height, 0));
    const after = projectRayRelative(ctx, new Vector3(max + 0.01, groundY(max + 0.01, radius) - height, 0));
    // A triangle crossing the range must remain continuous before its outside
    // fragments are clipped. The former identity fallback jumped kilometres.
    expect(after.distanceTo(before)).toBeLessThan(0.1);
    expect(projectRayEndpoint(table, max + 0.01, after.y)).toBeNull();
});

test("wide ray intervals invert launch slopes consistently", () => {
    const table = buildRayTable({settings: {maxDistance: 500000, distanceSamples: 64,
        step: 500, humidity: 0}, height: 2828, radius: 6376171,
        minAngle: -0.1, maxAngle: 1.4, rows: 64});
    const ctx = {rayTable: table, zenith: new Vector3(0, 1, 0)};
    const apparent = new Vector3(443000, 443000 * Math.tan(1.387), 0);
    const physical = unprojectRayRelative(ctx, apparent);
    expect(projectRayRelative(ctx, physical).distanceTo(apparent)).toBeLessThan(1e-6);
});

test("WGS84 endpoints agree with independent ellipsoid/geoid shooting for Pic Gaspard", () => {
    const table = buildRayTable({settings: {maxDistance: 500000, distanceSamples: 512,
        step: 100, humidity: 0}, height: 2827.6, radius: 6376171,
        minAngle: -0.03564453125, maxAngle: 0, rows: 4096});
    // WGS84 endpoints at 42.41445,2.13353,2827.6 MSL and
    // 44.99817687,6.330330848,3883 MSL, with EGM96 separation at each.
    const result = projectRayEndpoint(table, 443464.1877049465, -14368.882391230756);
    expect(result.reached).toBe(true);
    expect(result.angle).toBeGreaterThan(table.minAngle);
    expect(result.angle).toBeLessThan(table.maxAngle);
    // Independent 3-D gradient-index integration on WGS84/EGM96. This
    // tolerance validates this sightline, not all spherical approximations.
    expect(Math.abs(result.angle / rad - -1.5413677613955912) * 3600).toBeLessThan(0.2);
});
