import {Matrix4, ShaderChunk} from "three";

const STABLE_RECEIVER_KEY = "sitrecStableShadowReceiver";

let activeShadowLight = null;

const localShadowMatrix = new Matrix4();
const stableIdentityMatrix = new Matrix4();

function asMaterials(material) {
    if (!material) return [];
    return Array.isArray(material) ? material : [material];
}

function getPatchedShadowVertexChunk() {
    let stock = ShaderChunk.shadowmap_vertex;
    stock = stock.replace(
        "vec3 shadowWorldNormal = inverseTransformDirection( transformedNormal, viewMatrix );",
        "vec3 shadowWorldNormal = dot( transformedNormal, transformedNormal ) > 0.0 ? inverseTransformDirection( transformedNormal, viewMatrix ) : vec3( 0.0 );"
    );
    stock = stock.replace(
        "#if NUM_DIR_LIGHT_SHADOWS > 0",
        `#if NUM_DIR_LIGHT_SHADOWS > 0
		vec4 sitrecShadowLocalPosition = vec4( transformed, 1.0 );
		#ifdef USE_BATCHING
			sitrecShadowLocalPosition = batchingMatrix * sitrecShadowLocalPosition;
		#endif
		#ifdef USE_INSTANCING
			sitrecShadowLocalPosition = instanceMatrix * sitrecShadowLocalPosition;
		#endif`
    );
    const stockDirectional = `shadowWorldPosition = worldPosition + vec4( shadowWorldNormal * directionalLightShadows[ i ].shadowNormalBias, 0 );
			vDirectionalShadowCoord[ i ] = directionalShadowMatrix[ i ] * shadowWorldPosition;`;
    const stableDirectional = `vDirectionalShadowCoord[ i ] =
				sitrecDirectionalShadowMatrix[ i ] * sitrecShadowLocalPosition
				+ sitrecDirectionalShadowWorldMatrix[ i ] * vec4( shadowWorldNormal * directionalLightShadows[ i ].shadowNormalBias, 0.0 );`;
    return stock.replace(stockDirectional, stableDirectional);
}

function getPendingStableUniforms(material) {
    if (!material.userData[STABLE_RECEIVER_KEY]) {
        material.userData[STABLE_RECEIVER_KEY] = {
            shadowMatrices: [new Matrix4()],
            shadowWorldMatrices: [new Matrix4()],
        };
    }
    return material.userData[STABLE_RECEIVER_KEY];
}

function updateStableUniformValues(object, material, renderer) {
    const stable = getPendingStableUniforms(material);
    const shadowMatrix = activeShadowLight?.shadow?.matrix;

    if (shadowMatrix) {
        localShadowMatrix.multiplyMatrices(shadowMatrix, object.matrixWorld);
        stable.shadowMatrices[0].copy(localShadowMatrix);
        stable.shadowWorldMatrices[0].copy(shadowMatrix);
    } else {
        stable.shadowMatrices[0].copy(stableIdentityMatrix);
        stable.shadowWorldMatrices[0].copy(stableIdentityMatrix);
    }

    const rendererUniforms = renderer?.properties?.get(material)?.uniforms;
    if (rendererUniforms?.sitrecDirectionalShadowMatrix) {
        rendererUniforms.sitrecDirectionalShadowMatrix.value[0].copy(stable.shadowMatrices[0]);
    }
    if (rendererUniforms?.sitrecDirectionalShadowWorldMatrix) {
        rendererUniforms.sitrecDirectionalShadowWorldMatrix.value[0].copy(stable.shadowWorldMatrices[0]);
    }

    if (material.isShaderMaterial) {
        if (material.uniforms?.sitrecDirectionalShadowMatrix) {
            material.uniforms.sitrecDirectionalShadowMatrix.value[0].copy(stable.shadowMatrices[0]);
        }
        if (material.uniforms?.sitrecDirectionalShadowWorldMatrix) {
            material.uniforms.sitrecDirectionalShadowWorldMatrix.value[0].copy(stable.shadowWorldMatrices[0]);
        }
    }
}

export function setStableShadowReceiverLight(light) {
    const previous = activeShadowLight;
    activeShadowLight = light;
    return previous;
}

export function installStableShadowReceiver(material) {
    if (!material || material.userData?.stableShadowReceiverInstalled) return;

    const previousOnBeforeCompile = material.onBeforeCompile;
    material.onBeforeCompile = function(shader, renderer) {
        if (previousOnBeforeCompile) {
            previousOnBeforeCompile.call(this, shader, renderer);
        }

        const stable = getPendingStableUniforms(this);
        shader.uniforms.sitrecDirectionalShadowMatrix = {value: stable.shadowMatrices};
        shader.uniforms.sitrecDirectionalShadowWorldMatrix = {value: stable.shadowWorldMatrices};

        shader.vertexShader = shader.vertexShader.replace(
            "#include <common>",
            `#include <common>
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
uniform mat4 sitrecDirectionalShadowMatrix[ NUM_DIR_LIGHT_SHADOWS ];
uniform mat4 sitrecDirectionalShadowWorldMatrix[ NUM_DIR_LIGHT_SHADOWS ];
#endif`
        );

        shader.vertexShader = shader.vertexShader.replace(
            "#include <shadowmap_vertex>",
            getPatchedShadowVertexChunk()
        );
    };

    const previousCacheKey = material.customProgramCacheKey?.bind(material);
    material.customProgramCacheKey = function() {
        return `${previousCacheKey ? previousCacheKey() : ""}.${STABLE_RECEIVER_KEY}`;
    };

    material.userData.stableShadowReceiverInstalled = true;
    material.needsUpdate = true;
}

export function attachStableShadowUniformUpdater(mesh) {
    if (!mesh?.isMesh || mesh.userData?.stableShadowUniformUpdaterInstalled) return;

    const previousOnBeforeRender = mesh.onBeforeRender;
    mesh.onBeforeRender = function(renderer, scene, camera, geometry, material, group) {
        if (previousOnBeforeRender) {
            previousOnBeforeRender.call(this, renderer, scene, camera, geometry, material, group);
        }
        for (const mat of asMaterials(material)) {
            if (mat?.userData?.stableShadowReceiverInstalled) {
                updateStableUniformValues(this, mat, renderer);
            }
        }
    };

    mesh.userData.stableShadowUniformUpdaterInstalled = true;
}

export function installStableShadowReceivers(root) {
    if (!root) return;

    root.traverse(obj => {
        if (!obj.isMesh || !obj.receiveShadow || !obj.material) return;
        for (const material of asMaterials(obj.material)) {
            installStableShadowReceiver(material);
        }
        attachStableShadowUniformUpdater(obj);
    });
}
