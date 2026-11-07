/** @jest-environment jsdom */
import {Group, Object3D} from "three";
import {CNodeDisplayNightSky} from "../src/nodes/CNodeDisplayNightSky";
import {CStarField} from "../src/nodes/CStarField";
import {setFileManager, setNodeMan, setSit, Sit} from "../src/Globals";

test("the master hides both render passes and remains off when the star cloud is rebuilt", () => {
    const nodes = new Map();
    setFileManager({removeExportButton() {}});
    setNodeMan({
        add: (id, node) => nodes.set(id, node), exists: id => nodes.has(id), get: id => nodes.get(id),
        disposeRemove(node) { node.dispose(); nodes.delete(node.id); },
    });
    setSit({starScale: 1, starLimit: 6.5, physicalPointSources: false});
    const sky = Object.create(CNodeDisplayNightSky.prototype);
    sky.starsAndPlanetsGroup = new Group();
    sky.celestialDaySphere = new Group();
    const planet = new Object3D(), moon = new Object3D();
    sky.starsAndPlanetsGroup.add(planet);
    sky.celestialDaySphere.add(moon);
    const stars = new CStarField();
    Object.assign(stars, {BSC_NumStars: 2, BSC_MAG: [1, 5], BSC_RA: [0, 1], BSC_DEC: [0, 0]});
    stars.createStarCloud(sky.starsAndPlanetsGroup);
    const drawn = object => {
        for (let current = object; current; current = current.parent) if (!current.visible) return false;
        return true;
    };
    sky.showStars = false;
    sky.updateStarPlanetVisibility();
    expect(drawn(stars.lightCloud.points)).toBe(false);
    expect(drawn(planet)).toBe(false);
    expect(drawn(moon)).toBe(false);

    stars.updateStarVisibility(4);
    expect(stars.lightCloud.count).toBe(1);
    expect(stars.lightCloud.points.parent).toBe(sky.starsAndPlanetsGroup);
    expect(drawn(stars.lightCloud.points)).toBe(false);
    Sit.physicalPointSources = true;
    stars.createStarCloud(stars.scene);
    expect(drawn(stars.lightCloud.points)).toBe(false);

    sky.showStars = true;
    sky.updateStarPlanetVisibility();
    expect(drawn(stars.lightCloud.points)).toBe(true);
    expect(drawn(planet)).toBe(true);
    expect(drawn(moon)).toBe(true);
    stars.dispose();
});
