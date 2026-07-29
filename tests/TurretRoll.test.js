/**
 * Az-el ball turret image roll — src/TurretRoll.js
 *
 * The expected values here are not invented for the test: they come from three
 * independent derivations that were cross-checked against each other and against
 * Sitrec's own legacy roll-nod chain (JetHorizon.js) and human-horizon function
 * (JetUtils.js). The limiting cases below are the ones that distinguish an az-el
 * ball turret from ATFLIR's roll-nod pod, so they are the real regression guards.
 */

import {Vector3} from "three";
import {aircraftUpVector, azElTurretImageRoll} from "../src/TurretRoll";

const D = Math.PI / 180;
const deg = r => r * 180 / Math.PI;

// A flat test world matching the legacy local frame: +Y up, -Z forward, +X right.
// TurretRoll is coordinate-free, so this is just a convenient chart.
const WORLD_UP = new Vector3(0, 1, 0);

// LOS in the AIRCRAFT body frame, then rotated into the world by the aircraft's
// attitude — mirrors how the shipped code will feed it (vectors, not Euler angles).
function bodyLOS(azDeg, elDeg) {
    return new Vector3(
        Math.cos(elDeg * D) * Math.sin(azDeg * D),
        Math.sin(elDeg * D),
        -Math.cos(elDeg * D) * Math.cos(azDeg * D),
    );
}

// Aircraft frame for a given pitch and bank, in the flat test world.
function aircraft(pitchDeg, bankDeg) {
    const forward = new Vector3(0, 0, -1).applyAxisAngle(new Vector3(1, 0, 0), pitchDeg * D);
    const up = aircraftUpVector(forward, WORLD_UP, bankDeg * D);
    return {forward, up};
}

// Put a body-frame LOS into the world for that aircraft.
function worldLOS(pitchDeg, bankDeg, azDeg, elDeg) {
    const {forward, up} = aircraft(pitchDeg, bankDeg);
    const right = new Vector3().crossVectors(forward, up).normalize();
    const v = bodyLOS(azDeg, elDeg);
    // body (x=right, y=up, z=back) -> world
    return new Vector3()
        .addScaledVector(right, v.x)
        .addScaledVector(up, v.y)
        .addScaledVector(forward.clone().normalize(), -v.z);
}

function rollDeg(pitchDeg, bankDeg, azDeg, elDeg) {
    const {up} = aircraft(pitchDeg, bankDeg);
    const r = azElTurretImageRoll(worldLOS(pitchDeg, bankDeg, azDeg, elDeg), up, WORLD_UP);
    return r === null ? null : deg(r);
}

