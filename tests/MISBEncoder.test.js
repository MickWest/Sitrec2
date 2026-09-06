import {encodeMISBLocalSet, berLength} from "../src/MISBEncoder";

test("ST 0601 encodes signed limits without emitting unknown sentinels", () => {
    const packet = Buffer.from(encodeMISBLocalSet({2: 1000000, 13: -90, 14: 180, 15: -900, 16: 90, 19: -180}));
    expect(packet.subarray(0, 16).toString("hex")).toBe("060e2b34020b01010e01030101000000");
    expect(packet.subarray(17, 27).toString("hex")).toBe("020800000000000f4240");
    expect(packet.includes(Buffer.from("0d0480000001", "hex"))).toBe(true);
    expect(packet.includes(Buffer.from("0e047fffffff", "hex"))).toBe(true);
    expect(packet.includes(Buffer.from("0f020000", "hex"))).toBe(true);
    expect(packet.includes(Buffer.from("10028000", "hex"))).toBe(true);
    expect(packet.includes(Buffer.from("130480000001", "hex"))).toBe(true);
    let checksum = 0;
    for (let i = 0; i < packet.length - 2; i += 2) checksum += packet[i] * 256 + (packet[i + 1] || 0);
    expect(packet.readUInt16BE(packet.length - 2)).toBe(checksum & 65535);
});

test("BER long-form length uses the number of length octets", () => {
    expect(berLength(127)).toEqual([127]);
    expect(berLength(128)).toEqual([0x81, 128]);
    expect(berLength(256)).toEqual([0x82, 1, 0]);
    expect(berLength(65536)).toEqual([0x83, 1, 0, 0]);
});

test("invalid metadata is rejected instead of wrapped or silently clamped", () => {
    for (const values of [{2: 1.5}, {2: 1, 13: 91}, {2: 1, 15: 20000}, {2: 1, 17: NaN}, {2: 1, 99: 0}]) {
        expect(() => encodeMISBLocalSet(values)).toThrow();
    }
});
