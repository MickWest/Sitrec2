import {ColorManagement, Vector2, Vector4} from "three";
import {LineMaterial} from "three/addons/lines/LineMaterial.js";

const viewHeights = new WeakMap();
const viewport = new Vector4();
const rendererSize = new Vector2();

// Widths are display pixels, independent of DPR, render scale, or a fixed
// sensor canvas. Exporters supply their output dimensions through the view.
export function setLineViewHeight(renderer, height) {
    viewHeights.set(renderer, Math.max(1, height));
}

export class SceneLineMaterial extends LineMaterial {
    constructor(parameters = {}) {
        super({...parameters, transparent: true, depthWrite: false, alphaToCoverage: false});
        this.isSceneLineMaterial = true;
        this.uniforms.linePixelWidth = {value: this.linewidth};
        this.uniforms.lineViewportOrigin = {value: new Vector2()};
        this.uniforms.lineInputSRGB = {value: !ColorManagement.enabled};
        this.defaultAttributeValues.instanceLinePrevious = [0, 0, 0, 0];
        this.defaultAttributeValues.instanceLineNext = [0, 0, 0, 0];

        // Keep Three's endpoint transforms, near-plane trimming, depth, fog and
        // projection-patch anchors. Expand only the screen-space ribbon: the
        // extra pixels carry fractional coverage, including for widths < 1 px.
        this.vertexShader = this.vertexShader.replace("uniform float linewidth;", `
            uniform float linewidth;
            uniform float linePixelWidth;
            uniform vec2 lineViewportOrigin;
            varying vec2 vLinePixelStart;
            varying vec2 vLinePixelEnd;
            attribute vec4 instanceLinePrevious;
            attribute vec4 instanceLineNext;
            varying vec2 vLinePixelPrevious;
            varying vec2 vLinePixelNext;
            varying vec2 vLineJoins;
        `).replace("vec4 start = modelViewMatrix * vec4( instanceStart, 1.0 );", `
            vec4 linePrevious = modelViewMatrix * vec4( instanceLinePrevious.xyz, 1.0 );
            vec4 lineNext = modelViewMatrix * vec4( instanceLineNext.xyz, 1.0 );
            vec4 start = modelViewMatrix * vec4( instanceStart, 1.0 );
        `).replace("// direction", `
            vLinePixelStart = (ndcStart.xy * 0.5 + 0.5) * resolution + lineViewportOrigin;
            vLinePixelEnd = (ndcEnd.xy * 0.5 + 0.5) * resolution + lineViewportOrigin;
            vec4 lineClipPrevious = projectionMatrix * linePrevious;
            vec4 lineClipNext = projectionMatrix * lineNext;
            vLineJoins = vec2(instanceLinePrevious.w * step(1e-6, lineClipPrevious.w),
                              instanceLineNext.w * step(1e-6, lineClipNext.w));
            vLinePixelPrevious = vLinePixelStart;
            vLinePixelNext = vLinePixelEnd;
            if (vLineJoins.x > 0.5) vLinePixelPrevious = (lineClipPrevious.xy / lineClipPrevious.w * 0.5 + 0.5) * resolution + lineViewportOrigin;
            if (vLineJoins.y > 0.5) vLinePixelNext = (lineClipNext.xy / lineClipNext.w * 0.5 + 0.5) * resolution + lineViewportOrigin;
            // direction
        `).replace("dir = normalize( dir );", `
            float directionLength = length(dir);
            dir = directionLength > 1e-8 ? dir / directionLength : vec2(1.0, 0.0);
        `).replace("offset *= linewidth;", "offset *= linePixelWidth + 3.0;");

        const start = this.fragmentShader.indexOf("\t\t\t#ifdef USE_DASH", this.fragmentShader.indexOf("void main()"));
        const end = this.fragmentShader.indexOf("\t\t\t#include <logdepthbuf_fragment>", start);
        if (start < 0 || end < 0) throw new Error("Unsupported Three.js line shader: missing coverage anchors");
        const stockCoverage = this.fragmentShader.slice(start, end);
        this.fragmentShader = this.fragmentShader.slice(0, start) + `
            #ifdef WORLD_UNITS
                ${stockCoverage}
            #else
                // Distance to a screen-space capsule. Endpoints are constant
                // across each instance, so perspective interpolation cannot
                // stretch the fringe or turn round caps into ellipses.
                vec2 segment = vLinePixelEnd - vLinePixelStart;
                vec2 point = gl_FragCoord.xy - vLinePixelStart;
                float lineAlong = clamp(dot(point, segment) / max(dot(segment, segment), 1e-8), 0.0, 1.0);
                float distanceToLine = length(point - lineAlong * segment);
                bool ownsJoin = true;
                if (vLineJoins.x > 0.5) {
                    vec2 previousSegment = vLinePixelStart - vLinePixelPrevious;
                    float previousAlong = clamp(dot(gl_FragCoord.xy - vLinePixelPrevious, previousSegment)
                        / max(dot(previousSegment, previousSegment), 1e-8), 0.0, 1.0);
                    float previousDistance = length(gl_FragCoord.xy - vLinePixelPrevious - previousAlong * previousSegment);
                    ownsJoin = previousDistance > distanceToLine;
                }
                if (vLineJoins.y > 0.5) {
                    vec2 nextSegment = vLinePixelNext - vLinePixelEnd;
                    float nextAlong = clamp(dot(gl_FragCoord.xy - vLinePixelEnd, nextSegment)
                        / max(dot(nextSegment, nextSegment), 1e-8), 0.0, 1.0);
                    float nextDistance = length(gl_FragCoord.xy - vLinePixelEnd - nextAlong * nextSegment);
                    ownsJoin = ownsJoin && nextDistance >= distanceToLine;
                }
                float radius = max(linePixelWidth, 0.0) * 0.5;
                // Box-filter coverage also preserves the energy of subpixel
                // lines; a minimum-width clamp would make them too bright.
                float coverage = clamp(radius + 0.5 - distanceToLine, 0.0, 1.0)
                               - clamp(0.5 - radius - distanceToLine, 0.0, 1.0);
                #ifdef USE_DASH
                    float period = max(dashSize + gapSize, 1e-6);
                    float phase = mod(vLineDistance + dashOffset, period);
                    float dashDistance = abs(mod(phase - dashSize * 0.5 + period * 0.5, period) - period * 0.5);
                    float footprint = max(fwidth(vLineDistance), 1e-6);
                    float dashCoverage = clamp((dashSize * 0.5 + footprint * 0.5 - dashDistance) / footprint, 0.0, 1.0)
                                       - clamp((-dashSize * 0.5 + footprint * 0.5 - dashDistance) / footprint, 0.0, 1.0);
                    coverage *= gapSize > 0.0 ? dashCoverage : 1.0;
                #endif
                alpha *= ownsJoin ? coverage : 0.0;
                if (alpha <= 0.0) discard;
            #endif
        ` + this.fragmentShader.slice(end);
        this.fragmentShader = this.fragmentShader.replace("uniform float linewidth;", `
            uniform float linewidth;
            uniform float linePixelWidth;
            uniform bool lineInputSRGB;
            varying vec2 vLinePixelStart;
            varying vec2 vLinePixelEnd;
            varying vec2 vLinePixelPrevious;
            varying vec2 vLinePixelNext;
            varying vec2 vLineJoins;
        `).replace("gl_FragColor = vec4( diffuseColor.rgb, alpha );", `
            vec3 lineColor = diffuseColor.rgb;
            if (lineInputSRGB) lineColor = sRGBTransferEOTF(vec4(lineColor, 1.0)).rgb;
            gl_FragColor = vec4(lineColor, alpha);
        `);
    }

    onBeforeRender(renderer) {
        // Material callbacks run after LineSegments2's logical-viewport update.
        // Read the actual bound viewport, including offscreen/XR sub-viewports.
        renderer.getCurrentViewport(viewport);
        this.resolution.set(viewport.z, viewport.w);
        this.uniforms.lineViewportOrigin.value.set(viewport.x, viewport.y);
        // A headset has no CSS display box: use physical pixels per eye.
        const displayHeight = renderer.xr?.isPresenting ? viewport.w
            : viewHeights.get(renderer) ?? renderer.getSize(rendererSize).y;
        this.uniforms.linePixelWidth.value = this.linewidth * viewport.w / Math.max(1, displayHeight);
        this.uniforms.lineInputSRGB.value = !ColorManagement.enabled;
    }
}
