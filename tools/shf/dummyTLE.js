// Versioned wrapper for SHF's shared constellation generator. Keep the query on every
// dependency so standalone deployments retain their cache-busting behavior.
const VERSION = new URL(import.meta.url).search;
const [{ STARLINK_SHELLS }, { gmstRad }, core] = await Promise.all([
    import("./starlinkShells.js" + VERSION),
    import("./astro.js" + VERSION),
    import("./syntheticOrbits.js" + VERSION),
]);
export { STARLINK_SHELLS };
export const meanMotion = core.meanMotion;
export const nodalRate = core.nodalRate;
export function generateDummyTLE(date = new Date(), total) {
    return generateFromTable(date, {total});
}
export function generateFromTable(date = new Date(), opts = {}) {
    return core.generateConstellationTLE(date, opts.shells || STARLINK_SHELLS, gmstRad, opts);
}
