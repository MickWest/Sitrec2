import {RCS_SIZE_AREA_M2, satelliteAppearance, standardMagnitude} from "../src/SatelliteBrightness";
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

describe("brightness from the catalog", () => {
    const perSatellite = {...settings, starlinkProfile: "catalog"};

    test("Per satellite takes each Starlink's design from the catalog", () => {
        const dtc = {...starlink, starlinkDesign: "v2md"};
        const visor = {...starlink, starlinkDesign: "visor"};
        expect(magnitude(dtc, 70, perSatellite)).toBe(magnitude(starlink, 70, {...settings, starlinkProfile: "dtc"}));
        expect(magnitude(visor, 70, perSatellite)).toBe(magnitude(starlink, 70, {...settings, starlinkProfile: "visor"}));
    });

    test("Per satellite treats a Starlink the catalog does not list as unknown", () => {
        expect(magnitude(starlink, 3, perSatellite)).toBe(magnitude(starlink, 3, settings));
    });

    test("a fixed design ignores the catalog design", () => {
        const mini = {...settings, starlinkProfile: "mini"};
        expect(magnitude({...starlink, starlinkDesign: "visor"}, 3, mini)).toBe(magnitude(starlink, 3, mini));
    });

    test("an object's brightness follows its catalog area, else its radar size class", () => {
        const flux = satData => satelliteAppearance(satData, position, observer, sunAtGlint(70), 1, settings).flux;
        const unsized = flux(generic);
        expect(flux({...generic, areaM2: 40}) / unsized).toBeCloseTo(40, 10);
        expect(flux({...generic, rcsSize: "SMALL"}) / unsized).toBeCloseTo(RCS_SIZE_AREA_M2.SMALL, 10);
        expect(flux({...generic, rcsSize: "LARGE", areaM2: 0.5}) / unsized).toBeCloseTo(0.5, 10);
        expect(flux({...generic, rcsSize: "N/A"})).toBe(unsized);
    });

    test("the standard magnitude is the 1000-km, 90-degree value without a flare", () => {
        // A Lambert sphere of 40 m² and reflectance 0.2: Sun magnitude -26.74,
        // geometric albedo 2/3 * 0.2, phase function 1/pi at 90 degrees.
        const expected = -26.74 - 2.5 * Math.log10((2 / 3) * 0.2 * (40 / Math.PI) / 1e12 / Math.PI);
        expect(standardMagnitude({...generic, areaM2: 40}, settings)).toBeCloseTo(expected, 10);
        expect(standardMagnitude(starlink, {...settings, starlinkProfile: "mini"})).toBeCloseTo(7.502, 3);
        expect(standardMagnitude({name: "ISS (ZARYA)", number: 25544, areaM2: 60}, settings)).toBeCloseTo(-2, 10);
    });
});