describe("azElTurretImageRoll — the cases that define an az-el turret", () => {
    // THE signature property. A ball turret in level flight needs no derotation at
    // all; this is what makes it different from ATFLIR, whose pod roll tilts the
    // image for almost every look angle.
    // NOTE the elevation range stops short of +/-90 deliberately: AT exactly +/-90 the
    // line of sight lies along the mount's azimuth axis (the keyhole) and the function
    // returns null, which is a different thing from "zero roll". That case is covered
    // in the singularities block below.
    test("wings level and level pitch gives exactly zero roll at every az, |el| < 90", () => {
        for (let az = -180; az <= 180; az += 15) {
            for (let el = -80; el <= 80; el += 10) {
                expect(rollDeg(0, 0, az, el)).toBeCloseTo(0, 6);
            }
        }
    });

    // The world-up tilt lies along the line of sight when looking abeam at zero
    // elevation, so it cannot project into the image however hard the aircraft banks.
    test("looking abeam at zero elevation gives zero roll regardless of bank", () => {
        for (const bank of [10, 30, 60, -45]) {
            expect(rollDeg(0, bank, 90, 0)).toBeCloseTo(0, 6);
            expect(rollDeg(0, bank, -90, 0)).toBeCloseTo(0, 6);
        }
    });

    // ...but that rule is elevation-limited, and the limit is real geometry, not a
    // bug: depressing far enough abeam sweeps the LOS through world-nadir, and past
    // that point the level-up reference inverts, so the image really is upside down.
    test("abeam and steeply depressed, the roll flips through the world vertical", () => {
        expect(rollDeg(0, 30, 90, -59)).toBeCloseTo(0, 4);
        expect(rollDeg(0, 30, 90, -60)).toBeNull();       // LOS is exactly world-vertical
        expect(Math.abs(rollDeg(0, 30, 90, -61))).toBeCloseTo(180, 4);
        expect(Math.abs(rollDeg(0, 30, 90, -80))).toBeCloseTo(180, 4);
    });

    // Straight ahead, the turret's vertical and the roll-nod pod's roll axis put the
    // image up in the same place, so the two gimbal types agree exactly.
    test("looking straight ahead the roll equals the bank", () => {
        for (const bank of [0, 15, 30, -25]) {
            expect(rollDeg(0, bank, 0, 0)).toBeCloseTo(bank, 6);
        }
    });

    test("roll reverses sign with the bank", () => {
        const right = rollDeg(0, 30, 40, -20);
        const left = rollDeg(0, -30, -40, -20);
        expect(right).toBeCloseTo(-left, 6);
    });

    // Cross-implementation regression. These values come from an INDEPENDENT closed
    // form derived separately from this code:
    //     roll = atan2( -(sin(bank)cos(pitch)cos(az) + sin(pitch)sin(az)),
    //                    cos(pitch)cos(bank)cos(el)
    //                    + sin(el)(sin(bank)cos(pitch)sin(az) - sin(pitch)cos(az)) )
    // reported there as -28.2 .. -63.8 deg in a clockwise-positive convention, i.e.
    // the negation of Sitrec's. Agreement to 3-4 significant figures across the
    // sweep is the strongest single check that this file is right.
    //
    // Note the roll never changes sign: the closed form's numerator is independent
    // of elevation, so elevation only foreshortens the result.
    test("matches an independently derived closed form across elevation", () => {
        const expected = {
            "-60": 63.8499, "-40": 42.8082, "-20": 33.0320,
            "0": 28.9083, "20": 28.1954, "40": 30.5418,
        };
        for (const [el, want] of Object.entries(expected)) {
            expect(rollDeg(10, 30, 45, Number(el))).toBeCloseTo(want, 3);
        }
        // right bank => positive in Sitrec's convention, at every elevation
        const rolls = Object.keys(expected).map(el => rollDeg(10, 30, 45, Number(el)));
        for (const r of rolls) expect(r).toBeGreaterThan(0);
        // and it genuinely varies — this is not a constant
        expect(Math.max(...rolls) - Math.min(...rolls)).toBeGreaterThan(5);
    });

    test("pitch alone induces roll once off the nose", () => {
        expect(rollDeg(15, 0, 0, 0)).toBeCloseTo(0, 6);   // still symmetric ahead
        expect(Math.abs(rollDeg(15, 0, 60, -10))).toBeGreaterThan(1);
    });
});

