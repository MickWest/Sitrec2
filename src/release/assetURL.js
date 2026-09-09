// Resolve loose workers and vendor files against the selected immutable build.
// Preserve the existing relative URL in tests and non-browser entry points.
export function buildAssetURL(relative) {
    return typeof window !== 'undefined' && window.__SITREC_ASSET_BASE__
        ? new URL(relative, window.__SITREC_ASSET_BASE__).href : relative;
}
