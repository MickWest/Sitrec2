import {
    applyTypeDefaults,
    CLOUD_PRESET_NAMES,
    CLOUD_QUALITIES,
    CLOUD_QUALITY_SETTINGS,
    cloudQualitySettings,
    marchTargetSize,
    CLOUD_TYPE_NAMES,
    CLOUD_TYPES,
    deserializeCloudState,
    isSheetType,
    layerDefaultsFor,
    layerReferenceAltitude,
    layerTitle,
    MAX_CLOUD_LAYERS,
    nextLayerId,
    normalizeLayer,
    presetLayers,
    serializeCloudState,
} from "../src/clouds/CloudLayerModel";

describe("cloud layer model", () => {
    test("a sheet lies at its base altitude; a volume is represented by its middle", () => {
        const cirrus = normalizeLayer({type: "cirrus", baseAltitude: 9000, thickness: 800});
        const cumulus = normalizeLayer({type: "cumulus", baseAltitude: 1500, thickness: 1500});
        expect(layerReferenceAltitude(cirrus)).toBe(9000);
        expect(layerReferenceAltitude(cumulus)).toBe(2250);
        for (const type of CLOUD_TYPE_NAMES.filter(isSheetType)) {
            const layer = layerDefaultsFor(type);
            expect(layerReferenceAltitude(layer)).toBe(layer.baseAltitude);
        }
    });

    test("every type has the fields the renderer needs", () => {
        expect(CLOUD_TYPE_NAMES).toEqual(expect.arrayContaining([
            "cumulus", "stratocumulus", "stratus", "cumulonimbus",
            "altocumulus", "cirrus", "cirrostratus", "cirrocumulus"]));
        for (const name of CLOUD_TYPE_NAMES) {
            const info = CLOUD_TYPES[name];
            expect(["volume", "sheet"]).toContain(info.render);
            expect(info.baseAltitude).toBeGreaterThanOrEqual(0);
            expect(info.thickness).toBeGreaterThan(0);
            expect(info.extinction).toBeGreaterThan(0);
            if (info.render === "volume") {
                expect(info.gradient).toHaveLength(4);
                const [a, b, c, d] = info.gradient;
                expect(a <= b && b <= c && c <= d).toBe(true);
            } else {
                expect(info.opticalDepth).toBeGreaterThan(0);
                expect([0, 1, 2]).toContain(info.pattern);
            }
        }
        expect(isSheetType("cirrus")).toBe(true);
        expect(isSheetType("cumulus")).toBe(false);
    });

    test("normalizeLayer fills defaults and clamps values", () => {
        const layer = normalizeLayer({type: "nonsense", coverage: 7, density: -1, seed: 12.6,
            wind: {mode: "bad", from: -90, knots: 1e6}, extent: {mode: "disc", lat: 95, lon: 200}});
        expect(layer.type).toBe("cumulus");
        expect(layer.coverage).toBe(1);
        expect(layer.density).toBe(0);
        expect(layer.seed).toBe(13);
        expect(layer.wind.mode).toBe("local");
        expect(layer.wind.from).toBe(270);
        expect(layer.wind.knots).toBe(300);
        expect(layer.extent.mode).toBe("disc");
        expect(layer.extent.lat).toBe(90);
        expect(layer.extent.lon).toBe(-160);
        expect(layer.visible).toBe(true);
        expect(layer.id).toBe("layer1");
    });

    test("normalizeLayer is idempotent", () => {
        const once = normalizeLayer({type: "cirrus", coverage: 0.3, extent: {mode: "disc", lat: 34, lon: -118}});
        expect(normalizeLayer(once)).toEqual(once);
    });

    test("a type change applies that type's defaults and keeps the rest", () => {
        const layer = normalizeLayer({type: "cumulus", density: 1.7, seed: 42, wind: {mode: "custom", from: 10, knots: 33}});
        const changed = applyTypeDefaults(layer, "cirrus");
        expect(changed.type).toBe("cirrus");
        expect(changed.baseAltitude).toBe(CLOUD_TYPES.cirrus.baseAltitude);
        expect(changed.coverage).toBe(CLOUD_TYPES.cirrus.coverage);
        expect(changed.density).toBe(1.7);
        expect(changed.seed).toBe(42);
        expect(changed.wind).toEqual({mode: "custom", from: 10, knots: 33});
    });

    test("layer ids are unique", () => {
        expect(nextLayerId([])).toBe("layer1");
        expect(nextLayerId([{id: "layer1"}, {id: "layer3"}])).toBe("layer2");
    });

    test("presets produce valid, uniquely identified layers", () => {
        expect(CLOUD_PRESET_NAMES).toContain("Clear");
        expect(presetLayers("Clear")).toEqual([]);
        expect(presetLayers("No Such Preset")).toBeNull();
        for (const name of CLOUD_PRESET_NAMES) {
            const layers = presetLayers(name);
            expect(layers.length).toBeLessThanOrEqual(MAX_CLOUD_LAYERS);
            expect(new Set(layers.map(layer => layer.id)).size).toBe(layers.length);
            for (const layer of layers) expect(normalizeLayer(layer)).toEqual(layer);
        }
        const storm = presetLayers("Towering Storm");
        expect(storm[0].type).toBe("cumulonimbus");
        expect(storm[0].extent.mode).toBe("disc");
    });

    test("serialization round trip restores the same state", () => {
        const state = {
            showMain: true,
            showLook: false,
            quality: "High",
            layers: [
                normalizeLayer({type: "cumulus", coverage: 0.33, seed: 5, name: "low"}, {id: "layer1"}),
                normalizeLayer({type: "cirrus", visible: false, wind: {mode: "custom", from: 300, knots: 80}}, {id: "layer2"}),
                normalizeLayer({type: "cumulonimbus", extent: {mode: "disc", lat: 33.5, lon: -117.9, radius: 9000, feather: 3000}}, {id: "layer3"}),
            ],
        };
        const saved = serializeCloudState(state);
        const json = JSON.parse(JSON.stringify(saved));
        const restored = deserializeCloudState(json);
        expect(restored).toEqual(state);
        // Serializing copies: editing the saved object does not touch the live layer.
        saved.layers[0].extent.radius = 1;
        expect(state.layers[0].extent.radius).not.toBe(1);
    });

    test("deserialize tolerates missing, bad and duplicate data", () => {
        expect(deserializeCloudState(undefined)).toEqual({showMain: false, showLook: true, quality: "Medium", layers: []});
        expect(deserializeCloudState({enabled: false})).toMatchObject({showMain: false, showLook: false});
        expect(serializeCloudState({})).toMatchObject({showMain: false, showLook: true});
        const restored = deserializeCloudState({quality: "Silly", layers: [
            {id: "layer1", type: "cumulus"}, {id: "layer1", type: "stratus"}, null, 5,
            {type: "cirrus"}, {type: "cirrus"}, {type: "cirrus"}]});
        expect(restored.quality).toBe("Medium");
        expect(restored.layers.map(layer => layer.id)).toEqual(["layer1", "layer2", "layer3", "layer4"]);
        expect(restored.layers[1].type).toBe("stratus");
        expect(restored.layers.length).toBeLessThanOrEqual(MAX_CLOUD_LAYERS);
    });

    test("layer titles", () => {
        expect(layerTitle(layerDefaultsFor("cirrus"), 1)).toBe("Layer 2: Cirrus");
        expect(layerTitle({...layerDefaultsFor("stratus"), name: "deck"}, 0)).toBe("Layer 1: Stratus (deck)");
    });

    test("quality levels: resolution falls and the work grows from Low to Ultra", () => {
        expect(Object.keys(CLOUD_QUALITY_SETTINGS)).toEqual(CLOUD_QUALITIES);
        const levels = CLOUD_QUALITIES.map(name => CLOUD_QUALITY_SETTINGS[name]);
        for (const level of levels) {
            for (const key of ["resolution", "steps", "skipSteps", "lightSteps", "fineStep", "opticalStep", "detailLevel"]) {
                expect(Number.isFinite(level[key])).toBe(true);
            }
            expect(level.resolution).toBeGreaterThan(0);
            expect(level.resolution).toBeLessThanOrEqual(1);
            expect(level.lightSteps).toBeLessThanOrEqual(6);
            expect(level.steps).toBeLessThanOrEqual(256);
        }
        for (let index = 1; index < levels.length; index++) {
            expect(levels[index].resolution).toBeGreaterThanOrEqual(levels[index - 1].resolution);
            expect(levels[index].steps).toBeGreaterThanOrEqual(levels[index - 1].steps);
            expect(levels[index].lightSteps).toBeGreaterThanOrEqual(levels[index - 1].lightSteps);
            expect(levels[index].opticalStep).toBeLessThanOrEqual(levels[index - 1].opticalStep);
        }
        expect(CLOUD_QUALITY_SETTINGS.Ultra.resolution).toBe(1);
        expect(cloudQualitySettings("Nonsense")).toBe(CLOUD_QUALITY_SETTINGS.Medium);
    });

    test("march target size", () => {
        expect(marchTargetSize(1920, 1080, 0.5)).toEqual({width: 960, height: 540});
        expect(marchTargetSize(1361, 977, 0.5)).toEqual({width: 681, height: 489});
        expect(marchTargetSize(1920, 1080, 1)).toEqual({width: 1920, height: 1080});
        expect(marchTargetSize(3, 1, 0.25)).toEqual({width: 1, height: 1});
        expect(marchTargetSize(100, 100, 0)).toEqual({width: 100, height: 100});
    });
});
