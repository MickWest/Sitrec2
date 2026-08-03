// Unit tests for the pure backward-compat sitch migrations.
// These guard the subtle choice/structure rewrites that the rest of the app
// relies on to load pre-flatten saved custom sitches correctly.

import {
    migrateCameraHeadingReorg,
    migrateFovSwitchLabel,
    migrateCameraMenuFolders,
    objHasNestedChoice,
    migrateMaskOverlayId,
} from "../src/SitchMigrations";

// A minimal saved-custom shape with the OLD nested two-switch camera-heading model.
// `overrides` lets each test tweak the choices / sub-sitches.
function oldSave({ losChoice = "Use Angles", anglesChoice = "Manual PTZ", anglesKey = "anglesSwitch", subStates = [] } = {}) {
    const obj = {
        name: "custom",
        canMod: false,
        // embedded node defs
        [anglesKey]: {
            kind: "Switch",
            inputs: { "Manual PTZ": "ptzAngles", "Custom Az/El": "customAzElController" },
            desc: "Angles Source",
            gui: "camera",
        },
        CameraLOSController: {
            kind: "Switch",
            inputs: { "To Target": "trackToTrackController", "Use Angles": anglesKey },
            default: "Use Angles",
            desc: "Camera Heading",
            gui: "camera",
        },
        fovSwitch: {
            kind: "Switch",
            inputs: { "userFOV": "fovUI" },
            desc: "Camera FOV",
            gui: "camera",
        },
        dropTargets: {
            track: ["cameraTrackSwitch-1"],
            angles: [anglesKey],
        },
        // live state
        mods: {
            [anglesKey]: { visible: true, choice: anglesChoice },
            CameraLOSController: { visible: true, choice: losChoice },
        },
    };
    if (subStates.length) {
        obj.subSitchesData = {
            subSitches: subStates.map((s, i) => ({
                name: `Sub ${i + 1}`,
                state: { mods: { CameraLOSController: { visible: true, choice: s } } },
            })),
        };
    }
    return obj;
}

describe("migrateCameraHeadingReorg — node defs + dropTargets", () => {
    test("flattens CameraLOSController and removes the angles sub-switch", () => {
        const obj = oldSave();
        migrateCameraHeadingReorg(obj);

        expect(obj.anglesSwitch).toBeUndefined();
        expect(obj.angelsSwitch).toBeUndefined();
        expect(Object.keys(obj.CameraLOSController.inputs)).toEqual(["Manual", "To Target"]);
        expect(obj.CameraLOSController.inputs.Manual).toBe("ptzAngles");
        expect(obj.CameraLOSController.inputs["To Target"]).toBe("trackToTrackController");
        expect(obj.CameraLOSController.default).toBe("Manual");
        expect(obj.dropTargets.angles).toEqual(["CameraLOSController"]);
    });

    test("handles the legacy 'angelsSwitch' typo spelling", () => {
        const obj = oldSave({ anglesKey: "angelsSwitch", anglesChoice: "Manual PTZ" });
        migrateCameraHeadingReorg(obj);
        expect(obj.angelsSwitch).toBeUndefined();
        expect(obj.dropTargets.angles).toEqual(["CameraLOSController"]);
        expect(obj.mods.CameraLOSController.choice).toBe("Manual");
        expect(obj.mods.angelsSwitch).toBeUndefined();
    });
});

describe("migrateCameraHeadingReorg — main mods choice", () => {
    test("'Use Angles' + 'Manual PTZ' → 'Manual'", () => {
        const obj = oldSave({ losChoice: "Use Angles", anglesChoice: "Manual PTZ" });
        migrateCameraHeadingReorg(obj);
        expect(obj.mods.CameraLOSController.choice).toBe("Manual");
        expect(obj.mods.anglesSwitch).toBeUndefined();
    });

    test("'Use Angles' + 'Custom Az/El' → 'Custom Az/El'", () => {
        const obj = oldSave({ losChoice: "Use Angles", anglesChoice: "Custom Az/El" });
        migrateCameraHeadingReorg(obj);
        expect(obj.mods.CameraLOSController.choice).toBe("Custom Az/El");
    });

    test("'Use Angles' + per-track 'Angles_N97826' → 'Angles_N97826'", () => {
        const obj = oldSave({ losChoice: "Use Angles", anglesChoice: "Angles_N97826" });
        migrateCameraHeadingReorg(obj);
        expect(obj.mods.CameraLOSController.choice).toBe("Angles_N97826");
    });

    test("'To Target' stays 'To Target' and the angles mod is dropped", () => {
        const obj = oldSave({ losChoice: "To Target", anglesChoice: "Custom Az/El" });
        migrateCameraHeadingReorg(obj);
        expect(obj.mods.CameraLOSController.choice).toBe("To Target");
        expect(obj.mods.anglesSwitch).toBeUndefined();
    });
});

