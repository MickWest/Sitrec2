/** @jest-environment jsdom */
import {Matrix4, Vector3} from "three";
import {readQLCSpotlightEffects} from "../src/SpotlightQLC";
import {defaultSpotlightBeam, isFlowerCode, MAX_PROJECTOR_BEAMS, readSpotlightLumens, spotlightCandela, spotlightDirection,
    spotlightPreset, SPOTLIGHT_PRESETS, SPOTLIGHT_PATTERNS} from "../src/SpotlightMotion";
import {SpotlightField, spotlightUniforms} from "../src/clouds/SpotlightField";
import {DEFAULT_CONCERT} from "../src/SpotlightConcert";

describe("ground spotlight patterns", () => {
    test.each(SPOTLIGHT_PRESETS)("%s creates independent editable beam settings", preset => {
        const {beams, count, lumens} = spotlightPreset(preset);
        expect(beams).toHaveLength(count);
        expect(count).toBeGreaterThan(0);
        expect(count).toBeLessThanOrEqual(MAX_PROJECTOR_BEAMS);
        expect(lumens).toBeGreaterThan(0);
        expect(beams.every(beam => !("lumens" in beam))).toBe(true);
        beams[0].width = 0;
        expect(spotlightPreset(preset).beams[0].width).toBeGreaterThan(0);
    });

    test("older saves keep combined output across active heads, including unconfigured and unlit heads", () => {
        const beams = [{brightness: 0.4}, {lumens: 0}, {}, {lumens: 2000000}];
        expect(readSpotlightLumens({beams}, 3)).toBe(50000);
        expect(readSpotlightLumens({beams: [{lumens: 0}]}, 2)).toBe(50000);
        expect(readSpotlightLumens({lumens: 0, beams}, 3)).toBe(0);
        expect(readSpotlightLumens({lumens: 2000000}, 4)).toBe(500000);
        expect(readSpotlightLumens({beams: [{lumens: 800000}, {lumens: 0}]}, 2)).toBe(400000);
        expect(readSpotlightLumens({beams}, 4)).toBe(500000);
        expect(readSpotlightLumens({}, 4)).toBe(100000);
    });

    test("doubling flux doubles axial intensity, and widening the beam spreads it", () => {
        const intensity = spotlightCandela(100000, 8);
        expect(spotlightCandela(200000, 8)).toBeCloseTo(2 * intensity);
        expect(spotlightCandela(100000, 16)).toBeLessThan(0.26 * intensity);
        expect(spotlightCandela(0, 8)).toBe(0);
    });

    test.each(SPOTLIGHT_PATTERNS)("%s repeats on the timeline and points above the horizon", pattern => {
        const beam = {...defaultSpotlightBeam(1), pattern, tilt: 65, heading: 237};
        const direction = t => spotlightDirection(beam, t, new Vector3());
        expect(direction(3).distanceTo(direction(3 + beam.period))).toBeLessThan(1e-12);
        expect(direction(3).length()).toBeCloseTo(1);
        expect(direction(3).y).toBeGreaterThan(0);
        if (pattern === "Fixed") expect(direction(0)).toEqual(direction(1));
        else expect(direction(0).distanceTo(direction(1))).toBeGreaterThan(0.01);
    });

    test("the four default beams illuminate different points on a low cloud base", () => {
        const hits = [0, 1, 2, 3].map(i => {
            const dir = spotlightDirection(defaultSpotlightBeam(i), 0, new Vector3());
            return dir.multiplyScalar(400 / dir.y);
        });
        expect(hits[0].z).toBeCloseTo(-400 * Math.tan(24 * Math.PI / 180));
        for (let i = 0; i < 4; i++) expect(hits[i].distanceTo(hits[(i + 1) % 4])).toBeGreaterThan(200);
    });

    test.each(SPOTLIGHT_PATTERNS)("Spread scales the final %s direction around local vertical", pattern => {
        const beam = {...defaultSpotlightBeam(0), pattern, tilt: 35, heading: 63};
        const up = new Vector3(0, 1, 0);
        const direction = spread => spotlightDirection(beam, 2, new Vector3(), undefined, undefined, 0, undefined, spread);
        const original = direction(1);
        for (const spread of [0.1, 1.23, 3]) {
            const scaled = direction(spread);
            expect(scaled.angleTo(up)).toBeCloseTo(Math.min(Math.PI, original.angleTo(up) * spread), 9);
            expect(scaled.length()).toBeCloseTo(1);
            expect(Math.atan2(scaled.z, scaled.x)).toBeCloseTo(Math.atan2(original.z, original.x), 9);
        }
    });

    test("Spread keeps an overhead beam vertical and stops a wide tilt at straight down", () => {
        const beam = {...defaultSpotlightBeam(0), pattern: "Fixed"};
        const direction = tilt => spotlightDirection({...beam, tilt}, 0, new Vector3(), undefined, undefined, 0, undefined, 3);
        expect(direction(0).y).toBe(1);
        expect(direction(80).y).toBe(-1);
    });

    test("SkyTracker heads meet at vertical and reach 45 degrees in four directions", () => {
        const {beams} = spotlightPreset("stx4");
        const up = new Vector3(0, 1, 0);
        expect(beams).toHaveLength(4);
        const farthest = beams.map(beam => {
            expect(spotlightDirection(beam, 0, new Vector3()).angleTo(up)).toBeCloseTo(0);
            const dir = spotlightDirection(beam, beam.period / 2, new Vector3());
            expect(dir.angleTo(up)).toBeCloseTo(Math.PI / 4);
            return dir.setY(0).normalize();
        });
        farthest.forEach((dir, i) => expect(dir.angleTo(farthest[(i + 1) % 4])).toBeCloseTo(Math.PI / 2));
    });

    test("Spaceflower AUTO controls ring opening, ray rotation and pan independently", () => {
        expect(isFlowerCode("050")).toBe(true);
        for (const invalid of [50, "50", "0500", "05x"]) expect(isFlowerCode(invalid)).toBe(false);
        const {beams} = spotlightPreset("spaceflower");
        expect(beams).toHaveLength(36);
        const time = beams[0].period / 4;
        const dir = (i, code, seconds) => spotlightDirection(beams[i], seconds, new Vector3(), code, 90);
        // All rays on each ring keep their common opening angle.
        const axis = dir(0, "500", 2 * time);
        for (let i = 0; i < 36; i++) {
            const radius = (1 + Math.floor(i / 12)) * Math.PI / 20;
            expect(dir(i, "000", time).angleTo(axis)).toBeCloseTo(radius);
            expect(dir(i, "500", time).angleTo(axis)).toBeCloseTo(radius / 2);
            expect(dir(i, "050", time).distanceTo(dir(i - i % 12 + (i + 3) % 12, "000", 0))).toBeLessThan(1e-12);
        }
        const panned = dir(0, "005", time);
        expect(panned.y).toBeCloseTo(dir(0, "000", 0).y);
        expect(panned.distanceTo(dir(0, "000", 0))).toBeGreaterThan(0.05);
    });

    test("the published twin Leaf cue runs opposed heads and retraces each 20 second pass", () => {
        const [left, right] = spotlightPreset("twinLeaf").beams;
        const dir = (beam, seconds) => spotlightDirection(beam, seconds, new Vector3());
        expect(left.period).toBe(20);
        expect(dir(left, 5).x).toBeCloseTo(-dir(right, 5).x);
        expect(dir(left, 5).x).toBeLessThan(-0.2);
        expect(dir(left, 5).distanceTo(dir(left, 35))).toBeLessThan(1e-12);
        expect(dir(left, 5).distanceTo(dir(left, 25))).toBeGreaterThan(0.5);
    });
});

