import catalog from "../data/nightsky/deep-sky.json";

export const DEEP_SKY_OBJECTS = catalog.objects;
export const PLEIADES = DEEP_SKY_OBJECTS.find(object => object.id === "M 45");
// A short display-priority list, not a visibility guarantee. Integrated galaxy
// and nebula magnitudes alone greatly overstate their prominence in a photo.
export const PROMINENT_DEEP_SKY_IDS = new Set([
    "NGC 224", "NGC 1976", "M 45", "NGC 2632", // Andromeda, Orion, Pleiades, Beehive
    "PGC 17223", "NGC 292", "NGC 5139", "NGC 104", // Magellanic Clouds, Omega Centauri, 47 Tucanae
]);
export const PLEIADES_STARS = new Set([
    "Alcyone", "Atlas", "Electra", "Maia", "Merope", "Taygeta", "Pleione", "Celaeno", "Asterope", "Sterope",
]);

export function deepSkyCategory(object) {
    if (["oc", "gc"].includes(object.type)) return "Clusters";
    if (["s", "s0", "e", "i", "g", "sd"].includes(object.type)) return "Galaxies";
    return "Nebulae";
}

// Display pixels, so zooming into the cluster naturally reveals individual names.
export function groupPleiades(diameter, enabled = true) {
    return enabled && Number.isFinite(diameter) && diameter < 180;
}
