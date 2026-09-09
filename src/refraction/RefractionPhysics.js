// SI throughout: metres, radians, degrees Celsius, hPa, nanometres.
// Ciddor equations ported from Mick West's Metabunk refraction simulator,
// with local variables and explicit saturation pressure (the original shared globals).
// Reference: https://emtoolbox.nist.gov/Wavelength/Documentation.asp
export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

import {PROFILE_PRESETS, PROFILE_PRESET_DETAILS} from "./RefractionPresets";
export {PROFILE_PRESETS, PROFILE_PRESET_DETAILS} from "./RefractionPresets";

export function defaultLaser(index = 0) {
    return {name: `Laser ${index + 1}`, enabled: true, height: 1.524, angle: 0,
        distance: 10000, offset: 0, reverse: false, color: "#40ff70",
        wavelength: 532, diameter: 2, divergence: 1, power: 100};
}

const finite = (x, fallback, lo, hi) => Number.isFinite(Number(x)) ? clamp(Number(x), lo, hi) : fallback;
export function normalizeProfile(points, fallback, min, max) {
    if (!Array.isArray(points)) return fallback.map(p => [...p]);
    const sorted = points.filter(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))
        .slice(0, 128).map(([h, v]) => [clamp(h, -500, 20000), clamp(v, min, max)])
        .sort((a, b) => a[0] - b[0]);
    const unique = sorted.filter((p, i) => i === 0 || p[0] - sorted[i - 1][0] > 0.001);
    return unique.length >= 2 ? unique : fallback.map(p => [...p]);
}

export function normalizeSettings(input = {}) {
    const s = {
        enabled: !!input.enabled, view: typeof input.view === "string" ? input.view : "lookView",
        useStandard: input.useStandard ?? true, bend: input.bend ?? true, flat: !!input.flat,
        temperature: finite(input.temperature, 15, -40, 60), lapseRate: finite(input.lapseRate, -6.5, -100, 100),
        pressure: finite(input.pressure, 1013.25, 0, 1200), humidity: finite(input.humidity, 50, 0, 100),
        co2: finite(input.co2, 450, 0, 2000), wavelength: finite(input.wavelength, 550, 300, 1700),
        humidityProfile: !!input.humidityProfile,
        temperaturePoints: normalizeProfile(input.temperaturePoints, PROFILE_PRESETS.Standard, -40, 100),
        humidityPoints: normalizeProfile(input.humidityPoints, [[0, 66], [3, 58], [10, 50], [100, 50]], 0, 100),
        maxDistance: finite(input.maxDistance, 50000, 100, 300000),
        step: finite(input.step, 40, 2, 1000), distanceSamples: Math.round(finite(input.distanceSamples, 512, 64, 2048)),
        resolution: finite(input.resolution, 1, 0.25, 2),
        visibilityEnabled: !!input.visibilityEnabled, visibility: finite(input.visibility, 50, 0.1, 500),
        night: !!input.night, showGradient: input.showGradient ?? true,
        showRays: input.showRays ?? true, raySpacing: Math.round(finite(input.raySpacing, 40, 1, 500)),
        showEyeLevel: !!input.showEyeLevel, showHorizon: !!input.showHorizon,
        showIndex: !!input.showIndex, sideZoom: finite(input.sideZoom, 1, 0.1, 1000),
        lasersEnabled: !!input.lasersEnabled,
        lasers: (Array.isArray(input.lasers) ? input.lasers : [defaultLaser()]).slice(0, 8).map((l, i) => ({
            ...defaultLaser(i), name: String(l.name ?? `Laser ${i + 1}`).slice(0, 80), enabled: l.enabled !== false,
            height: finite(l.height, 1.524, -500, 20000), angle: finite(l.angle, 0, -30, 30),
            distance: finite(l.distance, 10000, 1, 300000), offset: finite(l.offset, 0, -10000, 10000),
            reverse: !!l.reverse, color: /^#[\da-f]{6}$/i.test(l.color) ? l.color : "#40ff70",
            wavelength: finite(l.wavelength, 532, 300, 1700), diameter: finite(l.diameter, 2, 0.1, 1000),
            divergence: finite(l.divergence, 1, 0, 100), power: finite(l.power, 100, 0, 100000),
        })),
    };
    s.temperatureCurve = normalizeCurve(input.temperatureCurve, s.temperaturePoints, -40, 100);
    s.humidityCurve = normalizeCurve(input.humidityCurve, s.humidityPoints, 0, 100);
    return s;
}

// Sitrec's MetaBezierCurve layout: anchor, handle, anchor, handle. An
// intermediate anchor's outgoing handle is the reflection of its stored handle.
export function anchorsToCurve(points) {
    return points.flatMap(([h, v], i) => {
        const other = points[i === 0 ? 1 : i - 1];
        return [h, v, h + (other[0] - h) / 3, v + (other[1] - v) / 3];
    });
}

