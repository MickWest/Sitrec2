/**
 * venusEphemerisContract.test.js — the celestial scenario's bearings must be
 * the REAL SKY at the site and epoch that scenario.json publishes.
 *
 * The interchange release hardens sealed sets with a salt-derived rigid
 * transform (rotate about the vertical, translate horizontally) so the target
 * no longer sits at the published ENU origin. Neither operation is safe here:
 *
 *   - ROTATION shifts Venus's azimuth while keeping its elevation, so the
 *     shipped sightlines contradict any ephemeris.
 *   - TRANSLATION buys nothing (a direction-kind target has no finite truth
 *     position to hide, so both extraction attacks already return Infinity)
 *     and costs real fidelity: the shipped bearings are in the ENU basis at
 *     originLLA, while a celestial consumer naturally works in the sensor's
 *     own local basis, and those diverge with distance from the origin.
 *     Measured at a 30 km offset: 0.163 deg = 5.4x the declared 0.03 deg
 *     pointing sigma.
 *
 * So celestial scenarios get no transform at all, and this test pins that
 * against an INDEPENDENT ephemeris call rather than against the generator.
 */

import fs from "fs";
import os from "os";
import path from "path";
import {Vector3} from "three";
import {setSit} from "../../src/Globals";
import {getCelestialDirection} from "../../src/CelestialMath";
import {LLAToECEF, ECEFToLLAVD_radii} from "../../src/LLA-ECEF-ENU";
import {enuBasisAt} from "../../src/TrackExportMath";
import {buildRelease} from "../../benchmarks/botbench/lib/interchangeRelease";

const SALT = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

function angleDeg(a, b) {
    const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const cr = Math.hypot(
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    );
    return Math.atan2(cr, dot) * 180 / Math.PI;
}

