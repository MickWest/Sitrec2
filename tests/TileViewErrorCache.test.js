import {Frustum, Matrix4, PerspectiveCamera, Vector3} from "three";
import {TileViewErrorCache} from "../src/rendering/TileViewErrorCache";
import {terrestrialLiftContext} from "../src/atmosphere/terrestrialRefraction";

function fixture() {
    const camera = new PerspectiveCamera(2, 1.2, 0.1, 8e8);
    const info = {isOrthographic: false, sseDenominator: 0.001, pixelSize: 0,
        position: new Vector3(), frustum: new Frustum()};
    const renderer = {group: {matrixWorld: new Matrix4()}, cameraInfo: [info]};
    const tile = {geometricError: 12, engineData: {boundingVolume: {}}};
    const cache = new TileViewErrorCache();
    const lift = terrestrialLiftContext(new Vector3(6378147, 0, 0), {enabled: true, k: .17});
    const update = () => {
        camera.updateMatrixWorld();
        info.position.copy(camera.position);
        info.frustum.setFromProjectionMatrix(new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
        cache.begin(renderer, lift);
    };
    update();
    cache.write(tile, {inView: true, error: 123, distanceFromCamera: 456});
    return {cache, tile, camera, info, renderer, lift, update};
}

test("async arrivals reuse exact answers, isolated from traversal mutations and other views", () => {
    const {cache, tile, update} = fixture();
    for (let i = 0; i < 10; i++) {
        update();
        const answer = {};
        expect(cache.read(tile, answer)).toBe(true);
        expect(answer).toEqual({inView: true, error: 123, distanceFromCamera: 456});
        answer.error = -1; // plugins may adjust the returned result
    }
    expect(cache.read({geometricError: 12, engineData: tile.engineData}, {})).toBe(false);
    expect(new TileViewErrorCache().read(tile, {})).toBe(false);
});

test.each([
    ["diagonal camera move", f => f.camera.position.set(1, -1, 0)],
    ["camera rotation", f => f.camera.rotateZ(.1)],
    ["asymmetric projection", f => { f.camera.projectionMatrix.elements[8] += .1; f.camera.projectionMatrix.elements[9] -= .1; }],
    ["orthographic projection", f => f.camera.projectionMatrix.makeOrthographic(-10, 10, 10, -10, .1, 1e8)],
    ["near plane", f => {f.camera.near = 10; f.camera.updateProjectionMatrix();}],
    ["same-aspect resize", f => f.info.sseDenominator *= .5],
    ["group transform", f => f.renderer.group.matrixWorld.makeTranslation(100, 0, 0)],
    ["refraction coefficient", f => f.lift.k += .01],
    ["refraction altitude", f => f.lift.obsAlt += 10],
    ["Earth radius", f => f.lift.R += 100],
    ["refraction limit", f => f.lift.maxLiftM *= 2],
    ["geometric error", f => f.tile.geometricError *= 2],
    ["replaced bounds", f => f.tile.engineData.boundingVolume = {}],
])("invalidates for %s", (name, change) => {
    const f = fixture();
    change(f);
    f.update();
    expect(f.cache.read(f.tile, {})).toBe(false);
});

test("refraction off and mutable flat projection do not reuse stale bounds", () => {
    const {cache, tile, renderer} = fixture();
    cache.begin(renderer, null);
    expect(cache.read(tile, {})).toBe(false);
    cache.write(tile, {inView: false, error: Infinity, distanceFromCamera: 0});
    cache.begin(renderer, null);
    const result = {};
    expect(cache.read(tile, result)).toBe(true);
    expect(result.error).toBe(Infinity);
    cache.begin(renderer, null, true);
    expect(cache.read(tile, {})).toBe(false);
    cache.write(tile, result);
    cache.begin(renderer, null, true);
    expect(cache.read(tile, {})).toBe(false);
});
