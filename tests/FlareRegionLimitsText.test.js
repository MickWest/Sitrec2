/** @jest-environment jsdom */
// The Flare Region tooltip and docs state the limits of the region calculation: it assumes a
// flat Earth-facing surface at one altitude (550 km, Starlink), it does not check the Flare
// Band, and it marks the best match even when no reflection is close. These tests check that
// the text says so, and that the calculation (updateFlareRegion) still does what the text says.
import fs from "fs";
import path from "path";
import {Group, Sphere, Vector3} from "three";
import {CNodeDisplayNightSky} from "../src/nodes/CNodeDisplayNightSky";
import {CSatellite} from "../src/nodes/CSatellite";
import {Globals, setNodeMan} from "../src/Globals";
import {disposeDebugArrows, disposeDebugSpheres} from "../src/threeExt";
import {wgs84} from "../src/LLA-ECEF-ENU";
import {degrees} from "../src/utils";
import en from "../src/i18n/en";

const STATED_ALTITUDE = 550000; // meters, as the tooltip and docs state

function docsRow() {
    const docs = fs.readFileSync(path.resolve(__dirname, "../docs/Satellites.md"), "utf8");
    return docs.split("\n").find(line => line.startsWith("| **Flare Region** |"));
}

// A night-sky node with only what updateFlareRegion needs, and the real satellite normal
function makeNightSky(cameraPos, toSun, flareModel) {
    const node = Object.create(CNodeDisplayNightSky.prototype);
    node.flareRegionGroup = new Group();
    node.showFlareRegion = true;
    node.showFlareRegionLook = false;
    node.camera = {position: cameraPos};
    node.globe = new Sphere(new Vector3(0, 0, 0), wgs84.POLAR_RADIUS);
    node.satellites = Object.create(CSatellite.prototype);
    node.satellites.flareModel = flareModel;
    setNodeMan({get: () => ({camera: {position: cameraPos}})});
    Globals.toSun = toSun.clone().normalize();
    return node;
}

// The marked point: the center of the region's sphere (the one child with a scale)
function markedPoint(node) {
    const sphere = node.flareRegionGroup.children.find(child => child.scale.x > 1000);
    return sphere.position.clone();
}

// Angle between the camera's ray reflected at the point and the direction to the Sun
function glintAngle(node, X) {
    const normal = node.satellites.getSatelliteNormal(X, node.globe.center);
    const reflected = X.clone().sub(node.camera.position).reflect(normal).normalize();
    return degrees(Math.acos(reflected.dot(Globals.toSun)));
}

afterEach(() => {
    disposeDebugArrows();
    disposeDebugSpheres();
});

test("the tooltip states the Starlink geometry and the Flare Band limit", () => {
    const tooltip = en.nightSky.flareRegion.tooltip;
    expect(tooltip).toMatch(/flat surface that faces the Earth/);
    expect(tooltip).toMatch(/one altitude of 550 km/);
    expect(tooltip).toMatch(/does not check the Flare Band/);
    expect(tooltip).toMatch(/valid only when the camera is inside the Flare Band/);
});

test("the docs state the same limits", () => {
    const row = docsRow();
    expect(row).toMatch(/flat surface that faces the Earth/);
    expect(row).toMatch(/one altitude of 550 km/);
    expect(row).toMatch(/does not check the Flare Band/);
    expect(row).toMatch(/valid only when the camera is inside the Flare Band/);
});

test.each(["Geocentric Nadir", "Geodetic Nadir"])(
    "the region is at one altitude of 550 km on an Earth-facing surface (%s)", (flareModel) => {
        // A camera on the equator at night, the Sun 40 degrees below its horizon
        const cameraPos = new Vector3(wgs84.RADIUS + 100, 0, 0);
        const toSun = new Vector3(-Math.sin(Math.PI * 40 / 180), Math.cos(Math.PI * 40 / 180), 0);
        const node = makeNightSky(cameraPos, toSun, flareModel);
        node.updateFlareRegion(0, 0, new Date("2026-03-20T00:00:00Z"));

        const X = markedPoint(node);
        expect(Math.abs(X.length() - (wgs84.RADIUS + STATED_ALTITUDE))).toBeLessThan(1);

        // The reflecting surface is perpendicular to the down direction: within 0.2 degrees of it
        const normal = node.satellites.getSatelliteNormal(X, node.globe.center);
        expect(degrees(normal.angleTo(X.clone().normalize()))).toBeLessThan(0.2);
    });

test("outside the Flare Band the region is still marked, though no reflection is close", () => {
    // Daytime: the Sun is high in the sky, so no Earth-facing surface can reflect it to the camera
    const cameraPos = new Vector3(wgs84.RADIUS + 100, 0, 0);
    const toSun = new Vector3(1, 0.3, 0);
    const node = makeNightSky(cameraPos, toSun, "Geocentric Nadir");
    node.updateFlareRegion(0, 0, new Date("2026-03-20T12:00:00Z"));

    const X = markedPoint(node);
    expect(glintAngle(node, X)).toBeGreaterThan(45);
});
