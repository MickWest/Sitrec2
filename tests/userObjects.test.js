// Which 3D objects the user made, and which nodes such an object owns (src/UserObjects.js).

import {BUILT_IN_OBJECT_IDS, isUserMadeObjectId, ownedSubNodeIds, savedObjectName} from "../src/UserObjects";

test("objects made in Sitrec are deletable; objects a sitch defines, and a balloon's sphere, are not", () => {
    expect(isUserMadeObjectId("syntheticObject_1791557242602")).toBe(true);
    expect(isUserMadeObjectId("syntheticObject_1791557242602_1")).toBe(true);
    // A load always rebuilds a balloon with its sphere, so a deleted sphere would come back.
    expect(isUserMadeObjectId("balloonObject_1791557242602")).toBe(false);
    for (const id of ["traverseObject", "targetObject", "jetObject_ob", "mySyntheticObject_1"]) {
        expect(isUserMadeObjectId(id)).toBe(false);
    }
});

test("an object owns its <id>_<name> nodes, but not another object made in the same millisecond", () => {
    const ids = [
        "syntheticObject_100",
        "syntheticObject_100_size",
        "syntheticObject_100_ControllerTrackPosition",
        "syntheticObject_100_color_colorInput",
        // UniqueName's clash suffix: a different object and its own nodes
        "syntheticObject_100_1",
        "syntheticObject_100_1_size",
        "syntheticObject_1000_size",
        "syntheticTrack_100",
    ];
    expect(ownedSubNodeIds("syntheticObject_100", ids)).toEqual([
        "syntheticObject_100_size",
        "syntheticObject_100_ControllerTrackPosition",
        "syntheticObject_100_color_colorInput",
    ]);
    expect(ownedSubNodeIds("syntheticObject_100_1", ids)).toEqual(["syntheticObject_100_1_size"]);
});

test("a built-in object does not take back the node id that an old save has as its name", () => {
    expect(BUILT_IN_OBJECT_IDS).toEqual(["cameraObject", "traverseObject"]);
    // A sitch saved before these two objects had names: the id was shown, and so it was saved.
    expect(savedObjectName("cameraObject", "cameraObject")).toBeNull();
    expect(savedObjectName("traverseObject", "traverseObject")).toBeNull();
    // a name that the user typed comes back, also for these two
    expect(savedObjectName("traverseObject", "The orb")).toBe("The orb");
    expect(savedObjectName("cameraObject", "traverseObject")).toBe("traverseObject");
});

test("every other object takes back its saved name, also when that is its id", () => {
    // An object that the API made with a name has that name as its id.
    expect(savedObjectName("Viewer", "Viewer")).toBe("Viewer");
    expect(savedObjectName("syntheticObject_100", "Object 1")).toBe("Object 1");
    expect(savedObjectName("balloonObject_100", "Object 1")).toBe("Object 1");
    // a save with no name for the object
    expect(savedObjectName("syntheticObject_100", undefined)).toBeNull();
});