describe("migrateCameraHeadingReorg — sub-sitch fallback (regression: do NOT use main heading)", () => {
    // The bug: a sub-sitch captured CameraLOSController='Use Angles' but never the
    // angles sub-choice. Historically it deferred to the MAIN angles source, which
    // is independent of the main heading. A buggy fallback to the main heading would
    // restore the sub to 'To Target' when that was the main heading.
    test("sub 'Use Angles' resolves to the MAIN angles source, even when main heading is 'To Target'", () => {
        const obj = oldSave({
            losChoice: "To Target",
            anglesChoice: "Custom Az/El",
            subStates: ["Use Angles"],
        });
        migrateCameraHeadingReorg(obj);
        expect(obj.mods.CameraLOSController.choice).toBe("To Target");
        // The sub must follow the warm angles source (Custom Az/El), NOT 'To Target'.
        expect(obj.subSitchesData.subSitches[0].state.mods.CameraLOSController.choice).toBe("Custom Az/El");
    });

    test("sub 'Use Angles' resolves to 'Manual' when main angles source was 'Manual PTZ'", () => {
        const obj = oldSave({
            losChoice: "Celestial Lock",
            anglesChoice: "Manual PTZ",
            subStates: ["Use Angles"],
        });
        migrateCameraHeadingReorg(obj);
        expect(obj.subSitchesData.subSitches[0].state.mods.CameraLOSController.choice).toBe("Manual");
    });

    test("a sub that captured a non-angles heading ('To Target') is left unchanged", () => {
        const obj = oldSave({
            losChoice: "Use Angles",
            anglesChoice: "Angles_N97826",
            subStates: ["To Target"],
        });
        migrateCameraHeadingReorg(obj);
        expect(obj.subSitchesData.subSitches[0].state.mods.CameraLOSController.choice).toBe("To Target");
    });
});

describe("migrateCameraHeadingReorg — idempotency & no-ops", () => {
    test("running twice yields the same result as running once", () => {
        const once = oldSave({ losChoice: "Use Angles", anglesChoice: "Custom Az/El", subStates: ["Use Angles"] });
        migrateCameraHeadingReorg(once);
        const twice = oldSave({ losChoice: "Use Angles", anglesChoice: "Custom Az/El", subStates: ["Use Angles"] });
        migrateCameraHeadingReorg(twice);
        migrateCameraHeadingReorg(twice);
        expect(twice).toEqual(once);
    });

    test("an already-flat (new) save is untouched", () => {
        const flat = {
            CameraLOSController: {
                kind: "Switch",
                inputs: { "Manual": "ptzAngles", "To Target": "trackToTrackController" },
                default: "Manual",
            },
            dropTargets: { angles: ["CameraLOSController"] },
            mods: { CameraLOSController: { choice: "Manual" } },
        };
        const copy = JSON.parse(JSON.stringify(flat));
        migrateCameraHeadingReorg(flat);
        expect(flat).toEqual(copy);
    });

    test("thin mod overlay (only a mods block) still migrates its choices", () => {
        const overlay = {
            modding: "someBase",
            mods: {
                anglesSwitch: { choice: "Custom Az/El" },
                CameraLOSController: { choice: "Use Angles" },
            },
        };
        expect(objHasNestedChoice(overlay)).toBe(true);
        migrateCameraHeadingReorg(overlay);
        expect(overlay.mods.CameraLOSController.choice).toBe("Custom Az/El");
        expect(overlay.mods.anglesSwitch).toBeUndefined();
    });

    test("does not throw on null / malformed input", () => {
        expect(() => migrateCameraHeadingReorg(null)).not.toThrow();
        expect(() => migrateCameraHeadingReorg(undefined)).not.toThrow();
        expect(() => migrateCameraHeadingReorg({})).not.toThrow();
        expect(() => migrateCameraHeadingReorg({ CameraLOSController: { inputs: null } })).not.toThrow();
    });
});

describe("migrateFovSwitchLabel", () => {
    test("injects the 'Manual' display label for userFOV", () => {
        const obj = oldSave();
        migrateFovSwitchLabel(obj);
        expect(obj.fovSwitch.labels).toEqual({ userFOV: "Manual" });
        // the option key/value is untouched
        expect(obj.fovSwitch.inputs.userFOV).toBe("fovUI");
    });

    test("does not clobber an existing userFOV label", () => {
        const obj = oldSave();
        obj.fovSwitch.labels = { userFOV: "Custom Name" };
        migrateFovSwitchLabel(obj);
        expect(obj.fovSwitch.labels.userFOV).toBe("Custom Name");
    });

    test("no-op when there is no fovSwitch or no userFOV input", () => {
        const a = {};
        expect(() => migrateFovSwitchLabel(a)).not.toThrow();
        const b = { fovSwitch: { inputs: { onlyTrack: "x" } } };
        migrateFovSwitchLabel(b);
        expect(b.fovSwitch.labels).toBeUndefined();
    });

    test("is idempotent", () => {
        const obj = oldSave();
        migrateFovSwitchLabel(obj);
        migrateFovSwitchLabel(obj);
        expect(obj.fovSwitch.labels).toEqual({ userFOV: "Manual" });
    });
});

