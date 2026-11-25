// Select optional shader code for the current draw, after scene/camera hooks
// have scoped their uniforms and before Three selects the material's program.
// Previously used variants stay in Three's program cache. Unchanged draws do
// not invalidate the material, and newly streamed materials need no scene walk.
const variants = new WeakMap();

export function updateShaderFeatureVariants(material) {
    const state = variants.get(material);
    if (!state) return;
    let changed = false;
    for (const [name, enabled] of state.entries) {
        const want = !!enabled(material);
        if ((material.defines?.[name] !== undefined) === want) continue;
        if (want) (material.defines ??= {})[name] = 1;
        else delete material.defines[name];
        changed = true;
    }
    if (changed) material.needsUpdate = true;
}

export function installShaderFeatureVariants(material, features) {
    let state = variants.get(material);
    if (!state) {
        state = {features: {}, entries: []};
        variants.set(material, state);
        const previous = material.onBeforeRender;
        material.onBeforeRender = function() {
            previous?.apply(this, arguments);
            updateShaderFeatureVariants(this);
        };
    }
    Object.assign(state.features, features);
    state.entries = Object.entries(state.features);
    updateShaderFeatureVariants(material);
}
