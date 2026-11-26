import {MeshBasicMaterial, ShaderLib, Vector3} from "three";
import {Globals} from "../src/Globals";
import {advanceShaderFeatureFrame, installShaderFeatureVariants, SCOPED_FEATURE_HOLD_FRAMES} from "../src/ShaderFeatureVariants";
import {glintUniforms, setGlintFeatureEnabled} from "../src/js/map33/material/TerrainGlints";
import {createTerrainDayNightMaterial, cloneTerrainDayNightMaterialForView} from "../src/js/map33/material/TerrainDayNightMaterial";
import {DayNightStandardMaterial} from "../src/js/map33/material/DayNightStandardMaterial";
import {sharedUniforms} from "../src/js/map33/material/SharedUniforms";
import {installTerrestrialRefractionOnMaterial, installTerrestrialRefractionVariants,
    terrestrialRefractionUniforms, TERRESTRIAL_REFRACTION_VERTEX_GLSL} from "../src/atmosphere/terrestrialRefraction";
import {rayGeometryUniforms} from "../src/refraction/RayGeometryProjection";
import {installMaterialAtmosphere, materialAtmosphereUniforms} from "../src/atmosphere/MaterialAtmosphere";

let originalSun;
beforeEach(() => {
    originalSun = Globals.sunLight;
    Globals.sunLight = {position: new Vector3(1, 0, 0)};
    setGlintFeatureEnabled(false);
    glintUniforms.glintEnabled.value = false;
    sharedUniforms.waterReflection.value = 0;
    sharedUniforms.waterSurfaceOnly.value = 0;
    sharedUniforms.waterTileCapture.value = 0;
    terrestrialRefractionUniforms.uTerrK.value = 0;
    rayGeometryUniforms.uRayGeometry.value = 0;
    materialAtmosphereUniforms.atmoEnabled.value = false;
});
afterEach(() => { Globals.sunLight = originalSun; });

// One more frame than a pass-scoped feature stays compiled in after its last use.
function passHold() {
    for (let i = 0; i <= SCOPED_FEATURE_HOLD_FRAMES; i++) advanceShaderFeatureFrame();
}

test("draw hooks keep their receiver and select flags after existing callbacks", () => {
    const material = new MeshBasicMaterial();
    material.defines = {EXISTING: "", OPTIONAL: ""};
    let enabled = false;
    material.onBeforeRender = function(value) {
        expect(this).toBe(material);
        enabled = value;
    };
    installShaderFeatureVariants(material, {OPTIONAL: () => enabled});
    expect(material.defines).toEqual({EXISTING: ""});
    material.onBeforeRender(true);
    expect(material.defines.OPTIONAL).toBe(1);
    const version = material.version;
    material.onBeforeRender(true);
    expect(material.version).toBe(version);
    material.onBeforeRender(false);
    expect(material.defines.OPTIONAL).toBeUndefined();
    expect(material.version).toBe(version + 1);
});

test("a pass-scoped feature holds after its last use, then drops, and its switch is immediate", () => {
    const material = new MeshBasicMaterial();
    let used = false, enabled = true;
    installShaderFeatureVariants(material, {SCOPED: {scoped: () => used, enabled: () => enabled}});
    expect(material.defines?.SCOPED).toBeUndefined();
    used = true;
    material.onBeforeRender();
    expect(material.defines.SCOPED).toBe(1);
    const version = material.version;

    // Draws that do not use it leave the material alone for the whole hold.
    used = false;
    for (let i = 0; i < SCOPED_FEATURE_HOLD_FRAMES; i++) {
        advanceShaderFeatureFrame();
        material.onBeforeRender();
    }
    expect(material.defines.SCOPED).toBe(1);
    expect(material.version).toBe(version);
    advanceShaderFeatureFrame();
    material.onBeforeRender();
    expect(material.defines.SCOPED).toBeUndefined();
    expect(material.version).toBe(version + 1);

    // The switch overrides both the current use and the hold.
    used = true;
    material.onBeforeRender();
    expect(material.defines.SCOPED).toBe(1);
    enabled = false;
    material.onBeforeRender();
    expect(material.defines.SCOPED).toBeUndefined();
    used = false;
    enabled = true;
    material.onBeforeRender();
    expect(material.defines.SCOPED).toBe(1);
});

