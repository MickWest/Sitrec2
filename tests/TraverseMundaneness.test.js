import {mundanenessCost, mundanenessSummary, physicalClassChecks, physicalCompatibilityDetails}
    from "../src/TraverseMundaneness";
import {balloonConsistency} from "../src/TraverseMotion";
import {judgingClass} from "../src/TraverseCriteria";
import {KNOTS_TO_MS} from "../src/TraverseAnalysis";
import {MULTIROTOR_LIMITS} from "../src/PhysicalEnvelopes";
import {QuadcopterModel} from "../src/QuadcopterModel";
import {quadcopterById} from "../src/VehicleModels";

function path(circling) {
    const track = new Float64Array(361 * 3);
    for (let i = 0; i <= 360; i++) {
        const theta = i * 4 * Math.PI / 360;
        track[i * 3] = circling ? 250 * Math.cos(theta) : i * 8;
        track[i * 3 + 1] = circling ? 250 * Math.sin(theta) : 0;
        track[i * 3 + 2] = 500;
    }
    return track;
}

function candidate(key, {min = 49, max = 50, mean = 49.7, g = 0.27, circling = true} = {}) {
    return {key, track: path(circling), metricsFull: {
        airSpeed: {min: min * KNOTS_TO_MS, max: max * KNOTS_TO_MS, mean: mean * KNOTS_TO_MS},
        gLoad: {max: g}, range: {mean: 10500},
    }};
}

test("a gentle two-circuit drone path is not labelled an ordinary balloon", () => {
    const h = candidate("quadcopter");
    const cost = mundanenessCost(null, h);
    expect(cost.classes.find(c => c.key === "balloon").motionRejected).toBe(true);
    expect(cost.compatibleClasses.map(c => c.key)).toEqual(["bird", "quadcopter", "smallUAS"]);
    expect(mundanenessSummary(cost)).toContain("Balloon fails the steady-drift check");
    expect(mundanenessSummary(cost)).toContain("size unmeasured");
    expect(mundanenessSummary(cost)).not.toContain("ordinary balloon");
    expect(physicalCompatibilityDetails(cost)).toContain("net horizontal displacement");
    expect(balloonConsistency(h.track)).toBeLessThan(0.01);
});

test("HSV receives the same physical checks regardless of solver label", () => {
    const h = candidate("horizontalSpeed", {min: 32.6, max: 58, mean: 46.9, g: 1.43});
    const classes = mundanenessCost(null, h).compatibleClasses.map(c => c.key);
    expect(classes).toContain("quadcopter");
    expect(classes).not.toContain("balloon");
    expect(physicalClassChecks(null, {...h, key: "quadcopter"}))
        .toEqual(physicalClassChecks(null, h));
    expect(judgingClass(h).cls.key).not.toBe("balloon");
});

test("straight drift still admits a balloon without choosing it over tied classes", () => {
    const cost = mundanenessCost(null, candidate("constAlt", {min: 10, max: 10, mean: 10, g: 0.01, circling: false}));
    expect(cost.compatibleClasses.map(c => c.key)).toEqual(["balloon", "bird", "quadcopter"]);
    expect(mundanenessSummary(cost)).toContain("balloon, bird, multirotor");
});

test("peak speed and the fixed-wing minimum cannot hide behind an ordinary average", () => {
    const cost = mundanenessCost(null, candidate("horizontalSpeed", {min: 0, max: 130, mean: 40}));
    expect(cost.classes.find(c => c.key === "quadcopter").speedCost).toBeGreaterThan(0);
    expect(cost.classes.find(c => c.key === "smallUAS").speedCost).toBe(Infinity);
    expect(cost.compatibleClasses).toHaveLength(0);
});

test("multirotor compatibility and the generic model share a speed limit in m/s", () => {
    const h = candidate("horizontalSpeed", {min: 45 / KNOTS_TO_MS, max: 45 / KNOTS_TO_MS});
    expect(physicalClassChecks(null, h).classes.find(c => c.key === "quadcopter").compatible).toBe(true);
    const model = new QuadcopterModel();
    expect(model.getParameterDefs().find(p => p.name === "speed").max).toBe(MULTIROTOR_LIMITS.maxSpeed);
    expect(quadcopterById("auto").maxSpeed).toBe(MULTIROTOR_LIMITS.maxSpeed);

    h.metricsFull.airSpeed.max = 65;
    h.metricsFull.horizontalAirSpeed = {min: 45, max: 60, mean: 50};
    const check = physicalClassChecks(null, h).classes.find(c => c.key === "quadcopter");
    expect(check.compatible).toBe(true);
    expect(check.speedBasis).toBe("horizontal");
    h.metricsFull.horizontalAirSpeed.max = 61;
    expect(physicalClassChecks(null, h).classes.find(c => c.key === "quadcopter").compatible).toBe(false);
});

test("missing path data is disclosed, not a demonstrated drift match", () => {
    const h = candidate("gfCV");
    delete h.track;
    const cost = mundanenessCost(null, h);
    expect(cost.unknown).toContain("drift shape");
    expect(mundanenessSummary(cost)).toContain("drift shape unmeasured");
});

test.each(["identity", "atInfinity", "nonPhysical", "underground", "groundMismatch"])(
    "%s candidates do not receive physical-class compatibility claims", (flag) => {
        expect(mundanenessCost(null, {...candidate("gfCV"), [flag]: true})).toBeNull();
    });
