jest.mock('../src/LocalFrame', () => ({GlobalScene: {}, GlobalNightSkyScene: undefined}));
jest.mock('../src/Globals', () => ({Globals: {}, NodeMan: {}}));
jest.mock('../src/SphericalMath', () => ({}));
jest.mock('../src/raycastGround', () => ({}));

import {CWaterPlanarMirror} from '../src/WaterPlanarMirror';
import {sharedUniforms} from '../src/js/map33/material/SharedUniforms';
import {PerspectiveCamera, Vector3} from 'three';
import {panoramaFaceCamera, panoramaFaces} from '../src/rendering/PanoramaMath';

function capture({clip = true, maskReady = true, fail = false} = {}) {
    const node = {mirrorClip: clip, applyTileWater: jest.fn(() => {
        if (maskReady) sharedUniforms.waterGeoActive.value = 1;
    })};
    const mirror = new CWaterPlanarMirror(node);
    const plane = {};
    const texture = {};
    mirror.detectPlane = () => plane;
    mirror.setupCamera = () => true;
    mirror.getTarget = () => ({target: {texture}});
    mirror.applyObliqueClip = jest.fn();
    const originalTarget = {};
    const renderer = {getRenderTarget: () => originalTarget, setRenderTarget: jest.fn(),
        autoClear: true, shadowMap: {autoUpdate: true}, setClearColor: jest.fn(), clear: jest.fn()};
    const view = {renderer, fullscreenQuad: {material: {}}, renderAtmosphereScene: jest.fn(() => {
        expect(sharedUniforms.waterReflection.value).toBe(0);
        expect(sharedUniforms.waterTileCapture.value).toBe(clip && maskReady ? 1 : 0);
        if (fail) throw new Error('capture failed');
    })};
    return {node, mirror, view, renderer, originalTarget, texture};
}

beforeEach(() => {
    sharedUniforms.waterReflection.value = 1;
    sharedUniforms.waterGeoActive.value = 0;
    sharedUniforms.waterTileCapture.value = 0;
});

test.each([true, false])('water exclusion is scoped to the mirror capture, including failures (%s)', fail => {
    const {mirror, view, node, renderer, originalTarget, texture} = capture({fail});
    if (fail) expect(() => mirror.render(view, 0, null)).toThrow('capture failed');
    else expect(mirror.render(view, 0, null)).toBe(texture);
    expect(node.applyTileWater).toHaveBeenCalledWith(mirror.detectPlane());
    expect(view.renderAtmosphereScene).toHaveBeenCalledTimes(1);
    expect(sharedUniforms.waterReflection.value).toBe(1);
    expect(sharedUniforms.waterGeoActive.value).toBe(0);
    expect(sharedUniforms.waterTileCapture.value).toBe(0);
    expect(renderer.setRenderTarget).toHaveBeenLastCalledWith(originalTarget);
    expect(renderer.shadowMap.autoUpdate).toBe(true);
    expect(renderer.autoClear).toBe(true);
});

test('disabling mirror clipping retains the original tile geometry', () => {
    const {mirror, view, node} = capture({clip: false});
    mirror.render(view, 0, null);
    expect(node.applyTileWater).not.toHaveBeenCalled();
    expect(mirror.applyObliqueClip).not.toHaveBeenCalled();
});

test('an unavailable water mask cannot reuse a previous view mask', () => {
    sharedUniforms.waterGeoActive.value = 1;
    const {mirror, view} = capture({maskReady: false});
    mirror.render(view, 0, null);
    expect(sharedUniforms.waterGeoActive.value).toBe(1);
    expect(sharedUniforms.waterTileCapture.value).toBe(0);
});

test('a cropped panorama face and its mirror cover the same points on the water', () => {
    const observer = new PerspectiveCamera(45, 2, 0.1, 1e6);
    observer.position.set(0, 10, 0);
    observer.rotation.x = -0.3;
    observer.updateMatrixWorld(true);
    const mirror = new CWaterPlanarMirror({});
    const plane = {point: new Vector3(), normal: new Vector3(0, 1, 0)};
    for (const face of panoramaFaces(180, 60)) {
        const camera = panoramaFaceCamera(face, observer);
        expect(mirror.setupCamera({camera}, plane)).toBe(true);
        for (const x of [-0.8, 0, 0.8]) {
            const ray = new Vector3(x, -0.5, 0).unproject(camera).sub(camera.position).normalize();
            if (ray.y >= 0) continue;
            const point = camera.position.clone().addScaledVector(ray, -camera.position.y / ray.y);
            const real = point.clone().project(camera);
            const reflected = point.clone().project(mirror.camera);
            expect(reflected.x).toBeCloseTo(-real.x, 8);
            expect(reflected.y).toBeCloseTo(real.y, 8);
        }
    }
});
