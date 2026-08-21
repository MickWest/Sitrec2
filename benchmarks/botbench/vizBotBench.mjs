#!/usr/bin/env node
// vizBotBench.mjs — visualize a BOTBench results set and keep a registry of
// every visualized run.
//
//   node benchmarks/botbench/vizBotBench.mjs results/botset_anomalies
//   node benchmarks/botbench/vizBotBench.mjs results/maneuvers --name maneuvers
//   node benchmarks/botbench/vizBotBench.mjs --index-only
//
// Output (all under benchmarks/botbench/results/viz/, gitignored with the rest
// of results/):
//   viz/runs/<runId>.html   self-contained page for one visualized run:
//                           stat tiles, a shape gallery (small multiples of
//                           every truth track), an animated scene player
//                           (platform + target + observed line of sight), a
//                           speed vs peak-g scatter, a realized pointing-error
//                           strip, and generation timing.
//   viz/registry.json       one entry per visualized run, with compact
//                           per-scenario stats (the meta page reads only this).
//   viz/index.html          the meta page: every run ever visualized, plus
//                           dataset-wide aggregates across all of them.
//
// Self-contained by design: no external JS/CSS, tracks are downsampled and
// rounded before embedding, and pages keep working after the source results
// folder is deleted or regenerated — the registry is the durable record.

import fs from "fs";
import path from "path";
import {fileURLToPath} from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(HERE, "results");
const VIZ_DIR = path.join(RESULTS, "viz");
const RUNS_DIR = path.join(VIZ_DIR, "runs");
const REGISTRY = path.join(VIZ_DIR, "registry.json");

// ---------------------------------------------------------------------------
// Palette (validated default; see the data-viz reference palette).
// Slot 1 blue = mundane, slot 2 orange = anomalous, slot 3 aqua = platform.
// Sequential blue ramp for the coverage heatmap. Ink/chrome per mode.
// ---------------------------------------------------------------------------
const CSS_TOKENS = `
:root {
  color-scheme: light;
  --surface: #fcfcfb; --page: #f9f9f7;
  --ink: #0b0b0b; --ink2: #52514e; --muted: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --border: rgba(11,11,11,0.10);
  --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a;
  --seq1: #cde2fb; --seq2: #9ec5f4; --seq3: #6da7ec; --seq4: #3987e5;
  --seq5: #256abf; --seq6: #184f95; --seq7: #0d366b;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --surface: #1a1a19; --page: #0d0d0d;
    --ink: #ffffff; --ink2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
    --s1: #3987e5; --s2: #d95926; --s3: #199e70;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --surface: #1a1a19; --page: #0d0d0d;
  --ink: #ffffff; --ink2: #c3c2b7; --muted: #898781;
  --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
  --s1: #3987e5; --s2: #d95926; --s3: #199e70;
}
* { box-sizing: border-box; }
body { margin: 0; padding: 24px; background: var(--page); color: var(--ink);
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 15px; margin: 28px 0 10px; }
.sub { color: var(--ink2); margin: 0 0 16px; }
.tiles { display: flex; flex-wrap: wrap; gap: 10px; margin: 14px 0; }
.tile { background: var(--surface); border: 1px solid var(--border);
  border-radius: 8px; padding: 10px 14px; min-width: 120px; }
.tile .v { font-size: 22px; font-weight: 600; }
.tile .k { color: var(--ink2); font-size: 12px; }
.card { background: var(--surface); border: 1px solid var(--border);
  border-radius: 8px; padding: 14px; margin: 10px 0; overflow-x: auto; }
.legend { display: flex; gap: 16px; align-items: center; color: var(--ink2);
  font-size: 12px; margin: 4px 0 8px; }
.legend .sw { display: inline-block; width: 10px; height: 10px;
  border-radius: 3px; margin-right: 5px; vertical-align: -1px; }
table { border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 4px 10px 4px 0;
  border-bottom: 1px solid var(--grid); font-variant-numeric: tabular-nums; }
th { color: var(--ink2); font-weight: 500; }
a { color: var(--s1); }
.gal { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 10px; }
.gal .cell { background: var(--surface); border: 1px solid var(--border);
  border-radius: 8px; padding: 6px; cursor: pointer; }
.gal .cell:hover { border-color: var(--s1); }
.gal .cell.sel { border-color: var(--s1); box-shadow: 0 0 0 1px var(--s1); }
.gal .name { font-size: 11px; color: var(--ink2); margin-top: 2px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.controls { display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
  margin: 8px 0; }
button, select { font: inherit; background: var(--surface); color: var(--ink);
  border: 1px solid var(--axis); border-radius: 6px; padding: 4px 12px;
  cursor: pointer; }
button:hover { border-color: var(--s1); }
input[type=range] { width: 260px; }
.readout { color: var(--ink2); font-size: 12px;
  font-variant-numeric: tabular-nums; }
.tip { position: fixed; pointer-events: none; background: var(--surface);
  border: 1px solid var(--border); border-radius: 6px; padding: 6px 9px;
  font-size: 12px; color: var(--ink); display: none; z-index: 10;
  box-shadow: 0 2px 8px rgba(0,0,0,0.25); }
details summary { cursor: pointer; color: var(--ink2); margin: 6px 0; }
`;

// ---------------------------------------------------------------------------
// Loading a results set
// ---------------------------------------------------------------------------

// Every directory (recursively) that holds the truth sidecars for a batch.
//
// TWO LAYOUTS. Older trees and sealed releases keep each sidecar beside its CSV,
// so the answer keys are in Truth/. The botset trees gather both sidecars in one
// meta/ folder instead. A group is a directory holding either.
const SIDECAR_SUBDIRS = ["meta", "Truth"];

/** The subdirectory of `dir` that actually holds the .truth.json files. */
export function truthJsonDir(dir) {
    for (const sub of SIDECAR_SUBDIRS) {
        const p = path.join(dir, sub);
        if (fs.existsSync(p) && fs.readdirSync(p).some((f) => f.endsWith(".truth.json"))) {
            return p;
        }
    }
    return null;
}

function findGroups(root) {
    const groups = [];
    const walk = (dir) => {
        if (truthJsonDir(dir)) groups.push(dir);
        for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
            if (e.isDirectory()
                && !["Truth", "Input", "All", "kml", "meta"].includes(e.name)) {
                walk(path.join(dir, e.name));
            }
        }
    };
    walk(root);
    return groups;
}

