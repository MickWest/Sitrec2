import {degrees, radians} from "./mathUtils";

export function SlidingAverage(data, window, iterations = 1) {
    return smoothDerivative(data, window, iterations);
}

function solveLinearSystem(matrix, vector) {
    const size = matrix.length;
    const a = new Array(size);
    const b = new Array(size);

    for (let r = 0; r < size; r++) {
        a[r] = matrix[r].slice();
        b[r] = vector[r];
    }

    for (let col = 0; col < size; col++) {
        let pivot = col;
        let maxAbs = Math.abs(a[col][col]);
        for (let row = col + 1; row < size; row++) {
            const value = Math.abs(a[row][col]);
            if (value > maxAbs) {
                maxAbs = value;
                pivot = row;
            }
        }

        if (pivot !== col) {
            const tempRow = a[col];
            a[col] = a[pivot];
            a[pivot] = tempRow;

            const tempValue = b[col];
            b[col] = b[pivot];
            b[pivot] = tempValue;
        }

        const diagonal = a[col][col];
        if (Math.abs(diagonal) < 1e-12) {
            // Singular matrix; fallback to zeros so smoothing degrades gracefully.
            return new Array(size).fill(0);
        }

        for (let j = col; j < size; j++) {
            a[col][j] /= diagonal;
        }
        b[col] /= diagonal;

        for (let row = 0; row < size; row++) {
            if (row === col) continue;
            const factor = a[row][col];
            if (factor === 0) continue;
            for (let j = col; j < size; j++) {
                a[row][j] -= factor * a[col][j];
            }
            b[row] -= factor * b[col];
        }
    }

    return b;
}

function fitPolynomialLeastSquares(data, degree) {
    const n = data.length;
    const d = Math.max(0, Math.min(degree, n - 1));
    const size = d + 1;

    const normal = new Array(size);
    const rhs = new Array(size).fill(0);
    const powerSums = new Array(2 * d + 1).fill(0);

    for (let i = 0; i < n; i++) {
        let pow = 1;
        for (let p = 0; p <= 2 * d; p++) {
            powerSums[p] += pow;
            pow *= i;
        }

        let basis = 1;
        for (let p = 0; p <= d; p++) {
            rhs[p] += data[i] * basis;
            basis *= i;
        }
    }

    for (let row = 0; row < size; row++) {
        normal[row] = new Array(size);
        for (let col = 0; col < size; col++) {
            normal[row][col] = powerSums[row + col];
        }
    }

    return solveLinearSystem(normal, rhs);
}

function evalPolynomial(coefficients, x) {
    let value = 0;
    let pow = 1;
    for (let i = 0; i < coefficients.length; i++) {
        value += coefficients[i] * pow;
        pow *= x;
    }
    return value;
}

function padByPolynomialExtrapolation(data, pad, fitWindow, edgeOrder = 2) {
    const len = data.length;
    const fitCount = Math.max(3, Math.min(fitWindow, len));
    const order = Math.max(1, Math.min(edgeOrder, fitCount - 1));

    const leftSegment = data.slice(0, fitCount);
    const rightSegment = data.slice(len - fitCount);

    const leftCoefficients = fitPolynomialLeastSquares(leftSegment, order);
    const rightCoefficients = fitPolynomialLeastSquares(rightSegment, order);

    const leftPad = new Array(pad);
    for (let i = 0; i < pad; i++) {
        const x = -(pad - i);
        leftPad[i] = evalPolynomial(leftCoefficients, x);
    }

    const rightPad = new Array(pad);
    const lastIndex = fitCount - 1;
    for (let i = 0; i < pad; i++) {
        const x = lastIndex + (i + 1);
        rightPad[i] = evalPolynomial(rightCoefficients, x);
    }

    return leftPad.concat(data, rightPad);
}

function centeredAverageWithFixedWindow(data, halfWindow) {
    const len = data.length - 2 * halfWindow;
    const out = new Array(len);
    const span = halfWindow * 2 + 1;

    let sum = 0;
    for (let i = 0; i < span; i++) {
        sum += data[i];
    }

    for (let i = 0; i < len; i++) {
        out[i] = sum / span;
        const removeIndex = i;
        const addIndex = i + span;
        if (addIndex < data.length) {
            sum += data[addIndex] - data[removeIndex];
        }
    }

    return out;
}

