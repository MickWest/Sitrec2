/**
 * stepRunner.mjs — the SINGLE step interpreter + canonical value normalizer for the
 * Scenario Harness (see SCENARIO-HARNESS-PLAN.md).
 *
 * Driver-agnostic: executeSteps() talks to an injected `driver` (a thin wrapper the
 * caller builds — for the headless harness it's backed by a Playwright `page`; the
 * MCP bridge can back it with sitrec_eval/sitrec_api_call). Both paths funnel reads
 * through the SAME projection + normalizer here, so an MCP-authored scenario produces
 * byte-identical JSON when run headless.
 *
 * Hard rules baked in (from the adversarial review of the plan):
 *  - Every read projects to a PLAIN object in-page (no raw Three.Vector3 crosses the
 *    boundary) so the MCP safeSerialize path and the page.evaluate path agree (C7).
 *  - window.sitrecAPI.call() is ASYNC; the read wrapper awaits it (C10).
 *  - Tolerance compares with abs(actual - baseline) <= tol (NOT round-and-equal), so a
 *    value sitting on a rounding boundary can't flip the result; the STORED baseline is
 *    rounded only for a clean committable diff (C11).
 *  - Mutation is decided by an explicit MUTATING_FNS denylist, never by the app's
 *    `transientCalls` set (which means "doesn't change SERIALIZED state" and includes
 *    mutating drives).
 */

// ---------------------------------------------------------------------------
// Tolerance model
// ---------------------------------------------------------------------------
// Each tier is an ABSOLUTE tolerance. ECEF magnitudes (~6.4e6 m) make a ratio
// tolerance meaningless, so everything is absolute. `decimals` is used only to round
// the STORED baseline for a clean git diff; the PASS test is abs-diff <= abs.
export const TOLERANCE_TIERS = {
    vector: {abs: 1e-6, decimals: 6}, // unit direction components heading/up/right/toSun…
    lla:    {abs: 1e-6, decimals: 6}, // lat/lon and other degree quantities (az/el)
    ecef:   {abs: 1e-3, decimals: 3}, // metres: position{x,y,z}, altitude
    scalar: {abs: 1e-4, decimals: 4}, // vFOV / fov / knots / generic angles
    count:  {abs: 0,    decimals: 0}, // integers — EXACT
};

// Fields stripped from every captured value before store/compare — they are volatile
// by construction and would make a committed baseline churn every run.
export const VOLATILE_KEYS = new Set([
    'exportVersion', 'exportTag', 'exportTagNumber', // CustomManagerSerialize.js:588-590
    'sitchName',                                      // datetime-stamped on export
    'elapsedMs', 'currentTimeString', 'realTime',
]);

// Keys we may sort an array-of-objects by, to kill insertion-order nondeterminism
// (e.g. tracks created in async order). First match wins.
const STABLE_SORT_KEYS = ['trackID', 'nodeID', 'id', 'shortName', 'name', 'norad'];

const lastSeg = (path) => {
    const parts = path.split('.');
    // skip trailing array indices like "0"/"1" to find the meaningful name
    for (let i = parts.length - 1; i >= 0; i--) {
        if (!/^\d+$/.test(parts[i])) return parts[i];
    }
    return parts[parts.length - 1] || '';
};

// Infer a tolerance tier from a capture's key path. Heuristic, and DELIBERATELY
// conservative: anything unrecognised returns null so resolveTol() can warn rather
// than silently pick a tier that might mask a regression (C11).
export function inferTier(path, value) {
    const seg = lastSeg(path).toLowerCase();
    if (/^(heading|up|right|forward|dir|tosun|tomoon|sundir|moondir|normal)/.test(seg)) return 'vector';
    if (seg === 'lat' || seg === 'lon' || seg === 'latitude' || seg === 'longitude'
        || seg === 'az' || seg === 'el' || seg === 'ra' || seg === 'dec'
        || seg === 'heading' || seg === 'bearing' || seg.endsWith('deg')) return 'lla';
    if (seg === 'alt' || seg === 'altitude' || seg === 'elevation') return 'ecef';
    if (seg === 'vfov' || seg === 'fov' || seg === 'knots' || seg === 'speed'
        || seg === 'angle' || seg === 'sunangle' || seg === 'magnitude' || seg === 'maxmag') return 'scalar';
    // Coordinate components: large magnitude => ECEF metres; small => unit-ish vector.
    if (seg === 'x' || seg === 'y' || seg === 'z') {
        if (typeof value === 'number' && Math.abs(value) > 1e5) return 'ecef';
        return 'vector';
    }
    if (typeof value === 'number' && Number.isInteger(value)) return 'count';
    return null;
}

