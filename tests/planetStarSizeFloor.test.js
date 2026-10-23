/**
 * Default-mode planet size floor (CPlanets._applyStarSizeFloor): a planet is never drawn
 * smaller than a star of the same magnitude.
 *
 * Stars are gl_PointSize points sized in framebuffer pixels by the real per-view chain
 * (CStarField.updateStarScales -> CPointLightCloud.preRender -> CNodeView.adjustPointScale).
 * Planets are world-space sprites. The test drives that real star chain for a view, applies
 * the floor, and then measures the planet's drawn diameter by projecting the sprite's quad
 * edges the way three.js's sprite shader does, so the check does not reuse the floor's own
 * arithmetic.
 */
import {Group, PerspectiveCamera, Sprite, SpriteMaterial, Vector3} from "three";
import * as Astronomy from "astronomy-engine";
import {setNodeMan, setSit} from "../src/Globals";
import {CPlanets} from "../src/nodes/CPlanets";
import {CStarField} from "../src/nodes/CStarField";
import {CPointLightCloud} from "../src/nodes/CPointLightCloud";
import {CNodeView} from "../src/nodes/CNodeView";

const SPHERE_RADIUS = 100;

// A star field with the real scale methods and a light cloud with the real preRender,
// standing in for the GPU objects with a uniform block.
function makeStarField() {
    const starField = Object.create(CStarField.prototype);
    const cloud = Object.create(CPointLightCloud.prototype);
    Object.assign(cloud, {
        material: {uniforms: {baseScale: {value: 0}, cameraFOV: {value: 45}}},
        points: {},
        useSkyAttenuation: false,
        useBoostScale: false,
        hdrPoint: false,
        baseScale: 1,
    });
    starField.lightCloud = cloud;
    return starField;
}

// A view carrying only what adjustPointScale reads. `canvasWidth` makes it render to a
// fixed-size target at pixel ratio 1, as CNodeView3D does for a view with a set resolution.
function makeView({fov, widthPx, heightPx, dpr, canvasWidth}) {
    const camera = new PerspectiveCamera(fov, widthPx / heightPx, 0.1, 1000);
    camera.position.set(0, 0, 0);       // renderSky draws the celestial sphere from the origin
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
    const view = Object.create(CNodeView.prototype);
    Object.assign(view, {
        camera, widthPx, heightPx,
        inputs: canvasWidth ? {canvasWidth: {v0: canvasWidth}} : {},
        nominalViewHeight: 1080,
        letterboxScaleY: 1,
        isXRPresenting: () => false,
    });
    // The framebuffer height the sky is drawn into: CSS height times the device pixel
    // ratio, or the fixed target height at pixel ratio 1.
    const framebufferHeight = canvasWidth ? view.getRenderTargetHeight() : heightPx * dpr;
    const renderer = {getCurrentViewport: (target) => target.set(0, 0, 0, framebufferHeight)};
    return {view, camera, renderer, framebufferHeight};
}

// A planet sprite on the celestial sphere, straight ahead of the camera, inside a parent
// group the way the real sprites sit inside celestialSphere.
function makeSprite({baseScale, mag, offAxisDeg = 0}) {
    const parent = new Group();
    const sprite = new Sprite(new SpriteMaterial());
    parent.add(sprite);
    const a = offAxisDeg * Math.PI / 180;
    sprite.position.set(Math.sin(a) * SPHERE_RADIUS, 0, -Math.cos(a) * SPHERE_RADIUS);
    sprite.scale.set(baseScale, baseScale, 1);
    sprite.userData.planetBaseScale = baseScale;
    sprite.userData.planetMag = mag;
    parent.updateMatrixWorld(true);
    return sprite;
}

