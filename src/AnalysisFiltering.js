import {metricSmoothingWindow, trajectorySmoothingSettings} from "./SmoothingPolicy";

const methodNames = {
    none: "None", moving: "Moving average with polynomial edges",
    movingPolyEdge: "Moving average with polynomial edges", sliding: "Smoothed velocity, reintegrated",
    savgol: "Savitzky–Golay", spline: "Spline interpolation", catmull: "Catmull–Rom spline",
};
const value = (node, fallback = 0) => node?.v0 ?? node?.value ?? fallback;
const seconds = n => Number.isFinite(n) ? `${Number(n.toFixed(3))} s` : "not available";
const selectedSource = node => {
    const seen = new Set();
    while (node && typeof node.getObject === "function" && !seen.has(node)) {
        seen.add(node);
        node = node.getObject();
    }
    return node;
};
const sourceLabel = (node, role) => node.smoothingKind === "column" && node.degrees
    ? `Recorded angles${node.in.misb?.shortName ? ` — ${node.in.misb.shortName}` : ""}` : ({
    cameraTrackSwitchSmooth: "Camera position", targetTrackSwitchSmooth: "Target position",
    traverseSmoothedTrack: "Live traverse output",
}[node.id] ?? (node.shortName ? `Track “${node.shortName}”` : role));

function rollingInfo(window, n, fps, frame0 = 0, frame1 = n - 1) {
    const half = Math.max(0, Math.floor(window / 2));
    const radius = f => Math.max(0, Math.min(half, f, n - 1 - f));
    const lo = Math.max(0, Math.min(n - 1, frame0));
    const hi = Math.max(lo, Math.min(n - 1, frame1));
    const maxHalf = radius(Math.max(lo, Math.min(hi, Math.floor((n - 1) / 2))));
    const minHalf = Math.min(radius(lo), radius(hi));
    return {
        active: half > 0,
        durationSeconds: 2 * maxHalf / fps,
        duration: `${seconds(2 * minHalf / fps)}–${seconds(2 * maxHalf / fps)} across this window`,
        detail: `${2 * maxHalf + 1} samples maximum; the average shortens at the source ends.`,
    };
}