export function applyProfilePreset(settings, name) {
    const points = PROFILE_PRESETS[name];
    if (!points) throw new Error(`Unknown temperature preset: ${name}`);
    settings.useStandard = name === "Standard";
    settings.temperature = points[0][1];
    settings.lapseRate = PROFILE_PRESET_DETAILS[name].lapseRate ?? -6.5;
    settings.temperaturePoints = points.map(point => [...point]);
    // Sharp layers can have very uneven anchor spacing. Constrain handles
    // before either the editor or worker sees them, so height stays monotonic.
    settings.temperatureCurve = normalizeCurve(anchorsToCurve(points), points, -40, 100);
    return settings;
}

export function normalizeCurve(curve, fallback, minValue, maxValue) {
    if (!Array.isArray(curve) || curve.length < 8 || curve.length % 4 || !curve.every(Number.isFinite)) return anchorsToCurve(fallback);
    const pairs = [];
    for (let i = 0; i < Math.min(curve.length, 512); i += 4) {
        pairs.push([clamp(curve[i], 0, 20000), clamp(curve[i + 1], minValue, maxValue),
            clamp(curve[i + 2], 0, 20000), clamp(curve[i + 3], minValue, maxValue)]);
    }
    pairs.sort((a, b) => a[0] - b[0]);
    if (pairs.some((p, i) => i && p[0] - pairs[i - 1][0] < 0.001)) return anchorsToCurve(fallback);
    // Monotonic height is essential: T(h) must be single-valued even in an inversion.
    pairs.forEach((p, i) => {
        if (i === 0) p[2] = clamp(p[2], p[0], pairs[1][0]);
        else {
            const next = i + 1 < pairs.length ? pairs[i + 1][0] - p[0] : Infinity;
            p[2] = clamp(p[2], p[0] - Math.min(p[0] - pairs[i - 1][0], next), p[0]);
        }
    });
    return pairs.flat();
}

export function curveSampler(curve, upperSlope = 0) {
    const cubic = (a, b, c, d, t) => a * (1 - t) ** 3 + 3 * b * t * (1 - t) ** 2 + 3 * c * t * t * (1 - t) + d * t ** 3;
    return h => {
        const last = curve.length - 4;
        if (h <= curve[0]) return curve[1];
        if (h >= curve[last]) return curve[last + 1] + (h - curve[last]) * upperSlope;
        let k = 0;
        while (curve[k + 4] < h) k += 4;
        const hx = k ? 2 * curve[k] - curve[k + 2] : curve[k + 2];
        const hy = k ? 2 * curve[k + 1] - curve[k + 3] : curve[k + 3];
        let lo = 0, hi = 1;
        for (let i = 0; i < 28; i++) {
            const t = (lo + hi) / 2;
            if (cubic(curve[k], hx, curve[k + 6], curve[k + 4], t) < h) lo = t; else hi = t;
        }
        return cubic(curve[k + 1], hy, curve[k + 7], curve[k + 5], (lo + hi) / 2);
    };
}

export function saturationPressure(t) {
    const T = t + 273.15;
    if (t < 0) {
        const theta = T / 273.16;
        return 611.657 * Math.exp(-13.928169 * (1 - theta ** -1.5) + 34.7078238 * (1 - theta ** -1.25));
    }
    const omega = T - 0.238555575678 / (T - 650.175348448);
    const a = omega ** 2 + 1167.05214528 * omega - 724213.167032;
    const b = -17.0738469401 * omega ** 2 + 12020.8247025 * omega - 3232555.03223;
    const c = 14.9151086135 * omega ** 2 - 4823.26573616 * omega + 405113.405421;
    return 1e6 * (2 * c / (-b + Math.sqrt(b * b - 4 * a * c))) ** 4;
}

export function airIndex(wavelength, t, pressureHPa, rh, co2 = 450) {
    if (pressureHPa <= 0) return 1;
    const p = pressureHPa * 100, T = t + 273.15, S = 1e6 / wavelength ** 2;
    const xv = clamp(rh / 100 * (1.00062 + 3.14e-8 * p + 5.60e-7 * t * t) * saturationPressure(t) / p, 0, 1);
    const ras = 1e-8 * (5792105 / (238.0185 - S) + 167917 / (57.362 - S));
    const rvs = 1.022e-8 * (295.235 + 2.6422 * S - 0.03238 * S * S + 0.004028 * S ** 3);
    const ma = 0.0289635 + 1.2011e-8 * (co2 - 400);
    const z = 1 - p / T * (1.58123e-6 - 2.9331e-8 * t + 1.1043e-10 * t * t
        + (5.707e-6 - 2.051e-8 * t) * xv + (1.9898e-4 - 2.376e-6 * t) * xv * xv)
        + (p / T) ** 2 * (1.83e-11 - 0.765e-8 * xv * xv);
    const referenceDensity = 101325 * ma / (0.9995922115 * 8.314472 * 288.15);
    return 1 + ((1 - xv) * p * ma / (z * 8.314472 * T) / referenceDensity)
        * ras * (1 + 5.34e-7 * (co2 - 450))
        + (xv * p * 0.018015 / (z * 8.314472 * T) / 0.00985938) * rvs;
}