function readJson(file, fallback = null) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); }
    catch { return fallback; }
}

// Parse an all.csv (sensor + LOS + truth per row). Returns full-resolution
// numeric columns.
function parseAllCsv(file) {
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    const head = lines[0].split(",");
    const col = (name) => head.indexOf(name);
    const iT = col("Time");
    const iS = col("SensorPositionX"), iL = col("LOSUnitVectorX"),
        iP = col("TruePositionX");
    const t = [], s = [], l = [], p = [];
    for (let i = 1; i < lines.length; i++) {
        const c = lines[i].split(",");
        t.push(Number(c[iT]));
        s.push(Number(c[iS]), Number(c[iS + 1]), Number(c[iS + 2]));
        if (iL >= 0) l.push(Number(c[iL]), Number(c[iL + 1]), Number(c[iL + 2]));
        if (iP >= 0) p.push(Number(c[iP]), Number(c[iP + 1]), Number(c[iP + 2]));
    }
    return {t, s, l, p, n: t.length};
}

// Peak horizontal speed and peak g from a full-resolution track, by finite
// differences (mirrors the bench's own `measure`).
function trackStats(t, p) {
    let vMax = 0, gMax = 0, pvx = null, pvy = null, pvz = null;
    for (let f = 1; f < t.length; f++) {
        const dt = t[f] - t[f - 1];
        if (!(dt > 0)) continue;
        const vx = (p[f * 3] - p[(f - 1) * 3]) / dt;
        const vy = (p[f * 3 + 1] - p[(f - 1) * 3 + 1]) / dt;
        const vz = (p[f * 3 + 2] - p[(f - 1) * 3 + 2]) / dt;
        const v = Math.hypot(vx, vy, vz);
        if (v > vMax) vMax = v;
        if (pvx !== null) {
            gMax = Math.max(gMax,
                Math.hypot(vx - pvx, vy - pvy, vz - pvz) / dt / 9.80665);
        }
        pvx = vx; pvy = vy; pvz = vz;
    }
    return {vMax, gMax};
}

// Downsample column arrays to at most maxN rows, rounding to keep the embed
// small. Always keeps the final row.
function downsample(full, maxN = 200) {
    const step = Math.max(1, Math.ceil(full.n / maxN));
    const idx = [];
    for (let f = 0; f < full.n; f += step) idx.push(f);
    if (idx[idx.length - 1] !== full.n - 1) idx.push(full.n - 1);
    const r1 = (x) => Math.round(x * 10) / 10;
    const r4 = (x) => Math.round(x * 10000) / 10000;
    const take3 = (arr, round) => idx.flatMap((f) =>
        [round(arr[f * 3]), round(arr[f * 3 + 1]), round(arr[f * 3 + 2])]);
    return {
        t: idx.map((f) => Math.round(full.t[f] * 1000) / 1000),
        s: take3(full.s, r1),
        l: full.l.length ? take3(full.l, r4) : [],
        p: full.p.length ? take3(full.p, r1) : [],
    };
}

// One scenario record: identity + stats + embedded (downsampled) tracks.
// A sidecar lives in meta/ (botset trees) or beside its CSV (sealed releases).
function readSidecar(groupDir, base, suffix, siblingDir) {
    for (const sub of ["meta", siblingDir]) {
        const p = path.join(groupDir, sub, `${base}.${suffix}`);
        if (fs.existsSync(p)) return readJson(p, {});
    }
    return {};
}

function loadScenario(groupDir, base, manifestByBase, groupLabel) {
    const truthJson = readSidecar(groupDir, base, "truth.json", "Truth");
    const scenJson = readSidecar(groupDir, base, "scenario.json", "Input");
    const allFile = path.join(groupDir, "All", `${base}.all.csv`);
    if (!fs.existsSync(allFile)) return null;
    const full = parseAllCsv(allFile);
    const stats = full.p.length ? trackStats(full.t, full.p) : {vMax: 0, gMax: 0};

    const man = manifestByBase.get(base) ?? {};
    const prof = man.profile ?? {};
    // The profile's substepped peak is the honest number when present; the
    // finite-difference fallback underestimates sharp events.
    const peakG = Number.isFinite(prof.realizedPeakGLoad) ? prof.realizedPeakGLoad
        : stats.gMax;
    const rn = truthJson.realizedNoise ?? {};
    const events = (truthJson.events ?? []).map((e) => ({
        id: e.eventId, family: e.family, anomalous: !!e.anomalous,
        t0: e.onsetSeconds, t1: e.endSeconds,
    }));
    // Identity fallback when the manifest has no per-file join: the filename's
    // TARGET field (the first underscore field — target-first name grammar),
    // e.g. "anom-highgturn-50g-nolead". Strip the anom-/ctrl- flag for the
    // kind and keep the remainder as the variant.
    const token = base.split("_")[0];
    const stripped = token.replace(/^(anom-|ctrl-)/, "");
    const kind = man.kind ?? prof.kind ?? stripped.split("-")[0];
    const variant = man.variant ?? prof.variant
        ?? (stripped.includes("-") ? stripped.slice(stripped.indexOf("-") + 1) : null);
    const anomalous = man.anomalous ?? truthJson.anomalous ?? false;
    return {
        base, group: groupLabel,
        kind, variant,
        label: [kind, variant].filter(Boolean).join(" "),
        anomalous: !!anomalous,
        durationSeconds: man.durationSeconds
            ?? (full.n > 1 ? Math.round(full.t[full.n - 1]) : 0),
        errorLabel: groupLabel.includes("/") ? groupLabel.split("/").pop()
            : (scenJson.losError?.model === "none" ? "clean"
                : `${scenJson.losError?.sigmaDeg ?? "?"}deg`),
        losModel: scenJson.losError?.model ?? "?",
        peakG: round3(peakG),
        maxSpeed: round3(stats.vMax),
        rmsDeg: round4(rn.rmsDegAllFrames), maxErrDeg: round4(rn.maxDeg),
        dropped: rn.outOfFrameCount ?? 0,
        bucket: truthJson.geometry?.cvConditioningBucket ?? null,
        events,
        track: downsample(full),
    };
}

const round3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
const round4 = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null);