test("terrain and its shadow clone compile glints only for the master switch, not blink phase", () => {
    const terrain = createTerrainDayNightMaterial(null);
    const clone = cloneTerrainDayNightMaterialForView(terrain);
    const building = new DayNightStandardMaterial();
    for (const material of [terrain, clone, building]) expect(material.defines?.SITREC_GLINTS).toBeUndefined();
    setGlintFeatureEnabled(true);
    for (const material of [terrain, clone, building]) {
        material.onBeforeRender();
        expect(material.defines.SITREC_GLINTS).toBe(1);
        const version = material.version;
        glintUniforms.glintEnabled.value = !glintUniforms.glintEnabled.value;
        material.onBeforeRender();
        expect(material.version).toBe(version);
    }
    setGlintFeatureEnabled(false);
    for (const material of [terrain, clone, building]) {
        material.onBeforeRender();
        expect(material.defines.SITREC_GLINTS).toBeUndefined();
    }
});

test("refraction keeps the standard and ray variants together for a material that both kinds of view draw", () => {
    const material = new MeshBasicMaterial();
    installTerrestrialRefractionVariants(material);
    const initial = material.version;
    material.onBeforeRender();
    expect(material.version).toBe(initial);
    terrestrialRefractionUniforms.uTerrK.value = .176;
    material.onBeforeRender();
    expect(material.defines.SITREC_TERRESTRIAL_REFRACTION).toBe(1);
    expect(material.defines.SITREC_RAY_GEOMETRY).toBeUndefined();
    rayGeometryUniforms.uRayGeometry.value = 1;
    material.onBeforeRender();
    expect(material.defines.SITREC_TERRESTRIAL_REFRACTION).toBe(1);
    expect(material.defines.SITREC_RAY_GEOMETRY).toBe(1);

    terrestrialRefractionUniforms.uTerrK.value = 0;
    rayGeometryUniforms.uRayGeometry.value = 0;
    material.onBeforeRender();
    expect(material.defines.SITREC_RAY_GEOMETRY).toBe(1);
    passHold();
    material.onBeforeRender();
    expect(material.defines).toEqual({});
});

