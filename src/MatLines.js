// Factory for line materials, which need to be updated on resize.
import {LineMaterial} from "three/addons/lines/LineMaterial.js";
import {Color} from "three";
import {getEffectiveMSAASamples, getEffectiveRenderScale} from "./Globals";

// Defensive accessors — under jest's node-smoke test, the Globals module
// is stubbed with a Proxy whose values may be non-numeric or throw when
// called. Wrap in try/catch and validate the result is a finite number;
// fall back to safe defaults (MSAA=4, renderScale=1) so CHelper's
// module-init-time makeMatLine() calls don't break the smoke test.
const safeMSAA = () => {
    try {
        const v = getEffectiveMSAASamples();
        return (typeof v === 'number' && isFinite(v)) ? v : 4;
    } catch (e) {
        return 4;
    }
};
const safeRenderScale = () => {
    try {
        const v = getEffectiveRenderScale();
        return (typeof v === 'number' && isFinite(v)) ? v : 1;
    } catch (e) {
        return 1;
    }
};

// LineMaterial is a ShaderMaterial — Three.js does not apply color management
// to its uniforms. Since the copy-to-screen shader applies sRGB encoding, we
// must pre-linearize colors so the round-trip (linearize here + encode in copy
// shader) produces the original intended sRGB color on screen.
function linearizeColor(srgb) {
    const c = srgb.clone();
    c.convertSRGBToLinear();
    return c;
}

// LineMaterial's alphaToCoverage path emits a smoothstep alpha which the GPU
// then quantizes into MSAA-sample-mask coverage. For a sub-pixel-wide line to
// render solidly, the quantization needs enough levels — empirically MSAA=4
// (5 levels including 0) is smooth, MSAA=2 (3 levels) shows periodic gaps,
// and MSAA=0 collapses to a hard α<0.5 discard. So when MSAA<4 we clamp the
// line to at least 1 fb-pixel; the rasterized triangle is then always ≥1 px
// wide and its center always passes the discard threshold. Quality preset
// (MSAA=4) keeps the originally-requested sub-pixel widths.
function getEffectiveLinewidth(linewidth) {
    return safeMSAA() >= 4 ? linewidth : Math.max(1, linewidth);
}

const matLines = {} // collection of line materials that need updating on resize
// we make one entry per unique material
function makeMatLine(color, linewidth = 2, dashed = false) {
    if(typeof window === 'undefined')
        return null;

    // if it's not a color object, then make it one
    if (!color.isColor) {
        color = new Color(color);
    }

    // we need a unique ID for the material
    // so we can update the resolution
    // we use the color, linewidth, and dashed as the key
    // first we make a string of the values
    // color is THREE.Color, convert it to a hex string
    const hex = color.getHexString()
    const key = hex + String(linewidth) + String(dashed)
    if (!matLines[key]) {
//        console.warn("LEAK?: Creating new line material for key: ", key)
        const lineMaterial = new LineMaterial({
            color: linearizeColor(color),
            linewidth: getEffectiveLinewidth(linewidth),
            dashed: dashed,
            // alphaToCoverage activates the smoothstep analytic-AA branch in
            // LineMaterial's fragment shader, which is what fills sub-pixel
            // coverage when the rasterized triangle is < 1 fb pixel wide
            // (the gap source at low renderScale). Requires MSAA>0 to actually
            // produce sub-pixel coverage; we toggle it dynamically based on
            // current settings so it's a no-op when MSAA is off.
            alphaToCoverage: safeMSAA() > 0,
        })
        // Stash the requested width so refreshMatLineAlphaToCoverage can
        // restore it (or re-clamp it) when MSAA toggles at runtime.
        lineMaterial.userData.originalLinewidth = linewidth;
        const rs = safeRenderScale();
        const dpr = (window.devicePixelRatio || 1) * rs;
        lineMaterial.resolution.set(window.innerWidth * dpr, window.innerHeight * dpr)
        matLines[key] = lineMaterial
        matLines[key].usageCount = 0;
    }
    matLines[key].usageCount++;
    return matLines[key]
}

// dispose of it if it's no longer needed
// note that we need to keep track of the usage count
// as identical materials can be used in multiple places
// and we don't want to dispose of them until they're no longer needed
export function disposeMatLine(matLine) {
    if(typeof window === 'undefined')
        return null;

    Object.keys(matLines).forEach(key => {
        if (matLines[key] === matLine) {
            matLines[key].usageCount--;
            if (matLines[key].usageCount <= 0) {
//                console.warn("LEAK?: Disposing line material for key: ", key)
                matLines[key].dispose()
                delete matLines[key]
            }
        }
    })
}

function updateMatLineResolution(windowWidth, windowHeight) {
    Object.keys(matLines).forEach(key => matLines[key].resolution.set(windowWidth, windowHeight))
}

// Push the current MSAA-derived alphaToCoverage flag into every pooled line
// material. Called from CCustomManager.applyRenderPerformanceSettings() when
// the user changes MSAA — without this, the materials' shader define stays
// stale and lines that were created with MSAA=0 (alphaToCoverage off) keep
// dropping sub-pixel fragments after the user enables MSAA.
function refreshMatLineAlphaToCoverage() {
    const enabled = safeMSAA() > 0;
    Object.keys(matLines).forEach(key => {
        const m = matLines[key];
        if (m.alphaToCoverage !== enabled) {
            m.alphaToCoverage = enabled;
            m.needsUpdate = true;
        }
        // Re-clamp linewidth too. getEffectiveLinewidth bumps sub-pixel
        // requested widths to ≥ 1 fb-pixel whenever MSAA<4 — at fewer samples
        // alphaToCoverage's sample-mask quantization is too coarse to fade
        // a sub-pixel line smoothly and visible periodic gaps appear.
        // linewidth is a plain uniform so no recompile.
        const want = getEffectiveLinewidth(m.userData.originalLinewidth);
        if (m.linewidth !== want) {
            m.linewidth = want;
        }
    });
}

export {updateMatLineResolution, refreshMatLineAlphaToCoverage};
export {makeMatLine};