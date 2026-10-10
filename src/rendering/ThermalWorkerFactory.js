// The bundler resolves the module worker and all of its numeric dependencies to
// versioned assets. Load this factory only on the first thermal preparation. The optics
// worker has its own factory next to its scheduler (sensorMath.js createDefaultOpticsWorker).
export function createAtmosphereWorker() {
    if (typeof Worker === "undefined") return null;
    try {
        return new Worker(new URL("../../tools/thermal/atmosphereWorker.js", import.meta.url), {type: "module"});
    } catch {return null;}
}
