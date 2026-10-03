import {automaticWindow, plateauLUT, processingParameters, gainStatistics, clamp, validateImage} from "../tools/thermal/sensorMath.js";

// Preserve the original algorithms as independent exact references.
function referenceWindow(counts, {lowPercentile = 0.01, highPercentile = 0.99,
    minimumSpan = 32, timeConstantS = 0, deltaTimeS = 0, dynamics = "endpoints"} = {}, previous = null) {
    validateImage(counts);
    if (!(lowPercentile >= 0 && highPercentile <= 1 && highPercentile > lowPercentile &&
        minimumSpan > 0 && Number.isFinite(minimumSpan) && timeConstantS >= 0 && Number.isFinite(timeConstantS) &&
        deltaTimeS >= 0 && Number.isFinite(deltaTimeS))) throw new RangeError("Invalid automatic window controls");
    const sorted = counts.slice().sort();
    const low = sorted[Math.floor(lowPercentile * (sorted.length - 1))];
    const high = Math.max(sorted[Math.floor(highPercentile * (sorted.length - 1))], low + minimumSpan);
    const alpha = previous ? (deltaTimeS === 0 ? 0 : timeConstantS === 0 ? 1 : -Math.expm1(-deltaTimeS / timeConstantS)) : 1;
    if (previous && dynamics === "gainOffset") {
        // Calculated affine map: drive = gain * counts + offset. Video recovery
        // constrains these displayed coefficients, not the count endpoints.
        const oldGain = 1 / (previous.high - previous.low), targetGain = 1 / (high - low);
        const gain = oldGain + alpha * (targetGain - oldGain);
        const offset = -previous.low * oldGain + alpha * (-low * targetGain + previous.low * oldGain);
        return {low: -offset / gain, high: (1 - offset) / gain};
    }
    return {low: previous ? previous.low + alpha * (low - previous.low) : low,
        high: previous ? previous.high + alpha * (high - previous.high) : high};
}

function referencePlateau(drive, plateauFactor = 4, bins = 256, countLevels = false) {
    validateImage(drive);
    if (!(plateauFactor > 0 && Number.isFinite(plateauFactor) && Number.isInteger(bins) && bins >= 2)) throw new RangeError("Invalid plateau controls");
    const histogram = new Float64Array(bins), lut = new Float32Array(bins);
    for (const value of drive) histogram[countLevels ? Math.round(clamp(value, 0, bins - 1)) : Math.floor(clamp(value) * (bins - 1))]++;
    const cap = plateauFactor * drive.length / bins;
    let total = 0, first = 0, found = false;
    for (let bin = 0; bin < bins; bin++) {
        total += Math.min(histogram[bin], cap);
        lut[bin] = total;
        if (!found && histogram[bin] > 0) { first = total; found = true; }
    }
    for (let bin = 0; bin < bins; bin++) lut[bin] = total > first ? clamp((lut[bin] - first) / (total - first)) : bin / (bins - 1);
    return {values: lut, constant: total <= first};
}

function randomSequence(seed = 123456) {
    return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
}

function benchmark() {
    const random = randomSequence(), size = 640 * 512;
    const frames = {
        integer: Float32Array.from({length: size}, () => Math.floor(random() * 16384)),
        fractional: Float32Array.from({length: size}, () => random() * 16383),
        constant: new Float32Array(size).fill(8100.125),
        twoValue: Float32Array.from({length: size}, (_, i) => i % 2 ? 100.25 : 15000.75),
        ascending: Float32Array.from({length: size}, (_, i) => i / 20),
        descending: Float32Array.from({length: size}, (_, i) => (size - i) / 20),
    };
    for (const [name, counts] of Object.entries(frames)) {
        const settings = {gainMode: "automatic", gainRegion: "detector", plateauFactor: 4};
        const tasks = {
            window: () => automaticWindow(counts),
            plateau: () => plateauLUT(counts, 4, 16384, true),
            automaticParameters: () => processingParameters(counts, settings),
            plateauParameters: () => processingParameters(counts, {...settings, gainMode: "plateau"}),
        };
        for (const [path, run] of Object.entries(tasks)) {
            for (let i = 0; i < 20; i++) run();
            const times = [];
            for (let i = 0; i < 60; i++) {
                const start = performance.now(); run(); times.push(performance.now() - start);
            }
            times.sort((a, b) => a - b);
            console.log(`${name} ${path}: median=${times[30].toFixed(3)} p95=${times[57].toFixed(3)} max=${times[59].toFixed(3)} ms`);
        }
    }
}

if (process.env.THERMAL_GAIN_BENCH === "1") benchmark();