function positionInfo(node, context) {
    const {fps} = context;
    const source = selectedSource(node.in.source);
    const n = node.in.source?.frames || node.frames;
    const method = node.method;
    const base = {method: methodNames[method] ?? method, status: "active"};
    if (source?.isAnalysisSnapshot || source?.preservesAnalysisSnapshot) {
        return {...base, status: "bypassed", duration: "0 s", detail: "Exact analysis snapshot; position filtering is bypassed."};
    }
    if (source?.lazyInterpolated || (!node.copyData && !node.in.dataTrack && source?.isConstantOverFrames)) {
        return {...base, status: "bypassed", duration: "0 s", detail: "Analytic or constant source passes through without position filtering."};
    }
    if (method === "none") return {...base, status: "off", duration: "0 s", detail: "This stage is disabled."};
    if (method === "spline" && node.in.dataTrack) {
        const data = node.in.dataTrack;
        let minGap = Infinity, maxGap = -Infinity;
        for (let i = 1; i < (data.misb?.length ?? 0); i++) {
            const gap = (data.getTime(i) - data.getTime(i - 1)) / 1000;
            if (gap > 0 && Number.isFinite(gap)) {
                minGap = Math.min(minGap, gap);
                maxGap = Math.max(maxGap, gap);
            }
        }
        return {...base, duration: "No fixed filter window", detail: "Chordal spline through original sparse samples; " +
            (Number.isFinite(minGap) ? `sample gaps ${seconds(minGap)}–${seconds(maxGap)}. ` : "") +
            "A zero window does not disable interpolation."};
    }
    let window = Math.min(value(node.in.window), n - 3);
    const iterations = Math.max(1, Math.floor(value(node.in.iterations, 1)));
    const spline = method === "spline" || method === "catmull";
    if (!spline && window <= 0) return {...base, status: "off", duration: "0 s", detail: "Window is zero; this stage is disabled."};
    let span = 0, detail = "";
    if (window > 0 && method !== "catmull") {
        if (method === "savgol" || method === "spline") {
            let samples = Math.max(3, Math.floor(window));
            if (samples % 2 === 0) samples++;
            samples = Math.min(samples, n % 2 === 0 ? n - 1 : n);
            const order = Math.min(value(node.in.polyOrder, spline ? 3 : 2), samples - 2);
            const edgeOrder = Math.max(order, value(node.in.edgeOrder, order));
            const edgeSamples = Math.min(n, Math.max(samples, value(node.in.fitWindow, window)));
            span = (samples - 1) * iterations / fps;
            detail = `${samples} samples, polynomial order ${order}; edge fit order ${edgeOrder} over ${seconds((edgeSamples - 1) / fps)}.`;
        } else if (method === "sliding") {
            span = Math.ceil(window) * iterations / fps;
            detail = "Velocity is averaged using a window that shifts across the source, then reintegrated; the result is anchored at the first position.";
        } else {
            const samples = 2 * Math.floor(window / 2) + 1;
            span = (samples - 1) * iterations / fps;
            const edgeSamples = Math.max(3, Math.min(n, method === "moving" ? window : value(node.in.fitWindow, window)));
            detail = `${samples} samples; polynomial edge fit over ${seconds((edgeSamples - 1) / fps)}.`;
        }
        if (iterations > 1) detail += ` ${iterations} passes; duration includes their combined span.`;
    }
    if (spline) {
        const step = Math.max(1, Math.floor(n / value(node.in.intervals, method === "catmull" ? 10 : 20)));
        return {...base, duration: `Spline control spacing ${seconds(step / fps)}`, durationSeconds: step / fps,
            detail: `${window > 0 && method !== "catmull" ? `Prefilter span ${seconds(span)}. ${detail} ` : ""}` +
                "Cubic interpolation has no single averaging duration; resampling remains active with window zero."};
    }
    return {...base, duration: seconds(span), durationSeconds: span, detail};
}

