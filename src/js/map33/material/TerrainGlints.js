import {Color, Matrix4, Vector3, Vector4} from "three";
import {installShaderFeatureVariants} from "../../../ShaderFeatureVariants";

let glintsEnabled = false;

export function setGlintFeatureEnabled(enabled) {
    glintsEnabled = !!enabled;
}

export function installGlintVariant(material) {
    installShaderFeatureVariants(material, {SITREC_GLINTS: () => glintsEnabled});
}

// Shared by terrain and streamed building materials, including per-view clones.
export const glintUniforms = {
    glintEnabled: {value: false},
    glintColor: {value: new Color(0xff00ff)},
    glintOpacity: {value: 1},
    glintCosTolerance: {value: Math.cos(5 * Math.PI / 180)},
    glintCameraPosition: {value: new Vector3()},
    glintOrthoDirection: {value: new Vector4(0, 0, 1, 0)},
};

const inverseView = new Matrix4();
const direction = new Vector3();

export function updateGlintCamera(viewCamera, lookCamera, useLookCamera) {
    const observer = useLookCamera && lookCamera ? lookCamera : viewCamera;
    viewCamera.updateWorldMatrix(true, false);
    observer.updateWorldMatrix(true, false);
    inverseView.copy(viewCamera.matrixWorld).invert();

    // Compose in CPU double precision. Subtracting ECEF camera positions in
    // GLSL loses sub-metre detail near the ground.
    glintUniforms.glintCameraPosition.value.setFromMatrixPosition(observer.matrixWorld)
        .applyMatrix4(inverseView);
    direction.setFromMatrixColumn(observer.matrixWorld, 2).transformDirection(inverseView);
    glintUniforms.glintOrthoDirection.value.set(direction.x, direction.y, direction.z,
        observer.isOrthographicCamera ? 1 : 0);
}

export const glintVertexDeclarations = `
#ifdef SITREC_GLINTS
varying vec3 vGlintViewPosition;
varying vec2 vGlintBarycentric;
vec2 glintBarycentric(float corner) {
    return corner < 0.5 ? vec2(1.0, 0.0) : (corner < 1.5 ? vec2(0.0, 1.0) : vec2(0.0));
}
#endif
`;

export const glintFragmentDeclarations = `
#ifdef SITREC_GLINTS
uniform bool glintEnabled;
uniform vec3 glintColor;
uniform float glintOpacity;
uniform float glintCosTolerance;
uniform vec3 glintCameraPosition;
uniform vec4 glintOrthoDirection;
varying vec3 vGlintViewPosition;
varying vec2 vGlintBarycentric;

bool sitrecSunGlint(vec3 sunDirectionWorld) {
    // Physical view-space positions keep derivatives precise and leave the
    // result independent of smooth vertex normals and apparent refraction.
    vec3 px = dFdx(vGlintViewPosition), py = dFdy(vGlintViewPosition);
    vec3 faceNormal = normalize(cross(px, py));
    if (!gl_FrontFacing) faceNormal = -faceNormal;
    // Recover the triangle's centroid from its barycentric coordinates.
    // Evaluating there selects the WHOLE polygon, rather than drawing a
    // curved magenta patch across part of a large triangle near the camera.
    vec2 bx = dFdx(vGlintBarycentric), by = dFdy(vGlintBarycentric);
    float determinant = bx.x * by.y - bx.y * by.x;
    if (abs(determinant) < 1e-20) return false;
    vec3 edgeB = (px * by.y - py * bx.y) / determinant;
    vec3 edgeC = (py * bx.x - px * by.x) / determinant;
    vec2 toCenter = vec2(1.0 / 3.0) - vGlintBarycentric;
    vec3 faceCenter = vGlintViewPosition + edgeB * toCenter.x + edgeC * toCenter.y;
    vec3 towardSun = normalize(mat3(viewMatrix) * sunDirectionWorld);
    vec3 towardObserver = glintOrthoDirection.w > 0.5
        ? glintOrthoDirection.xyz
        : normalize(glintCameraPosition - faceCenter);
    vec3 reflectedSun = reflect(-towardSun, faceNormal);
    return dot(faceNormal, towardSun) > 0.0
        && dot(faceNormal, towardObserver) > 0.0
        && dot(reflectedSun, towardObserver) >= glintCosTolerance;
}
#endif
`;

// Apply after surface lighting, fog and water to preserve the chosen highlight color.
export const glintFragmentHighlight = `
#ifdef SITREC_GLINTS
if (glintEnabled && sitrecSunGlint(sunDirection)) {
    gl_FragColor.rgb = mix(gl_FragColor.rgb, glintColor, glintOpacity);
}
#endif
`;
