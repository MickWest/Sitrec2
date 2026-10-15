import {appendAll, bytesToBinaryString, maxOf, minOf} from "../src/SafeArrays";

const BIG = 500000;   // well past any engine's argument limit

describe("SafeArrays", () => {
    test("the spread forms these helpers replace do fail at this size", () => {
        const big = new Array(BIG).fill(1);
        expect(() => [].push(...big)).toThrow(RangeError);
        expect(() => Math.max(...big)).toThrow(RangeError);
    });

    test("appendAll appends every item in order and returns the target", () => {
        const items = Array.from({length: BIG}, (_, i) => i);
        const target = [-1];
        expect(appendAll(target, items)).toBe(target);
        expect(target).toHaveLength(BIG + 1);
        expect(target[0]).toBe(-1);
        expect(target[BIG]).toBe(BIG - 1);
        expect(appendAll([1], new Set([2, 3]))).toEqual([1, 2, 3]);
    });

    test("maxOf and minOf handle large arrays, typed arrays and iterators", () => {
        const values = Float64Array.from({length: BIG}, (_, i) => Math.sin(i) * i);
        let max = -Infinity, min = Infinity;
        for (const v of values) { max = Math.max(max, v); min = Math.min(min, v); }
        expect(maxOf(values)).toBe(max);
        expect(minOf(values)).toBe(min);
        expect(minOf(new Map([[30, "a"], [10, "b"], [20, "c"]]).keys())).toBe(10);
    });

    test("maxOf and minOf keep Math.max and Math.min semantics exactly", () => {
        for (const case_ of [[], [3], [1, 5, 2], [-0, 0], [0, -0], [1, NaN, 3], [-Infinity], [Infinity, 2]]) {
            expect(Object.is(maxOf(case_), Math.max(...case_))).toBe(true);
            expect(Object.is(minOf(case_), Math.min(...case_))).toBe(true);
        }
    });

    test("bytesToBinaryString maps each byte to one character, for large buffers", () => {
        const bytes = Uint8Array.from({length: BIG}, (_, i) => i % 256);
        const s = bytesToBinaryString(bytes);
        expect(s).toHaveLength(BIG);
        expect(s.charCodeAt(0)).toBe(0);
        expect(s.charCodeAt(255)).toBe(255);
        expect(s.charCodeAt(BIG - 1)).toBe((BIG - 1) % 256);
        expect(bytesToBinaryString(new Uint8Array([72, 105]))).toBe("Hi");
        expect(bytesToBinaryString(new Uint8Array(0))).toBe("");
    });
});
