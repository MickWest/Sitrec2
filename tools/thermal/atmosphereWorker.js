import {createAtmosphere, createThermalRayGeometry, createStatisticalSea, RangeTableCache, SeaSkyBackgroundCache} from "./atmosphere.js";
import {atmosphereFromSounding} from "./sounding.js";

// Scalar form of the host's terrestrial lift in its horizontal/up plane. The
// worker gets the host's actual radius and all refraction parameters, not an
// effective-radius substitute. Tested against liftCameraRelative.
export function workerRayGeometry(spec) {
    if (!spec) return undefined;
    const atAltitude = sensorAltitudeM => {
        const {earthRadiusM: R, k, scaleHeightM: H, maxBendRad, maxLiftM, domainKey} = spec;
        const lift = (d, z) => {
            const h1 = Math.max(0, sensorAltitudeM + z + .5 * d * d / R), h2 = Math.max(0, sensorAltitudeM), dh = h2 - h1;
            const density = Math.abs(dh) < 1e-6 ? Math.exp(-h1 / H) : H * (Math.exp(-h1 / H) - Math.exp(-h2 / H)) / dh;
            const linear = k * density * d / (2 * R);
            const bend = maxBendRad ? linear / Math.sqrt(1 + (linear / maxBendRad) ** 2) : linear;
            const value = d * bend;
            const saturated = maxLiftM ? value / Math.sqrt(1 + (value / maxLiftM) ** 2) : value;
            // The host returns (z + lift) - z, retaining its rounding too.
            return z + saturated - z;
        };
        return Object.assign(createThermalRayGeometry({sensorAltitudeM, earthRadiusM: R, lift,
            key: JSON.stringify([domainKey, sensorAltitudeM, R])}), {domainKey, atAltitude});
    };
    return atAltitude(spec.sensorAltitudeM);
}

let serial = 0, atmosphereKey, atmosphere;
export async function buildRangeDomain(data, current = () => true) {
    const key = JSON.stringify(data.atmosphere);
    if (key !== atmosphereKey) {
        const {sounding, options} = data.atmosphere;
        atmosphere = sounding ? atmosphereFromSounding(sounding, options).atmosphere : createAtmosphere(options);
        atmosphereKey = key;
    }
    const options={...data.options,rayGeometry:workerRayGeometry(data.raySpec)};
    const cache = data.kind === "seaSky" ? new SeaSkyBackgroundCache() : new RangeTableCache();
    const steps = data.kind === "seaSky" ? cache.build(options,atmosphere,createStatisticalSea(options.settings,atmosphere)) :
        cache.build(options, atmosphere, data.reuse);
    while (current()) {
        const start = performance.now();
        let result;
        do {result = steps.next();} while (!result.done && performance.now() - start < 8);
        if (result.done) return result.value;
        // Let a seek or disposal cancel obsolete work between integrations.
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    return null;
}

if (typeof self !== "undefined" && typeof document === "undefined") {
    self.onmessage = async ({data}) => {
        serial = data.serial;
        try {
            const domain = await buildRangeDomain(data, () => serial === data.serial);
            if (domain && serial === data.serial) self.postMessage({serial, domain});
        } catch (error) {
            if (serial === data.serial) self.postMessage({serial, error: error.message});
        }
    };
}
