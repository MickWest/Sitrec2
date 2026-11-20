import {CNodeCamera} from "../../src/nodes/CNodeCamera";
import {CNodeManager} from "../../src/nodes/CNodeManager";
import {guiMenus, setNodeMan, setSit, setUnits} from "../../src/Globals";

beforeEach(() => {
    setNodeMan(new CNodeManager());
    setSit({lat: 35, lon: -88, frames: 101, fps: 30});
    setUnits({small: {toM: 0.3048, abbrev: "ft"}});
});

test("camera offsets survive serialization in metres and old saves default to zero", () => {
    const camera = new CNodeCamera({id: "offsetTest", fov: 30, aspect: 1, near: 0.1, far: 10000,
        positionOffsetX: -0.3, positionOffsetY: 1.2192, positionOffsetZ: 0.5});
    const saved = JSON.parse(JSON.stringify(camera.modSerialize()));
    const restored = new CNodeCamera({id: "restored", fov: 30, aspect: 1, near: 0.1, far: 10000});
    expect(restored.positionOffsetY).toBe(0);
    restored.modDeserialize(saved);
    expect([restored.positionOffsetX, restored.positionOffsetY, restored.positionOffsetZ]).toEqual([-0.3, 1.2192, 0.5]);
});

test("offset controls display small-distance units without changing the physical offset", () => {
    const camera = new CNodeCamera({id: "offsetTest", fov: 30, aspect: 1, near: 0.1, far: 10000});
    const folder = {
        close() { return this; },
        add(object, key) {
            return {object, key, label: "", listen() {return this;}, tooltip() {return this;},
                name(label) {this.label = label; return this;}, updateDisplay() {},
                onChange(fn) {this.changed = fn; return this;}};
        },
    };
    guiMenus.cameraTweaks = {addFolder: () => folder};
    try {
        camera.addPositionOffsetGUI();
        const y = camera.positionOffsetControllers[1];
        y.object.Y = 4;
        expect(camera.positionOffsetY).toBeCloseTo(1.2192, 10);
        expect(y.label).toBe("Offset Y (ft)");
        setUnits({small: {toM: 1, abbrev: "m"}});
        camera.changeUnits();
        expect(y.label).toBe("Offset Y (m)");
        expect(y.object.Y).toBeCloseTo(1.2192, 10);
        expect(camera.modSerialize().positionOffsetY).toBeCloseTo(1.2192, 10);
    } finally {
        delete guiMenus.cameraTweaks;
    }
});
