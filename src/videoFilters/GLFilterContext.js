// Minimal WebGL2 full-screen-pass framework for the video export filters.
//
// Deliberately standalone rather than built on three.js: the export filter runs on a
// plain 2D canvas handed to it by the exporter, has no scene, no camera and no render
// loop, and lives in a lazily-loaded chunk. A ~200 line pass runner is less machinery
// than an EffectComposer plus a scene, and it keeps the chunk free of three.js.

const VERTEX_SHADER = `#version 300 es
in vec2 aPos;
out vec2 vUV;
void main() {
    vUV = aPos * 0.5 + 0.5;
    gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// A render target: a texture plus the framebuffer that draws into it.
export class GLTarget {
    constructor(gl, width, height) {
        this.gl = gl;
        this.width = width;
        this.height = height;

        this.texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        this.framebuffer = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        // An incomplete framebuffer does not raise anything; it just renders nothing, so
        // the export would silently come out black. Fail here instead, where the caller
        // can fall back to encoding the frames unfiltered.
        if (status !== gl.FRAMEBUFFER_COMPLETE) {
            this.dispose();
            throw new Error(`Video filter render target is not usable (framebuffer status 0x${status.toString(16)})`);
        }
    }

    dispose() {
        const gl = this.gl;
        if (this.texture) gl.deleteTexture(this.texture);
        if (this.framebuffer) gl.deleteFramebuffer(this.framebuffer);
        this.texture = null;
        this.framebuffer = null;
    }
}

export class GLFilterContext {
    // Half-float targets keep headroom above 1.0, which the bloom and blown-highlight
    // passes need — an 8-bit chain clips the very thing the exposure sim is modelling.
    constructor(width, height) {
        this.canvas = document.createElement('canvas');
        this.canvas.width = width;
        this.canvas.height = height;

        this.gl = this.canvas.getContext('webgl2', {
            alpha: false,
            depth: false,
            stencil: false,
            antialias: false,
            // The encoder reads the canvas back through VideoFrame after the draw
            // returns, by which time an unpreserved drawing buffer may be gone.
            preserveDrawingBuffer: true,
            premultipliedAlpha: false,
        });
        if (!this.gl) throw new Error("WebGL2 is not available for the video export filter");

        const gl = this.gl;
        // Half-float render targets are not optional here. The composite signal and the
        // demodulated colour difference values are routinely negative, and the bloom
        // stage works above 1.0; an 8-bit target clamps both, which does not degrade the
        // picture so much as destroy it. Either extension makes RGBA16F renderable.
        gl.getExtension('EXT_color_buffer_float');
        gl.getExtension('EXT_color_buffer_half_float');

        this.quad = gl.createVertexArray();
        gl.bindVertexArray(this.quad);
        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);
        this.quadBuffer = buffer;

        this.programs = new Map();
        this.targets = [];

        // The single texture every source canvas is uploaded into.
        this.sourceTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    }

    // Compile once per fragment source and cache; the chain reuses the same handful
    // of programs for every frame of an export.
    program(name, fragmentSource) {
        let program = this.programs.get(name);
        if (program) return program;

        const gl = this.gl;
        const compile = (type, source) => {
            const shader = gl.createShader(type);
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                const log = gl.getShaderInfoLog(shader);
                gl.deleteShader(shader);
                throw new Error(`Video filter shader "${name}" failed to compile: ${log}`);
            }
            return shader;
        };

        const vs = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
        const fs = compile(gl.FRAGMENT_SHADER, fragmentSource);
        program = gl.createProgram();
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.bindAttribLocation(program, 0, 'aPos');
        gl.linkProgram(program);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            const log = gl.getProgramInfoLog(program);
            gl.deleteProgram(program);
            throw new Error(`Video filter shader "${name}" failed to link: ${log}`);
        }

        program.uniformLocations = new Map();
        this.programs.set(name, program);
        return program;
    }

    createTarget(width, height) {
        const target = new GLTarget(this.gl, width, height);
        this.targets.push(target);
        return target;
    }

    // Upload the exporter's composite canvas (or any ImageBitmap source) as the chain input.
    uploadSource(canvasOrImage) {
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvasOrImage);
        return this.sourceTexture;
    }

    uniformLocation(program, name) {
        let location = program.uniformLocations.get(name);
        if (location === undefined) {
            location = this.gl.getUniformLocation(program, name);
            program.uniformLocations.set(name, location);
        }
        return location;
    }

    // Draw one full-screen pass. `uniforms` values are plain numbers, small arrays,
    // booleans, or {texture} objects, which are bound to successive texture units.
    // `target` null means draw to the canvas itself.
    run(program, uniforms, target = null) {
        const gl = this.gl;
        const width = target ? target.width : this.canvas.width;
        const height = target ? target.height : this.canvas.height;

        gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.framebuffer : null);
        gl.viewport(0, 0, width, height);
        gl.useProgram(program);

        let textureUnit = 0;
        for (const [name, value] of Object.entries(uniforms)) {
            const location = this.uniformLocation(program, name);
            if (location === null) continue;
            if (value && value.texture !== undefined) {
                gl.activeTexture(gl.TEXTURE0 + textureUnit);
                gl.bindTexture(gl.TEXTURE_2D, value.texture);
                gl.uniform1i(location, textureUnit);
                textureUnit++;
            } else if (typeof value === 'number') {
                gl.uniform1f(location, value);
            } else if (typeof value === 'boolean') {
                gl.uniform1f(location, value ? 1 : 0);
            } else if (Array.isArray(value)) {
                if (value.length === 2) gl.uniform2f(location, value[0], value[1]);
                else if (value.length === 3) gl.uniform3f(location, value[0], value[1], value[2]);
                else if (value.length === 4) gl.uniform4f(location, value[0], value[1], value[2], value[3]);
            }
        }

        gl.bindVertexArray(this.quad);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindVertexArray(null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    dispose() {
        const gl = this.gl;
        for (const target of this.targets) target.dispose();
        this.targets.length = 0;
        for (const program of this.programs.values()) gl.deleteProgram(program);
        this.programs.clear();
        if (this.sourceTexture) gl.deleteTexture(this.sourceTexture);
        if (this.quadBuffer) gl.deleteBuffer(this.quadBuffer);
        if (this.quad) gl.deleteVertexArray(this.quad);
        this.sourceTexture = null;
        this.quadBuffer = null;
        this.quad = null;
        // Free the GPU context now rather than waiting for GC — an export can create
        // and destroy one of these per run, and contexts are a scarce resource.
        const lose = gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
        this.gl = null;
    }
}
