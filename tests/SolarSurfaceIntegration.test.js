/** @jest-environment jsdom */
import fs from "node:fs";
import path from "node:path";
import {parse} from "@babel/parser";
import {Group, Mesh, BoxGeometry, MeshBasicMaterial, PerspectiveCamera, Scene, Vector3} from "three";
import {SolarSurfacePatches} from "../src/rendering/SolarSurfacePatches";
import {solarSurfaceState} from "../tools/thermal/solarSurface.js";
import {createThermalSceneAdapter, createThermalReuseKey} from "../src/rendering/ThermalSceneAdapters";
import {objectThermalState} from "../src/rendering/ThermalLoader";

jest.mock("../src/Globals", () => ({Globals: {equatorRadius: 6371000, polarRadius: 6371000}, Sit: {}}));
jest.mock("../src/EGM96Geoid", () => ({meanSeaLevelOffset: () => 0}));

function nodeClass() {
    const source = fs.readFileSync(path.join(__dirname, "../src/nodes/CNode3DObject.js"), "utf8");
    const cls = parse(source, {sourceType: "module"}).program.body.find(n => n.declaration?.id?.name === "CNode3DObject").declaration;
    const methods = cls.body.body.filter(n => ["updateSolarSurface", "postRender", "modSerialize", "serializeSolarSurface", "restoreSolarSurface"].includes(n.key?.name));
    const scope = {Vector3, SolarSurfacePatches, solarSurfaceState, objectThermalState, effectiveRenderMode: v => v.renderMode,
        GlobalDateTimeNode: {dateNow: new Date("2004-11-14T20:30:00Z")}, Sit: {},
        Globals: {equatorRadius: 6371000, polarRadius: 6371000}, getCelestialDirection: () => new Vector3(1, 0, 0)};
    return new Function(...Object.keys(scope), "Base", `return class extends Base {${methods.map(n => source.slice(n.start,n.end)).join("\n")}}`)
        (...Object.values(scope), class {modSerialize() {return {};}});
}

test("node uses astronomical incidence only on thermal geometry and saves disabled coefficients", () => {
    const Node = nodeClass(), node = new Node();
    node.object = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    node.group = new Group(); node.group.position.set(6372000,0,0); node.group.add(node.object); node.group.updateMatrixWorld(true);
    Object.assign(node, {solarSurface: solarSurfaceState({enabled: true}), modelOrGeometry: "geometry", common: {},
        thermal: {}, flock: {isDefault: () => true}});
    node.updateSolarSurface({renderMode: "visible"}); expect(node._solarSurfacePatches).toBeUndefined();
    node.updateSolarSurface({renderMode: "physicalThermal"}); expect(node.object.visible).toBe(false);
    expect(node._solarSurfacePatches.group.visible).toBe(true);
    node.postRender({}); expect(node.object.visible).toBe(true);
    node.solarSurface.enabled = false; node.solarSurface.convectionWm2K = 35;
    expect(node.modSerialize().solarSurface).toMatchObject({enabled: false, convectionWm2K: 35});
    node.restoreSolarSurface(JSON.parse(JSON.stringify(node.modSerialize().solarSurface)));
    expect(node.solarSurface.convectionWm2K).toBe(35);
    node.restoreSolarSurface(undefined); expect(node.solarSurface.enabled).toBe(false);
    node._solarSurfacePatches.dispose();
});

test("derived patch participates and overrides uniform mode without changing ordinary mesh semantics", () => {
    const source = new Mesh(new BoxGeometry(), new MeshBasicMaterial()), parent = new Group(); parent.add(source);
    const node = {object: source, modelOrGeometry: "geometry", solarSurface: solarSurfaceState({enabled: true}), thermal: {mode: "uniform", temperatureK: 400, emissivity: .2}};
    node._solarSurfacePatches = new SolarSurfacePatches(source);
    node._solarSurfacePatches.update(node.solarSurface, new Vector3(1,0,0), true);
    const camera = new PerspectiveCamera(); camera.position.set(6372000,0,0); camera.updateMatrixWorld(true);
    const adapter = createThermalSceneAdapter([node], [], camera, {enabled: false});
    const patch = node._solarSurfacePatches.bands[32];
    expect(adapter.attributes(patch, {})).toEqual(patch.userData.thermal);
    expect(adapter.attributes(source, {})).toEqual({temperatureK: 400, emissivity: .2});
    // Derived heating must not silently reuse a prior frame before its state is keyed.
    const key = createThermalReuseKey();
    const scene = new Scene(); scene.add(parent);
    node._solarSurfacePatches.show(); scene.updateMatrixWorld(true);
    expect(key({objects: [node], scene, camera})).toBeNull();
    expect(key.lastNullReason).toBe("solar surface bands");
    node._solarSurfacePatches.dispose();
});
