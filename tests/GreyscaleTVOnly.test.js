import {CNodeEffect} from "../src/nodes/CNodeEffect";
import {Globals, guiMenus, setNodeMan} from "../src/Globals";

test("Greyscale TV Only control saves and restores independently of the effect enabled flag", () => {
    setNodeMan({add() {}, exists: () => false});
    const controllers = [];
    const folder = {close() {return this;}, perm() {return this;}, add(object, property) {
        const controller = {object, property, name() {return this;}, listen() {return this;},
            onChange() {return this;}, tooltip() {return this;}};
        controllers.push(controller);
        return controller;
    }};
    guiMenus.renderingEffects = {addFolder: () => folder};
    const effect = new CNodeEffect({id: "grey", effectName: "Greyscale", enabled: true});
    expect(effect.tvOnly).toBe(false);
    expect(controllers.some(c => c.object === effect && c.property === "tvOnly")).toBe(true);
    effect.tvOnly = true;
    const saved = JSON.parse(JSON.stringify(effect.modSerialize()));
    guiMenus.renderingEffects = {addFolder: () => folder};
    const restored = new CNodeEffect({id: "restoredGrey", effectName: "Greyscale", enabled: false});
    restored.modDeserialize(saved);
    expect(restored.tvOnly).toBe(true);
    expect(restored.enabled).toBe(true);
    Globals.defaultGui = null;
    delete guiMenus.renderingEffects;
});
