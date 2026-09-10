// Shared by the small bootstrap and the application. Keep this module free of
// application imports: authentication/channel selection must precede Three.js.
export const CHANNEL_FORMAT = 1;
export const BUILD_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,95}$/;

export function cleanBuild(value) {
    if (!value || typeof value.id !== 'string' || !BUILD_ID_PATTERN.test(value.id) ||
        !['shipped', 'beta'].includes(value.channel) ||
        typeof value.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(value.version) ||
        typeof value.builtAt !== 'string' ||
        !Number.isFinite(Date.parse(value.builtAt))) return null;
    return {id: value.id, channel: value.channel, version: value.version,
        builtAt: new Date(value.builtAt).toISOString()};
}

export function buildLabel(value) {
    const build = cleanBuild(value);
    if (!build) return 'Unknown build';
    return `${build.channel === 'beta' ? 'Beta' : 'Shipped'} ${build.version}${build.channel === 'beta' ? 'b' : ''} — ${build.builtAt.slice(0, 16).replace('T', ' ')} UTC`;
}

export function validateManifest(value, appBase) {
    if (value?.format !== CHANNEL_FORMAT) throw new Error('Unsupported channel manifest');
    const base = new URL(appBase);
    const parse = (entry, channel) => {
        const build = cleanBuild(entry);
        if (!build || build.channel !== channel) throw new Error(`Invalid ${channel} build`);
        const expected = new URL(`builds/${build.id}/`, base).href;
        if (new URL(entry.assetBase, base).href !== expected) throw new Error('Invalid build asset path');
        return {...build, assetBase: expected,
            coveredBetaIds: Array.isArray(entry.coveredBetaIds)
                ? entry.coveredBetaIds.filter(id => typeof id === 'string' && BUILD_ID_PATTERN.test(id)) : []};
    };
    return {format: CHANNEL_FORMAT, shipped: parse(value.shipped, 'shipped'),
        beta: value.beta && value.betaEnabled !== false ? parse(value.beta, 'beta') : null};
}

export function compareVersions(a, b) {
    const left = a.split('.').map(Number), right = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
    return 0;
}

// A full release can overtake the current Beta: Shipped 2.157.0 beside Beta
// 2.156.4b. Both builds carry a validated numeric version, so "newer" means the
// version, not the build time. Equal versions are not superseded.
export function betaSuperseded(manifest) {
    return !!manifest.beta && compareVersions(manifest.shipped.version, manifest.beta.version) > 0;
}

export function selectBuild(manifest, preference, override) {
    if (override === 'beta') return manifest.beta || manifest.shipped;
    if (override === 'shipped' || preference !== true || !manifest.beta) return manifest.shipped;
    // A Beta preference means "the newest build", never older code than a
    // visitor gets. The explicit ?channel=beta above still opens that exact
    // Beta, which is what a Beta-saved sitch's handoff relies on.
    return betaSuperseded(manifest) ? manifest.shipped : manifest.beta;
}

export function betaSaveNeedsWarning(sitch, current, manifest) {
    const creator = cleanBuild(sitch?.exportBuild);
    if (current?.channel === 'beta') return false;
    if (!creator) return sitch?.exportBuild?.channel === 'beta';
    if (creator.channel !== 'beta') return false;
    return !manifest?.shipped?.coveredBetaIds?.includes(creator.id);
}

export function entryFiles(entry) {
    const safe = name => typeof name === 'string' &&
        /^[a-zA-Z0-9_./-]+\.(?:js|css)$/.test(name) && !name.startsWith('/') &&
        !name.split('/').some(part => part === '..' || part === '.' || part === '');
    if (!entry || !Array.isArray(entry.scripts) || !entry.scripts.length ||
        !Array.isArray(entry.styles) || ![...entry.scripts, ...entry.styles].every(safe) ||
        !entry.scripts.every(name => name.endsWith('.js')) ||
        !entry.styles.every(name => name.endsWith('.css'))) throw new Error('Invalid application entry');
    return {scripts: entry.scripts, styles: entry.styles};
}
