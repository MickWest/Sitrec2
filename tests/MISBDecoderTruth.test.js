import {execFileSync} from "child_process";
import path from "path";

// Independent wire fixtures from the signed/unsigned mappings in ST 0601.8,
// sections 8.6–8.7, 8.13–8.24, 8.82–8.93. No Sitrec encoder is involved.
// https://upload.wikimedia.org/wikipedia/commons/1/19/MISB_Standard_0601.pdf
function packet(tag, hex) {
    const value = Buffer.from(hex, "hex");
    const payload = Buffer.concat([
        Buffer.from("020800060a24181e4000", "hex"), // timestamp, first element
        Buffer.from([tag, value.length]), value,
        Buffer.from("41010801020000", "hex"), // version 8, checksum last
    ]);
    const result = Buffer.concat([
        Buffer.from("060e2b34020b01010e01030101000000", "hex"),
        Buffer.from([payload.length]), payload,
    ]);
    let checksum = 0;
    for (let i = 0; i < result.length - 2; i++) checksum += result[i] << (i % 2 === 0 ? 8 : 0);
    result.writeUInt16BE(checksum & 0xffff, result.length - 2);
    return Array.from(result);
}

// Jest maps .mjs files to a stub; exercise the actual bundled parser in ESM.
function decode(fixtures) {
    return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
        import {readFileSync} from "node:fs";
        import {parse} from "./src/js/misb.js-main/src/st0601.mjs";
        const packets = JSON.parse(readFileSync(0, "utf8"));
        process.stdout.write(JSON.stringify(packets.map(p => parse(Uint8Array.from(p)))));
    `], {
        cwd: path.resolve(__dirname, ".."),
        input: JSON.stringify(fixtures.map(([tag, hex]) => packet(tag, hex))),
        encoding: "utf8",
    }));
}

test("full platform angles use all four bytes and the specified angular range", () => {
    const fixtures = [
        [90, "40000000", 45], [91, "40000000", 45], [92, "40000000", 45], [93, "40000000", 90],
        [90, "c0000000", -45], [91, "c0000000", -45], [92, "c0000000", -45], [93, "c0000000", -90],
        [90, "7fffffff", 90], [91, "80000001", -90], [93, "7fffffff", 180],
    ];
    decode(fixtures).forEach((items, i) => {
        expect(items.find(item => item.key === fixtures[i][0]).value).toBeCloseTo(fixtures[i][2], 6);
    });
});

test("unknown signed values remain null and do not prevent later tags from decoding", () => {
    const signed16 = [6, 7, 26, 27, 28, 29, 30, 31, 32, 33, 50, 51, 52, 79, 80];
    const signed32 = [13, 14, 19, 23, 24, 40, 41, 67, 68, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93];
    const fixtures = [...signed16.map(tag => [tag, "8000"]), ...signed32.map(tag => [tag, "80000000"])];
    decode(fixtures).forEach((items, i) => {
        expect(items.find(item => item.key === fixtures[i][0]).value).toBeNull();
        expect(items.find(item => item.key === 65).value).toBe(8);
        expect(items.at(-1).key).toBe(1);
    });
});

test("full corner coordinates accept valid negative values sharing the sentinel prefix", () => {
    const fixtures = Array.from({length: 8}, (_, i) => [82 + i, "80000001", i % 2 ? -180 : -90]);
    fixtures.push([82, "80001234", -90 + 0x1233 * 90 / 0x7fffffff]);
    fixtures.push([83, "80001234", -180 + 0x1233 * 180 / 0x7fffffff]);
    decode(fixtures).forEach((items, i) => {
        expect(items.find(item => item.key === fixtures[i][0]).value).toBeCloseTo(fixtures[i][2], 10);
    });
});

test("sensor FOV, altitude, range and azimuth retain their unsigned big-endian mappings", () => {
    const fixtures = [
        [15, "0000", -900], [15, "ffff", 19000],
        [16, "8000", 32768 * 180 / 65535], [17, "4000", 16384 * 180 / 65535],
        [5, "ffff", 360], [18, "40000000", 0x40000000 * 360 / 0xffffffff],
        [20, "ffffffff", 360], [21, "00000001", 5000000 / 0xffffffff],
    ];
    decode(fixtures).forEach((items, i) => {
        expect(items.find(item => item.key === fixtures[i][0]).value).toBeCloseTo(fixtures[i][2], 9);
    });
});