describe("migrateCameraMenuFolders", () => {
    // An old save embeds gui:"camera" for every camera node.
    const oldCameraSave = () => ({
        fixedCameraPosition: { kind: "PositionLLA", gui: "camera" },
        cameraTrackSwitch: { kind: "Switch", inputs: { fixedCamera: "fixedCameraPosition", flightSimCamera: "flightSimCameraPosition" }, desc: "Camera Track", gui: "camera" },
        cameraTrackSwitchSmooth: { kind: "SmoothedPositionTrack", window: { kind: "GUIValue", desc: "Camera Smooth Window", gui: "camera" } },
        ptzAngles: { kind: "PTZUI", gui: "camera" },
        CameraLOSController: { kind: "Switch", inputs: {}, gui: "camera" },
        orientCameraController: { kind: "ObjectTilt", gui: "camera" },
        fovUI: { kind: "GUIValue", gui: "camera" },
        fovSwitch: { kind: "Switch", inputs: { userFOV: "fovUI" }, gui: "camera" },
    });

    test("routes each camera node into its new sub-folder", () => {
        const obj = oldCameraSave();
        migrateCameraMenuFolders(obj);
        expect(obj.fixedCameraPosition.gui).toBe("cameraLocation");
        expect(obj.cameraTrackSwitch.gui).toBe("cameraLocation");
        expect(obj.cameraTrackSwitchSmooth.window.gui).toBe("cameraLocation");
        expect(obj.ptzAngles.gui).toBe("cameraHeading");
        expect(obj.CameraLOSController.gui).toBe("cameraHeading");
        expect(obj.orientCameraController.gui).toBe("cameraHeading");
        expect(obj.fovUI.gui).toBe("cameraFOV");
        expect(obj.fovSwitch.gui).toBe("cameraFOV");
    });

    test("applies the Position rename + Manual/Flight Sim labels", () => {
        const obj = oldCameraSave();
        migrateCameraMenuFolders(obj);
        expect(obj.cameraTrackSwitch.desc).toBe("Position");
        expect(obj.cameraTrackSwitch.labels).toEqual({ fixedCamera: "Manual", flightSimCamera: "Flight Sim" });
    });

    test("is idempotent and leaves an already-migrated (new) save untouched", () => {
        const neu = {
            fixedCameraPosition: { gui: "cameraLocation" },
            cameraTrackSwitch: { desc: "Position", gui: "cameraLocation", labels: { fixedCamera: "Manual", flightSimCamera: "Flight Sim" } },
            ptzAngles: { gui: "cameraHeading" },
            fovSwitch: { gui: "cameraFOV" },
        };
        const copy = JSON.parse(JSON.stringify(neu));
        migrateCameraMenuFolders(neu);
        expect(neu).toEqual(copy);
    });

    test("does not touch a custom user label / desc that isn't the old default", () => {
        const obj = oldCameraSave();
        obj.cameraTrackSwitch.desc = "My Camera";       // user-customized desc, not "Camera Track"
        migrateCameraMenuFolders(obj);
        expect(obj.cameraTrackSwitch.desc).toBe("My Camera"); // unchanged
        // gui still routed
        expect(obj.cameraTrackSwitch.gui).toBe("cameraLocation");
    });

    test("does not throw on null / empty input", () => {
        expect(() => migrateCameraMenuFolders(null)).not.toThrow();
        expect(() => migrateCameraMenuFolders({})).not.toThrow();
    });
});

describe("migrateMaskOverlayId", () => {
    // The mask node was renamed when it stopped belonging to Motion Analysis. Its mod has to
    // move with it: the old node is no longer created for custom sitches, so a mod left under
    // the old key is dropped when mods are applied, and the user's painted mask disappears.
    test("moves an old motionMaskOverlay mod onto videoMask", () => {
        const obj = {mods: {motionMaskOverlay: {maskData: "data:image/png;base64,AAAA", visible: false}}};
        migrateMaskOverlayId(obj);
        expect(obj.mods.videoMask).toEqual({maskData: "data:image/png;base64,AAAA", visible: false});
        expect(obj.mods.motionMaskOverlay).toBeUndefined();
    });

    test("does not overwrite a mod already saved under the new id", () => {
        const obj = {mods: {
            motionMaskOverlay: {maskData: "OLD"},
            videoMask: {maskData: "NEW"},
        }};
        migrateMaskOverlayId(obj);
        expect(obj.mods.videoMask.maskData).toBe("NEW");
        // The stale entry still goes, so it cannot be re-applied to a node that no longer exists.
        expect(obj.mods.motionMaskOverlay).toBeUndefined();
    });

    test("is idempotent", () => {
        const obj = {mods: {motionMaskOverlay: {maskData: "X"}}};
        migrateMaskOverlayId(obj);
        const once = JSON.parse(JSON.stringify(obj));
        migrateMaskOverlayId(obj);
        expect(obj).toEqual(once);
    });

    test("does not throw on null / empty / mod-less input", () => {
        expect(() => migrateMaskOverlayId(null)).not.toThrow();
        expect(() => migrateMaskOverlayId({})).not.toThrow();
        expect(() => migrateMaskOverlayId({mods: {}})).not.toThrow();
    });
});
