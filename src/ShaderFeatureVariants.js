// Select optional shader code for the current draw, after scene/camera hooks
// have scoped their uniforms and before Three selects the material's program.
// Previously used variants stay in Three's program cache. Unchanged draws do
// not invalidate the material, and newly streamed materials need no scene walk.
//
// A feature is one of:
//   material => boolean    A setting that is the same for every draw of a frame
//                          (a master switch). It applies immediately.
//   {scoped, enabled?}     `scoped(material)` reads state that one view or one
//                          pass sets for its own draws: a mirror capture, the
//                          look view's haze, a ray-traced view.
//
// A scoped feature stays compiled in for SCOPED_FEATURE_HOLD_FRAMES after the
// last draw of THIS material that used it. Without the hold, a material that
// two passes of one frame draw with different state changes its define twice
// per frame, and Three computes the program key again for each change. So the
// define is a superset of the draw state: the shader must keep its own uniform
// test inside the #ifdef. `enabled(material)`, when given, is an immediate
// switch that the hold does not override.
const variants = new WeakMap();

// Long enough for a view that does not draw on every frame, and for a tile that
// leaves and returns. An unused variant costs only a uniform branch meanwhile.
export const SCOPED_FEATURE_HOLD_FRAMES = 30;
let frame = 0;

// Once per drawn frame, before the views render. A render path that never
// calls this keeps its scoped features compiled in, which is always correct.
export function advanceShaderFeatureFrame() {
    frame++;
}

function wanted(entry, material) {
    const feature = entry.feature;
    if (typeof feature === "function") return !!feature(material);
    if (feature.enabled && !feature.enabled(material)) return false;
    if (feature.scoped(material)) {
        entry.lastUsed = frame;
        return true;
    }
    return frame - entry.lastUsed <= SCOPED_FEATURE_HOLD_FRAMES;
}

export function updateShaderFeatureVariants(material) {
    const entries = variants.get(material);
    if (!entries) return;
    let changed = false;
    for (const entry of entries) {
        const want = wanted(entry, material);
        if ((material.defines?.[entry.name] !== undefined) === want) continue;
        if (want) (material.defines ??= {})[entry.name] = 1;
        else delete material.defines[entry.name];
        changed = true;
    }
    if (changed) material.needsUpdate = true;
}

export function installShaderFeatureVariants(material, features) {
    let entries = variants.get(material);
    if (!entries) {
        entries = [];
        variants.set(material, entries);
        const previous = material.onBeforeRender;
        material.onBeforeRender = function() {
            previous?.apply(this, arguments);
            updateShaderFeatureVariants(this);
        };
    }
    for (const [name, feature] of Object.entries(features)) {
        const existing = entries.find(entry => entry.name === name);
        if (existing) existing.feature = feature;
        else entries.push({name, feature, lastUsed: -Infinity});
    }
    updateShaderFeatureVariants(material);
}
