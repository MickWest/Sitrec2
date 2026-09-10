import {test, expect} from "@playwright/test";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {PerspectiveCamera} from "three";

// Exercise the actual GPU shader with analytic rays and a finite ridge in
// front of a separately rendered sky. No terrain service or saved sitch needed.
const source = readFileSync(resolve("src/refraction/RefractionPass.js"), "utf8");
const fragment = source.match(/const fragmentShader = \/\* glsl \*\/`([\s\S]*?)`;/)[1];
const camera = new PerspectiveCamera(2 * Math.atan(0.025) * 180 / Math.PI, 1, 0.1, 8e8);

for (const manualFiltering of [false, true]) for (const scenario of ["straight", "raised ridge", "lowered ridge", "overlapping ridges", "mirage fold", "visible frame-edge ridge"]) {
    test(`refraction preserves the analytic ${scenario} (${manualFiltering ? "manual" : "hardware"} filtering)`, async ({page}) => {
        const result = await page.evaluate(({fragment, projection, inverseProjection, scenario, manualFiltering}) => {
            const height = 512, width = 1, ridge = scenario === "visible frame-edge ridge" ? 0.02 : 0.625,
                distance = 1000, maxDistance = 5000;
            const canvas = document.createElement("canvas");
            canvas.width = width; canvas.height = height;
            const gl = canvas.getContext("webgl2");
            if (!gl) throw new Error("WebGL2 required");
            if (!manualFiltering && !gl.getExtension("OES_texture_float_linear")) return {noLinearFiltering: true};
            const compile = (type, text) => {
                const s = gl.createShader(type); gl.shaderSource(s, text); gl.compileShader(s);
                if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
                return s;
            };
            const program = gl.createProgram();
            gl.attachShader(program, compile(gl.VERTEX_SHADER, `#version 300 es
                out vec2 vUv;
                void main() {
                    vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
                    vUv = p; gl_Position = vec4(p * 2. - 1., 0., 1.);
                }`));
            const fs = fragment.replace("varying vec2 vUv;", "in vec2 vUv;\nout vec4 outputColor;")
                .replaceAll("texture2D", "texture").replaceAll("gl_FragColor", "outputColor");
            gl.attachShader(program, compile(gl.FRAGMENT_SHADER, "#version 300 es\n" + fs));
            gl.linkProgram(program);
            if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
            gl.useProgram(program);
            const uniform = name => gl.getUniformLocation(program, name);
            const scalar = (name, value) => gl.uniform1f(uniform(name), value);
            gl.uniformMatrix4fv(uniform("projection"), false, projection);
            gl.uniformMatrix4fv(uniform("inverseProjection"), false, inverseProjection);
            gl.uniform3f(uniform("zenith"), 0, 1, 0);
            gl.uniform2f(uniform("resolution"), width, height);
            gl.uniform2f(uniform("angles"), -0.03, 0.03);
            scalar("cameraNear", 0.1); scalar("cameraFar", 8e8); scalar("logDepth", 1);
            scalar("maxDistance", maxDistance);
            scalar("rayLinearFiltering", manualFiltering ? 0 : 1);
            const texture = (name, unit, w, h, data, float = false, linear = false) => {
                gl.activeTexture(gl.TEXTURE0 + unit);
                gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
                gl.texImage2D(gl.TEXTURE_2D, 0, float ? gl.RGBA32F : gl.RGBA8, w, h, 0,
                    gl.RGBA, float ? gl.FLOAT : gl.UNSIGNED_BYTE, data);
                for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, linear ? gl.LINEAR : gl.NEAREST);
                for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
                gl.uniform1i(uniform(name), unit);
            };
            const scene = new Uint8Array(height * 4), sky = new Uint8Array(height * 4), depth = new Float32Array(height * 4);
            for (let y = 0; y < height; y++) {
                const v = (y + 0.5) / height, ground = v < ridge;
                sky.set([0, Math.round(v * 255), 255, 255], y * 4);
                scene.set(ground ? [255, Math.round(v * 255), 0, 255] : sky.subarray(y * 4, y * 4 + 4), y * 4);
                const surfaceDistance = scenario === "overlapping ridges" && v >= 0.4 ? 2000 : distance;
                depth[y * 4] = ground ? Math.log2(surfaceDistance + 1) / Math.log2(8e8 + 1) : 1;
            }
            texture("tDiffuse", 0, width, height, scene);
            texture("tSky", 1, width, height, sky);
            texture("tDepth", 2, width, height, depth, true);
            const rows = 1024, columns = 128, rays = new Float32Array(rows * columns * 4);
            const curvature = scenario === "visible frame-edge ridge" ? -2e-5
                : ["raised ridge", "overlapping ridges"].includes(scenario) ? -4e-6 : scenario === "lowered ridge" ? 4e-6 : 0;
            const ridgeSlope = (ridge * 2 - 1) * 0.025;
            const displacement = angle => scenario === "mirage fold"
                ? ridgeSlope + 0.002 * Math.sin(angle * 600) - Math.tan(angle)
                : curvature * distance / 2;
            for (let row = 0; row < rows; row++) {
                const angle = -0.03 + 0.06 * row / (rows - 1);
                for (let col = 0; col < columns; col++) {
                    const d = maxDistance * (col / (columns - 1)) ** 2;
                    const offset = displacement(angle) * d / distance;
                    rays.set([offset, offset * 2, maxDistance, 0], (row * columns + col) * 4);
                }
            }
            texture("tRays", 3, columns, rows, rays, true, !manualFiltering);
            gl.uniform2f(uniform("tableSize"), columns, rows);
            gl.viewport(0, 0, width, height);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            const pixels = new Uint8Array(height * 4);
            gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
            const mismatches = [], wrongColor = [];
            let transitions = 0, previous;
            for (let y = 0; y < height; y++) {
                const v = (y + 0.5) / height, tangent = (2 * v - 1) * 0.025;
                const offset = displacement(Math.atan(tangent));
                const sourceV = (tangent + offset * (scenario === "overlapping ridges" ? 2 : 1)) / 0.05 + 0.5;
                const expectedGround = sourceV < ridge;
                const actualGround = pixels[y * 4] > 128;
                if (previous !== undefined && previous !== actualGround) transitions++;
                previous = actualGround;
                // Ignore the one-pixel silhouette footprint and offscreen sources.
                if (sourceV > 0 && sourceV < 1 && Math.abs(sourceV - ridge) > 1 / height) {
                    if (actualGround !== expectedGround) mismatches.push(y);
                    if (expectedGround && scenario !== "overlapping ridges" && Math.abs(pixels[y * 4 + 1] / 255 - sourceV) > 2 / 255) wrongColor.push(y);
                    if (!expectedGround) {
                        const outgoingV = (tangent + offset * maxDistance / distance * 2) / 0.05 + 0.5;
                        const skyV = outgoingV >= 0 && outgoingV <= 1 ? outgoingV : v;
                        if (Math.abs(pixels[y * 4 + 1] / 255 - skyV) > 2 / 255) wrongColor.push(y);
                    }
                }
            }
            const error = gl.getError();
            gl.getExtension("WEBGL_lose_context").loseContext();
            return {mismatches, wrongColor, transitions, error};
        }, {fragment, projection: camera.projectionMatrix.elements,
            inverseProjection: camera.projectionMatrixInverse.elements, scenario, manualFiltering});
        test.skip(result.noLinearFiltering, "Optional hardware float filtering is absent; manual path is tested separately");
        expect(result.error).toBe(0);
        expect(result.mismatches).toEqual([]);
        expect(result.wrongColor).toEqual([]);
        if (scenario === "mirage fold") expect(result.transitions).toBeGreaterThan(2);
        // Offscreen source pixels remain a documented limitation; the edge
        // case checks all recoverable in-frame samples above, not their fallback.
        else if (scenario !== "visible frame-edge ridge") expect(result.transitions).toBe(1);
    });
}