describe("concert choreography", () => {
    const {beams} = spotlightPreset("concert");
    const direction = (i, seconds, concert = DEFAULT_CONCERT) =>
        spotlightDirection(beams[i], seconds, new Vector3(), undefined, undefined, i, concert);

    test("each six-head bank follows a common path with an adjustable delay", () => {
        expect(beams).toHaveLength(12);
        for (const leader of [0, 6]) {
            for (let slot = 1; slot < 6; slot++) {
                expect(direction(leader + slot, 2.5).distanceTo(direction(leader, 2.5 - 0.3 * slot))).toBeLessThan(1e-12);
            }
        }
        expect(direction(0, 2).distanceTo(direction(6, 2))).toBeGreaterThan(0.2);
        const tight = {...DEFAULT_CONCERT, spacing: 0};
        expect(direction(0, 2, tight)).toEqual(direction(5, 2, tight));
    });

    test("heads break formation, hold separate spots, then release one bank first", () => {
        expect(direction(1, 10.4).distanceTo(direction(0, 10.1))).toBeGreaterThan(0.1);
        for (let i = 0; i < beams.length; i++) {
            const parked = direction(i, 14);
            expect(direction(i, 20)).toEqual(parked);
            for (let j = 0; j < i; j++) expect(parked.distanceTo(direction(j, 14))).toBeGreaterThan(0.05);
            if (i < 6) expect(direction(i, 22)).toEqual(parked);
            else expect(direction(i, 22).distanceTo(parked)).toBeGreaterThan(0.05);
        }
    });

    test("cue changes and the loop are continuous and replay at the same positions after a seek", () => {
        const timing = [0, 3.5, 4.5, 6.5, 7.5, 9, 10, 11.5, 13, 20.5, 22, 22.5, 23.5, 24.5, 25.5, 27.5, 29, 30];
        for (const t of timing) for (let i = 0; i < beams.length; i++) {
            expect(direction(i, t - 0.00001).distanceTo(direction(i, t + 0.00001))).toBeLessThan(0.0001);
            expect(direction(i, t + 30).distanceTo(direction(i, t))).toBeLessThan(1e-12);
        }
        const faster = {...DEFAULT_CONCERT, speed: 2, heading: 90};
        const normal = direction(2, 9);
        expect(direction(2, 4.5, faster).distanceTo(new Vector3(-normal.z, normal.y, normal.x))).toBeLessThan(1e-12);
    });
});

