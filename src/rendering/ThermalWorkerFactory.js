// The bundler resolves the module worker and all of its numeric dependencies to
// versioned assets. Load this factory only on the first thermal preparation.
export function createOpticsWorker() {
    if (typeof Worker === "undefined") return null;
    try {
        return new Worker(new URL("../../tools/thermal/opticsWorker.js", import.meta.url), {type: "module"});
    } catch {return null;}
}