export function atmosphere(settings, wavelength = settings.wavelength) {
    const tempCurve = curveSampler(settings.temperatureCurve, settings.lapseRate / 1000);
    const rhCurve = curveSampler(settings.humidityCurve);
    const temperature = h => clamp(settings.useStandard ? settings.temperature + settings.lapseRate * h / 1000 : tempCurve(h), -80, 100);
    const humidity = h => clamp(settings.humidityProfile ? rhCurve(h) : settings.humidity, 0, 100);
    const index = h => {
        if (!settings.bend) return 1;
        // Same standard pressure-altitude law as the original, extended smoothly
        // above the troposphere. Temperature profiles are height above sea level.
        const h0 = Math.min(h, 11000);
        let p = settings.pressure * Math.max(0.001, 1 - 2.25577e-5 * h0) ** 5.25588;
        if (h > 11000) p *= Math.exp(-(h - 11000) / 6341.6);
        return airIndex(wavelength, temperature(h), p, humidity(h), settings.co2);
    };
    // Cache n and d(log n)/dh on a nonuniform grid. Fine near thin surface
    // layers, coarser aloft; no Ciddor evaluations inside the ray integration loop.
    const count = 16384, scale = Math.log1p(120000 / 0.1), indices = new Float64Array(count);
    for (let i = 0; i < count; i++) indices[i] = index(0.1 * Math.expm1(i / (count - 1) * scale));
    const sample = h => {
        const u = clamp(Math.log1p(Math.max(0, h) / 0.1) / scale * (count - 1), 0, count - 1.000001);
        const i = Math.floor(u);
        return indices[i] + (indices[i + 1] - indices[i]) * (u - i);
    };
    const gradient = h => (sample(h + 0.02) - sample(Math.max(0, h - 0.02)))
        / (h < 0.02 ? h + 0.02 : 0.04) / sample(h);
    return {temperature, humidity, index, sample, gradient};
}

export function groundY(x, radius) {
    if (!Number.isFinite(radius)) return 0;
    return -x * x / (radius + Math.sqrt(Math.max(0, radius * radius - x * x)));
}

// Integrate y(x), slope dy/dx in the observer's vertical plane. The atmosphere
// is spherical: its gradient rotates with local vertical along the path.
// RK4 with an extra vertical-step limit resolves thin inversion layers.
export function traceRay({height, angle, distances, radius, medium, step = 40, origin = 0, reverse = false}) {
    let x = origin, y = groundY(origin, radius) + height, slope = Math.tan(angle);
    const direction = reverse ? -1 : 1;
    if (reverse) slope = -slope;
    const values = new Float64Array(distances.length * 3);
    let hit = false;
    const acceleration = (xx, yy, m) => {
        const r = Number.isFinite(radius) ? Math.hypot(xx, radius + yy) : 1;
        const h = Number.isFinite(radius) ? (xx * xx + yy * (2 * radius + yy)) / (r + radius) : yy;
        const gx = Number.isFinite(radius) ? xx / r : 0;
        const gy = Number.isFinite(radius) ? (radius + yy) / r : 1;
        return (1 + m * m) * medium.gradient(Math.max(0, h)) * (gy - m * gx);
    };
    for (let i = 0; i < distances.length; i++) {
        const goal = origin + direction * distances[i];
        while (!hit && direction * (goal - x) > 1e-7) {
            const oldX = x, oldY = y;
            const localSlope = slope + (Number.isFinite(radius) ? x / radius : 0);
            const h = Math.max(0, y - groundY(x, radius));
            const verticalLimit = Math.max(0.03, h * 0.03);
            const dx = direction * Math.min(step, Math.abs(goal - x), verticalLimit / Math.max(0.001, Math.abs(localSlope)));
            const a = acceleration(x, y, slope);
            const mb = slope + dx * a / 2, b = acceleration(x + dx / 2, y + dx * slope / 2, mb);
            const mc = slope + dx * b / 2, c = acceleration(x + dx / 2, y + dx * mb / 2, mc);
            const md = slope + dx * c, d = acceleration(x + dx, y + dx * mc, md);
            y += dx / 6 * (slope + 2 * mb + 2 * mc + md);
            slope += dx / 6 * (a + 2 * b + 2 * c + d);
            x += dx;
            hit = y < groundY(x, radius) || !Number.isFinite(y) || Math.abs(slope) > 1000;
            if (hit && Number.isFinite(y)) {
                let lo = 0, hi = 1;
                for (let j = 0; j < 24; j++) {
                    const t = (lo + hi) / 2;
                    const xx = oldX + (x - oldX) * t, yy = oldY + (y - oldY) * t;
                    if (yy > groundY(xx, radius)) lo = t; else hi = t;
                }
                x = oldX + (x - oldX) * (lo + hi) / 2;
                y = groundY(x, radius);
                values.hitDistance = Math.abs(x - origin);
            }
        }
        values[i * 3] = y;
        values[i * 3 + 1] = slope;
        values[i * 3 + 2] = hit ? 0 : 1;
    }
    return values;
}