function loadSet(setDir) {
    const groups = findGroups(setDir);
    if (!groups.length) {
        throw new Error(`no meta/*.truth.json or Truth/*.truth.json under ${setDir}`);
    }
    const scenarios = [];
    for (const g of groups) {
        const label = path.relative(setDir, g) || ".";
        const manifest = readJson(path.join(g, "manifest.json"), []) ?? [];
        const byBase = new Map();
        for (const m of (Array.isArray(manifest) ? manifest : [])) {
            // botset manifests key by basename; the real-arm manifest keys by name.
            const key = m.basename ?? m.name;
            if (key) byBase.set(key, m);
        }
        for (const f of fs.readdirSync(truthJsonDir(g))) {
            if (!f.endsWith(".truth.json")) continue;
            const base = f.replace(/\.truth\.json$/, "");
            const rec = loadScenario(g, base, byBase, label);
            if (rec) scenarios.push(rec);
        }
    }
    // Numeric-aware ordering (batch_20s before batch_120s) for every list
    // the page derives from the scenario order.
    const natural = new Intl.Collator(undefined, {numeric: true}).compare;
    scenarios.sort((a, b) => natural(a.group, b.group) || natural(a.label, b.label));
    const timing = readJson(path.join(setDir, "timing.json"), null);
    return {scenarios, timing, groups: groups.map((g) => path.relative(setDir, g) || ".")};
}

// ---------------------------------------------------------------------------
// Batch page
// ---------------------------------------------------------------------------

// Quotes are escaped as well as the angle brackets: esc() is used inside attribute
// values (href="runs/${esc(r.runId)}.html"), where a bare " would close the attribute.
function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// JSON destined for an inline <script>: "</script>" inside any string value
// would terminate the block, so every "<" is embedded as an escape.
function embedJson(o) {
    return JSON.stringify(o).replace(/</g, "\\u003c");
}

function buildRunPage(run, data) {
    const {scenarios, timing} = data;
    const nAnom = scenarios.filter((s) => s.anomalous).length;
    const groups = [...new Set(scenarios.map((s) => s.group))];
    const payload = {
        run: {id: run.runId, name: run.name, source: run.sourceDir,
            generatedAt: run.generatedAt},
        scenarios,
        timing: timing ?? null,
    };
    const tiles = [
        ["scenarios", scenarios.length],
        ["anomalous", nAnom],
        ["folders", groups.length],
        ["gen time", timing ? `${(timing.totalMs / 1000).toFixed(1)} s` : "—"],
        ["files", timing ? timing.files : "—"],
    ];
    return `<!doctype html><meta charset="utf-8">
<title>BOTBench viz — ${esc(run.name)}</title>
<style>${CSS_TOKENS}</style>
<body>
<h1>BOTBench — ${esc(run.name)}</h1>
<p class="sub">${esc(run.sourceDir)} · visualized ${esc(run.generatedAt)} ·
<a href="../index.html">all runs</a></p>
<div class="tiles">${tiles.map(([k, v]) =>
        `<div class="tile"><div class="v">${esc(v)}</div><div class="k">${esc(k)}</div></div>`).join("")}
</div>

<h2>Shape gallery — truth tracks (top-down)</h2>
<div class="legend"><span><span class="sw" style="background:var(--s1)"></span>mundane</span>
<span><span class="sw" style="background:var(--s2)"></span>anomalous</span>
<span>click a shape to load it in the player</span></div>
<div class="gal" id="gallery"></div>

<h2>Scene player — animated platform, target and observed line of sight</h2>
<div class="card">
  <div class="controls">
    <select id="selScenario"></select>
    <button id="btnPlay">Play</button>
    <input type="range" id="scrub" min="0" max="1000" value="0">
    <select id="selSpeed"><option value="1">1×</option><option value="4" selected>4×</option>
      <option value="10">10×</option><option value="30">30×</option></select>
    <span class="readout" id="readout"></span>
  </div>
  <canvas id="scene" width="980" height="560" style="width:100%;max-width:980px"></canvas>
  <div class="legend"><span><span class="sw" style="background:var(--s3)"></span>platform</span>
  <span><span class="sw" style="background:var(--s1)"></span>target (truth)</span>
  <span><span class="sw" style="background:var(--muted)"></span>observed line of sight</span>
  <span id="evLegend"></span></div>
</div>

<h2>Kinematic envelope — peak speed vs peak g</h2>
<div class="legend"><span><span class="sw" style="background:var(--s1)"></span>mundane</span>
<span><span class="sw" style="background:var(--s2)"></span>anomalous</span></div>
<div class="card"><svg id="envelope" width="960" height="420"></svg></div>

<h2>Realized pointing error by folder</h2>
<div class="card"><svg id="noise" width="960" height="300"></svg></div>

<h2>Generation timing</h2>
<div class="card"><svg id="timing" width="960" height="300"></svg></div>

<details><summary>Data table</summary><div class="card" id="tableBox"></div></details>
<div class="tip" id="tip"></div>
<script>
const DATA = ${embedJson(payload)};
${CLIENT_JS}
</script>
</body>`;
}