describe("celestial ephemeris contract", () => {
    jest.setTimeout(120000);
    let tmpRoot;

    beforeAll(() => {
        setSit({name: "venus-contract", frames: 10000, fps: 10,
            simSpeed: 1, lat: 40, lon: -105});
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "venus-contract-"));
    });
    afterAll(() => {
        if (tmpRoot) fs.rmSync(tmpRoot, {recursive: true, force: true});
    });

    for (const sealed of [false, true]) {
        test(`${sealed ? "sealed" : "development"} release: bearings match an `
            + "independent ephemeris at originLLA", () => {
            const rel = buildRelease({
                outDir: path.join(tmpRoot, sealed ? "sealed" : "dev"),
                sealed, saltHex: sealed ? SALT : null,
            });

            const celestial = rel.index.filter((r) => r.truthKind === "direction");
            expect(celestial.length).toBeGreaterThan(0);

            for (const r of celestial) {
                const sj = JSON.parse(fs.readFileSync(
                    path.join(rel.challengeDir, "input", `${r.name}.scenario.json`), "utf8"));
                const [lat, lon, alt] = sj.frame.originLLA;
                // The frame contract must be stated, not left to be guessed.
                expect(sj.frame.directionBasis).toBe("originLLA");

                const epochMs = Date.parse(sj.epochISO);
                const o = LLAToECEF(lat, lon, alt);
                const {east, north, up} = enuBasisAt(lat, lon);
                const rows = fs.readFileSync(
                    path.join(rel.answersDir, "truth", `${r.name}.truth.csv`), "utf8")
                    .trim().split("\n").slice(1);

                let maxDeg = 0;
                for (const line of rows) {
                    const c = line.split(",");
                    const d = getCelestialDirection("Venus",
                        new Date(epochMs + Number(c[1]) * 1000), new Vector3(o.x, o.y, o.z));
                    maxDeg = Math.max(maxDeg, angleDeg(
                        [d.dot(east), d.dot(north), d.dot(up)],
                        [Number(c[2]), Number(c[3]), Number(c[4])]));
                }
                // Independent ephemeris agreement, far below any pointing sigma.
                expect(maxDeg).toBeLessThan(1e-4);
            }
        });
    }

    // A conditioning VERDICT only means something where a range exists to be
    // conditioned. A direction-truth target has none, and its LOS series is
    // near-singular for that reason rather than from weak geometry — so a
    // populated bucket would bin it with the straight-platform cells.
    test("no-range truth emits no conditioning verdict", () => {
        const rel = buildRelease({
            outDir: path.join(tmpRoot, "applicability"), sealed: true, saltHex: SALT,
        });

        let sawDirection = false, sawPosition = false;
        for (const r of rel.index) {
            const g = JSON.parse(fs.readFileSync(
                path.join(rel.answersDir, "truth", `${r.name}.truth.json`), "utf8")).geometry;

            // Applicability must track the structural fact, not be set by hand.
            expect(g.cvConditioningApplicable).toBe(g.rangeDefined);

            if (g.rangeDefined) {
                sawPosition = true;
                expect(g.cvConditioningBucket)
                    .toMatch(/^(well-posed|marginal|degenerate)$/);
            } else {
                sawDirection = true;
                expect(g.cvConditioningBucket).toBeNull();
                // The raw diagnostic still ships — it is a real measurement of
                // the LOS series — but carries no verdict.
                expect(Number.isFinite(g.cvDesignLog10RcondObserved)).toBe(true);
            }
        }
        // Both branches must actually be exercised, or this proves nothing.
        expect(sawDirection).toBe(true);
        expect(sawPosition).toBe(true);
    });

    test("celestial scenarios receive no rigid placement", () => {
        const rel = buildRelease({
            outDir: path.join(tmpRoot, "placement"), sealed: true, saltHex: SALT,
        });
        const venus = rel.realized.find((r) => r.scenario.target.kind === "direction");
        expect(venus).toBeDefined();
        expect(venus.placement).toEqual({psiRad: 0, dE: 0, dN: 0});
        // Non-celestial scenarios must still be placed, or the hardening is off.
        const other = rel.realized.filter((r) => r.scenario.target.kind !== "direction");
        expect(other.every((r) => r.placement.psiRad !== 0)).toBe(true);
    });

    // The sensor-local basis reading is the WRONG reading — frame.directionBasis
    // says originLLA, and the test above shows that reading agrees with an
    // independent ephemeris to 1e-5 deg. But the divergence is worth pinning,
    // because it is what translation cost us: 0.163 deg (5.4 sigma) at a 30 km
    // offset versus 0.041 deg once the celestial scene stays put.
    //
    // The residual is INHERENT to a single flat tangent frame, not a defect:
    // the local vertical tilts by about d/R_earth, so the divergence is fixed
    // by how far the sensor ranges from the origin. Bounding it by that
    // geometric prediction (rather than a magic constant) pins the mechanism
    // and still fails loudly if a transform ever moves the scene again.
    test("the sensor-local basis divergence is no worse than the frame tilt", () => {
        const rel = buildRelease({
            outDir: path.join(tmpRoot, "basis"), sealed: true, saltHex: SALT,
        });
        for (const r of rel.index.filter((x) => x.truthKind === "direction")) {
            const sj = JSON.parse(fs.readFileSync(
                path.join(rel.challengeDir, "input", `${r.name}.scenario.json`), "utf8"));
            const [lat, lon, alt] = sj.frame.originLLA;
            const o = LLAToECEF(lat, lon, alt);
            const {east, north, up} = enuBasisAt(lat, lon);
            const i0 = fs.readFileSync(
                path.join(rel.challengeDir, "input", `${r.name}.input.csv`), "utf8")
                .split("\n")[1].split(",");
            const [sE, sN, sU] = [Number(i0[4]), Number(i0[5]), Number(i0[6])];
            const sEcef = new Vector3(
                o.x + east.x * sE + north.x * sN + up.x * sU,
                o.y + east.y * sE + north.y * sN + up.y * sU,
                o.z + east.z * sE + north.z * sN + up.z * sU);
            const sLLA = ECEFToLLAVD_radii(sEcef);
            const bs = enuBasisAt(sLLA.x, sLLA.y);
            const d = getCelestialDirection("Venus", new Date(Date.parse(sj.epochISO)), sEcef);

            const t0 = fs.readFileSync(
                path.join(rel.answersDir, "truth", `${r.name}.truth.csv`), "utf8")
                .split("\n")[1].split(",");
            const shipped = [Number(t0[2]), Number(t0[3]), Number(t0[4])];
            const sensorBasis = angleDeg(
                [d.dot(bs.east), d.dot(bs.north), d.dot(bs.up)], shipped);

            // Pure tangent-frame tilt for this sensor's offset from the origin.
            const offsetM = Math.hypot(sE, sN);
            const tiltDeg = Math.atan2(offsetM, 6371000) * 180 / Math.PI;
            expect(sensorBasis).toBeLessThanOrEqual(1.5 * tiltDeg);

            // And the offset itself must stay at scenario scale — a translated
            // celestial scene would blow both this and the divergence up.
            expect(offsetM).toBeLessThan(15000);
        }
    });
});
