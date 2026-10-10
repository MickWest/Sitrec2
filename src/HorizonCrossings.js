// Horizon crossings of a satellite in a time range.
//
// elevationAt(timeMS) returns the satellite's elevation, in any angle unit, at a
// time in ms since the epoch, or null when there is no position for that time.
// The range is sampled every stepMS, and once more at endMS. Each pair of
// neighboring samples whose elevations are on opposite sides of zero gives one
// crossing, placed by linear interpolation between the two samples. A crossing
// is {timeMS, rising}; rising is true when the elevation goes from below zero
// to zero or above.
//
// Two crossings closer together than stepMS (a pass that only grazes the
// horizon) can fall between two samples and are then not found.

export const HORIZON_STEP_MS = 30000;

export function findHorizonCrossings(elevationAt, startMS, endMS, stepMS = HORIZON_STEP_MS) {
    const crossings = [];
    let previousTime = startMS;
    let previousElevation = elevationAt(startMS);
    let time = startMS;
    while (time < endMS) {
        time = Math.min(endMS, time + stepMS);
        const elevation = elevationAt(time);
        if (Number.isFinite(previousElevation) && Number.isFinite(elevation)
            && (previousElevation < 0) !== (elevation < 0)) {
            const fraction = previousElevation / (previousElevation - elevation);
            crossings.push({
                timeMS: previousTime + fraction * (time - previousTime),
                rising: elevation > previousElevation,
            });
        }
        previousTime = time;
        previousElevation = elevation;
    }
    return crossings;
}
