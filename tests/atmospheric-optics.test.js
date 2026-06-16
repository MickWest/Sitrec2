import {
    circumhorizontalCenterAltitudeDeg,
    circumzenithalCenterAltitudeDeg,
    lunarOpticsPhaseScale,
    platePrismDeviationRay,
    sunDogOffsetsDeg,
} from "../src/nodes/CNodeAtmosphericOptics";
import {Vector3} from "three";

const DEG = Math.PI / 180;

function azElDeg(dir) {
    return {
        azDeg: Math.atan2(dir.y, dir.x) / DEG,
        elDeg: Math.asin(dir.z) / DEG,
    };
}

describe("atmospheric optics plate-crystal centerlines", () => {
    test("circumzenithal arc rises toward zenith at the high-Sun limit", () => {
        expect(circumzenithalCenterAltitudeDeg(0)).toBeCloseTo(57.8, 1);
        expect(circumzenithalCenterAltitudeDeg(22)).toBeCloseTo(67.7, 1);
        expect(circumzenithalCenterAltitudeDeg(32)).toBeGreaterThan(84);
        expect(circumzenithalCenterAltitudeDeg(35)).toBeNull();
    });

    test("circumhorizontal arc starts near the horizon and rises with high Sun", () => {
        expect(circumhorizontalCenterAltitudeDeg(55)).toBeNull();
        expect(circumhorizontalCenterAltitudeDeg(58)).toBeLessThan(5);
        expect(circumhorizontalCenterAltitudeDeg(70)).toBeCloseTo(24.1, 1);
        expect(circumhorizontalCenterAltitudeDeg(90)).toBeCloseTo(32.2, 1);
    });
});

describe("atmospheric optics sun dog geometry", () => {
    test("sun dogs detach outward from the 22 degree halo as Sun elevation rises", () => {
        const horizon = sunDogOffsetsDeg(0);
        const high = sunDogOffsetsDeg(40);

        expect(horizon.greatCircleDeg).toBeCloseTo(21.8, 1);
        expect(high.greatCircleDeg).toBeGreaterThan(27);
        expect(high.azimuthDeg).toBeGreaterThan(high.greatCircleDeg);
    });

    test("sun dogs end at the high-Sun total-internal-reflection cutoff", () => {
        expect(sunDogOffsetsDeg(60)).not.toBeNull();
        expect(sunDogOffsetsDeg(61)).toBeNull();
    });

    test("plate-axis wobble tilts sun dogs outward from the Sun", () => {
        const sunElev = 29.48 * DEG;
        const source = new Vector3(Math.cos(sunElev), 0, Math.sin(sunElev));
        const zenith = new Vector3(0, 0, 1);
        const sunward = new Vector3(1, 0, 0);
        const side = new Vector3(0, 1, 0);

        for (const sign of [1, -1]) {
            const tiltDir = sunward.clone().addScaledVector(side, -sign).normalize();
            const sample = (tiltDeg) => {
                const tilt = tiltDeg * DEG;
                const axis = zenith.clone().multiplyScalar(Math.cos(tilt))
                    .addScaledVector(tiltDir, Math.sin(tilt))
                    .normalize();
                return azElDeg(platePrismDeviationRay(source, axis, sign));
            };

            const lower = sample(-6);
            const upper = sample(6);
            expect(upper.elDeg).toBeGreaterThan(lower.elDeg);
            expect(Math.abs(upper.azDeg)).toBeGreaterThan(Math.abs(lower.azDeg));
        }
    });

    test("off-minimum prism deviation makes the sun dog tail extend outward", () => {
        const sunElev = 29.48 * DEG;
        const source = new Vector3(Math.cos(sunElev), 0, Math.sin(sunElev));
        const zenith = new Vector3(0, 0, 1);

        for (const sign of [1, -1]) {
            const head = azElDeg(platePrismDeviationRay(source, zenith, sign));
            const tail = azElDeg(platePrismDeviationRay(source, zenith, sign, 3 * DEG));
            expect(Math.abs(tail.azDeg)).toBeGreaterThan(Math.abs(head.azDeg));
            expect(tail.elDeg).toBeCloseTo(head.elDeg, 8);
        }
    });
});

describe("atmospheric optics lunar brightness", () => {
    test("lunar phase brightness is much steeper than illuminated fraction", () => {
        expect(lunarOpticsPhaseScale(-1)).toBeCloseTo(1, 6); // full Moon
        expect(lunarOpticsPhaseScale(0)).toBeLessThan(0.12); // quarter Moon
        expect(lunarOpticsPhaseScale(0.8)).toBeLessThan(0.02); // crescent
        expect(lunarOpticsPhaseScale(1)).toBeLessThan(0.001); // new Moon
    });
});