// Resolve the #ifdef / #elif defined() / #else / #endif lines of the chunk.
function preprocess(source, defined) {
    const stack = [];
    const lines = [];
    for (const line of source.split("\n")) {
        const directive = line.trim().match(/^#(ifdef|elif|else|endif)\b\s*(?:defined\()?(\w+)?/);
        if (!directive) {
            if (stack.every(level => level.active)) lines.push(line);
            continue;
        }
        const [, kind, name] = directive;
        const top = stack[stack.length - 1];
        if (kind === "ifdef") stack.push({active: defined.includes(name), taken: defined.includes(name)});
        else if (kind === "endif") stack.pop();
        else {
            top.active = !top.taken && (kind === "else" || defined.includes(name));
            top.taken ||= top.active;
        }
    }
    return lines.join("\n");
}

test("the refraction chunk selects ray geometry by uniform, so both variants can be compiled in", () => {
    const start = TERRESTRIAL_REFRACTION_VERTEX_GLSL.indexOf("vec3 applyTerrestrialRefraction_chunk");
    const end = TERRESTRIAL_REFRACTION_VERTEX_GLSL.indexOf("vec4 applyTerrestrialRefraction_clip");
    const chunk = defined => preprocess(TERRESTRIAL_REFRACTION_VERTEX_GLSL.slice(start, end), defined)
        .replace(/\/\/[^\n]*/g, "");
    const ray = "if (uRayGeometry > 0.5) return applyRayGeometry(viewPos);";
    const standard = "if (uTerrK == 0.0) return viewPos;";

    const off = chunk([]);
    expect(off).not.toContain("uRayGeometry");
    expect(off).not.toContain("uTerrK");
    expect(off).toContain("return viewPos;");

    const rayOnly = chunk(["SITREC_RAY_GEOMETRY"]);
    expect(rayOnly).toContain(ray);
    expect(rayOnly).not.toContain("uTerrK");
    // A draw with the uniform off must still return the physical position.
    expect(rayOnly.indexOf("return viewPos;")).toBeGreaterThan(rayOnly.indexOf(ray));

    const standardOnly = chunk(["SITREC_TERRESTRIAL_REFRACTION"]);
    expect(standardOnly).toContain(standard);
    expect(standardOnly).not.toContain("uRayGeometry");

    // Both: the ray test comes first and falls through to the standard lift.
    const both = chunk(["SITREC_RAY_GEOMETRY", "SITREC_TERRESTRIAL_REFRACTION"]);
    expect(both).toContain(ray);
    expect(both.indexOf(standard)).toBeGreaterThan(both.indexOf(ray));
    expect(both).toContain("return viewPos + uTerrZenithView * lift;");
});

test("terrain water holds across a mirror capture, stays off a view that never uses it, and drops for a sea surface", () => {
    const terrain = createTerrainDayNightMaterial(null);
    const clone = cloneTerrainDayNightMaterialForView(terrain);
    sharedUniforms.waterReflection.value = 1;
    terrain.onBeforeRender();
    expect(terrain.defines.SITREC_TERRAIN_WATER).toBe(1);
    sharedUniforms.waterReflection.value = 0;
    clone.onBeforeRender();
    terrain.onBeforeRender();
    expect(clone.defines.SITREC_TERRAIN_WATER).toBeUndefined();
    expect(terrain.defines.SITREC_TERRAIN_WATER).toBe(1);

    // A separate sea surface now draws the water in every pass.
    sharedUniforms.waterReflection.value = 1;
    sharedUniforms.waterSurfaceOnly.value = 1;
    passHold();
    terrain.onBeforeRender();
    expect(terrain.defines.SITREC_TERRAIN_WATER).toBeUndefined();
});

test("building water preserves capture masks and disables an existing empty-string define", () => {
    const material = new DayNightStandardMaterial();
    material.setTileWater(true);
    sharedUniforms.waterTileCapture.value = 1;
    material.onBeforeRender();
    expect(material.defines.SITREC_TILE_WATER).toBe(1);
    material.defines.SITREC_TILE_WATER = "";
    material.setTileWater(false);
    expect(material.defines.SITREC_TILE_WATER).toBeUndefined();
    const version = material.version;
    material.onBeforeRender();
    expect(material.version).toBe(version);
});

test("disabled atmosphere leaves the base shader intact after a previous enabled draw", () => {
    const material = new MeshBasicMaterial();
    installMaterialAtmosphere(material);
    const shader = () => ({...ShaderLib.basic, uniforms: {}});
    let program = shader();
    material.onBeforeCompile(program, {});
    expect(program.vertexShader).toBe(ShaderLib.basic.vertexShader);
    expect(program.fragmentShader).toBe(ShaderLib.basic.fragmentShader);
    expect(program.uniforms.atmoEnabled).toBe(materialAtmosphereUniforms.atmoEnabled);
    materialAtmosphereUniforms.atmoEnabled.value = true;
    material.onBeforeRender();
    program = shader();
    material.onBeforeCompile(program, {});
    expect(program.fragmentShader).toContain("applyMaterialAtmosphere");

    // The main view draws the same material without haze: the variant stays.
    materialAtmosphereUniforms.atmoEnabled.value = false;
    const version = material.version;
    material.onBeforeRender();
    expect(material.version).toBe(version);

    passHold();
    material.onBeforeRender();
    program = shader();
    material.onBeforeCompile(program, {});
    expect(program.vertexShader).toBe(ShaderLib.basic.vertexShader);
    expect(program.fragmentShader).toBe(ShaderLib.basic.fragmentShader);
});

// Each draw list is the pass order of ONE frame. Three computes the program key
// again each time a material's version changes, so a steady frame must not change it.
describe("a steady multi-pass frame does not invalidate a material", () => {
    const water = (reflection, capture = 0) => () => {
        sharedUniforms.waterReflection.value = reflection;
        sharedUniforms.waterTileCapture.value = capture;
    };
    const haze = on => () => { materialAtmosphereUniforms.atmoEnabled.value = on; };
    const rayView = on => () => { rayGeometryUniforms.uRayGeometry.value = on ? 1 : 0; };
    const cases = [
        ["planar mirror or ocean: terrain tile in the capture, then the visible pass",
            () => cloneTerrainDayNightMaterialForView(createTerrainDayNightMaterial(null)),
            [water(0), water(1)]],
        ["water reflection in the look view only: terrain tile that both views share",
            () => createTerrainDayNightMaterial(null),
            [water(0), water(1)]],
        ["planar mirror: building tile in an unclipped capture, a clipped capture, then the visible pass",
            () => { const tile = new DayNightStandardMaterial(); tile.setTileWater(true); return tile; },
            [water(0), water(0, 1), water(1)]],
        ["look-view haze: material that the main view also draws",
            () => { const shared = new MeshBasicMaterial(); installMaterialAtmosphere(shared); return shared; },
            [haze(false), haze(true)]],
        ["ray-traced look view beside a standard main view",
            () => {
                const shared = new MeshBasicMaterial();
                installTerrestrialRefractionOnMaterial(shared);
                terrestrialRefractionUniforms.uTerrK.value = .176;
                return shared;
            },
            [rayView(false), rayView(true)]],
    ];

    test.each(cases)("%s", (name, make, passes) => {
        const material = make();
        const frame = () => {
            advanceShaderFeatureFrame();
            for (const pass of passes) {
                pass();
                material.onBeforeRender();
            }
        };
        frame();
        const version = material.version;
        for (let i = 0; i < 3 * SCOPED_FEATURE_HOLD_FRAMES; i++) frame();
        expect(material.version).toBe(version);
    });
});
