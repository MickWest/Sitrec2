import catalog from "../data/nightsky/deep-sky.json";

export const DEEP_SKY_OBJECTS = catalog.objects;
export const PLEIADES = DEEP_SKY_OBJECTS.find(object => object.id === "M 45");
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
