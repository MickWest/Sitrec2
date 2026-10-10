// Horizon crossings found from 30 s samples (src/HorizonCrossings.js), checked against real
// ISS passes: SGP4 from satellite.js, elevations from satellite.js's own look angles, and a
// reference found from 1 s samples.

import * as satellite from "satellite.js";
import {findHorizonCrossings, HORIZON_STEP_MS} from "../src/HorizonCrossings";

const ISS = [
    "1 25544U 98067A   24001.50000000  .00016717  00000-0  10270-3 0  9993",
    "2 25544  51.6412 218.4910 0005690  23.4567 336.5678 15.49556478432568",
];
const satrec = satellite.twoline2satrec(...ISS);
const observer = {latitude: satellite.degreesToRadians(40), longitude: satellite.degreesToRadians(-100), height: 0.5};

function issElevation(timeMS) {
    const date = new Date(timeMS);
    const {position} = satellite.propagate(satrec, date);
    const ecf = satellite.eciToEcf(position, satellite.gstime(date));
    return satellite.radiansToDegrees(satellite.ecfToLookAngles(observer, ecf).elevation);
}

const start = Date.parse("2024-01-01T12:00:00Z");
const end = start + 24 * 3600 * 1000;

test("every rise and set of the ISS in a day, each within a second of the 1 s reference", () => {
    const reference = findHorizonCrossings(issElevation, start, end, 1000);
    const found = findHorizonCrossings(issElevation, start, end);
    expect(reference.length).toBeGreaterThanOrEqual(8);
    expect(found.map(crossing => crossing.rising)).toEqual(reference.map(crossing => crossing.rising));
    for (let index = 0; index < found.length; index++) {
        expect(Math.abs(found[index].timeMS - reference[index].timeMS)).toBeLessThan(1000);
    }
    // Rises and sets alternate.
    for (let index = 1; index < found.length; index++) {
        expect(found[index].rising).toBe(!found[index - 1].rising);
    }
});

test("a crossing is interpolated between the samples, not placed at the later one", () => {
    // Elevation -10 at 0 s and +20 at 30 s: the crossing is one third of the way.
    const crossings = findHorizonCrossings(time => -10 + 30 * time / HORIZON_STEP_MS, 0, HORIZON_STEP_MS);
    expect(crossings).toEqual([{timeMS: HORIZON_STEP_MS / 3, rising: true}]);
});

test("the range is searched from its start to its end, including a short final step", () => {
    // Above the horizon from 0 to 40 s, then below: one set at 40 s, inside the last 5 s step.
    const elevation = time => (40000 - time) / 1000;
    expect(findHorizonCrossings(elevation, 0, 45000)).toEqual([{timeMS: 40000, rising: false}]);
    // A range shorter than one step is still searched.
    expect(findHorizonCrossings(elevation, 39000, 41000)).toEqual([{timeMS: 40000, rising: false}]);
    expect(findHorizonCrossings(elevation, 0, 30000)).toEqual([]);
});

test("a sample without a position is skipped", () => {
    const elevation = time => (time === 30000 ? null : (time < 75000 ? -1 : 1));
    // The two pairs that include the gap give no crossing; the next pair gives one.
    expect(findHorizonCrossings(elevation, 0, 90000)).toEqual([{timeMS: 75000, rising: true}]);
});