// Follow only selected switches and enabled controllers. The captured rows are
// plain values, so a cached report cannot silently acquire later GUI settings.
export function captureInputFiltering(roots, context) {
    const rows = new Map();
    for (const {node: root, role, shallow = false} of roots) {
        const visited = new Set();
        const add = (key, node, info) => {
            if (rows.has(key)) {
                const row = rows.get(key);
                if (!row.roles.includes(role)) row.roles.push(role);
            } else rows.set(key, {source: sourceLabel(node, role), roles: [role], ...info});
        };
        const visit = node => {
            if (!node || visited.has(node) || (node.isController && node.enabled === false)) return;
            if (node.isController && node.in?.enabled && !value(node.in.enabled)) return;
            visited.add(node);
            if (typeof node.getObject === "function") {
                if (!shallow) visit(node.getObject());
                return;
            }
            if (node.smoothingKind === "position") add(node.id, node, positionInfo(node, context));
            if (node.smoothingKind === "trackInterpolation") {
                const frames = [...(node.splineEditor?.frameNumbers ?? [])].sort((a, b) => a - b);
                const gaps = frames.slice(1).map((f, i) => (f - frames[i]) / context.fps);
                add(node.id, node, {source: node.menuText ?? node.shortName ?? role,
                    method: `Track interpolation: ${node.curveType}`, status: frames.length > 1 ? "active" : "off",
                    duration: "No fixed filter window", detail: frames.length > 1
                        ? `${frames.length} control points; ${node.constantSpeed ? "constant-speed timing across the path" : `frame spacing ${seconds(Math.min(...gaps))}–${seconds(Math.max(...gaps))}`}. ${node.extrapolateTrack ? "Extrapolates" : "Holds position"} outside the control-point range.`
                        : "No moving interpolated track."});
            }
            if (node.smoothingKind === "manualTracking") {
                const points = [...node.keyframes].sort((a, b) => a.frame - b.frame);
                let min = Infinity, max = 0;
                for (let i = 1; i < points.length; i++) {
                    const gap = (points[i].frame - points[i - 1].frame) / context.fps;
                    min = Math.min(min, gap); max = Math.max(max, gap);
                }
                add(node.id, node, {method: `Manual pixel track: ${points.length <= 2 ? "Linear / held" : node.curveType}`,
                    status: points.length > 1 ? "active" : "off", duration: "No fixed filter window",
                    detail: points.length > 1 ? `Interpolation between ${points.length} keyframes, separated by ${seconds(min)}–${seconds(max)}.` : "No moving interpolated track."});
            }
            if (node.filterEnabled === true && node.filteredSlots) {
                add(`${node.id}:outliers`, node, {method: "Bad-data acceleration filter", status: "active",
                    duration: "Variable; velocity baselines target at least 0.5 s on each side", detail: `Threshold ${node.filterMaxG} g; shorter baselines at source ends. Multiple passes: ${node.filteredSlots.size} samples excluded, ${node.altitudeFixedSlots?.size ?? 0} altitudes repaired before interpolation.`});
            }
            if (["column", "rolling", "motion"].includes(node.smoothingKind)) {
                const windowNode = node.in.smooth ?? node.in.window;
                const window = value(windowNode, node.smooth ?? 0);
                const info = rollingInfo(window, node.frames, context.fps, context.frame0, context.frame1);
                add(windowNode?.id ?? node.id, node, {
                    method: node.degrees ? "Circular moving average of recorded angles"
                        : node.smoothingKind === "motion" ? "Tracked-pixel moving average" : "Moving average",
                    status: info.active ? "active" : "off", ...info,
                    detail: info.active ? info.detail : "Angle/array filtering is disabled.",
                });
            }
            for (const [file, input, label] of [
                ["azFile", "azSmooth", "Custom azimuth"], ["elFile", "elSmooth", "Custom elevation"],
                ["headingFile", "headingSmooth", "Custom heading"],
            ]) {
                if (node[file] === undefined) continue;
                const info = rollingInfo(value(node.in[input], 200), node.frames, context.fps, context.frame0, context.frame1);
                add(`${node.id}:${input}`, node, {method: `${label} moving average`, status: info.active ? "active" : "off", ...info});
            }
            if (shallow || node.isAnalysisSnapshot) return;
            for (const [key, input] of Object.entries(node.in ?? node.inputs ?? {})) {
                if (key === "smoothedTrack" && node.tiltType !== undefined
                    && !["banking", "axialpush", "axialpull", "axialpushzerog", "axialpullzerog"].includes(node.tiltType.toLowerCase())) continue;
                visit(input);
            }
        };
        visit(root);
    }
    return Array.from(rows.values());
}

