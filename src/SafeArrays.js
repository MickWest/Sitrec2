// Array helpers that never spread an array into a function call.
//
// f(...array) and f.apply(null, array) pass every element as a separate call argument.
// JavaScript engines limit the argument count by stack size (in V8 about 100,000; less
// in some browsers), so these forms throw "RangeError: Maximum call stack size exceeded"
// once the array is large. The code works on test data and fails on a real file.
//
// Use these helpers wherever the length depends on the data: file rows, frames, samples,
// directory entries, catalogue records. A spread over a fixed, small list (a vector, the
// corners of a box) is fine and need not change.
//
// tools/shf/ cannot import from src/ (it is served as raw modules), so the flare tool
// uses plain loops for the same reason; see tools/shf/flareEngine.js parseTLE.

// target.push(...items), for any size. Accepts any iterable. Returns target.
export function appendAll(target, items) {
    for (const item of items) target.push(item);
    return target;
}

// Math.max(...values), for any size. Accepts any iterable (an array, a typed array,
// map.keys()). Same result as Math.max in every case: -Infinity when empty, NaN if any
// value is NaN, and +0 over -0.
export function maxOf(values) {
    let m = -Infinity;
    for (const v of values) m = Math.max(m, v);
    return m;
}

// Math.min(...values), for any size, with the same semantics as Math.min.
export function minOf(values) {
    let m = Infinity;
    for (const v of values) m = Math.min(m, v);
    return m;
}

// String.fromCharCode(...bytes): one character per byte (Latin-1), for any size.
// Converts in chunks well under every engine's argument limit.
export function bytesToBinaryString(bytes) {
    const CHUNK = 0x8000;
    let s = "";
    for (let i = 0; i < bytes.length; i += CHUNK) {
        s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return s;
}
