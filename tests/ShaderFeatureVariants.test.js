import {MeshBasicMaterial, ShaderLib, Vector3} from "three";
import {Globals} from "../src/Globals";
import {installShaderFeatureVariants} from "../src/ShaderFeatureVariants";
import {glintUniforms, setGlintFeatureEnabled} from "../src/js/map33/material/TerrainGlints";
import {createTerrainDayNightMaterial, cloneTerrainDayNightMaterialForView} from "../src/js/map33/material/TerrainDayNightMaterial";
import {DayNightStandardMaterial} from "../src/js/map33/material/DayNightStandardMaterial";
import {sharedUniforms} from "../src/js/map33/material/SharedUniforms";
import {installTerrestrialRefractionVariants, terrestrialRefractionUniforms} from "../src/atmosphere/terrestrialRefraction";
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

test("refraction selects exclusive off, standard and ray variants for each camera draw", () => {
    const material = new MeshBasicMaterial();
    installTerrestrialRefractionVariants(material);
    const initial = material.version;
    material.onBeforeRender();
    expect(material.version).toBe(initial);
    terrestrialRefractionUniforms.uTerrK.value = .176;
    material.onBeforeRender();
    expect(material.defines.SITREC_TERRESTRIAL_REFRACTION).toBe(1);
    rayGeometryUniforms.uRayGeometry.value = 1;
    material.onBeforeRender();
    expect(material.defines.SITREC_TERRESTRIAL_REFRACTION).toBeUndefined();
    expect(material.defines.SITREC_RAY_GEOMETRY).toBe(1);
    terrestrialRefractionUniforms.uTerrK.value = 0;
    rayGeometryUniforms.uRayGeometry.value = 0;
    material.onBeforeRender();
    expect(material.defines).toEqual({});
});

test("terrain water follows the view scope and is absent when a separate sea surface draws it", () => {
    const terrain = createTerrainDayNightMaterial(null);
    const clone = cloneTerrainDayNightMaterialForView(terrain);
    sharedUniforms.waterReflection.value = 1;
    terrain.onBeforeRender();
    expect(terrain.defines.SITREC_TERRAIN_WATER).toBe(1);
    sharedUniforms.waterReflection.value = 0;
    clone.onBeforeRender();
    expect(clone.defines.SITREC_TERRAIN_WATER).toBeUndefined();
    sharedUniforms.waterReflection.value = 1;
    sharedUniforms.waterSurfaceOnly.value = 1;
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
    materialAtmosphereUniforms.atmoEnabled.value = false;
    material.onBeforeRender();
    program = shader();
    material.onBeforeCompile(program, {});
    expect(program.vertexShader).toBe(ShaderLib.basic.vertexShader);
    expect(program.fragmentShader).toBe(ShaderLib.basic.fragmentShader);
});
