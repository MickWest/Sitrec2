/** @jest-environment jsdom */
import {Group, Vector3} from "three";
import {CCelestialElements} from "../src/nodes/CCelestialElements";
import {CNodeDisplayNightSky} from "../src/nodes/CNodeDisplayNightSky";
import {MASK_LOOKRENDER, MASK_MAINRENDER} from "../src/LayerMasks";

test("horizontal coordinates follow each observer's east, north and zenith", () => {
    const elements = new CCelestialElements();
    const grid = new Group();
    for (const [observer, east, north, up] of [
        [[10, 0, 0], [0, 1, 0], [0, 0, 1], [1, 0, 0]],
        [[0, 10, 0], [-1, 0, 0], [0, 0, 1], [0, 1, 0]],
        [[0, 0, 10], [0, 1, 0], [-1, 0, 0], [0, 0, 1]],
    ]) {
        elements.orientAzimuthalGrid(grid, new Vector3(...observer), 10, 10);
        for (const [local, world] of [[[1, 0, 0], east], [[0, 1, 0], north], [[0, 0, 1], up]]) {
            expect(new Vector3(...local).applyQuaternion(grid.quaternion).distanceTo(new Vector3(...world))).toBeLessThan(1e-12);
        }
    }
});

test("both grids share width controls and dispose their lines from their actual parents", () => {
    const elements = new CCelestialElements();
    const equatorial = new Group(), azimuthal = new Group();
    elements.addCelestialSphereLines(equatorial, 10);
    elements.addAzimuthalSphereLines(azimuthal, 10);
    expect(azimuthal.children).toHaveLength(55); // 36 azimuths and 19 elevations
    const horizon = azimuthal.children[45].sourceGeometry.attributes.position;
    for (let i = 0; i < horizon.count; i++) expect(horizon.getZ(i)).toBeCloseTo(0);
    elements.setLineWidth(0.37);
    for (const line of [...azimuthal.children, ...equatorial.children]) expect(line.material.linewidth).toBe(0.37);
    elements.dispose(new Group());
    expect(azimuthal.children).toHaveLength(0);
    expect(equatorial.children).toHaveLength(0);
});

function sky() {
    const n = Object.create(CNodeDisplayNightSky.prototype);
    n.simpleSerials = ["showEquatorialGridMain", "showEquatorialGridLook", "showAzimuthalGridMain", "showAzimuthalGridLook"];
    for (const key of n.simpleSerials) n[key] = false;
    for (const key of ["equatorialSphereGroup", "azimuthalSphereGroup", "constellationsGroup", "sunArrowGroup", "flareRegionGroup",
        "flareBandGroup", "satelliteGroup", "satelliteTrackGroup", "satelliteFlareTracksGroup", "satelliteGroundGroup"]) n[key] = new Group();
    n.equatorialSphereGroup.add(new Group());
    n.azimuthalSphereGroup.add(new Group());
    n.celestialElements = {setLineWidth() {}};
    n.satellites = {filterSatellites() {}};
    n.updateStarPlanetVisibility = () => {};
    n.updateCelestialVectorVisibility = () => {};
    return n;
}

test.each([[false, false], [true, false], [false, true], [true, true]])(
    "saved azimuthal flags Main=%s Look=%s restore independently of the equatorial grid", (main, look) => {
        const n = sky();
        const saved = {showAzimuthalGridMain: main, showAzimuthalGridLook: look, showEquatorialGridMain: !main, showEquatorialGridLook: !look};
        n.modDeserialize(saved);
        for (const [group, m, l] of [[n.azimuthalSphereGroup, main, look], [n.equatorialSphereGroup, !main, !look]]) {
            expect(group.visible).toBe(m || l);
            group.traverse(child => {
                expect(!!(child.layers.mask & MASK_MAINRENDER)).toBe(m);
                expect(!!(child.layers.mask & MASK_LOOKRENDER)).toBe(l);
            });
        }
        expect(n.modSerialize()).toMatchObject(saved);
    });

test("old equatorial master saves retain their display and do not turn on the new grid", () => {
    const n = sky();
    n.modDeserialize({showEquatorialGrid: false, showEquatorialGridLook: true});
    expect(n.equatorialSphereGroup.visible).toBe(false);
    expect(n.azimuthalSphereGroup.visible).toBe(false);
});

test("all slider spacings rebuild both grids around zero elevation without accumulating lines", () => {
    const elements = new CCelestialElements({lineWidth: 0.41});
    const equatorial = new Group(), azimuthal = new Group();
    for (let spacing = 5; spacing <= 45; spacing += 5) {
        const old = equatorial.children[0];
        const disposed = jest.fn();
        old?.material.addEventListener("dispose", disposed);
        elements.rebuildGridLines(equatorial, azimuthal, spacing);
        if (old) {
            expect(old.parent).toBeNull();
            expect(disposed).toHaveBeenCalledTimes(1);
        }
        const meridians = Math.ceil(360 / spacing);
        const parallels = 3 + 2 * (Math.ceil(90 / spacing) - 1);
        for (const group of [equatorial, azimuthal]) {
            expect(group.children).toHaveLength(meridians + parallels);
            const horizon = group.children[meridians + (parallels - 1) / 2].sourceGeometry.attributes.position;
            for (let i = 0; i < horizon.count; i++) expect(horizon.getZ(i)).toBeCloseTo(0);
            for (const line of group.children) expect(line.material.linewidth).toBe(0.41);
        }
        // A 35-degree grid still has an azimuth-zero meridian at true north.
        const north = azimuthal.children[0].sourceGeometry.attributes.position;
        expect(north.getX(50)).toBeCloseTo(0);
        expect(north.getY(50)).toBeCloseTo(100);
        expect(north.getZ(50)).toBeCloseTo(0);
    }
    elements.dispose();
});

test("restoring grid spacing rebuilds both geometries and preserves their view flags", () => {
    const n = sky();
    n.simpleSerials.push("celestialGridSpacing");
    n.celestialGridSpacing = 10;
    n.celestialLineWidth = 0.25;
    n.celestialElements = new CCelestialElements();
    n.equatorialSphereGroup.clear();
    n.azimuthalSphereGroup.clear();
    n.celestialElements.rebuildGridLines(n.equatorialSphereGroup, n.azimuthalSphereGroup, 10);
    n.modDeserialize({celestialGridSpacing: 35, showAzimuthalGridLook: true, showEquatorialGridMain: true});
    expect(n.equatorialSphereGroup.children).toHaveLength(18);
    expect(n.azimuthalSphereGroup.children).toHaveLength(18);
    expect(n.modSerialize().celestialGridSpacing).toBe(35);
    expect(!!(n.equatorialSphereGroup.layers.mask & MASK_LOOKRENDER)).toBe(false);
    expect(!!(n.azimuthalSphereGroup.layers.mask & MASK_MAINRENDER)).toBe(false);
    n.celestialElements.dispose();
});
