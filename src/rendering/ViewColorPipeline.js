// Optical operations consume radiance. Display/sensor operations may clip it.
const opticalEffects = new Set(["hBlur", "vBlur", "DiffractionGlare"]);

export function splitViewEffects(effects, opticsBeforeSensor) {
    const enabled = Object.values(effects).filter(effect => effect.enabled);
    return opticsBeforeSensor
        ? {optical: enabled.filter(effect => opticalEffects.has(effect.effectName)),
            sensor: enabled.filter(effect => !opticalEffects.has(effect.effectName))}
        : {optical: enabled, sensor: []};
}

export function viewColorPolicy(view, sceneExposure = 1, skyExposure = 1) {
    const active = view.id === "lookView" && !view.isIR && !view.isXRPresenting();
    return {
        active,
        toneMapping: active && view.toneMappingEnabled,
        exposure: active ? sceneExposure * view.viewExposure * (view.legacySkyExposure ? skyExposure : 1) : 1,
        opticsBeforeSensor: active && view.opticsBeforeSensor,
    };
}

// Freeze the old atmosphere-dependent output choice when loading a save. Haze
// can then change without silently changing the camera's tone mapping/exposure.
export function migrateViewColorSettings(saved, atmosphereEnabled, sceneExposure = 1, hdrSupported = true) {
    const toneMappingEnabled = atmosphereEnabled && hdrSupported && (saved.atmosphereHDR ?? true);
    return {
        toneMappingEnabled,
        viewExposure: toneMappingEnabled ? (saved.atmosphereExposure ?? 1) : 1 / Math.max(0.0001, sceneExposure),
        opticsBeforeSensor: false,
        legacySkyExposure: true,
    };
}
