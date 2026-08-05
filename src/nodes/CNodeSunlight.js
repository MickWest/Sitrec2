// CNodeSunlight.js - upates the global scene with the current sunlight
// based on the current date and time and the look camera
import {CNode} from "./CNode";
import {GlobalDateTimeNode, Globals, NodeMan} from "../Globals";
import {getCelestialDirection} from "../CelestialMath";
import {getEclipseState, isEclipseLightingEnabled, NO_ECLIPSE} from "../CEclipseCalc";
import {degrees} from "../utils";
import {altitudeHAE, getLocalUpVector} from "../SphericalMath";
import {Color, MathUtils, Vector3} from "three";

// apparent V magnitude of the Sun, the anchor for the Moonlight-mode
// illuminance ratio (moon mag -12.7 full -> ~20 stops below daylight)
const SUN_APPARENT_MAG = -26.74;

// will exist as a singleton node: "theSun"
export class CNodeSunlight extends CNode {
    constructor(v) {
        super(v);

        this.sunIntensity = 3.0;
        this.ambientIntensity = 1.2;
        this.sunBoost = 1;

        // temp value
        this.sunScattering = 0.1;

        this.darkeningAngle = 10.0;
    }

    // Eclipse circumstances used by the lighting. Returns the frozen
    // NO_ECLIPSE state (obscuration 0, all factors 1 — a hard no-op) unless
    // the Moon actually overlaps the Sun's disk and the effect is enabled.
    // getEclipseState memoizes on (time, position), so the several probes per
    // frame (sun, sky brightness, haze) share one real computation.
    calculateEclipseLightFactor(position, date) {
        if (!isEclipseLightingEnabled()) return NO_ECLIPSE;
        // "No Lighting in Main View" flattens the main view to pure ambient so
        // the geometry can be seen. An eclipse dimming that flat light is the
        // same thing the switch exists to defeat, so it is suppressed with it —
        // and suppressed HERE rather than at the three call sites, because the
        // direct sun, the sky brightness and the horizon glow all read the
        // eclipse through this one function.
        if (this.suppressEclipse) return NO_ECLIPSE;
        // Callers like calculateSkyBrightness(position) omit the date —
        // default it here or the eclipse silently no-ops for those paths.
        if (date === undefined) date = GlobalDateTimeNode.dateNow;
        return getEclipseState(position, date);
    }

    calculateSunAt(position, date) {
        if (date === undefined) {
            date = GlobalDateTimeNode.dateNow;
        }

        const result = {}

        const dir = getCelestialDirection("Sun", date, position);
        const sunPos = dir.clone().multiplyScalar(60000)
        result.sunPos = sunPos;

        // find the angle above or below the horizon
        const up = getLocalUpVector(position);

        const angle = 90-degrees(dir.angleTo(up));
        result.sunAngle = angle;

        let scale = brightnessOfSun(angle,this.darkeningAngle)

        // note, the intensity is in radians
        // so we multiply by PI (so 1.0 is full intensity)

        result.sunIntensity = this.sunIntensity * scale * Math.PI * this.sunBoost

        // scale the scattering ambient over 10 to -10 degrees
        let scaleScattering = this.sunScattering * brightnessOfSun(angle+this.darkeningAngle,this.darkeningAngle*2)

        if (this.ambientOnly) {
            result.ambientIntensity = (this.ambientIntensity) * Math.PI;
        } else {
            // ambient light is scattered light plus the fixed ambient light
            result.ambientIntensity = (this.sunIntensity * scaleScattering + this.ambientIntensity) * Math.PI;
        }

        // Solar eclipse: attenuate by the remaining photospheric flux. A hard
        // no-op whenever the Moon is not overlapping the Sun (obscuration 0).
        // Direct sunlight scales linearly with the limb-darkened flux; the
        // ambient (scattered skylight) falls more gently and is floored so
        // totality reads as deep twilight rather than a black scene.
        const eclipse = this.calculateEclipseLightFactor(position, date);
        if (eclipse.obscuration > 0) {
            result.sunIntensity *= eclipse.lightFraction;
            result.ambientIntensity *= Math.max(Math.pow(eclipse.lightFraction, 0.6), 0.05);
        }
        result.eclipseObscuration = eclipse.obscuration;

        // calculate the total light in the sky
        // just a ballpark for how visible the stars should be.
        result.sunTotal = result.sunIntensity + result.ambientIntensity;

        // infoDiv.innerHTML= `<br><br>Sun Intensity ${result.sunIntensity.toFixed(2)} Ambient: ${result.ambientIntensity.toFixed(2)}`
        // infoDiv.innerHTML+=`<br>SunTotal: ${result.sunTotal.toFixed(2)}`
        // infoDiv.innerHTML+=`<br>Angle: ${angle.toFixed(2)}`
        // infoDiv.innerHTML+=`<br>Sun Scattering: ${this.sunScattering.toFixed(2)}`
        // infoDiv.innerHTML+=`<br>Scale: ${scale.toFixed(2)}`
        // infoDiv.innerHTML+=`<br>ScaleScattering: ${scaleScattering.toFixed(2)}`
        // infoDiv.innerHTML  +=`<br>Darkening: ${this.darkeningAngle.toFixed(2)}`
        // infoDiv.innerHTML+=`<br>Position: ${position.x.toFixed(2)} ${position.y.toFixed(2)} ${position.z.toFixed(2)}`
        // infoDiv.innerHTML+=`<br>SunPos: ${sunPos.x.toFixed(2)} ${sunPos.y.toFixed(2)} ${sunPos.z.toFixed(2)}`
        // infoDiv.innerHTML+=`<br>Dir: ${dir.x.toFixed(2)} ${dir.y.toFixed(2)} ${dir.z.toFixed(2)}`
        // infoDiv.innerHTML+=`<br>Up: ${up.x.toFixed(2)} ${up.y.toFixed(2)} ${up.z.toFixed(2)}`


      //  console.log(result.sunTotal);


        return result;
    }