// Client-side renderer, shared verbatim by every run page. Kept as a plain
// string so the page has zero external references.
const CLIENT_JS = String.raw`
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const S = DATA.scenarios;
const tip = document.getElementById("tip");
function showTip(x, y, html) {
    tip.innerHTML = html; tip.style.display = "block";
    tip.style.left = Math.min(x + 14, innerWidth - 240) + "px";
    tip.style.top = (y + 14) + "px";
}
function hideTip() { tip.style.display = "none"; }
const fmt = (x, d = 1) => (x == null ? "—" : Number(x).toFixed(d));
const escH = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const colorOf = (s) => s.anomalous ? css("--s2") : css("--s1");

// ---- shape gallery: one cell per unique kind+variant (first group seen) ----
const seen = new Map();
for (const s of S) {
    const key = s.label;
    // Prefer the longest duration member as the representative shape.
    if (!seen.has(key) || s.durationSeconds > seen.get(key).durationSeconds) seen.set(key, s);
}
const gal = document.getElementById("gallery");
const cells = [];
for (const s of seen.values()) {
    const d = document.createElement("div");
    d.className = "cell";
    d.innerHTML = miniShapeSVG(s) + '<div class="name">' + escH(s.label)
        + (s.anomalous ? " ⚠" : "") + "</div>";
    d.title = s.base;
    d.onclick = () => { selectScenario(S.indexOf(s)); d.scrollIntoView({block: "nearest"}); };
    gal.appendChild(d);
    cells.push([d, s]);
}
function miniShapeSVG(s) {
    const p = s.track.p, n = p.length / 3;
    if (!n) return "<svg width=138 height=90></svg>";
    let xs = [], ys = [];
    for (let i = 0; i < n; i++) { xs.push(p[i * 3]); ys.push(p[i * 3 + 1]); }
    const mnx = Math.min(...xs), mxx = Math.max(...xs);
    const mny = Math.min(...ys), mxy = Math.max(...ys);
    const span = Math.max(mxx - mnx, mxy - mny, 1);
    const cx = (mnx + mxx) / 2, cy = (mny + mxy) / 2;
    const W = 138, H = 78, sc = Math.min(W - 12, H - 12) / span;
    const pt = (i) => (W / 2 + (xs[i] - cx) * sc).toFixed(1) + ","
        + (H / 2 - (ys[i] - cy) * sc).toFixed(1);
    let dstr = "M" + pt(0);
    for (let i = 1; i < n; i++) dstr += "L" + pt(i);
    const col = s.anomalous ? "var(--s2)" : "var(--s1)";
    // Static point: a dot, not an invisible zero-length path.
    const dot = span <= 1 ? '<circle cx="' + W / 2 + '" cy="' + H / 2
        + '" r="4" fill="' + col + '"/>' : "";
    return '<svg width="' + W + '" height="' + (H + 12) + '">'
        + '<path d="' + dstr + '" fill="none" stroke="' + col + '" stroke-width="2"/>'
        + dot
        + '<text x="4" y="' + (H + 9) + '" font-size="9" fill="var(--muted)">'
        + Math.round(span) + " m</text></svg>";
}

// ---- scene player -----------------------------------------------------------
const sel = document.getElementById("selScenario");
S.forEach((s, i) => {
    const o = document.createElement("option");
    o.value = i;
    o.textContent = s.group + " \u00b7 " + s.label + (s.anomalous ? " \u26a0" : "");
    sel.appendChild(o);
});
const canvas = document.getElementById("scene"), ctx = canvas.getContext("2d");
const scrub = document.getElementById("scrub");
const btnPlay = document.getElementById("btnPlay");
const selSpeed = document.getElementById("selSpeed");
const readout = document.getElementById("readout");
let cur = 0, playT = 0, playing = false, lastTs = null;

function selectScenario(i) {
    cur = i; sel.value = i; playT = 0; playing = false;
    btnPlay.textContent = "Play";
    cells.forEach(([d, s]) => d.classList.toggle("sel", S.indexOf(s) === i));
    const ev = S[i].events.map((e) =>
        e.id + " [" + fmt(e.t0, 1) + "–" + fmt(e.t1, 1) + " s]").join(" · ");
    document.getElementById("evLegend").textContent = ev ? "events: " + ev : "";
    draw();
}
sel.onchange = () => selectScenario(Number(sel.value));
btnPlay.onclick = () => { playing = !playing; btnPlay.textContent = playing ? "Pause" : "Play"; lastTs = null; if (playing) requestAnimationFrame(tick); };
scrub.oninput = () => { const s = S[cur]; playT = scrub.value / 1000 * s.track.t[s.track.t.length - 1]; playing = false; btnPlay.textContent = "Play"; draw(); };
function tick(ts) {
    if (!playing) return;
    if (lastTs != null) {
        playT += (ts - lastTs) / 1000 * Number(selSpeed.value);
        const s = S[cur], tEnd = s.track.t[s.track.t.length - 1];
        if (playT >= tEnd) { playT = tEnd; playing = false; btnPlay.textContent = "Play"; }
    }
    lastTs = ts; draw();
    if (playing) requestAnimationFrame(tick);
}
function lerp3(arr, i, j, f, k) { return arr[i * 3 + k] + (arr[j * 3 + k] - arr[i * 3 + k]) * f; }
function sampleAt(s, t) {
    const T = s.track.t;
    let i = 0;
    while (i < T.length - 2 && T[i + 1] < t) i++;
    const f = Math.min(1, Math.max(0, (t - T[i]) / ((T[i + 1] - T[i]) || 1)));
    const g = (arr) => arr.length ? [lerp3(arr, i, i + 1, f, 0), lerp3(arr, i, i + 1, f, 1), lerp3(arr, i, i + 1, f, 2)] : null;
    return {i, f, s: g(s.track.s), p: g(s.track.p), l: g(s.track.l)};
}
function draw() {
    const s = S[cur], T = s.track.t, tEnd = T[T.length - 1] || 1;
    scrub.value = Math.round(playT / tEnd * 1000);
    const W = canvas.width, H = canvas.height, altH = 110, mainH = H - altH - 14;
    ctx.fillStyle = css("--surface"); ctx.fillRect(0, 0, W, H);
    // shared top-down frame over sensor + target extents
    let xs = [], ys = [];
    const push = (arr) => { for (let i = 0; i < arr.length / 3; i++) { xs.push(arr[i * 3]); ys.push(arr[i * 3 + 1]); } };
    push(s.track.p); push(s.track.s);
    const mnx = Math.min(...xs), mxx = Math.max(...xs), mny = Math.min(...ys), mxy = Math.max(...ys);
    const span = Math.max(mxx - mnx, mxy - mny, 10);
    const cx = (mnx + mxx) / 2, cy = (mny + mxy) / 2;
    const sc = Math.min(W - 60, mainH - 40) / span;
    const X = (x) => W / 2 + (x - cx) * sc, Y = (y) => mainH / 2 - (y - cy) * sc + 16;
    // scale bar
    const bar = Math.pow(10, Math.floor(Math.log10(span / 4)));
    ctx.strokeStyle = css("--axis"); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(16, mainH - 6); ctx.lineTo(16 + bar * sc, mainH - 6); ctx.stroke();
    ctx.fillStyle = css("--muted"); ctx.font = "11px system-ui";
    ctx.fillText((bar >= 1000 ? (bar / 1000) + " km" : bar + " m"), 16, mainH - 12);
    // trails up to playT
    const upTo = (arr, col) => {
        ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.beginPath();
        let started = false;
        for (let i = 0; i < T.length && T[i] <= playT + 1e-9; i++) {
            const px = X(arr[i * 3]), py = Y(arr[i * 3 + 1]);
            if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
        }
        ctx.stroke();
    };
    const now = sampleAt(s, playT);
    // event window shading on the time strip below, plus target trail color
    upTo(s.track.s, css("--s3"));
    upTo(s.track.p, colorOf(s));
    // observed line of sight: from sensor along LOS for the sensor→truth range
    if (now.l && now.s && now.p) {
        const r = Math.hypot(now.p[0] - now.s[0], now.p[1] - now.s[1], now.p[2] - now.s[2]);
        ctx.strokeStyle = css("--muted"); ctx.lineWidth = 1;
        ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.moveTo(X(now.s[0]), Y(now.s[1]));
        ctx.lineTo(X(now.s[0] + now.l[0] * r), Y(now.s[1] + now.l[1] * r)); ctx.stroke();
        ctx.setLineDash([]);
    }
    const mark = (pt, col, rr) => { if (!pt) return; ctx.fillStyle = col;
        ctx.strokeStyle = css("--surface"); ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(X(pt[0]), Y(pt[1]), rr, 0, 7); ctx.fill(); ctx.stroke(); };
    mark(now.s, css("--s3"), 6);
    mark(now.p, colorOf(s), 6);
    // altitude strip
    const aTop = mainH + 8;
    ctx.strokeStyle = css("--grid"); ctx.strokeRect(40, aTop, W - 56, altH - 20);
    let zmin = Infinity, zmax = -Infinity;
    for (let i = 0; i < T.length; i++) { const z = s.track.p[i * 3 + 2]; if (z < zmin) zmin = z; if (z > zmax) zmax = z; }
    if (zmax - zmin < 1) { zmax += 1; zmin -= 1; }
    const AX = (t) => 40 + t / tEnd * (W - 56), AY = (z) => aTop + (altH - 20) * (1 - (z - zmin) / (zmax - zmin));
    // event windows shaded
    for (const e of s.events) {
        ctx.fillStyle = s.anomalous ? "rgba(235,104,52,0.15)" : "rgba(42,120,214,0.12)";
        ctx.fillRect(AX(e.t0), aTop, Math.max(2, AX(Math.min(e.t1, tEnd)) - AX(e.t0)), altH - 20);
    }
    ctx.strokeStyle = colorOf(s); ctx.lineWidth = 2; ctx.beginPath();
    for (let i = 0; i < T.length; i++) {
        const px = AX(T[i]), py = AY(s.track.p[i * 3 + 2]);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.strokeStyle = css("--ink2");
    ctx.beginPath(); ctx.moveTo(AX(playT), aTop); ctx.lineTo(AX(playT), aTop + altH - 20); ctx.stroke();
    ctx.fillStyle = css("--muted"); ctx.font = "11px system-ui";
    ctx.fillText("altitude " + Math.round(zmin) + "–" + Math.round(zmax) + " m", 44, aTop + 12);
    readout.textContent = "t = " + playT.toFixed(1) + " s / " + tEnd.toFixed(0) + " s"
        + "   peak " + fmt(s.peakG) + " g, " + fmt(s.maxSpeed, 0) + " m/s"
        + (s.rmsDeg != null ? "   pointing RMS " + fmt(s.rmsDeg, 3) + "°" : "");
}

// ---- envelope scatter (log-log) --------------------------------------------
(function envelope() {
    const svg = document.getElementById("envelope");
    const W = 960, H = 420, L = 60, B = 40, T2 = 14, R = 20;
    const pts = S.map((s, i) => ({s, i,
        x: Math.max(s.maxSpeed || 0, 0.05), y: Math.max(s.peakG || 0, 0.005)}));
    const lx = (v) => Math.log10(v);
    const xmin = Math.min(...pts.map((p) => lx(p.x))) - 0.15,
        xmax = Math.max(...pts.map((p) => lx(p.x))) + 0.15;
    const ymin = Math.min(...pts.map((p) => lx(p.y))) - 0.15,
        ymax = Math.max(...pts.map((p) => lx(p.y))) + 0.15;
    const X = (v) => L + (lx(v) - xmin) / (xmax - xmin) * (W - L - R);
    const Y = (v) => T2 + (1 - (lx(v) - ymin) / (ymax - ymin)) * (H - T2 - B);
    let g = "";
    for (let e = Math.ceil(xmin); e <= Math.floor(xmax); e++) {
        const v = Math.pow(10, e);
        g += '<line x1="' + X(v) + '" y1="' + T2 + '" x2="' + X(v) + '" y2="' + (H - B) + '" stroke="var(--grid)"/>'
            + '<text x="' + X(v) + '" y="' + (H - B + 16) + '" fill="var(--muted)" font-size="11" text-anchor="middle">' + v + '</text>';
    }
    for (let e = Math.ceil(ymin); e <= Math.floor(ymax); e++) {
        const v = Math.pow(10, e);
        g += '<line x1="' + L + '" y1="' + Y(v) + '" x2="' + (W - R) + '" y2="' + Y(v) + '" stroke="var(--grid)"/>'
            + '<text x="' + (L - 8) + '" y="' + (Y(v) + 4) + '" fill="var(--muted)" font-size="11" text-anchor="end">' + v + '</text>';
    }
    g += '<line x1="' + L + '" y1="' + (H - B) + '" x2="' + (W - R) + '" y2="' + (H - B) + '" stroke="var(--axis)"/>';
    g += '<text x="' + (W / 2) + '" y="' + (H - 6) + '" fill="var(--ink2)" font-size="12" text-anchor="middle">peak speed (m/s, log)</text>';
    g += '<text x="14" y="' + (H / 2) + '" fill="var(--ink2)" font-size="12" transform="rotate(-90 14 ' + (H / 2) + ')" text-anchor="middle">peak g (log)</text>';
    for (const p of pts) {
        g += '<circle data-i="' + p.i + '" cx="' + X(p.x).toFixed(1) + '" cy="' + Y(p.y).toFixed(1)
            + '" r="5" fill="' + (p.s.anomalous ? "var(--s2)" : "var(--s1)")
            + '" stroke="var(--surface)" stroke-width="1.5" style="cursor:pointer"/>';
    }
    svg.innerHTML = g;
    svg.addEventListener("mousemove", (ev) => {
        const c = ev.target.closest("circle[data-i]");
        if (!c) { hideTip(); return; }
        const s = S[Number(c.dataset.i)];
        showTip(ev.clientX, ev.clientY, "<b>" + escH(s.group + " · " + s.label) + "</b><br>"
            + fmt(s.maxSpeed, 0) + " m/s · " + fmt(s.peakG, 2) + " g"
            + (s.rmsDeg != null ? "<br>pointing RMS " + fmt(s.rmsDeg, 3) + "°" : ""));
    });
    svg.addEventListener("mouseleave", hideTip);
    svg.addEventListener("click", (ev) => {
        const c = ev.target.closest("circle[data-i]");
        if (c) selectScenario(Number(c.dataset.i));
    });
})();

// ---- realized pointing error strip by folder --------------------------------
(function noise() {
    const svg = document.getElementById("noise");
    const groups = [...new Set(S.map((s) => s.group))];
    const W = 960, H = Math.max(120, groups.length * 34 + 60), L = 200, R = 30;
    svg.setAttribute("height", H);
    const vmax = Math.max(0.01, ...S.map((s) => s.maxErrDeg || 0));
    const X = (v) => L + v / (vmax * 1.06) * (W - L - R);
    let g = "";
    groups.forEach((grp, gi) => {
        const y = 30 + gi * 34;
        g += '<text x="6" y="' + (y + 4) + '" fill="var(--ink2)" font-size="12">' + escH(grp) + '</text>';
        g += '<line x1="' + L + '" y1="' + y + '" x2="' + (W - R) + '" y2="' + y + '" stroke="var(--grid)"/>';
        for (const s of S.filter((s) => s.group === grp)) {
            if (s.rmsDeg == null) continue;
            g += '<circle data-i="' + S.indexOf(s) + '" cx="' + X(s.rmsDeg).toFixed(1) + '" cy="' + y
                + '" r="4.5" fill="' + (s.anomalous ? "var(--s2)" : "var(--s1)")
                + '" fill-opacity="0.75" stroke="var(--surface)"/>';
            if (s.dropped) {
                g += '<circle cx="' + X(s.maxErrDeg).toFixed(1) + '" cy="' + y + '" r="3" fill="none" stroke="var(--s2)"/>';
            }
        }
    });
    for (const v of [0, vmax / 2, vmax]) {
        g += '<text x="' + X(v) + '" y="' + (H - 10) + '" fill="var(--muted)" font-size="11" text-anchor="middle">' + v.toFixed(2) + '°</text>';
    }
    g += '<text x="' + ((L + W - R) / 2) + '" y="' + (H - 26) + '" fill="var(--ink2)" font-size="12" text-anchor="middle">realized pointing RMS per scenario (° per frame-set); open rings mark scenarios with dropped frames at their max error</text>';
    svg.innerHTML = g;
    svg.addEventListener("mousemove", (ev) => {
        const c = ev.target.closest("circle[data-i]");
        if (!c) { hideTip(); return; }
        const s = S[Number(c.dataset.i)];
        showTip(ev.clientX, ev.clientY, "<b>" + escH(s.label) + "</b><br>RMS " + fmt(s.rmsDeg, 3)
            + "° · max " + fmt(s.maxErrDeg, 3) + "°<br>dropped frames: " + s.dropped);
    });
    svg.addEventListener("mouseleave", hideTip);
})();


// ---- timing bars ------------------------------------------------------------
(function timing() {
    const box = document.getElementById("timing").parentElement;
    const t = DATA.timing;
    if (!t) { box.previousElementSibling.remove(); box.remove(); return; }
    const svg = document.getElementById("timing");
    const rows = t.batches;
    const W = 960, RH = 22, H = rows.length * RH + 50, L = 200;
    svg.setAttribute("height", H);
    const vmax = Math.max(...rows.map((r) => r.ms));
    let g = "";
    rows.forEach((r, i) => {
        const y = 14 + i * RH;
        const w = Math.max(3, r.ms / vmax * (W - L - 90));
        g += '<text x="6" y="' + (y + 12) + '" fill="var(--ink2)" font-size="12">' + escH(r.batch) + '</text>'
            + '<rect x="' + L + '" y="' + y + '" width="' + w + '" height="14" rx="4" fill="var(--s1)"/>'
            + '<text x="' + (L + w + 8) + '" y="' + (y + 12) + '" fill="var(--ink2)" font-size="12">' + r.ms + ' ms</text>';
    });
    g += '<text x="' + L + '" y="' + (H - 10) + '" fill="var(--muted)" font-size="12">total ' + t.totalMs + " ms · " + t.scenarios + " scenarios · " + t.files + " files</text>";
    svg.innerHTML = g;
})();

// ---- data table -------------------------------------------------------------
(function table() {
    const cols = ["group", "label", "anomalous", "durationSeconds", "maxSpeed",
        "peakG", "rmsDeg", "maxErrDeg", "dropped"];
    let h = "<table><tr>" + cols.map((c) => "<th>" + c + "</th>").join("") + "</tr>";
    for (const s of S) {
        h += "<tr>" + cols.map((c) => "<td>" + escH(s[c] ?? "—") + "</td>").join("") + "</tr>";
    }
    document.getElementById("tableBox").innerHTML = h + "</table>";
})();

selectScenario(0);
`;