// Drawn diameter in framebuffer pixels, from matrixWorld (what three.js draws with): the
// sprite shader offsets the quad corners in view space by the world scale, then projects.
function drawnPixels(sprite, camera, framebufferHeight) {
    const center = new Vector3().setFromMatrixPosition(sprite.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
    const scale = new Vector3().setFromMatrixColumn(sprite.matrixWorld, 1).length();
    const top = center.clone().add(new Vector3(0, scale / 2, 0)).applyMatrix4(camera.projectionMatrix);
    const bottom = center.clone().add(new Vector3(0, -scale / 2, 0)).applyMatrix4(camera.projectionMatrix);
    return (top.y - bottom.y) / 2 * framebufferHeight;
}

// The default-mode magnitude size, before the slider: CPlanets.updatePlanetSprite.
const magnitudeScale = (mag) => Math.min(1, 10 * Math.pow(10, -0.4 * (mag + 5)));

let starField, planets;

beforeEach(() => {
    starField = makeStarField();
    setNodeMan({get: (id) => (id === "NightSkyNode" ? {starField} : undefined)});
    setSit({starScale: 1, planetScale: 1, physicalPointSources: false});
    global.window = {devicePixelRatio: 2};
    planets = Object.create(CPlanets.prototype);   // the floor needs no textures or ephemeris state
});

afterEach(() => {
    delete global.window;
});

// Size the stars for this view exactly as renderSky does, then apply the floor.
function renderPlanet(sprite, setup) {
    CStarField.prototype.updateStarScales.call(starField, setup.view);
    planets._applyStarSizeFloor(sprite, setup.renderer, setup.camera);
    const starPx = (mag) => starField.magnitudeToFlux(mag) * starField.lightCloud.material.uniforms.baseScale.value;
    return {planetPx: drawnPixels(sprite, setup.camera, setup.framebufferHeight), starPx};
}

describe("CPlanets.spriteScaleForPixels", () => {
    test.each([
        [45, 864, 20], [5, 864, 20], [90, 1728, 3.5], [1, 400, 60],
    ])("a sprite at fov %p, height %p px is drawn %p px across", (fov, height, px) => {
        const setup = makeView({fov, widthPx: height * 1.5, heightPx: height, dpr: 1});
        const sprite = makeSprite({baseScale: 1, mag: 0});
        const scale = CPlanets.spriteScaleForPixels(px, SPHERE_RADIUS, fov, height);
        sprite.scale.set(scale, scale, 1);
        sprite.updateMatrixWorld();
        expect(drawnPixels(sprite, setup.camera, height)).toBeCloseTo(px, 6);
    });

    test("nothing to draw gives 0", () => {
        expect(CPlanets.spriteScaleForPixels(0, 100, 45, 864)).toBe(0);
        expect(CPlanets.spriteScaleForPixels(5, -100, 45, 864)).toBe(0);
        expect(CPlanets.spriteScaleForPixels(5, 100, 45, 0)).toBe(0);
    });
});

describe("default-mode planet floor at star size", () => {
    // Main views at several zooms and display densities, and a look view with a set
    // resolution (pixel ratio 1), which sizes its stars differently from the main view.
    const views = [
        {name: "main, 45 deg, dpr 2", fov: 45, widthPx: 1500, heightPx: 864, dpr: 2},
        {name: "main, 5 deg, dpr 2", fov: 5, widthPx: 1500, heightPx: 864, dpr: 2},
        {name: "main, 60 deg, dpr 1", fov: 60, widthPx: 1200, heightPx: 700, dpr: 1},
        {name: "look, 2 deg, set resolution", fov: 2, widthPx: 960, heightPx: 540, dpr: 2, canvasWidth: 1920},
    ];

    test.each(views)("Saturn (mag 0.68) is drawn as large as a mag 0.68 star: $name", (v) => {
        global.window.devicePixelRatio = v.dpr;
        const setup = makeView(v);
        const sprite = makeSprite({baseScale: magnitudeScale(0.68), mag: 0.68});
        const before = drawnPixels(sprite, setup.camera, setup.framebufferHeight);
        const {planetPx, starPx} = renderPlanet(sprite, setup);
        expect(planetPx).toBeCloseTo(starPx(0.68), 6);
        expect(planetPx).toBeGreaterThan(before);
        // The forum report: Saturn smaller than stars of magnitude 2 to 4.
        expect(planetPx).toBeGreaterThan(starPx(2));
    });

    test("off the view axis the floor still matches the star", () => {
        const setup = makeView({fov: 45, widthPx: 1500, heightPx: 864, dpr: 2});
        const sprite = makeSprite({baseScale: magnitudeScale(0.68), mag: 0.68, offAxisDeg: 15});
        const {planetPx, starPx} = renderPlanet(sprite, setup);
        // A sprite's quad is a fixed world size, so it projects a little larger off axis,
        // where it is nearer the image plane; it never projects smaller.
        expect(planetPx).toBeGreaterThanOrEqual(starPx(0.68) * (1 - 1e-9));
        expect(planetPx).toBeLessThan(starPx(0.68) * 1.1);
    });

    test.each([["Venus", -4.0], ["Jupiter", -2.5], ["Jupiter at opposition", -2.9]])(
        "%s (mag %p) keeps its current size on a dpr 2 display", (name, mag) => {
            const setup = makeView({fov: 45, widthPx: 1500, heightPx: 864, dpr: 2});
            const base = magnitudeScale(mag);
            const sprite = makeSprite({baseScale: base, mag});
            renderPlanet(sprite, setup);
            expect(sprite.scale.x).toBe(base);
        });

    test("each view gets its own floor, and the scale always restarts from the planet's own size", () => {
        const main = makeView({fov: 45, widthPx: 1500, heightPx: 864, dpr: 2});
        const look = makeView({fov: 2, widthPx: 960, heightPx: 540, dpr: 2, canvasWidth: 1920});
        const sprite = makeSprite({baseScale: magnitudeScale(0.68), mag: 0.68});

        const first = renderPlanet(sprite, main);
        const mainScale = sprite.scale.x;
        const second = renderPlanet(sprite, look);
        expect(sprite.scale.x).not.toBeCloseTo(mainScale, 6);
        expect(second.planetPx).toBeCloseTo(second.starPx(0.68), 6);
        const third = renderPlanet(sprite, main);
        expect(sprite.scale.x).toBeCloseTo(mainScale, 12);
        expect(third.planetPx).toBeCloseTo(first.planetPx, 9);
    });

    test("matrixWorld carries the floored scale, since three.js reads it right after the hook", () => {
        const setup = makeView({fov: 45, widthPx: 1500, heightPx: 864, dpr: 2});
        const sprite = makeSprite({baseScale: magnitudeScale(0.68), mag: 0.68});
        renderPlanet(sprite, setup);
        expect(new Vector3().setFromMatrixColumn(sprite.matrixWorld, 0).length()).toBeCloseTo(sprite.scale.x, 12);
    });
});

describe("Planet Brightness on top of the floor", () => {
    const setupView = () => makeView({fov: 45, widthPx: 1500, heightPx: 864, dpr: 2});
    const slider = (s) => Math.pow(10, 0.4 * Math.log10(s));    // updatePlanetSprite's size curve

    test("locked at 3x, Saturn is at least as large as a mag 0.68 star at 3x", () => {
        setSit({starScale: 3, planetScale: 3, physicalPointSources: false});
        const setup = setupView();
        const sprite = makeSprite({baseScale: magnitudeScale(0.68) * slider(3), mag: 0.68});
        const {planetPx, starPx} = renderPlanet(sprite, setup);
        expect(planetPx).toBeCloseTo(starPx(0.68), 6);
    });

    test("unlocked, the floor follows Planet Brightness, not Star Brightness", () => {
        const setup = setupView();
        const sprite = makeSprite({baseScale: magnitudeScale(0.68), mag: 0.68});
        const atOne = renderPlanet(sprite, setup).planetPx;

        setSit({starScale: 3, planetScale: 1, physicalPointSources: false});
        expect(renderPlanet(sprite, setup).planetPx).toBeCloseTo(atOne, 6);

        setSit({starScale: 1, planetScale: 2, physicalPointSources: false});
        sprite.userData.planetBaseScale = magnitudeScale(0.68) * slider(2);
        expect(renderPlanet(sprite, setup).planetPx).toBeCloseTo(2 * atOne, 6);
    });

    test("Planet Brightness 0 still hides the planet", () => {
        setSit({starScale: 1, planetScale: 0, physicalPointSources: false});
        const setup = setupView();
        const sprite = makeSprite({baseScale: magnitudeScale(0.68) * slider(0), mag: 0.68});
        renderPlanet(sprite, setup);
        expect(sprite.scale.x).toBe(0);
    });

    test("a planet fainter than Star Limit gets no floor, as no star that faint is drawn", () => {
        const setup = setupView();
        const base = magnitudeScale(5.7);
        const sprite = makeSprite({baseScale: base, mag: 5.7});     // Uranus

        setSit({starScale: 1, planetScale: 1, starLimit: 15, physicalPointSources: false});
        renderPlanet(sprite, setup);
        expect(sprite.scale.x).toBeGreaterThan(base);

        setSit({starScale: 1, planetScale: 1, starLimit: 4, physicalPointSources: false});
        renderPlanet(sprite, setup);
        expect(sprite.scale.x).toBe(base);
    });

    test("with Star Brightness 0 there is no star to match, and the planet keeps its own size", () => {
        setSit({starScale: 0, planetScale: 1, physicalPointSources: false});
        const setup = setupView();
        const base = magnitudeScale(0.68);
        const sprite = makeSprite({baseScale: base, mag: 0.68});
        renderPlanet(sprite, setup);
        expect(sprite.scale.x).toBe(base);
    });
});

describe("updatePlanetSprite feeds the floor", () => {
    let realPlanets;
    beforeEach(() => {
        jest.spyOn(CPlanets.prototype, "_loadTextures").mockImplementation(() => {});
        realPlanets = new CPlanets();
    });
    afterEach(() => jest.restoreAllMocks());

    const date = new Date("2026-10-22T00:00:00Z");
    const observer = new Astronomy.Observer(34, -118, 0);

    test("default mode records the planet's own size and magnitude, and the floor raises Saturn", () => {
        const sprite = new Sprite(new SpriteMaterial());
        realPlanets.updatePlanetSprite("Saturn", sprite, date, observer);
        const mag = Astronomy.Illumination("Saturn", date).mag;
        expect(sprite.userData.planetMag).toBeCloseTo(mag, 9);
        expect(sprite.userData.planetBaseScale).toBeCloseTo(magnitudeScale(mag), 12);
        expect(sprite.scale.x).toBe(sprite.userData.planetBaseScale);

        const setup = makeView({fov: 45, widthPx: 1500, heightPx: 864, dpr: 2});
        sprite.updateMatrixWorld();
        setup.camera.lookAt(sprite.position);
        setup.camera.updateMatrixWorld();
        const before = drawnPixels(sprite, setup.camera, setup.framebufferHeight);
        const {planetPx, starPx} = renderPlanet(sprite, setup);
        expect(planetPx).toBeGreaterThan(before);
        expect(planetPx).toBeCloseTo(starPx(mag), 6);
    });

    // Venus and Jupiter are exempt. Without the exemption the floor would enlarge them where a
    // star of the same magnitude is drawn larger: a set-resolution look view, a dpr 1 display,
    // higher Planet Brightness, and Jupiter near conjunction (about -1.8 on 2026-08-15).
    test.each([
        ["look view at set resolution", {fov: 2, widthPx: 960, heightPx: 540, dpr: 2, canvasWidth: 1920}, 1],
        ["main view on a dpr 1 display", {fov: 60, widthPx: 1200, heightPx: 700, dpr: 1}, 1],
        ["main view at Planet Brightness 3", {fov: 45, widthPx: 1500, heightPx: 864, dpr: 2}, 3],
        ["look view at Planet Brightness 3", {fov: 2, widthPx: 960, heightPx: 540, dpr: 2, canvasWidth: 1920}, 3],
    ])("Venus and Jupiter keep their own size: %s", (name, v, brightness) => {
        global.window.devicePixelRatio = v.dpr;
        setSit({starScale: brightness, planetScale: brightness, physicalPointSources: false});
        const setup = makeView(v);
        for (const [planet, when] of [["Venus", date], ["Jupiter", date], ["Jupiter", new Date("2026-08-15T00:00:00Z")]]) {
            const sprite = new Sprite(new SpriteMaterial());
            realPlanets.updatePlanetSprite(planet, sprite, when, observer);
            expect(sprite.userData.planetBaseScale).toBeUndefined();
            const own = sprite.scale.x;
            sprite.updateMatrixWorld();
            renderPlanet(sprite, setup);
            expect(sprite.scale.x).toBe(own);
        }
        // Saturn is still raised in the same view.
        const saturn = new Sprite(new SpriteMaterial());
        realPlanets.updatePlanetSprite("Saturn", saturn, date, observer);
        const saturnOwn = saturn.scale.x;
        saturn.updateMatrixWorld();
        setup.camera.lookAt(saturn.position);
        setup.camera.updateMatrixWorld();
        renderPlanet(saturn, setup);
        expect(saturn.scale.x).toBeGreaterThan(saturnOwn);
    });

    test("physical point-source mode is left to its own sizing", () => {
        setSit({starScale: 1, planetScale: 1, physicalPointSources: true});
        const sprite = new Sprite(new SpriteMaterial());
        realPlanets.updatePlanetSprite("Saturn", sprite, date, observer);
        expect(sprite.userData.planetBaseScale).toBeUndefined();
        const physicalScale = sprite.scale.x;

        const setup = makeView({fov: 45, widthPx: 1500, heightPx: 864, dpr: 2});
        sprite.updateMatrixWorld();
        renderPlanet(sprite, setup);
        expect(sprite.scale.x).toBe(physicalScale);
    });
});