function getSavitzkyGolayCoefficients(window, polyOrder) {
    const halfWindow = Math.floor(window / 2);
    const order = Math.max(0, polyOrder);
    const basisCount = order + 1;

    const ata = new Array(basisCount);
    const unit = new Array(basisCount).fill(0);
    unit[0] = 1;

    for (let row = 0; row < basisCount; row++) {
        ata[row] = new Array(basisCount).fill(0);
    }

    for (let x = -halfWindow; x <= halfWindow; x++) {
        const powers = new Array(basisCount);
        let pow = 1;
        for (let p = 0; p < basisCount; p++) {
            powers[p] = pow;
            pow *= x;
        }

        for (let r = 0; r < basisCount; r++) {
            for (let c = 0; c < basisCount; c++) {
                ata[r][c] += powers[r] * powers[c];
            }
        }
    }

    const projection = solveLinearSystem(ata, unit);
    const coefficients = new Array(window);

    for (let k = -halfWindow; k <= halfWindow; k++) {
        let value = 0;
        let pow = 1;
        for (let p = 0; p < basisCount; p++) {
            value += projection[p] * pow;
            pow *= k;
        }
        coefficients[k + halfWindow] = value;
    }

    return coefficients;
}

function applySavitzkyGolayOnce(data, window, polyOrder, edgeOrder, fitWindow) {
    const len = data.length;
    if (len === 0) return [];
    if (len < 3) return data.slice();

    let usedWindow = Math.max(3, Math.floor(window));
    if (usedWindow % 2 === 0) {
        usedWindow += 1;
    }
    if (usedWindow > len) {
        usedWindow = len % 2 === 0 ? len - 1 : len;
    }
    if (usedWindow < 3) return data.slice();

    let order = Math.max(1, Math.floor(polyOrder));
    order = Math.min(order, usedWindow - 2);

    const halfWindow = Math.floor(usedWindow / 2);
    const usedFitWindow = Math.max(usedWindow, Math.floor(fitWindow));
    const usedEdgeOrder = Math.max(order, Math.floor(edgeOrder));

    const extended = padByPolynomialExtrapolation(data, halfWindow, usedFitWindow, usedEdgeOrder);
    const coefficients = getSavitzkyGolayCoefficients(usedWindow, order);
    const out = new Array(len);

    for (let i = 0; i < len; i++) {
        const center = i + halfWindow;
        let value = 0;
        for (let k = -halfWindow; k <= halfWindow; k++) {
            value += coefficients[k + halfWindow] * extended[center + k];
        }
        out[i] = value;
    }

    return out;
}

// Moving average with polynomial extrapolation at each end.
// This keeps a fixed-width centered window across all frames and avoids edge kinks.
export function RollingAveragePolyEdge(data, window, iterations = 1, edgeOrder = 2, fitWindow = window) {
    let working = data;
    const len = data.length;
    if (len === 0) return [];

    if (typeof working[0] !== "number") {
        working = working.map(x => parseFloat(x));
    } else {
        working = working.slice();
    }

    const usedIterations = Math.max(1, Math.floor(iterations));

    for (let i = 0; i < usedIterations; i++) {
        const halfWindow = Math.floor(window / 2);
        if (halfWindow < 1 || len < 3) return working;

        const extended = padByPolynomialExtrapolation(working, halfWindow, fitWindow, edgeOrder);
        working = centeredAverageWithFixedWindow(extended, halfWindow);
    }

    return working;
}

// Savitzky-Golay smoothing with polynomial edge extrapolation.
// Preserves curvature significantly better than simple moving average.
export function SavitzkyGolay(data, window, polyOrder = 2, iterations = 1, edgeOrder = polyOrder, fitWindow = window) {
    let working = data;
    const len = data.length;
    if (len === 0) return [];

    if (typeof working[0] !== "number") {
        working = working.map(x => parseFloat(x));
    } else {
        working = working.slice();
    }

    const usedIterations = Math.max(1, Math.floor(iterations));
    for (let i = 0; i < usedIterations; i++) {
        working = applySavitzkyGolayOnce(working, window, polyOrder, edgeOrder, fitWindow);
    }

    return working;
}

