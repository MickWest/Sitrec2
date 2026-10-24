// The Moon's shadow during a LUNAR eclipse. At full moon the shadow axis (Sun→Moon)
// points away from the Earth, so intersectEllipsoid finds no hit ahead of the Moon and
// rebuild() falls back to a sphere. When the axis passes within an Earth radius of the
// geocentre - any umbral lunar eclipse - that sphere's roots are both BEHIND the Moon,
// and taking the nearer one gave a negative cone distance. calculateShadowRadii then
// threw "Altitude must be non-negative" from update() every frame, which stopped the
// render loop. Checked here with the real 2025-03-14 total lunar eclipse geometry.

import {Group} from "three";
import {Globals, setNodeMan} from "../src/Globals";
import {getGeocentricBodyPositionECEF} from "../src/CelestialMath";
import {intersectEllipsoid} from "../src/threeExt";
import {CNodeDisplayMoonShadow} from "../src/nodes/CNodeDisplayMoonShadow";

// Greatest eclipse of the 2025-03-14 total lunar eclipse.
const LUNAR_ECLIPSE = new Date("2025-03-14T06:58:43Z");
// A full moon with no eclipse (2025-04-13), for comparison.
const PLAIN_FULL_MOON = new Date("2025-04-13T00:22:00Z");
// A total SOLAR eclipse, where the shadow really does reach the ground (2026-08-12).
const SOLAR_ECLIPSE = new Date("2026-08-12T17:46:00Z");

// No main camera and no terrain: the ground clearance and ground clamp use their defaults.
setNodeMan({exists: () => false, get: () => undefined});

function setSky(date) {
    Globals.moonPos = getGeocentricBodyPositionECEF("Moon", date);
    Globals.sunPos = getGeocentricBodyPositionECEF("Sun", date);
    Globals.fromSun = Globals.moonPos.clone().sub(Globals.sunPos).normalize();
    Globals.toSun = Globals.fromSun.clone().negate();
}

// Only the state rebuild() reads: the constructor also builds GUI controls.
function makeShadowNode() {
    const node = Object.create(CNodeDisplayMoonShadow.prototype);
    Object.assign(node, {
        visible: true, showEclipsePath: false, showPenumbraCone: false, showShadowCenter: false,
        numSegments: 4, moonRadius: 1737400, sunMoonDistance: 149597870700,
        _object: new Group(), pathLines: [],
        umbraConeMaterial: {}, penumbraConeMaterial: {}, umbraMaterial: {}, penumbraMaterial: {},
    });
    return node;
}

afterEach(() => {
    delete Globals.moonPos;
    delete Globals.sunPos;
    delete Globals.fromSun;
    delete Globals.toSun;
});

test("the lunar eclipse geometry takes the spherical fallback, behind the Moon", () => {
    // Pins the precondition, so the rebuild test below exercises the path it claims to.
    setSky(LUNAR_ECLIPSE);
    const moon = Globals.moonPos;
    const shadowDir = moon.clone().sub(Globals.sunPos).normalize();
    expect(intersectEllipsoid(moon, shadowDir)).toBeNull();

    const b = -moon.dot(shadowDir);
    const discriminant = b * b - (moon.dot(moon) - Globals.equatorRadius ** 2);
    expect(discriminant).toBeGreaterThanOrEqual(0);
    expect(b - Math.sqrt(discriminant)).toBeLessThan(0);
});

test("rebuild() during a lunar eclipse does not throw", () => {
    setSky(LUNAR_ECLIPSE);
    const node = makeShadowNode();
    expect(() => node.rebuild()).not.toThrow();
    // The cone is drawn as at any other full moon, pointing away from the Earth,
    // and nothing lands on the ground.
    expect(node.umbraConeMesh).toBeTruthy();
    expect(node.umbraLine).toBeFalsy();
    expect(node.penumbraLine).toBeFalsy();
});

test("update() keeps working across a lunar eclipse", () => {
    const node = makeShadowNode();
    for (const date of [PLAIN_FULL_MOON, LUNAR_ECLIPSE, PLAIN_FULL_MOON]) {
        setSky(date);
        expect(() => node.update(0)).not.toThrow();
    }
});

test("a solar eclipse still puts the umbra on the ground", () => {
    setSky(SOLAR_ECLIPSE);
    const node = makeShadowNode();
    expect(() => node.rebuild()).not.toThrow();
    expect(node.umbraConeMesh).toBeTruthy();
    expect(node.umbraLine).toBeTruthy();
    expect(node.penumbraLine).toBeTruthy();
});