    // Sky brightness model for star visibility and sky overlay opacity.
    // Uses the full twilight range (0° to -18°) with a smoothstep curve
    // that matches observed twilight behavior: sky stays bright through
    // civil twilight (-6°), stars emerge mid-nautical (~-9°), and reach
    // full visibility at astronomical twilight end (-18°).
    calculateSkyBrightness(position, date) {
        if (!this.atmosphere) {
            return 0;
        }
        const sun = this.calculateSunAt(position, date)
        const skyDarkAngle = -18;  // astronomical twilight end
        const skyBrightAngle = 0;  // geometric sunset
        let skyBrightness = 0;
        if (sun.sunAngle < skyDarkAngle) {
            skyBrightness = 0; // night
        } else if (sun.sunAngle > skyBrightAngle) {
            skyBrightness = 1; // full daylight
        } else {
            // smoothstep — stays brighter longer during civil twilight,
            // then drops through nautical/astronomical twilight
            const t = (sun.sunAngle - skyDarkAngle) / (skyBrightAngle - skyDarkAngle);
            skyBrightness = t * t * (3 - 2 * t);
        }

        // Solar eclipse: dim the sky with the remaining photospheric flux.
        // No-op (factor 1) at obscuration 0.
        skyBrightness *= this.calculateEclipseSkyFactor(position, date);
        // infoDiv.innerHTML+=`<br>Sky Brightness: ${skyBrightness.toFixed(2)} (angle: ${sun.sunAngle.toFixed(2)})`
        // return the sky brightness



        // let oldBrightness = sun.sunIntensity / Math.PI;
        // infoDiv.innerHTML+=`<br>Old Sun Brightness: ${oldBrightness.toFixed(2)} (sunIntensity: ${sun.sunIntensity.toFixed(2)})`

        // attentuate by the square of the altitiude
        const alt = altitudeHAE(position);
        const atten = Math.pow(0.5, alt/100000);
        skyBrightness *= atten;
        // infoDiv.innerHTML+=`<br>Sun Total (attenuated): ${skyBrightness.toFixed(2)} (altitude: ${alt.toFixed(2)}) attenuation: ${atten.toFixed(2)}`
        return skyBrightness;
    }

    // Sky-brightness multiplier for the eclipse: the remaining photospheric
    // flux perceptually compressed, floored at deep-twilight brightness —
    // the totality sky keeps a residual glow from the corona and from sunlit
    // air outside the Moon's shadow. The 0.3 exponent makes the sky LAG the
    // direct light (skylight scatters in from a wide region, much of it
    // outside the umbra): stars shouldn't appear until the last minute, and
    // at 90% obscuration the sky is dimmer but still clearly daytime.
    // Exactly 1 outside an eclipse. Shared by calculateSkyBrightness and the
    // sky-gradient path (CNodeView3D.populateAtmosphereRayUniforms).
    calculateEclipseSkyFactor(position, date) {
        const eclipse = this.calculateEclipseLightFactor(position, date);
        if (eclipse.obscuration === 0) return 1;
        return Math.max(Math.pow(eclipse.lightFraction, 0.3), 0.22);
    }

    calculateSkyColor(position, date) {

        // the 0.75 is a factor to make the sky color more saturated by limiting max brightness
        const sunTotal = this.calculateSkyBrightness(position, date) * 0.75;

        const blue = new Vector3(0.53,0.81,0.92)
        blue.multiplyScalar(sunTotal)
        return new Color(blue.x, blue.y, blue.z)
    }