export function captureAnalysisFiltering(dataset, hypotheses = [], inputFilters = [], outputFilters = [], kalman = {}) {
    const {n, fps} = dataset;
    const rows = [...inputFilters];
    const h = metricSmoothingWindow(n, fps);
    rows.push({source: "Analysis metrics", roles: ["Scoring and displayed speed / acceleration"], status: "active",
        method: "Centered finite differences", duration: `${seconds(2 * h / fps)} velocity; ${seconds(4 * h / fps)} acceleration`,
        durationSeconds: 2 * h / fps, accelerationDurationSeconds: 4 * h / fps,
        detail: `Maximum interior spans; source-end windows shorten. Summary statistics omit ${h + 2} frames at each end. Short maneuvers can be attenuated.`});
    const keys = new Set(hypotheses.filter(x => x.track).map(x => x.key));
    if (kalman.referenceCompared ?? inputFilters.some(row => row.roles.some(role => role.startsWith("Reference")))) {
        const half = Math.max(1, Math.min(Math.floor(Math.max(3, Math.round(0.5 * fps)) / 2), Math.floor((n - 1) / 2)));
        rows.push({source: "Reference comparison", roles: ["Speed and heading differences"], status: "active",
            method: "Centered finite differences", duration: seconds(2 * half / fps), durationSeconds: 2 * half / fps,
            detail: "Same differentiation window for both trajectories; shortened at ends. Windows without valid reference endpoints are omitted. Position differences are not averaged."});
    }
    for (const [key, label, options] of [
        ["constAir", "Constant air speed", {}], ["constAlt", "Constant altitude", {}],
        ["saddle", "Minimum speed", {}], ["plausible", "Minimum acceleration", {spacing: 4, maxK: 400}],
    ]) {
        if (!keys.has(key)) continue;
        const {K, curvature} = trajectorySmoothingSettings(n, fps, options);
        const spacing = (n - 1) / (fps * (K - 3));
        rows.push({source: label, roles: ["Candidate trajectory"], status: "active", method: "Penalized cubic B-spline",
            duration: `Knot spacing ${seconds(spacing)}; fit uses the full ${seconds((n - 1) / fps)} window`,
            durationSeconds: (n - 1) / fps, detail: `${K} control points; curvature penalty ${Number(curvature.toPrecision(4))}. This is a global fit, not a moving average; the final path can miss the sightlines.`});
    }
    if (keys.has("gfKalman")) rows.push({source: "Kalman smoother", roles: ["Candidate trajectory"], status: "active",
        method: "Forward filter + backward smoother", duration: `Full ${seconds((n - 1) / fps)} analysis window`,
        durationSeconds: (n - 1) / fps, detail: `No fixed averaging duration. Process noise ${kalman.processNoise ?? "as configured"}; measurement noise ${kalman.measurementNoise ?? "as configured"}.`});
    if (kalman.seedSource) rows.push({source: "Physical-model initialization", roles: ["Starting trajectory for model optimization"], status: "active",
        method: kalman.seedSource === "kalman" ? "Kalman smoother seed" : "Minimum-acceleration fallback seed",
        duration: `Full ${seconds((n - 1) / fps)} analysis window`, durationSeconds: (n - 1) / fps,
        detail: kalman.seedSource === "kalman" ? `Process noise ${kalman.processNoise}; measurement noise ${kalman.measurementNoise}. The final physical trajectories are fitted models, not this smoothed seed.`
            : "Uses the minimum-acceleration result described above when the Kalman seed is unavailable."});
    return {rows, outputFilters, note: "Captured when Analyze ran. Durations use physical time (including simulation speed). Input filters run before A–B cropping. “Off” disables only that stage. Exact result snapshots bypass live traverse position filtering."};
}

const escape = text => String(text ?? "").replace(/[&<>"']/g, ch => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[ch]));
export function filteringSummaryHTML(summary) {
    if (!summary) return "<p>Filtering metadata was not captured for this analysis.</p>";
    const table = rows => `<table style="width:100%;border-collapse:collapse;font-size:12px;text-align:left"><thead><tr><th>Applies to</th><th>Processing</th><th>Effective duration</th></tr></thead><tbody>${rows.map(row => `<tr><td style="padding:6px;vertical-align:top">${escape(row.source)}<br><small>${escape(row.roles.join(", "))}</small></td><td style="padding:6px;vertical-align:top">${escape(row.method)} (${escape(row.status)})<br><small>${escape(row.detail)}</small></td><td style="padding:6px;vertical-align:top">${escape(row.duration)}</td></tr>`).join("")}</tbody></table>`;
    return `<p>${escape(summary.note)}</p>${table(summary.rows)}${summary.outputFilters.length ? `<p><strong>Live display at analysis time</strong> — separate from the candidate fits above.</p>${table(summary.outputFilters)}` : ""}`;
}