// Resolve {abs, decimals} for a number at `path`. Explicit per-capture `tol` (a number =
// absolute tolerance) always wins; otherwise infer; otherwise fall back to `scalar` and
// record a warning so the fall-through is VISIBLE, never silent.
export function resolveTol(path, value, explicitTol, warnings) {
    if (typeof explicitTol === 'number') {
        const decimals = Math.max(0, Math.round(-Math.log10(explicitTol)));
        return {abs: explicitTol, decimals};
    }
    if (explicitTol && typeof explicitTol === 'object') {
        // per-path override map: { 'heading.x': 1e-6, ... } or { '*': 'scalar' }
        const hit = explicitTol[path] ?? explicitTol[lastSeg(path)] ?? explicitTol['*'];
        if (typeof hit === 'number') return {abs: hit, decimals: Math.max(0, Math.round(-Math.log10(hit)))};
        if (typeof hit === 'string' && TOLERANCE_TIERS[hit]) return TOLERANCE_TIERS[hit];
    }
    const tier = inferTier(path, value);
    if (tier) return TOLERANCE_TIERS[tier];
    if (warnings) warnings.push(`tolerance fell through to 'scalar' for "${path}" (=${value}); set explicit tol`);
    return TOLERANCE_TIERS.scalar;
}

const roundTo = (n, d) => {
    if (!Number.isFinite(n)) return n;
    const f = 10 ** d;
    return Math.round(n * f) / f;
};

// Recursively normalise a captured value for STORAGE: strip volatile keys, sort object
// keys, sort arrays-of-objects by a stable key, round numbers by their tolerance tier.
export function canonicalize(value, {path = '', tol, warnings} = {}) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'number') return roundTo(value, resolveTol(path, value, tol, warnings).decimals);
    if (typeof value !== 'object') return value;             // string/bool
    if (Array.isArray(value)) {
        let arr = value.map((v, i) => canonicalize(v, {path: `${path}.${i}`, tol, warnings}));
        if (arr.length && arr.every(v => v && typeof v === 'object' && !Array.isArray(v))) {
            const k = STABLE_SORT_KEYS.find(k => arr.every(o => k in o));
            if (k) arr = [...arr].sort((a, b) => String(a[k]).localeCompare(String(b[k])));
        }
        return arr;
    }
    const out = {};
    for (const key of Object.keys(value).sort()) {
        if (VOLATILE_KEYS.has(key)) continue;
        out[key] = canonicalize(value[key], {path: path ? `${path}.${key}` : key, tol, warnings});
    }
    return out;
}

// Compare a freshly-captured value against a (rounded) committed baseline with per-leaf
// absolute tolerance. Numbers pass when abs(actual - baseline) <= tol; everything else is
// exact. Returns a list of {path, expected, actual, delta?, tol?} diffs (empty = pass).
export function diffValue(baseline, actual, {path = '', tol} = {}) {
    const diffs = [];
    const walk = (b, a, p) => {
        if (typeof b === 'number' && typeof a === 'number') {
            const {abs} = resolveTol(p, b, tol);
            const delta = Math.abs(a - b);
            if (delta > abs) diffs.push({path: p, expected: b, actual: a, delta, tol: abs});
            return;
        }
        if (b === null || a === null || typeof b !== 'object' || typeof a !== 'object') {
            if (b !== a) diffs.push({path: p, expected: b, actual: a});
            return;
        }
        if (Array.isArray(b) || Array.isArray(a)) {
            if (!Array.isArray(b) || !Array.isArray(a) || b.length !== a.length) {
                diffs.push({path: p, expected: `array[${b?.length}]`, actual: `array[${a?.length}]`});
                return;
            }
            b.forEach((bv, i) => walk(bv, a[i], `${p}.${i}`));
            return;
        }
        const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
        for (const k of keys) walk(b[k], a[k], p ? `${p}.${k}` : k);
    };
    walk(baseline, actual, path);
    return diffs;
}

