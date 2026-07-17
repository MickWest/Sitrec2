import {
    collectActiveTrackSourceFileIDs,
    hasOtherTrackSourceReference,
    shouldSerializeLoadedFileEntry,
    shouldPreserveAnglesHeading,
} from "../src/trackSourceUtils";

function makeTrackManager(tracks) {
    return {
        iterate(callback) {
            Object.entries(tracks).forEach(([id, trackOb]) => callback(id, trackOb));
        }
    };
}

describe("trackSourceUtils", () => {
    test("collects only live non-synthetic track source file ids", () => {
        const trackManager = makeTrackManager({
            Track_A: {trackFileName: "old.kml", isSynthetic: false},
            Track_B: {trackFileName: "new.kml", isSynthetic: false},
            Track_C: {trackFileName: "old.kml", isSynthetic: false},
            Track_Synth: {trackFileName: "synthetic.json", isSynthetic: true},
            Track_NoFile: {isSynthetic: false},
        });

        expect(collectActiveTrackSourceFileIDs(trackManager)).toEqual(new Set(["old.kml", "new.kml"]));
    });

    test("detects whether a file is still referenced by another track", () => {
        const trackManager = makeTrackManager({
            Track_A: {trackFileName: "old.kml", isSynthetic: false},
            Track_B: {trackFileName: "old.kml", isSynthetic: false},
            Track_C: {trackFileName: "new.kml", isSynthetic: false},
        });

        expect(hasOtherTrackSourceReference(trackManager, "old.kml", "Track_A")).toBe(true);
        expect(hasOtherTrackSourceReference(trackManager, "new.kml", "Track_C")).toBe(false);
        expect(hasOtherTrackSourceReference(trackManager, "missing.kml")).toBe(false);
    });

    test("serializes orphaned files unless they were previously used as track sources", () => {
        const activeTrackSourceFileIDs = new Set(["new.kml"]);

        expect(shouldSerializeLoadedFileEntry("notes.txt", {usedAsTrackSource: false}, activeTrackSourceFileIDs)).toBe(true);
        expect(shouldSerializeLoadedFileEntry("new.kml", {usedAsTrackSource: true}, activeTrackSourceFileIDs)).toBe(true);
        expect(shouldSerializeLoadedFileEntry("old.kml", {usedAsTrackSource: true}, activeTrackSourceFileIDs)).toBe(false);
    });
});

describe("shouldPreserveAnglesHeading", () => {
    const base = {
        headingChoice: "Angles_MISB-Jet (10)",
        cameraShortName: "MISB-Jet (10)",
        arrivingShortName: "Center_MISB-Jet (10)",
        sameSourceFile: true,
        isSupplementary: true,
    };

    test("keeps the measured angles when the camera track's derived Center track arrives", () => {
        expect(shouldPreserveAnglesHeading(base)).toBe(true);
    });

    test("relationship check survives shortName uniquification", () => {
        // Camera track renamed by a collision ("_1" suffix); its Center track kept
        // the original base name — the exact-name match fails but the verified
        // file relationship still identifies the derived Center track.
        expect(shouldPreserveAnglesHeading({
            ...base,
            cameraShortName: "MISB-Jet (10)_1",
            headingChoice: "Angles_MISB-Jet (10)_1",
            arrivingShortName: "Center_MISB-Jet (10)",
        })).toBe(true);
    });

    test("forces To Target when the heading is not the camera track's angles", () => {
        expect(shouldPreserveAnglesHeading({...base, headingChoice: "To Target"})).toBe(false);
        expect(shouldPreserveAnglesHeading({...base, headingChoice: "Manual"})).toBe(false);
        // angles of a DIFFERENT track than the camera track
        expect(shouldPreserveAnglesHeading({...base, headingChoice: "Angles_OtherTrack"})).toBe(false);
    });

    test("forces To Target for ordinary (non-Center) target tracks", () => {
        // plain two-track import: second aircraft becomes the target
        expect(shouldPreserveAnglesHeading({
            ...base,
            arrivingShortName: "N12345",
            sameSourceFile: false,
            isSupplementary: false,
        })).toBe(false);
        // STANAG role-hinted target from the same file, but not a derived Center track
        expect(shouldPreserveAnglesHeading({
            ...base,
            arrivingShortName: "GroundTarget-1",
            isSupplementary: false,
        })).toBe(false);
    });

    test("a Center_-named track from an unrelated file does not qualify", () => {
        expect(shouldPreserveAnglesHeading({
            ...base,
            arrivingShortName: "Center_SomeOtherPlatform",
            sameSourceFile: false,
            isSupplementary: false,
        })).toBe(false);
    });

    test("null-guards the camera switch state", () => {
        expect(shouldPreserveAnglesHeading({...base, cameraShortName: null})).toBe(false);
        // "fixedCamera" is not a track: the wiring finds no camera CMetaTrack, so
        // sameSourceFile/isSupplementary are false and nothing matches by name.
        expect(shouldPreserveAnglesHeading({...base, cameraShortName: "fixedCamera",
            headingChoice: "Angles_fixedCamera", sameSourceFile: false, isSupplementary: false})).toBe(false);
        expect(shouldPreserveAnglesHeading({...base, headingChoice: null})).toBe(false);
        expect(shouldPreserveAnglesHeading({...base, arrivingShortName: null})).toBe(false);
    });
});