// ---------------------------------------------------------------------------
// Meta index page
// ---------------------------------------------------------------------------

function buildIndexPage(registry) {
    const runs = registry.runs;
    const all = runs.flatMap((r) => r.scenarios.map((s) => ({...s, run: r.name})));
    const nAnom = all.filter((s) => s.anomalous).length;
    const kinds = [...new Set(all.map((s) => s.kind))].sort();

    // coverage heatmap rows: duration x errorLabel
    const durs = [...new Set(all.map((s) => s.durationSeconds))].sort((a, b) => a - b);
    const errs = [...new Set(all.map((s) => s.errorLabel))];
    const cell = new Map();
    for (const s of all) {
        const k = `${s.durationSeconds}|${s.errorLabel}`;
        cell.set(k, (cell.get(k) ?? 0) + 1);
    }
    const payload = {runs: runs.map((r) => ({
        runId: r.runId, name: r.name, sourceDir: r.sourceDir,
        generatedAt: r.generatedAt, scenarios: r.scenarios.length,
        anomalous: r.scenarios.filter((s) => s.anomalous).length,
        timingMs: r.timingMs ?? null,
    })), all, kinds, durs, errs,
    cells: [...cell.entries()]};

    return `<!doctype html><meta charset="utf-8">
<title>BOTBench dataset</title>
<style>${CSS_TOKENS}</style>
<body>
<h1>BOTBench — visualized dataset</h1>
<p class="sub">${runs.length} visualized runs · registry at results/viz/registry.json</p>
<div class="tiles">
  <div class="tile"><div class="v">${all.length}</div><div class="k">scenarios</div></div>
  <div class="tile"><div class="v">${nAnom}</div><div class="k">anomalous</div></div>
  <div class="tile"><div class="v">${kinds.length}</div><div class="k">track kinds</div></div>
  <div class="tile"><div class="v">${runs.length}</div><div class="k">runs</div></div>
</div>

<h2>Runs</h2>
<div class="card"><table id="runsTable"><tr>
<th>run</th><th>source</th><th>visualized</th><th>scenarios</th><th>anomalous</th><th>gen time</th></tr>
${runs.map((r) => `<tr><td><a href="runs/${esc(r.runId)}.html">${esc(r.name)}</a></td>
<td>${esc(r.sourceDir)}</td><td>${esc(r.generatedAt.replace("T", " ").slice(0, 19))}</td>
<td>${r.scenarios.length}</td><td>${r.scenarios.filter((s) => s.anomalous).length}</td>
<td>${r.timingMs ? (r.timingMs / 1000).toFixed(1) + " s" : "—"}</td></tr>`).join("\n")}
</table></div>

<h2>Scenario counts by track kind</h2>
<div class="legend"><span><span class="sw" style="background:var(--s1)"></span>mundane</span>
<span><span class="sw" style="background:var(--s2)"></span>anomalous</span></div>
<div class="card"><svg id="kinds" width="960" height="10"></svg></div>

<h2>Coverage — duration × operator error</h2>
<div class="card"><svg id="coverage" width="700" height="10"></svg></div>

<h2>Kinematic envelope of the whole dataset</h2>
<div class="legend"><span><span class="sw" style="background:var(--s1)"></span>mundane</span>
<span><span class="sw" style="background:var(--s2)"></span>anomalous</span>
<span>every scenario in every registered run</span></div>
<div class="card"><svg id="envelope" width="960" height="440"></svg></div>

<div class="tip" id="tip"></div>
<script>
const DATA = ${embedJson(payload)};
${INDEX_JS}
</script>
</body>`;
}

