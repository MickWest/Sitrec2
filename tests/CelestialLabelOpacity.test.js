/** @jest-environment jsdom */
// Show > Celestial > Labels > Label Opacity: the value that the night sky node saves, and
// the canvas alpha that the sky overlay draws the celestial names with.
import {Group, Matrix4, PerspectiveCamera, Sphere, Vector3} from "three";
import {CNodeDisplayNightSky} from "../src/nodes/CNodeDisplayNightSky";
import {CNodeDisplaySkyOverlay} from "../src/nodes/CNodeDisplaySkyOverlay";
import {raDec2Celestial} from "../src/CelestialMath";
import {setSit} from "../src/Globals";
import {par} from "../src/par";
import en from "../src/i18n/en";
import GUI from "../src/js/lil-gui.esm";
import "../src/lil-gui-extras";

// One direction holds a star, a planet, a constellation name and a satellite, and the
// camera looks at it, so every kind of name is inside the view.
const RA = 1.0, DEC = 0.5;
const DATE = new Date("2024-01-01T00:00:00Z");
// The Earth test needs a sphere. This one is not on any line of sight.
const NO_EARTH = new Sphere(new Vector3(1e12, 0, 0), 1);

// A night sky node as the constructor leaves it, without the scene and the menus.
function sky() {
    const n = Object.create(CNodeDisplayNightSky.prototype);
    n.simpleSerials = ["celestialLabelOpacity"];
    n.celestialLabelOpacity = 1;
    for (const key of ["constellationsGroup", "equatorialSphereGroup", "azimuthalSphereGroup", "sunArrowGroup",
        "flareRegionGroup", "flareBandGroup", "satelliteGroup", "satelliteTrackGroup",
        "satelliteFlareTracksGroup", "satelliteGroundGroup"]) n[key] = new Group();
    n.celestialElements = {setLineWidth() {}};
    n.satellites = {filterSatellites() {}};
    n.updateStarPlanetVisibility = () => {};
    n.updateCelestialVectorVisibility = () => {};
    return n;
}

// A sky overlay with a recording canvas context. Each drawn name keeps the alpha and the
// fill color that the canvas had at that moment.
function overlayAt(opacity) {
    const position = raDec2Celestial(RA, DEC, 100);
    const camera = new PerspectiveCamera(60, 4 / 3, 1, 1000);
    camera.lookAt(position);
    camera.updateMatrixWorld(true);
    const drawn = [];
    const ctx = {
        globalAlpha: 1, fillStyle: "", strokeStyle: "", font: "", textAlign: "left",
        fillText(text) { drawn.push({text, alpha: this.globalAlpha, fillStyle: this.fillStyle}); },
    };
    const satellite = {name: "ISS (ZARYA)", visible: true, invalidPosition: false, ecef: position.clone()};
    const overlay = Object.assign(Object.create(CNodeDisplaySkyOverlay.prototype), {
        ctx, onlyLabelPlanets: false, _renderedRect: {x: 0, y: 0, w: 800, h: 600},
        overlayView: {id: "lookView", camera},
        nightSky: {
            celestialLabelOpacity: opacity,
            labelListPrefixes: null,
            maxLabelsDisplayed: 1000,
            celestialSphere: {matrix: new Matrix4()},
            starField: {
                commonNames: {1: "Vega"},
                getStarMagnitude: () => 0, getStarRA: () => RA, getStarDEC: () => DEC,
            },
            planets: {planetSprites: {Jupiter: {equatorial: position.clone(), color: "#FFFF80"}}},
            satellites: {renderTLEData: {satData: [satellite]}, arrowRange: 1000},
        },
    });
    overlay.constellationLabels = () => [{name: "Lyra", ra: RA, dec: DEC, pos: position.clone()}];
    const drawStarNames = (starAlpha = 1) => overlay.drawAtCelestialLabelOpacity(
        () => overlay.renderStarNames(camera, NO_EARTH, new Vector3(), DATE, starAlpha));
    const drawConstellationNames = () => overlay.drawAtCelestialLabelOpacity(
        () => overlay.renderConstellationNames(camera, NO_EARTH, new Vector3(), DATE));
    const drawSatelliteNames = (starAlpha = 1) => overlay.drawAtCelestialLabelOpacity(
        () => overlay.renderSatelliteNames(camera, NO_EARTH, starAlpha));
    return {ctx, drawn, satellite, drawStarNames, drawConstellationNames, drawSatelliteNames};
}