if (typeof test === "function") {
    test.each(["endpoints", "gainOffset"])("exact percentile windows with %s dynamics", dynamics => {
        const random = randomSequence();
        const fields = [new Float32Array([7]), new Float32Array(100).fill(123.25),
            new Float32Array([-0, 0, -0, 0]), new Float32Array([-0]),
            new Float32Array([-3.4028234663852886e38, -1e-40, -0, 0, 1e-40, 3.4028234663852886e38]),
            Float32Array.from({length: 1000}, (_, i) => i % 3 ? 16383 : 0),
            new Float32Array([999, -8, -0, 0, 2, 1000]).subarray(1, 5)];
        for (let trial = 0; trial < 100; trial++) {
            fields.push(Float32Array.from({length: 1 + Math.floor(random() * 5000)}, () => {
                const value = random() * 40000 - 20000;
                return trial % 3 === 0 ? Math.round(value) : trial % 3 === 1 ? value : Math.fround((random() - .5) * 2 ** Math.floor(random() * 250 - 125));
            }));
        }
        for (const counts of fields) {
            const original = counts.slice();
            for (const [lowPercentile, highPercentile] of [[0, 1], [.01, .99], [.49, .51], [.2, .20001]]) {
                for (const previous of [null, {low: -4.25, high: 8000.125}]) {
                    for (const deltaTimeS of [0, .03, 1]) {
                        const controls = {lowPercentile, highPercentile, minimumSpan: 32, timeConstantS: .12, deltaTimeS, dynamics};
                        expect(automaticWindow(counts, controls, previous)).toEqual(referenceWindow(counts, controls, previous));
                    }
                }
            }
            expect(counts).toEqual(original);
        }
    });
    test("plateau tables preserve exact rounding, clipping and constant fields", () => {
        const random = randomSequence();
        const fields = [new Float32Array([0]), new Float32Array(200).fill(.125),
            new Float32Array([-1, -0, 0, .5, 1, 1.5, 16382.5, 16383, 20000]),
            Float32Array.from({length: 640 * 512}, () => random() * 20000 - 1000)];
        for (let trial = 0; trial < 20; trial++) fields.push(Float32Array.from(
            {length: 1 + Math.floor(random() * 2000)}, () => random() * 20000 - 1000));
        for (const field of fields) for (const countLevels of [false, true]) {
            for (const bins of [2, 256, 16384]) for (const factor of [.1, 4, 100]) {
                expect(plateauLUT(field, factor, bins, countLevels)).toEqual(referencePlateau(field, factor, bins, countLevels));
            }
        }
    });

    test.each(["endpoints", "gainOffset"])("consecutive full-frame and cropped processing with %s dynamics", agcDynamics => {
        const random = randomSequence();
        const counts = Float32Array.from({length: 640 * 512}, () => random() * 16383);
        for (const gainMode of ["automatic", "plateau"]) for (const gainRegion of ["detector", "displayed"]) {
            const settings = {gainMode, gainRegion, agcDynamics, detectorWidth: 640, detectorHeight: 512,
                digitalZoom: 2, plateauFactor: 3.123, lowPercentile: .01, highPercentile: .99,
                minimumWindowCounts: 32, agcTimeConstantS: .12};
            let actualPrevious = null, expectedPrevious = null;
            for (let frame = 0; frame < 4; frame++) {
                for (let i = 0; i < counts.length; i++) counts[i] = .3 * counts[i] + .7 * random() * 16383;
                const statistics = gainStatistics(counts, 640, 512, settings);
                const controls = {lowPercentile: .01, highPercentile: .99, minimumSpan: 32,
                    timeConstantS: .12, deltaTimeS: frame === 2 ? 0 : 1 / 30, dynamics: agcDynamics};
                const expected = {window: referenceWindow(statistics, controls, expectedPrevious),
                    lut: gainMode === "plateau" ? referencePlateau(statistics, 3.123, 16384, true) : null,
                    statisticsCount: statistics.length};
                const actual = processingParameters(counts, settings, actualPrevious, controls.deltaTimeS);
                expect(actual).toEqual(expected);
                // A later call must not alter a caller's retained table or window.
                automaticWindow(new Float32Array([1, 1]));
                plateauLUT(new Float32Array([0, 1]));
                expect(actual).toEqual(expected);
                actualPrevious = actual.window; expectedPrevious = expected.window;
            }
        }
    });
    test("finite Float32 bit patterns, rank boundaries and minimum spans are exact", () => {
        const random = randomSequence(), words = new Uint32Array(20000);
        for (let i = 0; i < words.length; i++) {
            let word;
            do { word = Math.floor(random() * 4294967296); } while ((word & 0x7f800000) === 0x7f800000);
            words[i] = word;
        }
        const fields = [new Float32Array(words.buffer),
            Float32Array.from({length: 65537}, (_, i) => i / 65536),
            Float32Array.from({length: 65537}, (_, i) => (65536 - i) / 65536)];
        for (const counts of fields) for (const minimumSpan of [Number.MIN_VALUE, .125, 32, 1e40]) {
            for (const [lowPercentile, highPercentile] of [[0, 1], [0, .00001], [.99999, 1], [.5, .500001]]) {
                const controls = {minimumSpan, lowPercentile, highPercentile};
                expect(automaticWindow(counts, controls)).toEqual(referenceWindow(counts, controls));
            }
        }
    });
    test("invalid images and controls retain validation", () => {
        for (const counts of [[], new Float64Array([1]), new Float32Array(),
            new Float32Array([NaN]), new Float32Array([Infinity]), new Float32Array([-Infinity])]) {
            expect(() => automaticWindow(counts)).toThrow(RangeError);
            expect(() => plateauLUT(counts)).toThrow(RangeError);
        }
        const counts = new Float32Array([1, 2]);
        for (const controls of [{lowPercentile: -1}, {highPercentile: 2}, {lowPercentile: 1},
            {minimumSpan: 0}, {timeConstantS: -1}, {deltaTimeS: NaN}]) {
            expect(() => automaticWindow(counts, controls)).toThrow(RangeError);
        }
    });
}