const INDEX_JS = String.raw`
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const escH = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const tip = document.getElementById("tip");
function showTip(x, y, html) {
    tip.innerHTML = html; tip.style.display = "block";
    tip.style.left = Math.min(x + 14, innerWidth - 240) + "px";
    tip.style.top = (y + 14) + "px";
}
function hideTip() { tip.style.display = "none"; }
const fmt = (x, d = 1) => (x == null ? "—" : Number(x).toFixed(d));

// ---- counts by kind (paired bars: mundane + anomalous) ----------------------
(function kinds() {
    const svg = document.getElementById("kinds");
    const counts = DATA.kinds.map((k) => ({k,
        m: DATA.all.filter((s) => s.kind === k && !s.anomalous).length,
        a: DATA.all.filter((s) => s.kind === k && s.anomalous).length}));
    counts.sort((x, y) => (y.m + y.a) - (x.m + x.a));
    const RH = 24, W = 960, L = 170, H = counts.length * RH + 30;
    svg.setAttribute("height", H);
    const vmax = Math.max(...counts.map((c) => c.m + c.a));
    const X = (v) => v / vmax * (W - L - 60);
    let g = "";
    counts.forEach((c, i) => {
        const y = 8 + i * RH;
        g += '<text x="6" y="' + (y + 11) + '" fill="var(--ink2)" font-size="12">' + escH(c.k) + '</text>';
        if (c.m) g += '<rect x="' + L + '" y="' + y + '" width="' + Math.max(2, X(c.m) - 1) + '" height="14" rx="4" fill="var(--s1)"/>';
        if (c.a) g += '<rect x="' + (L + X(c.m) + (c.m ? 2 : 0)) + '" y="' + y + '" width="' + Math.max(2, X(c.a) - 1) + '" height="14" rx="4" fill="var(--s2)"/>';
        g += '<text x="' + (L + X(c.m + c.a) + 8) + '" y="' + (y + 11) + '" fill="var(--ink2)" font-size="12">' + (c.m + c.a) + '</text>';
    });
    svg.innerHTML = g;
})();

// ---- coverage heatmap -------------------------------------------------------
(function coverage() {
    const svg = document.getElementById("coverage");
    const durs = DATA.durs, errs = DATA.errs;
    const cw = 84, ch = 34, L = 110, T = 30;
    const W = L + errs.length * cw + 20, H = T + durs.length * ch + 20;
    svg.setAttribute("width", W); svg.setAttribute("height", H);
    const cmap = new Map(DATA.cells);
    const vmax = Math.max(1, ...DATA.cells.map((c) => c[1]));
    const ramp = ["--seq1", "--seq2", "--seq3", "--seq4", "--seq5", "--seq6", "--seq7"];
    let g = "";
    errs.forEach((e, j) => {
        g += '<text x="' + (L + j * cw + cw / 2) + '" y="18" fill="var(--ink2)" font-size="12" text-anchor="middle">' + escH(e) + '</text>';
    });
    durs.forEach((d, i) => {
        g += '<text x="' + (L - 10) + '" y="' + (T + i * ch + ch / 2 + 4) + '" fill="var(--ink2)" font-size="12" text-anchor="end">' + d + ' s</text>';
        errs.forEach((e, j) => {
            const v = cmap.get(d + "|" + e) ?? 0;
            const step = v === 0 ? null : ramp[Math.min(ramp.length - 1, Math.floor(v / vmax * (ramp.length - 1)))];
            g += '<rect x="' + (L + j * cw) + '" y="' + (T + i * ch) + '" width="' + (cw - 2) + '" height="' + (ch - 2)
                + '" rx="4" fill="' + (step ? "var(" + step + ")" : "var(--surface)") + '" stroke="var(--grid)"/>';
            if (v) g += '<text x="' + (L + j * cw + cw / 2 - 1) + '" y="' + (T + i * ch + ch / 2 + 4)
                + '" font-size="12" text-anchor="middle" fill="' + (v / vmax > 0.55 ? "#ffffff" : "var(--ink)") + '">' + v + '</text>';
        });
    });
    svg.innerHTML = g;
})();

// ---- dataset-wide envelope scatter ------------------------------------------
(function envelope() {
    const svg = document.getElementById("envelope");
    const W = 960, H = 440, L = 60, B = 40, T2 = 14, R = 20;
    const pts = DATA.all.map((s, i) => ({s, i,
        x: Math.max(s.maxSpeed || 0, 0.05), y: Math.max(s.peakG || 0, 0.005)}));
    if (!pts.length) return;
    const lx = Math.log10;
    const xmin = Math.min(...pts.map((p) => lx(p.x))) - 0.15,
        xmax = Math.max(...pts.map((p) => lx(p.x))) + 0.15;
    const ymin = Math.min(...pts.map((p) => lx(p.y))) - 0.15,
        ymax = Math.max(...pts.map((p) => lx(p.y))) + 0.15;
    const X = (v) => L + (lx(v) - xmin) / (xmax - xmin) * (W - L - R);
    const Y = (v) => T2 + (1 - (lx(v) - ymin) / (ymax - ymin)) * (H - T2 - B);
    let g = "";
    for (let e = Math.ceil(xmin); e <= Math.floor(xmax); e++) {
        const v = Math.pow(10, e);
        g += '<line x1="' + X(v) + '" y1="' + T2 + '" x2="' + X(v) + '" y2="' + (H - B) + '" stroke="var(--grid)"/>'
            + '<text x="' + X(v) + '" y="' + (H - B + 16) + '" fill="var(--muted)" font-size="11" text-anchor="middle">' + v + '</text>';
    }
    for (let e = Math.ceil(ymin); e <= Math.floor(ymax); e++) {
        const v = Math.pow(10, e);
        g += '<line x1="' + L + '" y1="' + Y(v) + '" x2="' + (W - R) + '" y2="' + Y(v) + '" stroke="var(--grid)"/>'
            + '<text x="' + (L - 8) + '" y="' + (Y(v) + 4) + '" fill="var(--muted)" font-size="11" text-anchor="end">' + v + '</text>';
    }
    g += '<line x1="' + L + '" y1="' + (H - B) + '" x2="' + (W - R) + '" y2="' + (H - B) + '" stroke="var(--axis)"/>';
    g += '<text x="' + (W / 2) + '" y="' + (H - 6) + '" fill="var(--ink2)" font-size="12" text-anchor="middle">peak speed (m/s, log)</text>';
    g += '<text x="14" y="' + (H / 2) + '" fill="var(--ink2)" font-size="12" transform="rotate(-90 14 ' + (H / 2) + ')" text-anchor="middle">peak g (log)</text>';
    for (const p of pts) {
        g += '<circle data-i="' + p.i + '" cx="' + X(p.x).toFixed(1) + '" cy="' + Y(p.y).toFixed(1)
            + '" r="4" fill-opacity="0.8" fill="' + (p.s.anomalous ? "var(--s2)" : "var(--s1)")
            + '" stroke="var(--surface)" stroke-width="1"/>';
    }
    svg.innerHTML = g;
    svg.addEventListener("mousemove", (ev) => {
        const c = ev.target.closest("circle[data-i]");
        if (!c) { hideTip(); return; }
        const s = DATA.all[Number(c.dataset.i)];
        showTip(ev.clientX, ev.clientY, "<b>" + escH(s.run + " · " + (s.label || s.kind)) + "</b><br>"
            + fmt(s.maxSpeed, 0) + " m/s \u00b7 " + fmt(s.peakG, 2) + " g \u00b7 " + escH(s.durationSeconds + " s \u00b7 " + s.errorLabel));
    });
    svg.addEventListener("mouseleave", hideTip);
})();
`;

