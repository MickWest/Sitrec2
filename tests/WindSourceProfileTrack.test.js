// The "Track: <name>" wind source of a sounding track is read by altitude, not by time.
// altitudeProfileForSourceKey() is the one test for "is this Track entry a sounding".

import {setNodeMan} from '../src/Globals';
import {altitudeProfileForSourceKey, trackSourceKey} from '../src/nodes/WindSources';

describe('altitudeProfileForSourceKey', () => {
    const soundingProfile = {id: "atmosphericProfile_wx-file", windByAltitude: true};
    const otherProfile = {id: "atmosphericProfile_legacy", windByAltitude: false};
    const nodes = {[soundingProfile.id]: soundingProfile, [otherProfile.id]: otherProfile};

    beforeAll(() => setNodeMan({get: (id) => nodes[id], exists: (id) => id in nodes}));
    afterAll(() => setNodeMan(undefined));

    test('gives the profile for the Track entry of a sounding track', () => {
        expect(altitudeProfileForSourceKey(trackSourceKey("TrackData_wx-file"))).toBe(soundingProfile);
        expect(altitudeProfileForSourceKey("track:TrackData_wx-file")).toBe(soundingProfile);
    });

    test('gives null for a telemetry track, which has no profile and is read by time', () => {
        expect(altitudeProfileForSourceKey("track:TrackData_N12345")).toBeNull();
    });

    test('gives null for a profile that is not marked, and for every source that is not a Track entry', () => {
        expect(altitudeProfileForSourceKey("track:TrackData_legacy")).toBeNull();
        for (const key of ["manual", "gfs", "uwyo", "igra2", "manual-soundings", "custom", "", null, undefined]) {
            expect(altitudeProfileForSourceKey(key)).toBeNull();
        }
        expect(altitudeProfileForSourceKey("track:Something_else")).toBeNull();
    });
});
