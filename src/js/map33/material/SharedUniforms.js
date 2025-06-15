// shared uniforms used by multiple materials in Sitrec
export const sharedUniforms = {
    nearPlane: {value: 0.1},
    farPlane: {value: 1000},
    cameraFocalLength: {value: 300},
    useDayNight: {value: true},
    sunGlobalTotal: {value: 1.0},
    sunAmbientIntensity: {value: 0.5},
    // ... other shared uniforms
};