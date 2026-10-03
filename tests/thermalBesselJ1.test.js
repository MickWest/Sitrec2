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
    console.info("J1 dense integral comparison", result);
    expect(result.maximum).toBeLessThanOrEqual(1e-10);
}, 60000);

test("J1 resolves both branches and both sides of the switch", () => {
    const xs = Array.from({length: 24577}, (_, i) => i / 2048);
    xs.push(11 - 8 * Number.EPSILON, 11, 11 + 8 * Number.EPSILON);
    const result = worstError(xs, x => integralJ1(x));
    console.info("J1 fine series/switch comparison", result);
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
    console.info("J1 integral refinement difference", maximum);
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

// Calculated outputs of the previous implementation, retained as values only.
// Its measured absolute error is about 5e-9, largest just below |x| = 8;
// a 6e-9 absolute budget includes that error and the new implementation's error.
// Relative error is unsuitable at zeros. These values span both old/new branch
// transitions, the first three zeros, and the full tested argument range.
const previousOutputs = [
    [0, 0],
    [1e-12, 5.000000000760061e-13],
    [0.1, 0.049937526043523334],
    [0.25, 0.12402597733693042],
    [0.5, 0.24226845767957006],
    [0.75, 0.34924360214402644],
    [1, 0.4400505856771301],
    [1.25, 0.5106232602494581],
    [1.5, 0.5579365078908043],
    [1.75, 0.580156197706936],
    [2, 0.5767248078962938],
    [2.25, 0.5483783567848086],
    [2.5, 0.49709410250442176],
    [2.75, 0.42597230283991766],
    [3, 0.3390589582725358],
    [3.25, 0.2411196877319747],
    [3.5, 0.13737752717818574],
    [3.75, 0.033229349105749206],
    [4, -0.06604332795908473],
    [4.25, -0.1555531930152246],
    [4.5, -0.2310604322641216],
    [4.75, -0.2891867993674216],
    [5, -0.3275791385663632],
    [5.25, -0.34501397955592705],
    [5.5, -0.3414382162311407],
    [5.75, -0.31794452464760536],
    [6, -0.27668385915946636],
    [6.25, -0.22072087924313627],
    [6.5, -0.15384130375413999],
    [6.75, -0.08032278774263196],
    [7, -0.004682825726925465],
    [7.25, 0.06858169814416658],
    [7.5, 0.1352484238519061],
    [7.75, 0.19160258810331862],
    [8, 0.23463634662568797],
    [8.25, 0.26220355183126826],
    [8.5, 0.27312196357148644],
    [8.75, 0.2672178914334058],
    [9, 0.2453117865662281],
    [9.25, 0.20914665050898978],
    [9.5, 0.16126443084319333],
    [9.75, 0.10483850138938673],
    [10, 0.04347274633934274],
    [10.25, -0.01902045549673215],
    [10.5, -0.07885001401093526],
    [10.75, -0.13247010232571252],
    [11, -0.176785298754234],
    [11.25, -0.20932517945139853],
    [11.5, -0.22837862053295802],
    [11.75, -0.23308058819087632],
    [12, -0.22344710446120497],
    [12.25, -0.2003571987804806],
    [12.5, -0.16548380469006757],
    [12.75, -0.121178550942572],
    [13, -0.07031805227605177],
    [13.25, -0.01612147441255661],
    [13.5, 0.03804929189586606],
    [13.75, 0.08889464655188797],
    [14, 0.13337515452077847],
    [14.25, 0.16889055333036038],
    [14.5, 0.19342946347159234],
    [14.75, 0.2056812713995987],
    [15, 0.20510403856910112],
    [15.25, 0.19194500945418116],
    [15.5, 0.16721318039439412],
    [15.75, 0.13260627474020287],
    [16, 0.0903971757783616],
    [7.9999, 0.23462210846567993],
    [8.0001, 0.23465057750827262],
    [10.9999, -0.1767697859161585],
    [11.0001, -0.17680080969804965],
    [3.8317059702075125, 1.98411995725538e-11],
    [7.015586669815619, -2.234965511180584e-9],
    [10.173468135062722, 1.9234607997117074e-10],
    [20, 0.06683312401580496],
    [80, -0.056057296600897706],
    [140, 0.05627305274432983],
    [200, -0.05430453815391219],
    [260, 0.04945313460103869],
    [320, -0.0419882298685719],
    [380, 0.03249301609821735],
    [440, -0.021713086808666154],
    [500, 0.010472613494913104],
    [560, 0.0003971456421711754],
    [620, -0.010124130925205027],
    [680, 0.01805452641399358],
    [740, -0.02370078557577785],
    [800, 0.02677513870740379],
    [860, -0.02720612963994474],
    [920, 0.02513712020718452],
    [980, -0.020907216107856102],
    [1040, 0.015016543098149237],
    [1100, -0.008079099614580988],
    [1160, 0.0007674165776738707],
    [1220, 0.0062461179092605295],
    [1280, -0.012346212340198082],
    [1340, 0.017025088621047988],
    [1400, -0.019922200993253557],
    [1460, 0.020850101263534614],
    [1520, -0.019804557483075438],
    [1580, 0.016958439677010547],
    [1640, -0.012640310690797074],
    [1700, 0.007299977230644564],
    [1760, -0.001464351422725197],
    [1820, -0.004312246442460894],
    [1880, 0.009498811836641538],
    [1999, 0.0028759404204409763],
    [2000, 0.016370141512395867],
];
test("J1 agrees with previous outputs within their 6e-9 absolute accuracy", () => {
    let maximum = 0;
    for (const [x, previous] of previousOutputs) {
        maximum = Math.max(maximum, Math.abs(j1(x) - previous));
        expect(Math.abs(previous - integralJ1(x))).toBeLessThanOrEqual(6e-9);
    }
    console.info("J1 previous-output comparison", maximum);
    expect(maximum).toBeLessThanOrEqual(6e-9);
});

