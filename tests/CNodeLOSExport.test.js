import {Matrix3, Vector3} from "three";
import {CNodeLOS} from "../src/nodes/CNodeLOS";
import {ENU2ECEF_radii, updateEarthRadii} from "../src/LLA-ECEF-ENU";

describe("CNodeLOS reverse export check", () => {
    afterEach(() => updateEarthRadii(false));

    test("compares CSV rows with the source frames that were exported", () => {
        for (const useEllipsoid of [false, true]) {
            updateEarthRadii(useEllipsoid);
            const originLat = 40 * Math.PI / 180;
            const originLon = -105 * Math.PI / 180;
            const enuToEcef = new Matrix3().set(
                -Math.sin(originLon), Math.cos(originLon), 0,
                -Math.sin(originLat) * Math.cos(originLon), -Math.sin(originLat) * Math.sin(originLon), Math.cos(originLat),
                Math.cos(originLat) * Math.cos(originLon), Math.cos(originLat) * Math.sin(originLon), Math.sin(originLat)
            ).invert();

            const frameData = new Map();
            const rows = [
                {frame: 5, pos: new Vector3(10, 20, 1000), heading: new Vector3(0.1, 0.2, -0.9).normalize()},
                {frame: 8, pos: new Vector3(30, 40, 1200), heading: new Vector3(-0.2, 0.1, -0.8).normalize()},
            ];

            for (const row of rows) {
                frameData.set(row.frame, {
                    position: ENU2ECEF_radii(row.pos, originLat, originLon),
                    heading: row.heading.clone().applyMatrix3(enuToEcef).normalize(),
                });
            }

            const csv = [
                "Time, SensorPositionX, SensorPositionY, SensorPositionZ, LOSUnitVectorX, LOSUnitVectorY, LOSUnitVectorZ, maxRange, LOSUncertaintyVertical, LOSUncertaintyHorizontal, OriginLat, OriginLon, BaseAltitude",
                ...rows.map(({pos, heading}) =>
                    `0,${pos.x},${pos.y},${pos.z},${heading.x},${heading.y},${heading.z},-1,1,1,40,-105,0`),
            ].join("\n");

            const node = Object.create(CNodeLOS.prototype);
            node.getValueFrame = jest.fn(frame => frameData.get(frame));
            jest.spyOn(console, "log").mockImplementation(() => {});
            jest.spyOn(console, "warn").mockImplementation(() => {});

            const result = node.testReverseExport(csv, originLat, originLon, rows.map(row => row.frame));

            expect(node.getValueFrame.mock.calls.map(([frame]) => frame)).toEqual([5, 8]);
            expect(result.count).toBe(2);
            expect(result.maxPosError).toBeLessThan(1e-6);
            expect(result.maxHeadingError).toBeLessThan(1e-6);
        }
    });
});