    calculateHazeColor(position, date, opts = {}, target = new Color()) {
        const sky = this.calculateSkyColor(position, date);
        const sunTotal = this.calculateSkyBrightness(position, date);
        const visKm = Math.max(0.001, opts.visibilityKm ?? 50);

        const t = MathUtils.clamp(
            (Math.log(visKm) - Math.log(5)) / (Math.log(100) - Math.log(5)),
            0,
            1
        );
        const desat = 0.95 - 0.65 * t;
        const lum = 0.70 * sunTotal + 0.15;

        target.setRGB(
            sky.r * (1 - desat) + lum * desat,
            sky.g * (1 - desat) + lum * desat,
            sky.b * (1 - desat) + lum * desat
        );
        return target;
    }

    calculateHazeColors(position, date, opts = {}, out = undefined) {
        if (out === undefined) {
            if (!this._hazeOut) {
                this._hazeOut = {
                    cool: new Color(),
                    warm: new Color(),
                    warmStrength: 0,
                };
            }
            out = this._hazeOut;
        }

        this.calculateHazeColor(position, date, opts, out.cool);

        const sunAngle = opts.sunAngle ?? Globals.sunAngle ?? 90;
        const sunTotal = this.calculateSkyBrightness(position, date);
        if (sunAngle < 12 && sunAngle > -8) {
            const w = MathUtils.clamp((12 - sunAngle) / 20, 0, 1);
            const floor = Math.max(sunTotal, 0.15);
            out.warm.setRGB(1.00 * floor, 0.69 * floor, 0.48 * floor);
            out.warmStrength = w;
        } else {
            out.warm.copy(out.cool);
            out.warmStrength = 0;
        }

        // Deep solar eclipse: the horizon glows warm ALL around — sunlit air
        // beyond the Moon's shadow, the classic 360° sunset of totality.
        // Ramps in only once the remaining flux drops to a few percent.
        const eclipse = this.calculateEclipseLightFactor(position, date);
        if (eclipse.obscuration > 0) {
            const deep = 1 - MathUtils.smoothstep(eclipse.lightFraction, 0.005, 0.05);
            if (deep > 0) {
                // Noticeably brighter than the eclipsed zenith sky so the
                // horizon ring reads as a glow, not just haze.
                const glow = Math.max(sunTotal, 0.28);
                out.warm.setRGB(1.0 * glow, 0.55 * glow, 0.32 * glow);
                out.warmStrength = Math.max(out.warmStrength, 0.55 * deep);
            }
        }
        return out;
    }

    // this is a simple function to calculate the opacity of the sky
    // i.e. how transparent the blu daylight sky should be to stars
    // most of the time it's 1.0 (daylight) or 0.0 (night)
    calculateSkyOpacity(position, date) {
        const skyBrightness = this.calculateSkyBrightness(position, date);
        const skyOpacity = Math.min(1.0, skyBrightness*2);
        // infoDiv.innerHTML+=`<br>Sky Brightness (for opacity): ${skyBrightness.toFixed(2)}`
        // infoDiv.innerHTML+=`<br>Sky Opacity: ${skyOpacity.toFixed(2)}`

        return skyOpacity;
    }

