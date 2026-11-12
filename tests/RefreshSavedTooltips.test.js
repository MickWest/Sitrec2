import {refreshSavedTooltips} from "../src/utils";

// A custom-sitch save holds a full copy of the node definitions, so its tooltip text is the text
// of the build that wrote it. updateNewCustomFields calls refreshSavedTooltips to show the
// current text instead, and must change nothing else.
describe("refreshSavedTooltips", () => {
    test("updates tooltip and tip text at any depth, and nothing else", () => {
        const current = {
            cameraSwitch: {kind: "Switch", desc: "Position", tooltip: "New position text"},
            effects: {Blur: {inputs: {h: {kind: "GUIValue", value: 2, tip: "New blur text"}}}},
            newNode: {kind: "Switch", tooltip: "Not in the save"},
        };
        const saved = {
            cameraSwitch: {kind: "Switch", desc: "Position", choice: "Manual"},
            effects: {Blur: {inputs: {h: {kind: "GUIValue", value: 7, tip: "Old blur text"}}}},
            userData: {tooltip: "Kept: not in the current definition"},
        };

        refreshSavedTooltips(saved, current);

        expect(saved.cameraSwitch).toEqual({kind: "Switch", desc: "Position", choice: "Manual", tooltip: "New position text"});
        expect(saved.effects.Blur.inputs.h).toEqual({kind: "GUIValue", value: 7, tip: "New blur text"});
        expect(saved.newNode).toBeUndefined();
        expect(saved.userData.tooltip).toBe("Kept: not in the current definition");
    });

    test("skips a path whose saved value is not an object", () => {
        const saved = {node: "a string in the save"};
        refreshSavedTooltips(saved, {node: {tooltip: "text"}});
        expect(saved.node).toBe("a string in the save");
    });
});