export function buildRayTable({settings: input, height, radius, minAngle, maxAngle, rows}) {
    const settings = normalizeSettings(input), medium = atmosphere(settings);
    const width = settings.distanceSamples;
    const distances = new Float64Array(width);
    // Quadratic spacing puts precision near the observer without wasting columns.
    for (let i = 0; i < width; i++) distances[i] = settings.maxDistance * (i / (width - 1)) ** 2;
    const data = new Float32Array(width * rows * 4);
    const earth = settings.flat ? Infinity : radius;
    // Summarize the traced fan while its samples are already hot in the worker.
    // Retain double precision between rows: rounded heights can invent folds.
    const previousHeights = new Float64Array(width), previousAlive = new Uint8Array(width);
    const foldTolerance = Math.max(1e-10, (maxAngle - minAngle) / (rows - 1) * 0.001);
    let groundHits = 0, reachedSamples = 0, testedPairs = 0, foldedPairs = 0;
    for (let row = 0; row < rows; row++) {
        const angle = minAngle + (maxAngle - minAngle) * row / (rows - 1);
        const ray = traceRay({height, angle, distances, radius: earth, medium, step: settings.step});
        if (ray.hitDistance !== undefined) groundHits++;
        for (let i = 0; i < width; i++) {
            const k = 4 * (row * width + i), d = distances[i];
            data[k] = d > 0 ? (ray[i * 3] - height) / d - Math.tan(angle) : 0;
            data[k + 1] = ray[i * 3 + 1] - Math.tan(angle);
            data[k + 2] = ray.hitDistance ?? settings.maxDistance;
            data[k + 3] = ray[i * 3];
            const alive = ray[i * 3 + 2] > 0;
            if (i > 0 && alive) {
                reachedSamples++;
                if (row > 0 && previousAlive[i]) {
                    testedPairs++;
                    // Endpoint order reverses when two adjacent launch rays fold.
                    // This describes the fan, not visibility of a scene surface.
                    if ((ray[i * 3] - previousHeights[i]) / d < -foldTolerance) foldedPairs++;
                }
            }
            previousHeights[i] = ray[i * 3]; previousAlive[i] = alive ? 1 : 0;
        }
    }
    const lasers = settings.lasersEnabled ? settings.lasers.filter(l => l.enabled).map(l => {
        const count = 257, samples = Float64Array.from({length: count}, (_, i) => l.distance * i / (count - 1));
        const origin = l.reverse ? l.distance : 0;
        const angle = l.angle * Math.PI / 180 + (l.reverse && Number.isFinite(earth) ? origin / earth : 0);
        const laserMedium = atmosphere(settings, l.wavelength);
        const args = {height: l.height, distances: samples, radius: earth, medium: laserMedium, step: settings.step, origin, reverse: l.reverse};
        const center = traceRay({...args, angle});
        const upper = traceRay({...args, height: l.height + l.diameter / 2000, angle: angle + l.divergence / 2000});
        const lower = traceRay({...args, height: l.height - l.diameter / 2000, angle: angle - l.divergence / 2000});
        return {laser: l, center, upper, lower, distances: samples};
    }) : [];
    const referenceRadius = Number.isFinite(radius) && radius > 0 ? radius : 6371000;
    const diagnostics = {groundHits, totalRays: rows, reachedSamples, totalSamples: rows * (width - 1),
        testedPairs, foldedPairs,
        // k is expressed relative to the local Earth radius even in flat mode.
        kAt1m: -referenceRadius * medium.gradient(1), kAt50m: -referenceRadius * medium.gradient(50),
        kAtObserver: -referenceRadius * medium.gradient(height)};
    return {width, rows, data, distances, lasers, height, radius: earth, minAngle, maxAngle, diagnostics};
}
