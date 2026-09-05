import {captureInputFiltering, captureAnalysisFiltering, filteringSummaryHTML} from "../src/AnalysisFiltering";
import {metricSmoothingWindow, trajectorySmoothingSettings} from "../src/SmoothingPolicy";

const constant = v0 => ({v0});
const context = {fps: 30, frame0: 0, frame1: 300};
const raw = {id: "raw", frames: 301};
function position(id, method, window, source = raw) {
    return {id, smoothingKind: "position", method, frames: 301,
        in: {source, window: constant(window)}};
}

test("captures the selected chain, deduplicates shared angle filters, and freezes values", () => {
    const importFilter = position("import", "savgol", 20);
    const cameraFilter = position("cameraTrackSwitchSmooth", "moving", 20, importFilter);
    const angleWindow = {id: "angles", v0: 120};
    const angles = Array.from({length: 6}, (_, i) => ({id: `angle${i}`, smoothingKind: "column", degrees: true,
        frames: 301, in: {smooth: angleWindow, misb: importFilter}}));
    const camera = {id: "camera", in: {position: cameraFilter,
        active: {id: "attitude", isController: true, enabled: true, in: Object.fromEntries(angles.map((a, i) => [i, a]))},
        inactive: {id: "disabled", isController: true, enabled: false, in: {source: position("unused", "savgol", 80)}}}};
    const switchNode = {id: "los", getObject: () => camera, in: {camera, unused: position("unused2", "moving", 60)}};
    const rows = captureInputFiltering([{node: switchNode, role: "Sightlines"}], context);
    expect(rows).toHaveLength(3);
    expect(rows.filter(x => x.method.includes("recorded angles"))).toHaveLength(1);
    expect(rows.find(x => x.source === "Camera position").durationSeconds).toBeCloseTo(20 / 30);
    expect(rows.find(x => x.method.includes("recorded angles")).durationSeconds).toBe(4);
    const captured = JSON.stringify(rows);
    angleWindow.v0 = 0;
    expect(JSON.stringify(rows)).toBe(captured);
    expect(captureInputFiltering([{node: switchNode, role: "Sightlines"}], context).find(x => x.method.includes("recorded angles")).status).toBe("off");
});

test("effective duration includes simulation speed, odd windows, clamping, and repeated passes", () => {
    const node = position("smooth", "savgol", 20);
    node.in.iterations = constant(2);
    const [row] = captureInputFiltering([{node, role: "Camera"}], {...context, fps: 3});
    expect(row.durationSeconds).toBeCloseTo(40 / 3);
    const short = position("short", "savgol", 200, {frames: 10});
    expect(captureInputFiltering([{node: short, role: "Camera"}], context)[0].durationSeconds).toBeCloseTo(6 / 30);
});

test("spline with window zero is active; analytic sources and exact snapshots are bypassed", () => {
    const spline = position("spline", "spline", 0);
    spline.in.dataTrack = {misb: [0, 1, 2], getTime: i => [0, 1000, 5000][i]};
    const [row] = captureInputFiltering([{node: spline, role: "Reference track"}], context);
    expect(row.status).toBe("active");
    expect(row.duration).toBe("No fixed filter window");
    expect(row.detail).toContain("1 s–4 s");
    for (const source of [{isAnalysisSnapshot: true}, {lazyInterpolated: true}]) {
        const node = position("output", "moving", 20, {frames: 301, ...source});
        expect(captureInputFiltering([{node, role: "Output"}], context)[0].status).toBe("bypassed");
    }
});

test("unused attitude helper does not appear as active filtering", () => {
    const helper = position("bankHelper", "sliding", 200);
    const ctrl = {id: "orientation", tiltType: "frontPointing", in: {smoothedTrack: helper}};
    expect(captureInputFiltering([{node: ctrl, role: "Camera"}], context)).toHaveLength(0);
    ctrl.tiltType = "banking";
    expect(captureInputFiltering([{node: ctrl, role: "Camera"}], context)).toHaveLength(1);
});

test("reports interpolation and reference metrics even without a reference smoothing node", () => {
    const node = {id: "drawn", smoothingKind: "trackInterpolation", curveType: "chordal",
        splineEditor: {frameNumbers: [0, 30, 90]}, extrapolateTrack: true};
    const [row] = captureInputFiltering([{node, role: "Camera"}], context);
    expect(row.detail).toContain("1 s–2 s");
    expect(row.detail).toContain("Extrapolates");
    const result = captureAnalysisFiltering({n: 301, fps: 30}, [], [], [], {referenceCompared: true});
    expect(result.rows.some(x => x.source === "Reference comparison")).toBe(true);
});

test("summary reports actual finite-difference and spline spans and escapes source text", () => {
    const ds = {n: 301, fps: 30};
    const inputs = [{source: '<img src=x onerror="bad()">', roles: ["Reference"], method: "None", status: "off", duration: "0 s", detail: ""}];
    const result = captureAnalysisFiltering(ds, [{key: "constAlt", track: []}, {key: "gfKalman", track: []}], inputs, [], {processNoise: 0.0001, measurementNoise: 1});
    const metrics = result.rows.find(x => x.source === "Analysis metrics");
    expect(metrics.accelerationDurationSeconds).toBe(4 * metricSmoothingWindow(301, 30) / 30);
    const K = trajectorySmoothingSettings(301, 30).K;
    expect(result.rows.find(x => x.source === "Constant altitude").detail).toContain(`${K} control points`);
    expect(result.rows.find(x => x.source === "Kalman smoother").durationSeconds).toBe(10);
    const html = filteringSummaryHTML(result);
    expect(html).toContain("&lt;img");
    expect(html).not.toContain('<img src=x');
    expect(html).toContain("simulation speed");
});