// ---------------------------------------------------------------------------
// Mutation classification + scenario lint
// ---------------------------------------------------------------------------
// API fns that MUTATE app state. A scenario step calling one of these must be bracketed
// by snapshot+restore OR carry isolated:true. This is the safety contract — NOT the
// app's transientCalls set (verified to mean "doesn't change serialized state", which
// includes these mutating drives, CSitrecAPI.js:2766).
export const MUTATING_FNS = new Set([
    'gotoLLA', 'setCameraAltitude', 'pointCameraAtRaDec', 'pointCameraAtNamedObject',
    'lockCameraOnObject', 'lockCameraOnRaDec', 'unlockCamera', 'setDateTime', 'setFrame',
    'play', 'pause', 'togglePlayPause',
    'addObjectAtLLA', 'createSynthBuilding', 'createSynthBuildings', 'createSynthClouds',
    'createSynthOverlay', 'updateSynthElement', 'deleteSynthElement', 'deleteSynthElements',
    'setObjectModel', 'setObjectGeometry', 'setAllObjectsGeometry', 'setAllObjectsModel',
    'setObjectDimensions', 'setAllObjectsDimensions',
    'setMenuValue', 'executeMenuButton', 'showView', 'hideView', 'setViewPosition',
    'setLayout', 'hideMenu', 'showMenu', 'hideTimeline', 'showTimeline', 'hideChrome', 'showChrome',
    'setNotes', 'updateNotes', 'importMedia', 'undo', 'redo', 'loadSitch',
    // satellite show/hide/load toggles all mutate NightSky state:
    'satellitesShowSatellites', 'satellitesHideSatellites', 'satellitesShowStarlink',
    'satellitesHideStarlink', 'satellitesShowISS', 'satellitesHideISS', 'satellitesShowBrightest',
    'satellitesHideBrightest', 'satellitesShowOther', 'satellitesHideOther',
    'satellitesLoadLEO', 'satellitesLoadCurrentStarlink',
]);

// API fns that are FORBIDDEN entirely (would write to the server / hit live data) — a
// scenario naming one is a hard lint error, never executed.
export const FORBIDDEN_FNS = new Set([
    'saveSitch', 'getShareLink',                 // server write (rehost.php + S3 PUT)
    'getNearbyWeatherBalloons', 'compareSondeTrajectory', // live UWYO/IGRA2 fetch
]);

export function lintScenario(scenario) {
    const errors = [];
    const isolated = scenario.isolated === true;
    const steps = scenario.steps || [];
    const snapNames = new Set(steps.filter(s => s.type === 'snapshot').map(s => s.name));
    const hasAnyRestoreCapacity = snapNames.size > 0;
    for (const [i, s] of steps.entries()) {
        if (s.type === 'apiCall') {
            if (FORBIDDEN_FNS.has(s.fn)) errors.push(`step ${i}: forbidden API '${s.fn}' (server write / live network)`);
            if (MUTATING_FNS.has(s.fn) && !isolated && !hasAnyRestoreCapacity) {
                errors.push(`step ${i}: mutating API '${s.fn}' requires a snapshot+restore in the scenario, or isolated:true`);
            }
        }
        if (s.type === 'setFrame' && !isolated && !hasAnyRestoreCapacity) {
            // setFrame moves par.frame; harmless within a fresh page but flag if the scenario
            // claims purity. We allow it (fresh page per scenario), so this is informational only.
        }
        if (s.type === 'capture' && !s.name) errors.push(`step ${i}: capture step missing 'name'`);
        if (s.type === 'capture' && !s.read) errors.push(`step ${i}: capture '${s.name}' missing 'read'`);
        if (s.type === 'assert' && (!s.fn || !('equals' in s))) errors.push(`step ${i}: assert '${s.name}' needs fn + equals`);
    }
    return errors;
}

// ---------------------------------------------------------------------------
// Read-expression builder (page-side projection to PLAIN objects)
// ---------------------------------------------------------------------------
// window.sitrecAPI.call() resolves to the handleAPICall ENVELOPE {success, fn, result}
// (CSitrecAPI.js:2750). This unwraps to the bare `result`, throwing on success:false so a
// failed drive surfaces as a step error rather than a silent undefined. Returns a Promise
// expression (the caller awaits it).
export function apiCallExpr(fn, args = {}) {
    return `window.sitrecAPI.call(${JSON.stringify(fn)}, ${JSON.stringify(args)}).then(__e=>{`
        + `if(__e && __e.success===false) throw new Error('API '+${JSON.stringify(fn)}+' failed: '+(__e.error||'unknown'));`
        + `return (__e && typeof __e==='object' && 'result' in __e) ? __e.result : __e;})`;
}

function readExpr(read) {
    if (read.node) {
        const frameArg = read.frame === undefined ? '' : JSON.stringify(read.frame);
        const method = read.method || 'getValue';
        return `window.NodeMan.get(${JSON.stringify(read.node)}).${method}(${frameArg})`;
    }
    if (read.api) return apiCallExpr(read.api, read.args || {});
    if (read.eval) return `(${read.eval})()`;
    throw new Error('read must specify node | api | eval');
}

