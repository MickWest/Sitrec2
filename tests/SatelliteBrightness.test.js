import {satelliteAppearance} from "../src/SatelliteBrightness";
import {KUIPER_PHOTOMETRY, satelliteFlux} from "../tools/shf/satellitePhotometry.js";

const EARTH_RADIUS_M = 6371e3;
const settings = {flareModel: "Geocentric Nadir", starlinkProfile: "unknown"};

// A satellite 637 km above +x, whose reflecting panel faces straight down, and an
// observer 22 degrees of arc away. The Sun sits `glintDeg` off the mirror direction.
const position = {x: EARTH_RADIUS_M + 637e3, y: 0, z: 0};
const arc = 22 * Math.PI / 180;
const observer = {x: EARTH_RADIUS_M * Math.cos(arc), y: EARTH_RADIUS_M * Math.sin(arc), z: 0};

function sunAtGlint(glintDeg) {
    const dx = position.x - observer.x, dy = position.y - observer.y;
    const length = Math.hypot(dx, dy);
    const mirrorX = -dx / length, mirrorY = dy / length;
    const angle = glintDeg * Math.PI / 180;
    return {
        x: mirrorX * Math.cos(angle) - mirrorY * Math.sin(angle),
        y: mirrorX * Math.sin(angle) + mirrorY * Math.cos(angle),
        z: 0,
    };
}

function magnitude(satData, glintDeg, options = settings) {
    return satelliteAppearance(satData, position, observer, sunAtGlint(glintDeg), 1, options).magnitude;
}

const kuiper = {name: "KUIPER-00128", number: 63000};
const starlink = {name: "STARLINK-32361", number: 58000};
const generic = {name: "COSMOS 2612", number: 60000};

describe("satellite photometric classes", () => {
    test("the test geometry gives the requested glint angle", () => {
        const appearance = satelliteAppearance(kuiper, position, observer, sunAtGlint(3), 1, settings);
        expect(appearance.glintAngleDeg).toBeCloseTo(3, 6);
    });

    test("a Kuiper satellite flares near the mirror direction", () => {
        expect(magnitude(kuiper, 3)).toBeLessThan(magnitude(kuiper, 70) - 3);
    });

    test("a Kuiper satellite combines the assumed flare curve with its own diffuse reference", () => {
        const {flareProfile, diffuseMagnitudeAt90Deg} = KUIPER_PHOTOMETRY;
        const {flux, rangeM, phaseAngleRad, glintAngleDeg} =
            satelliteAppearance(kuiper, position, observer, sunAtGlint(70), 1, settings);
        expect(flux).toBe(satelliteFlux(
            {rangeM, phaseAngleRad, glintAngleDeg, flareProfile, diffuseMagnitudeAt90Deg}));
    });

    test("a generic satellite gets only the diffuse estimate, even at the mirror direction", () => {
        const appearance = satelliteAppearance(generic, position, observer, sunAtGlint(0), 1, settings);
        expect(appearance.flux).toBe(satelliteFlux(
            {rangeM: appearance.rangeM, phaseAngleRad: appearance.phaseAngleRad}));
    });

    test("the Starlink Design setting changes a Starlink but not a Kuiper satellite", () => {
        const mini = {...settings, starlinkProfile: "mini"};
        const visor = {...settings, starlinkProfile: "visor"};
        expect(magnitude(starlink, 3, mini)).not.toBeCloseTo(magnitude(starlink, 3, visor), 2);
        expect(magnitude(kuiper, 3, mini)).toBe(magnitude(kuiper, 3, visor));
    });

    test("the ISS keeps its estimated reference", () => {
        const iss = {name: "ISS (ZARYA)", number: 25544};
        expect(magnitude(iss, 70)).toBeLessThan(magnitude(kuiper, 70) - 5);
    });
});
