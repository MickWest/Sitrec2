// Small, dependency-free envelope shared by Sitrec and the standalone designer.
// Increment the generator revision when a geometry change alters saved designs.
export const VEHICLE_GENERATOR = "sitrec-vehicle";
export const VEHICLE_GENERATOR_REVISION = 1;
export function vehicleFileStem(name, maxLength = 80) {
    return String(name || "vehicle").replace(/[^a-z0-9_-]+/gi,"-").replace(/^-|-$/g,"").slice(0,maxLength) || "vehicle";
}
export function copyVehicleRecipe(value, {allowFuture = false} = {}) {
    if (!value || value.format !== "sitrec-procedural-vehicle" || value.version !== 1 ||
        (value.generator && value.generator !== VEHICLE_GENERATOR) || !value.parameters ||
        typeof value.parameters !== "object" || Array.isArray(value.parameters))
        throw new Error("Choose a Vehicle Designer recipe (version 1).");
    const revision = value.generatorRevision ?? 1;
    if (!Number.isInteger(revision) || revision < 1 || (!allowFuture && revision !== VEHICLE_GENERATOR_REVISION))
        throw new Error(`Vehicle generator revision ${revision} is not supported. Use its frozen GLB or a compatible Sitrec version.`);
    const entries = Object.entries(value.parameters);
    if (entries.length > 400 || entries.some(([key, v]) => key.length > 80 ||
        !["number", "string", "boolean"].includes(typeof v) ||
        (typeof v === "number" && !Number.isFinite(v)) || (typeof v === "string" && v.length > 200)))
        throw new Error("Vehicle recipe parameters are invalid or too large.");
    return {format: value.format, version: 1, generator: VEHICLE_GENERATOR, generatorRevision: revision,
        name: String(value.name ?? "My vehicle").slice(0, 100),
        presetId: typeof value.presetId === "string" ? value.presetId.slice(0, 100) : null,
        parameters: Object.fromEntries(entries)};
}

export function copyProceduralModel(value) {
    if (!value) return null;
    if (!["procedural", "frozen"].includes(value.mode)) throw new Error("Unknown procedural model storage mode.");
    if (value.mode === "frozen" && (typeof value.file !== "string" || !value.file)) throw new Error("Frozen model asset is missing.");
    return {mode: value.mode, recipe: copyVehicleRecipe(value.recipe, {allowFuture: true}),
        ...(value.mode === "frozen" ? {file: value.file} : {})};
}