// Build a single page-side async expression that awaits the read and projects to a plain
// object. With `pick` (a dotted-path list) only those leaves cross the boundary, so no raw
// Three object is ever serialised. Without `pick`, the value is shallow-cloned via JSON so
// Vector3 {x,y,z} own-fields survive but methods/prototype don't.
function captureExpr(read, pick) {
    const inner = readExpr(read);
    if (Array.isArray(pick) && pick.length) {
        return `(async()=>{const __v=await (${inner});const __pick=${JSON.stringify(pick)};const __o={};`
            + `for(const __p of __pick){let __c=__v;for(const __k of __p.split('.')){__c=(__c==null?undefined:__c[__k]);}`
            + `__o[__p]=(__c&&typeof __c==='object'&&'x'in __c&&'y'in __c&&'z'in __c)?{x:__c.x,y:__c.y,z:__c.z}:__c;}`
            + `return __o;})()`;
    }
    return `(async()=>{const __v=await (${inner});return JSON.parse(JSON.stringify(__v??null));})()`;
}

// ---------------------------------------------------------------------------
// Step executor
// ---------------------------------------------------------------------------
// driver must provide:
//   evaluate(exprString) -> Promise<any>   (page.evaluate of a JS expression; awaits page promises)
//   settle(frame)        -> Promise        (drive to `frame` + wait for the scene to settle)
//   screenshot(name,view)-> Promise<Buffer|null>  (pixel tier; may be a no-op stub)
// Returns { captures, asserts, warnings, error }. `captures` is name -> canonicalized value.
export async function executeSteps(driver, scenario) {
    const captures = {};
    const asserts = [];
    const warnings = [];
    const snapshots = {};
    const pendingRestores = [];
    let error = null;

    try {
        for (const step of scenario.steps || []) {
            switch (step.type) {
                case 'settle':
                case 'setFrame': {
                    await driver.settle(step.frame);
                    break;
                }
                case 'snapshot': {
                    snapshots[step.name] = await driver.evaluate(`(${step.fn})()`);
                    // If the snapshot carries a restoreFn AND no explicit {type:'restore'} step
                    // targets it, queue an auto-restore for the finally block (reverts mutations
                    // even if a later step throws). Explicit restore steps take precedence.
                    const hasExplicitRestore = (scenario.steps || []).some(s => s.type === 'restore' && s.from === step.name);
                    if (step.restoreFn && !hasExplicitRestore) {
                        pendingRestores.push(`(${step.restoreFn})(${JSON.stringify(snapshots[step.name] ?? null)})`);
                    }
                    break;
                }
                case 'restore': {
                    const snap = snapshots[step.from];
                    await driver.evaluate(`(${step.fn})(${JSON.stringify(snap ?? null)})`);
                    break;
                }
                case 'apiCall': {
                    const expr = `(async()=>{const __r=await (${apiCallExpr(step.fn, step.args || {})});return JSON.parse(JSON.stringify(__r??null));})()`;
                    const res = await driver.evaluate(expr);
                    if (step.capture) captures[step.capture] = canonicalize(res, {tol: step.tol, warnings});
                    break;
                }
                case 'eval': {
                    const argStr = step.arg === undefined ? '' : JSON.stringify(step.arg);
                    const res = await driver.evaluate(`(async()=>{const __r=await (${step.fn})(${argStr});return JSON.parse(JSON.stringify(__r??null));})()`);
                    if (step.capture) captures[step.name] = canonicalize(res, {tol: step.tol, warnings});
                    break;
                }
                case 'capture': {
                    const res = await driver.evaluate(captureExpr(step.read, step.pick));
                    captures[step.name] = canonicalize(res, {tol: step.tol, warnings});
                    break;
                }
                case 'assert': {
                    const actual = await driver.evaluate(`(async()=>{const __r=await (${step.fn})();return JSON.parse(JSON.stringify(__r??null));})()`);
                    const diffs = diffValue(canonicalize(step.equals, {}), canonicalize(actual, {}), {});
                    asserts.push({name: step.name, ok: diffs.length === 0, expected: step.equals, actual, diffs});
                    break;
                }
                case 'pixel': {
                    // pixel tier handled by the runner (run-scenarios); here we just mark intent.
                    if (driver.screenshot) await driver.screenshot(step.name, step.view || 'composite');
                    break;
                }
                default:
                    warnings.push(`unknown step type '${step.type}'`);
            }
        }
    } catch (e) {
        error = e.message || String(e);
    } finally {
        // Auto-restore any snapshot that lacked an explicit restore step, using its
        // companion restoreFn if provided (defensive — M1 scenarios are zero-mutation).
        for (const r of pendingRestores.reverse()) {
            try { await driver.evaluate(r); } catch { /* best effort */ }
        }
    }
    return {captures, asserts, warnings, error};
}