// ---------------------------------------------------------------------------
// Registry + main
// ---------------------------------------------------------------------------

function loadRegistry() {
    if (!fs.existsSync(REGISTRY)) return {runs: []};
    const reg = readJson(REGISTRY, null);
    if (!reg || !Array.isArray(reg.runs)) {
        throw new Error(`registry ${REGISTRY} exists but is unreadable - fix or move it `
            + "before visualizing (overwriting it would lose the run history)");
    }
    return reg;
}

function saveRegistry(reg) {
    fs.mkdirSync(VIZ_DIR, {recursive: true});
    fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2));
}

// Compact per-scenario stats kept in the registry (the meta page reads only
// these, so it stays fast and survives result-set regeneration).
function summarize(s) {
    return {base: s.base, kind: s.kind, variant: s.variant, label: s.label,
        anomalous: s.anomalous, group: s.group,
        durationSeconds: s.durationSeconds, errorLabel: s.errorLabel,
        maxSpeed: s.maxSpeed, peakG: s.peakG,
        rmsDeg: s.rmsDeg, maxErrDeg: s.maxErrDeg, dropped: s.dropped};
}

function rebuildIndex(reg) {
    fs.mkdirSync(VIZ_DIR, {recursive: true});
    fs.writeFileSync(path.join(VIZ_DIR, "index.html"), buildIndexPage(reg));
}

