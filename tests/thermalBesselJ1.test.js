import {j1} from "../tools/thermal/sensorMath.js";

// Calculated reference: periodic trapezoidal quadrature of
// J1(x) = (1/(2*pi)) integral_0^(2*pi) cos(x*sin(t)-t) dt.
// N >= 4*|x|+64, with N >= 128, suppresses aliases exponentially: on the
// complex strip |Im(t)| <= 1, the exact-arithmetic quadrature error is bounded
// by 2*exp(|x|*sinh(1)+1)/(exp(N)-1), below 1e-45 here. Floating-point
// trigonometry dominates; compensated summation limits accumulation error.
// The oracle shares neither coefficients nor branches with the implementation.
const quadratureNodes = new Map();
function integralJ1(x, refinement = 1) {
    const count = refinement * 2 ** Math.ceil(Math.log2(Math.max(128, 4 * Math.abs(x) + 64)));
    if (!quadratureNodes.has(count)) {
        const angles = new Float64Array(count), sines = new Float64Array(count);
        for (let i = 0; i < count; i++) {
            angles[i] = 2 * Math.PI * i / count;
            sines[i] = Math.sin(angles[i]);
        }
        quadratureNodes.set(count, {angles, sines});
    }
    const {angles, sines} = quadratureNodes.get(count);
    let sum = 0, correction = 0;
    for (let i = 0; i < count; i++) {
        const term = Math.cos(x * sines[i] - angles[i]) - correction;
        const next = sum + term;
        correction = (next - sum) - term;
        sum = next;
    }
    return sum / count;
}

function worstError(xs, reference) {
    let maximum = 0, argument = 0;
    for (const x of xs) {
        const error = Math.abs(j1(x) - reference(x));
        expect(Number.isFinite(error)).toBe(true);
        if (error > maximum) {maximum = error; argument = x;}
    }
    return {maximum, argument};
}

// Calculated sample grids: 1/8 argument spacing resolves each oscillation;
// 1/2048 spacing near the series branch resolves cancellation and the switch.
const denseGrid = Array.from({length: 16001}, (_, i) => i / 8);
test("J1 has absolute error <= 1e-10 on a dense grid from 0 to 2000", () => {
    const result = worstError(denseGrid, x => integralJ1(x));
    expect(result.maximum).toBeLessThanOrEqual(1e-10);
}, 60000);

test("J1 resolves both branches and both sides of the switch", () => {
    const xs = Array.from({length: 24577}, (_, i) => i / 2048);
    xs.push(11 - 8 * Number.EPSILON, 11, 11 + 8 * Number.EPSILON);
    const result = worstError(xs, x => integralJ1(x));
    expect(result.maximum).toBeLessThanOrEqual(1e-10);
    expect(Math.abs(j1(xs[xs.length - 1]) - j1(xs[xs.length - 3]))).toBeLessThanOrEqual(1e-10);
}, 30000);

// Calculated with independent 80-decimal arithmetic and then rounded to binary64.
// Arguments are the exact binary64 values shown, including the neighbors of 11.
const precisionReference = [
    [1e-12, 5e-13],
    [0.125, 0.062378009134494684],
    [1, 0.4400505857449335],
    [3.8317059702075125, -6.149807356994906e-17],
    [7.015586669815619, 2.825339409478929e-17],
    [10.173468135062722, 1.1192177797744682e-16],
    [10.999999999999998, -0.17678529895672124],
    [11, -0.17678529895672151],
    [11.000000000000002, -0.17678529895672176],
    [16, 0.09039717566130419],
    [32, -0.026589028475905285],
    [128, 0.0705143491347411],
    [512, 0.026820902108731393],
    [1000, 0.004728311907089524],
    [1999.875, 0.015358422573106842],
    [2000, 0.016370141522854216],
];
test("J1 and the independent integral match high-precision reference values", () => {
    for (const [x, expected] of precisionReference) {
        expect(Math.abs(j1(x) - expected)).toBeLessThanOrEqual(1e-10);
        expect(Math.abs(integralJ1(x) - expected)).toBeLessThanOrEqual(2e-13);
        expect(Math.abs(integralJ1(x, 2) - expected)).toBeLessThanOrEqual(2e-13);
    }
});

test("doubling the integral samples converges across the full argument range", () => {
    let maximum = 0;
    for (let i = 0; i <= 2000; i++) {
        maximum = Math.max(maximum, Math.abs(integralJ1(i, 2) - integralJ1(i)));
    }
    expect(maximum).toBeLessThanOrEqual(2e-13);
}, 30000);

test("J1 has the first three positive zeros and the expected crossings", () => {
    // Calculated by independent 80-decimal root solving; arguments dimensionless.
    const zeros = [3.8317059702075125, 7.015586669815619, 10.173468135062722];
    for (const [index, zero] of zeros.entries()) {
        expect(Math.abs(j1(zero))).toBeLessThanOrEqual(1e-10);
        let low = zero - 0.1, high = zero + 0.1;
        for (let i = 0; i < 44; i++) {
            const middle = (low + high) / 2;
            if (integralJ1(low) * integralJ1(middle) > 0) low = middle;
            else high = middle;
        }
        expect(Math.abs((low + high) / 2 - zero)).toBeLessThanOrEqual(1e-12);
        const before = index % 2 === 0 ? 1 : -1;
        expect(before * j1(zero - 1e-6)).toBeGreaterThan(0);
        expect(before * j1(zero + 1e-6)).toBeLessThan(0);
    }
});

test("J1 preserves odd symmetry, signed zero, and the small-argument limit", () => {
    for (const x of denseGrid) expect(j1(-x)).toBe(-j1(x));
    expect(Object.is(j1(0), 0)).toBe(true);
    expect(Object.is(j1(-0), -0)).toBe(true);
    for (const x of [1e-20, 1e-12, 1e-6]) {
        expect(Math.abs(j1(x) / (x / 2) - 1)).toBeLessThanOrEqual(2e-13);
    }
});