describe("singularities", () => {
    // The ball-turret nadir keyhole: looking along the turret's own azimuth axis,
    // azimuth is indeterminate. Real limitation of the gimbal, not a maths artefact.
    test("returns null looking straight down the aircraft's vertical", () => {
        const {up} = aircraft(0, 0);
        expect(azElTurretImageRoll(up.clone().negate(), up, WORLD_UP)).toBeNull();
        expect(azElTurretImageRoll(up.clone(), up, WORLD_UP)).toBeNull();
    });

    // Distinct from the keyhole: the horizon itself has no orientation when the LOS
    // is world-vertical, so the level reference is undefined.
    test("returns null when the line of sight is world-vertical", () => {
        const {up} = aircraft(0, 30);          // banked, so aircraft up != world up
        const los = WORLD_UP.clone().negate();  // straight down in the WORLD
        expect(azElTurretImageRoll(los, up, WORLD_UP)).toBeNull();
    });

    test("stays finite very close to, but not at, the keyhole", () => {
        const r = rollDeg(0, 30, 45, -89.5);
        expect(r).not.toBeNull();
        expect(Number.isFinite(r)).toBe(true);
    });

    // A guard whose threshold is scaled by the input lengths cannot catch a
    // zero-length input: the threshold becomes zero too and `0 < 0` is false. These
    // degenerate cases must be rejected explicitly, or a duplicate track sample
    // (zero velocity) reads as a roll of 0 — indistinguishable from level flight.
    describe("degenerate inputs return null, not zero", () => {
        const UP = new Vector3(0, 1, 0);
        const LOS = new Vector3(0, 0, -1);

        test.each([
            ["zero-length los", new Vector3(0, 0, 0), UP, WORLD_UP],
            ["zero-length aircraftUp", LOS, new Vector3(0, 0, 0), WORLD_UP],
            ["zero-length worldUp", LOS, UP, new Vector3(0, 0, 0)],
            ["NaN in los", new Vector3(NaN, 0, 0), UP, WORLD_UP],
            ["NaN in aircraftUp", LOS, new Vector3(0, NaN, 0), WORLD_UP],
            ["Infinity in los", new Vector3(Infinity, 0, 0), UP, WORLD_UP],
        ])("%s", (_label, los, acUp, wUp) => {
            expect(azElTurretImageRoll(los, acUp, wUp)).toBeNull();
        });

        test("aircraftUpVector rejects a zero or non-finite forward", () => {
            expect(aircraftUpVector(new Vector3(0, 0, 0), WORLD_UP, 0)).toBeNull();
            expect(aircraftUpVector(new Vector3(NaN, 0, -1), WORLD_UP, 0)).toBeNull();
            expect(aircraftUpVector(new Vector3(0, 0, -1), WORLD_UP, NaN)).toBeNull();
        });
    });

    // A caller updating in place (out === forward) must still get a banked result:
    // writing to `out` first would destroy `forward` before the bank axis is read.
    test("aircraftUpVector is safe when out aliases forward", () => {
        const forward = new Vector3(0, 0, -1);
        const result = aircraftUpVector(forward, WORLD_UP, 30 * D, forward);
        expect(result.x).toBeCloseTo(0.5, 6);
        expect(result.y).toBeCloseTo(Math.cos(30 * D), 6);
        expect(result.z).toBeCloseTo(0, 6);
    });
});

describe("aircraftUpVector", () => {
    test("with no bank it is perpendicular to forward and in the vertical plane", () => {
        const up = aircraftUpVector(new Vector3(0, 0, -1), WORLD_UP, 0);
        expect(up.dot(new Vector3(0, 0, -1))).toBeCloseTo(0, 9);
        expect(up.x).toBeCloseTo(0, 9);
        expect(up.y).toBeCloseTo(1, 9);
    });

    test("banking right leans the up vector to the aircraft's right", () => {
        const up = aircraftUpVector(new Vector3(0, 0, -1), WORLD_UP, 30 * D);
        expect(up.x).toBeGreaterThan(0);            // toward +X = starboard
        expect(up.y).toBeCloseTo(Math.cos(30 * D), 6);
        expect(up.length()).toBeCloseTo(1, 9);
    });

    test("pitch is carried by forward, needing no explicit pitch angle", () => {
        const forward = new Vector3(0, 0, -1).applyAxisAngle(new Vector3(1, 0, 0), 20 * D);
        const up = aircraftUpVector(forward, WORLD_UP, 0);
        expect(up.dot(forward)).toBeCloseTo(0, 9);
        expect(up.y).toBeCloseTo(Math.cos(20 * D), 6);
    });

    test("returns null in vertical flight, where bank is meaningless", () => {
        expect(aircraftUpVector(WORLD_UP.clone(), WORLD_UP, 0)).toBeNull();
        expect(aircraftUpVector(WORLD_UP.clone().negate(), WORLD_UP, 0)).toBeNull();
    });
});
