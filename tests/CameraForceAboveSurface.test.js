// The look camera's surface clamp (forceAboveSurface) is turned off when a dropped photo or
// video gives an absolute altitude, and has to stay off after the sitch is saved and loaded
// again, or the camera is lifted onto the terrain. The two methods are run on their own,
// extracted from the source, so the browser-only dependencies of CNodeCamera are not loaded.
import fs from "node:fs";
import path from "node:path";
import {parse} from "@babel/parser";
import {Vector3} from "three";

function extractMethods(file, className, names, globals, Base) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    const declaration = parse(source, {sourceType: "module"}).program.body
        .map(node => node.declaration ?? node).find(node => node.id?.name === className);
    const body = declaration.body.body.filter(node => names.includes(node.key?.name))
        .map(node => source.slice(node.start, node.end)).join("\n");
    return new Function(...Object.keys(globals), "Base", `return class extends Base {${body}}`)(...Object.values(globals), Base);
}

const Camera = extractMethods("src/nodes/CNodeCamera.js", "CNodeCamera", ["modSerialize", "modDeserialize"],
    {ECEFToLLAVD_radii: () => new Vector3(), Vector3},
    class {
        modSerialize() { return {}; }
        modDeserialize() {}
    });

function camera(forceAboveSurface) {
    return Object.assign(new Camera(), {
        forceAboveSurface,
        camera: {position: new Vector3(1, 2, 3), up: new Vector3(0, 1, 0), fov: 30,
            updateMatrixWorld() {}, updateProjectionMatrix() {}, matrixWorld: {elements: new Array(16).fill(0)}},
        psfGlare: {},
        resetCamera() {},
    });
}

describe("look camera surface clamp in a save", () => {
    test("saved only when off, so a save with the default is unchanged", () => {
        expect("forceAboveSurface" in camera(true).modSerialize()).toBe(false);
        expect(camera(false).modSerialize().forceAboveSurface).toBe(false);
    });

    test("a reload restores it, and a save without it (older, or clamp on) turns it on", () => {
        const saved = camera(false).modSerialize();
        const reloaded = camera(true);
        reloaded.modDeserialize(saved);
        expect(reloaded.forceAboveSurface).toBe(false);

        const older = camera(true).modSerialize();
        const restored = camera(false);
        restored.modDeserialize(older);
        expect(restored.forceAboveSurface).toBe(true);
    });
});
