import {Color, MeshBasicMaterial, ShaderLib} from "three";
import {installTrackWallLines, patchTrackWallLineShader} from "../src/rendering/TrackWallLines";

describe("TrackWallLines", () => {
    test("patches the stock basic mesh shader", () => {
        const patched = patchTrackWallLineShader(ShaderLib.basic);
        expect(patched.vertexShader).toContain("attribute vec2 wallU;");
        expect(patched.vertexShader).toContain("vWallU = wallU;\n#include <begin_vertex>");
        expect(patched.fragmentShader).toContain("uniform float wallLineSpacing;");
        // The lines are composited before the last output chunk.
        expect(patched.fragmentShader.indexOf("wallFineStep"))
            .toBeLessThan(patched.fragmentShader.indexOf("#include <dithering_fragment>"));
    });

    test("fails loudly when an anchor chunk is missing", () => {
        expect(() => patchTrackWallLineShader({vertexShader: "void main() {}", fragmentShader: "void main() {}"}))
            .toThrow("missing");
    });

    test("install wires uniforms, a program key and the per-view pixel scale", () => {
        const material = new MeshBasicMaterial();
        const defaultKey = material.customProgramCacheKey();
        installTrackWallLines(material, {
            color: new Color(1, 0, 0), opacity: 0.5, spacing: 20, length: 1000, pixelScale: () => 2,
        });
        expect(material.customProgramCacheKey()).not.toBe(defaultKey);

        const shader = {uniforms: {}, ...ShaderLib.basic};
        material.onBeforeCompile(shader);
        expect(shader.uniforms.wallLineSpacing.value).toBe(20);
        expect(shader.uniforms.wallLength.value).toBe(1000);
        expect(shader.fragmentShader).toContain("wallFineStep");

        material.onBeforeRender({});
        expect(shader.uniforms.wallLinePixelScale.value).toBe(2);
    });
});