function main() {
    const args = process.argv.slice(2);
    if (args.includes("--index-only")) {
        const reg = loadRegistry();
        rebuildIndex(reg);
        console.log(`[viz] index rebuilt: ${path.join(VIZ_DIR, "index.html")} (${reg.runs.length} runs)`);
        return;
    }
    const setArg = args.find((a) => !a.startsWith("--"));
    if (!setArg) {
        console.error("usage: node vizBotBench.mjs <resultsSubdir> [--name label] | --index-only");
        process.exit(1);
    }
    const nameIdx = args.indexOf("--name");
    const setDir = path.isAbsolute(setArg) ? setArg : path.resolve(HERE, setArg);
    const rawName = nameIdx >= 0 ? args[nameIdx + 1] : path.basename(setDir);
    // The name becomes a filename component: keep it to a safe slug.
    const name = String(rawName).replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^[.-]+/, "") || "run";

    const t0 = Date.now();
    const data = loadSet(setDir);
    const generatedAt = new Date().toISOString();
    const runId = `${name}-${generatedAt.replace(/[:.]/g, "-").slice(0, 23)}`;
    const run = {runId, name, sourceDir: path.relative(HERE, setDir),
        generatedAt,
        timingMs: data.timing?.totalMs ?? null,
        scenarios: data.scenarios.map(summarize)};

    fs.mkdirSync(RUNS_DIR, {recursive: true});
    const pageFile = path.join(RUNS_DIR, `${runId}.html`);
    fs.writeFileSync(pageFile, buildRunPage(run, data));

    const reg = loadRegistry();
    reg.runs.push(run);
    saveRegistry(reg);
    rebuildIndex(reg);

    console.log(`[viz] ${data.scenarios.length} scenarios from ${data.groups.length} folder(s) in ${Date.now() - t0} ms`);
    console.log(`[viz] run page:  ${pageFile}`);
    console.log(`[viz] index:     ${path.join(VIZ_DIR, "index.html")}`);
}

main();