// Sliding average
export function SlidingAverageX(data, window, iterations = 1) {
    for (var i = 0; i < iterations; i++) {
        var output = new Array()
        const n = data.length;
        // conversion from strings would typically be when data is a CSV column or similar.
        if (typeof data[0] !== 'number') {
            data = data.map(x => parseFloat(x))
        }

        // Prefix sums: prefix[k] = data[0] + ... + data[k-1].
        // Every sample in a frame's window shares the same fractional offset
        // (frac of the window start `a`), so the sum of the window's interpolated
        // samples decomposes into two integer range sums:
        //   sum = (1-frac) * S(x0 .. x0+W-1) + frac * S(x0+1 .. x0+W)
        // This is O(n) instead of the O(n * window) inner loop it replaces,
        // with identical results up to float summation order.
        // W = ceil(window) matches the original inner loop `for (w=0; w<window; w++)`,
        // which ran ceil(window) samples for a fractional window (the sum is still
        // divided by the fractional `window`, as before). Integer windows: W === window.
        const W = Math.ceil(window);
        const prefix = new Float64Array(n + 1);
        for (let k = 0; k < n; k++) {
            prefix[k + 1] = prefix[k] + data[k];
        }

        // data is index 0..len
        // the window start out starting at the current value,
        // and slides backwards until it ends up starting at at len-window
        for (var f = 0; f < n; f++) {
            let a = f - (f / (n - 1) * window);
            const x0 = Math.floor(a);
            const frac = a - x0;
            const sum = (1 - frac) * (prefix[x0 + W] - prefix[x0])
                      + frac * (prefix[x0 + W + 1] - prefix[x0 + 1]);
            output.push(sum / window)
        }
        data = output;
    }
    return output;
}

// given an array and a sample window size, then return a same sized array
// that has been smoothed by the rolling average method
// (somewhat ad-hoc method, by Mick)
export function RollingAverage(data, window, iterations = 1) {
    for (var i = 0; i < iterations; i++) {
        var output = new Array()
        const len = data.length;

        // conversion from strings would typically be when data is a CSV column or similar.
        if (typeof data[0] !== 'number') {
            data = data.map(x => parseFloat(x))
        }

        var xa = -1;
        var xb = -1;
        var sum = 0;
        const halfWindow = parseInt(window / 2) // force int, as otherwise it fails for odd numbers

        for (var f = 0; f < len; f++) {
            var a = f - halfWindow
            var b = f + halfWindow

            if (a < 0) {
                // a needs bringing up by -a to 0
                // so we also bring b down by a
                b += a;
                a = 0
            }
            if (b >= len) {
                // likewise at the end
                a += (b - (len - 1))
                b = len - 1
            }

            const samples = b - a + 1;

            if (xa === -1) {
                sum = 0;
                for (var x = a; x <= b; x++) {
                    sum += data[x]
                }
                xa = a
                xb = b
            } else {
                // a and/or b may have moved one or two, so account for that
                if (xb === b - 2) {
                    sum += data[b] + data[b - 1]
                    xb = b;
                } else if (xb === b - 1) {
                    sum += data[b]
                    xb = b;
                }
                if (xa === a - 2) {
                    sum -= data[xa] + data[xa + 1]
                    xa = a;
                } else if (xa === a - 1) {
                    sum -= data[xa]
                    xa = a;
                }
            }

            output.push(sum / samples)
        }
        data = output;
    }
    return output;
}

// same for degrees, handling wrap-around by independently smoothing the sine and cos of the angles
export function RollingAverageDegrees(data, window, iterations = 1) {
    const length = data.length;

    const sines = new Array(length)
    const cosines = new Array(length)
    for (let i = 0; i < length; i++) {
        const rad = radians(data[i])
        sines[i] = Math.sin(rad)
        cosines[i] = Math.cos(rad)
    }

    const smoothedSines = RollingAverage(sines, window, iterations)
    const smoothedCosines = RollingAverage(cosines, window, iterations)

    const output = new Array(length)
    for (let i = 0; i < length; i++) {
        output[i] = degrees(Math.atan2(smoothedSines[i], smoothedCosines[i]))
    }

    return output;
}

// given a 1d array of values, calculate the local derivatives of those values
// then smooth that
// then recalculate the values based on that derivative
// (i.e. given positions, calculate speed, smooth speed, then recalculate positions)
export function smoothDerivative(data, window, iterations) {
    const derivatives = []
    const len = data.length;
    for (var i = 0; i < len - 1; i++) {
        derivatives.push(data[i + 1] - data[i])
    }
    const smoothedDerivatives = SlidingAverageX(derivatives, window, iterations)
    const output = []
    output.push(data[0])
    for (i = 0; i < len - 1; i++) {
        output.push(output[i] + smoothedDerivatives[i])
    }
    return output
}