    update(f) {
        if (Globals.sunLight) {
            //
          //  try {
                const date = GlobalDateTimeNode.dateNow;

                let camera;
                if (NodeMan.exists("lookCamera")) {
                    camera = NodeMan.get("lookCamera").camera;
                } else if (NodeMan.exists("mainCamera")) {
                    camera = NodeMan.get("mainCamera").camera;
                } else {
                    // some of the tool sitches have no camera, so we just return
//                    showError("No camera found for sunlight")
                    return;
                }

                const sun = this.calculateSunAt(camera.position, date);

                // Moonlight mode (Long Exposure): light the scene with ONLY the
                // Moon — no ambient, the directional light re-aimed at the Moon
                // with its true phase-dependent brightness relative to the sun
                // (a full moon is ~14 magnitudes = ~400,000x dimmer). This has
                // to live HERE because every view render re-runs this update,
                // overwriting any external write to the global lights. The
                // intensity scales with this.sunIntensity, so the Long Exposure
                // HDR-background boost flows through linearly.
                if (this.moonlightMode) {
                    const moonDir = getCelestialDirection("Moon", date, camera.position);
                    const moonAngle = 90 - degrees(moonDir.angleTo(getLocalUpVector(camera.position)));
                    const moonMag = NodeMan.get("NightSkyNode", false)?.planets?.planetSprites?.Moon?.mag ?? -12.7;
                    const ratio = Math.pow(10, -0.4 * (moonMag - SUN_APPARENT_MAG));
                    sun.sunPos = moonDir.clone().multiplyScalar(60000);
                    sun.sunIntensity = this.sunIntensity * brightnessOfSun(moonAngle, this.darkeningAngle) * Math.PI * this.sunBoost * ratio;
                    sun.ambientIntensity = 0;
                    sun.sunTotal = sun.sunIntensity;
                }

                Globals.sunLight.position.copy(sun.sunPos)
                Globals.sunAngle = sun.sunAngle;
                Globals.sunLight.intensity = sun.sunIntensity;
                Globals.ambientLight.intensity = sun.ambientIntensity;
                Globals.sunTotal = sun.sunTotal


            // } catch (e) {
            //     showError("Sunlight error", e)
            //     debugger;
            // }
        }

        // V5 shadows: deferred-first-apply. CNodeLighting builds Globals.sunLight
        // at (0,7000,0) — we only get the real ~60000-unit position after the
        // first calculateSunAt call above. Trigger applyShadowConfig now so any
        // sitch with shadowsEnabled saved-on can wire up before the next render.
        const lighting = NodeMan.get("lighting", false);
        if (lighting && lighting._pendingFirstShadowConfig) {
            lighting._pendingFirstShadowConfig = false;
            lighting.applyShadowConfig({reason: "firstApply"});
        }

        // V5 shadows: per-frame throttled invalidation. Gated on
        // Globals.shadowsEnabled so this is a single boolean check when off.
        if (Globals.shadowsEnabled) {
            propagateSunAndThrottle(performance.now());
        }
    }

}

// V5 shadows: per-view throttled shadow invalidation. Walks all CNodeView3D
// instances whose effective shadows are on; flags shadow.needsUpdate=true at
// most once per minInterval ms, and only when sun direction has moved at least
// minAngleDeg. Per-view state ensures lookView and mainView throttles don't
// stamp on each other.
const _tmpSunDir = new Vector3();
function propagateSunAndThrottle(now) {
    const lighting = NodeMan.get("lighting", false);
    if (!lighting) return;
    const minInterval = lighting.shadowUpdateMinIntervalMs ?? 50;
    const minAngleDeg = lighting.shadowUpdateAngleThreshold ?? 0.25;

    NodeMan.iterate((id, node) => {
        if (node.constructor.name !== "CNodeView3D") return;
        if (typeof node.areShadowsEffective !== "function") return;
        if (!node.areShadowsEffective() || !node.viewSun) return;

        if (!node._lastShadowSunDir) {
            node._lastShadowSunDir = new Vector3();
            node._lastShadowUpdateMs = 0;
        }

        const dt = now - node._lastShadowUpdateMs;
        if (dt < minInterval && node._lastShadowUpdateMs !== 0) return;

        const curDir = _tmpSunDir.copy(Globals.sunLight.position).normalize();
        const firstUpdate = node._lastShadowUpdateMs === 0;
        const angleDeg = firstUpdate
            ? Infinity
            : (curDir.angleTo(node._lastShadowSunDir) * 180) / Math.PI;

        if (firstUpdate || angleDeg >= minAngleDeg) {
            node.viewSun.shadow.needsUpdate = true;
            node._lastShadowSunDir.copy(curDir);
            node._lastShadowUpdateMs = now;
        }
    });
}


// a simple model of the brightness of the sun
// as a function of the angle above the horizon
// and the angle at which the sun starts to drop off
// the drop region is the angle at which the sun starts to drop off
// the brightness is 1.0 at zenith, and 0.25 at the horizon
// the drop off is a cosine squared function
// whene the sun goes below the horizon, the brightness drops to 0 over 0.5 degrees (angular diameter of the sun)
// This is not perfect as it does not take into account atmospheric refraction or topology

function brightnessOfSun(angle,dropRegion) {
    const maxBrightness = 1.0;  // Maximum brightness at zenith
    const minBrightness = 0.25;  // Minimum brightness at horizon

    if (angle < 0) {
        if (angle < -0.5) {
            return 0;  // Sun is below the horizon, shadow over 0.5 degrees
        } else {
            return minBrightness * (0.5+angle)/0.5;  // Sun is below the horizon, shadow over 0.5 degrees
        }
    } else if (angle > 90) {
        return maxBrightness;  // Cap the brightness at zenith
    }

    if (angle > dropRegion) {
        return maxBrightness;
    } else {
        // Calculate the drop-off for angles below 10 degrees
        let theta = angle * (Math.PI / 180);
        let dropOffFactor = Math.cos(theta) * Math.pow((angle / dropRegion), 2);
        return minBrightness + (maxBrightness - minBrightness) * dropOffFactor;
    }
}
