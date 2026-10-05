import {buildOpticalDomain} from "./sensorMath.js";

// Only numeric arrays cross this boundary. Scene objects and GPU resources stay
// on the rendering thread. A worker owns at most one construction at a time.
export function buildOpticsMessage({id, settings, width, height, spectrum}, publish = null) {
    const start = performance.now();
    try {
        const domain = buildOpticalDomain(settings, width, height, spectrum, publish ? anchor =>
            publish({id, domain: anchor, complete: false, buildMs: performance.now() - start}) : null);
        return {id, domain, complete: true, buildMs: performance.now() - start};
    } catch (error) {return {id, error: error.message};}
}
if (typeof self !== "undefined") self.onmessage = event => {
    // The anchor arrays are still needed for validation: clone this early reply,
    // and transfer ownership only when the completed domain is ready.
    const result = buildOpticsMessage(event.data, message => self.postMessage(message)), buffers = new Set();
    for (const cell of result.domain?.intervals ?? []) for (const basis of [cell.a, cell.b])
        for (const kernel of [...basis.bands, basis.scatter, basis.farScatter])
            if (kernel) buffers.add(kernel.data.buffer);
    for (const cell of result.domain?.intervals ?? []) for (const band of cell.coefficients ?? [])
        for (const coefficient of band) buffers.add(coefficient.buffer);
    self.postMessage(result, [...buffers]);
};
