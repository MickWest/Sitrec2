// Which 3D objects the user made, and which nodes such an object owns (src/UserObjects.js).

import {isUserMadeObjectId, ownedSubNodeIds} from "../src/UserObjects";

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