describe("QLC+ position EFX import", () => {
    const effect = `<Function Type="EFX" Name="Two heads"><Fixture><ID>0</ID><Mode>0</Mode><Direction>Forward</Direction></Fixture>
        <Fixture><ID>1</ID><Mode>0</Mode><Direction>Backward</Direction></Fixture>
        <Speed Duration="20000" FadeIn="0" FadeOut="0"/><PropagationMode>Parallel</PropagationMode><RunOrder>PingPong</RunOrder>
        <Width>125</Width><Height>127</Height><Algorithm>Leaf</Algorithm></Function>`;

    test("reads a native workspace and a standalone effect, preserving the two-head cue", () => {
        const scene = `<Workspace xmlns="http://www.qlcplus.org/Workspace"><Engine>
            <Function Type="Scene"/>${effect}</Engine></Workspace>`;
        const cues = readQLCSpotlightEffects(scene);
        expect(cues).toEqual(readQLCSpotlightEffects(effect));
        expect(cues).toHaveLength(1);
        expect(cues[0].name).toBe("Two heads");
        const expected = spotlightPreset("twinLeaf").beams;
        cues[0].beams.forEach((beam, i) => {
            for (const seconds of [0, 4, 15, 21]) {
                const actual = spotlightDirection(beam, seconds, new Vector3());
                expect(actual.distanceTo(spotlightDirection(expected[i], seconds, new Vector3()))).toBeLessThan(1e-10);
            }
        });
    });

    test("the console circle starts toward negative X and keeps its per-head phase", () => {
        const circle = effect.replace("Leaf", "Circle").replace("<ID>0</ID>", "<StartOffset>90</StartOffset>");
        const [beam] = readQLCSpotlightEffects(circle)[0].beams;
        const dir = spotlightDirection(beam, 0, new Vector3());
        expect(dir.x).toBeLessThan(0);
        expect(dir.z).toBeCloseTo(0);
    });

    test("ignores inapplicable functions without changing the scene", () => {
        for (const xml of [effect.replace("Parallel", "Serial"), effect.replace("<Mode>0", "<Mode>2"),
            effect.replace("FadeIn=\"0\"", "FadeIn=\"1000\""), effect.replace("Leaf", "Square"),
            effect.replace("<Width>", "<IsRelative>1</IsRelative><Width>"), "<broken>"]) {
            expect(readQLCSpotlightEffects(xml)).toEqual([]);
        }
    });
});

test("cloud draws share beam data but locate the same source relative to each view", () => {
    const field = new SpotlightField();
    const anchor = new Vector3(-2518842.123, -4669206.456, 3528541.789);
    const lamp = {origin: anchor.clone().addScalar(0.25), direction: new Vector3(0, 1, 0),
        settings: defaultSpotlightBeam(0)};
    const widerLamp = {...lamp, settings: {...lamp.settings, width: 16}};
    const projector = {group: {position: anchor, visible: true}, lumens: 50000, beams: [lamp, widerLamp]};
    field.projectors.set("a", projector);
    field.dirty = true;
    const uniforms = spotlightUniforms();
    const firstCamera = new Matrix4().makeTranslation(anchor.x + 500, anchor.y, anchor.z);
    field.setUniforms(uniforms, firstCamera);
    expect(uniforms.spotlightCount.value).toBe(2);
    expect(uniforms.spotlightOrigin.value.toArray()).toEqual([-500, 0, 0]);
    const texture = uniforms.spotlightData.value;
    const intensities = [texture.image.data[3], texture.image.data[11]];
    expect(intensities[0]).toBeGreaterThan(intensities[1]);
    projector.lumens *= 2;
    field.dirty = true;
    expect(Array.from(texture.image.data.slice(0, 3))).toEqual([0.25, 0.25, 0.25]);
    field.setUniforms(uniforms, new Matrix4().makeTranslation(...anchor.toArray()));
    expect(uniforms.spotlightData.value).toBe(texture);
    expect([texture.image.data[3], texture.image.data[11]]).toEqual(intensities.map(value => value * 2));
    expect(uniforms.spotlightOrigin.value.length()).toBe(0);
    projector.group.visible = false;
    field.dirty = true;
    field.setUniforms(uniforms, firstCamera);
    expect(uniforms.spotlightCount.value).toBe(0);
    expect(uniforms.spotlightData.value).toBeNull();
});