// jsdom has no matchMedia, and a lil-gui number control asks it for the pointer type.
window.matchMedia ??= () => ({matches: false, addEventListener() {}, removeEventListener() {}});

beforeAll(() => setSit({starLimit: 6.5}));

test("the slider has a label and a tooltip", () => {
    expect(en.nightSky.celestialLabelOpacity.label).toBeTruthy();
    expect(en.nightSky.celestialLabelOpacity.tooltip).toBeTruthy();
});

test("a save with no value keeps full opacity, and a saved value is restored and written again", () => {
    const n = sky();
    n.modDeserialize({});
    expect(n.celestialLabelOpacity).toBe(1);
    n.modDeserialize({celestialLabelOpacity: 0.35});
    expect(n.celestialLabelOpacity).toBe(0.35);
    expect(n.modSerialize()).toMatchObject({celestialLabelOpacity: 0.35});
    // 0 is a value, not "no value".
    n.modDeserialize({celestialLabelOpacity: 0});
    expect(n.celestialLabelOpacity).toBe(0);
});

test("the slider is in the celestial Labels folder, with a mirror in the satellite Labels folder", () => {
    const show = new GUI();
    const satelliteMenu = new GUI();
    const n = sky();
    n.labelsGUI = show.addFolder("Labels");
    n.satelliteLabelsGUI = satelliteMenu.addFolder("Labels");
    const slider = n.addLabelOpacityControls();
    const mirror = n.satelliteLabelsGUI.controllers.find(c => c.property === "celestialLabelOpacity");
    expect(n.labelsGUI.controllers).toContain(slider);
    for (const control of [slider, mirror]) {
        expect(control._name).toBe(en.nightSky.celestialLabelOpacity.label);
        expect([control._min, control._max, control._step]).toEqual([0, 1, 0.01]);
    }
    // The mirror writes the one value and runs the onChange of the slider, which asks for a render.
    par.renderOne = false;
    mirror.setValue(0.4);
    expect(n.celestialLabelOpacity).toBe(0.4);
    expect(par.renderOne).toBeTruthy();
    slider.setValue(0.7);
    expect(mirror.getValue()).toBe(0.7);
    show.destroy();
    satelliteMenu.destroy();
});

test.each([1, 0.5, 0.25])("constellation, star, planet and satellite names are drawn at opacity %s", opacity => {
    const {ctx, drawn, drawStarNames, drawConstellationNames, drawSatelliteNames} = overlayAt(opacity);
    drawConstellationNames();
    drawStarNames();
    drawSatelliteNames();
    // The fill colors are the ones the names had before the slider: the opacity is in the alpha.
    expect(drawn).toEqual([
        {text: "Lyra", alpha: opacity, fillStyle: "#a8a8a8"},
        {text: "Vega", alpha: opacity, fillStyle: "#ffffffff"},
        {text: "Jupiter", alpha: opacity, fillStyle: "#FFFF80ff"},
        {text: "ISS (ZARYA)", alpha: opacity, fillStyle: "#ffffffff"},
    ]);
    // What the overlay draws next (track labels, measurements) is not changed.
    expect(ctx.globalAlpha).toBe(1);
});

test("the opacity multiplies the twilight fade and an alpha that is already set", () => {
    const {ctx, drawn, drawStarNames, drawSatelliteNames} = overlayAt(0.5);
    ctx.globalAlpha = 0.8;
    drawStarNames(0.5);
    drawSatelliteNames(0.5);
    expect(drawn.map(name => name.text)).toEqual(["Vega", "Jupiter", "ISS (ZARYA)"]);
    for (const name of drawn) {
        expect(name.alpha).toBeCloseTo(0.4, 12);
        expect(name.fillStyle.slice(-2)).toBe("7f");   // the twilight fade, as before
    }
    expect(ctx.globalAlpha).toBe(0.8);
});

test("at opacity 0 the names are invisible, and the look view still records the satellites it sees", () => {
    const {ctx, drawn, satellite, drawStarNames, drawConstellationNames, drawSatelliteNames} = overlayAt(0);
    drawConstellationNames();
    drawStarNames();
    drawSatelliteNames();
    // A canvas paints nothing at alpha 0.
    expect(drawn.map(name => name.alpha)).toEqual([0, 0, 0, 0]);
    // Label Look Visible Only and the satellite arrows read this flag.
    expect(satellite.visibleInLook).toBe(true);
    expect(ctx.globalAlpha).toBe(1);
});
