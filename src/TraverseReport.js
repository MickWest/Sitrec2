// Report structure is independent of the scene and of chart rendering.
import {explainTraverseHTML, traverseGlossaryHTML, TRAVERSE_TERM_CSS} from "./TraverseTerminology";
export const reportEscape = value => String(value ?? "").replace(/[&<>"']/g,
    c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));

export function constantAirReportCases({hypotheses = [], sweep, sweepFreeWind}) {
    return [
        {mode: "supplied", short: "CAS/SW", label: "Constant air speed — supplied wind", sweep},
        {mode: "fitted", short: "CAS/FW", label: "Constant air speed — fitted wind", sweep: sweepFreeWind},
    ].map(c => ({...c, hypothesis: hypotheses.find(h => h.key === "constAir" && h.track
        && (h.windMode === c.mode || (!h.windMode && c.mode === "supplied")))}))
        .filter(c => c.sweep || c.hypothesis);
}

export function reportOverviewCandidates(ranked) {
    const paths = ranked.filter(({h}) => h.track?.length && !h.atInfinity);
    if (!paths.length) return [];
    return paths[0].r.coLeader ? paths.filter(({r}) => r.coLeader) : paths.slice(0, 1);
}

export function reportSourceHTML(source) {
    const esc = reportEscape;
    if (!source?.files?.length) return "<p>No imported track source was recorded. This analysis uses the scene's configured tracks and sightlines.</p>";
    return source.files.map(f => `<h3>${esc(f.name)}${f.primary ? " — primary observation source" : " — loaded track source"}</h3>`
        + `<p><strong>Relative path:</strong> <code>${esc(f.relativePath || "Not recorded by the import")}</code>${f.pathBasis ? ` (${esc(f.pathBasis)})` : ""}.</p>`
        + `<p><strong>File:</strong> ${esc(f.type || "Type not recorded")}${Number.isFinite(f.bytes) ? ` · ${f.bytes.toLocaleString("en-US")} bytes` : ""}`
        + `${Number.isFinite(f.rows) ? ` · ${f.rows.toLocaleString("en-US")} data rows` : ""}`
        + `${f.lastModified ? ` · last modified ${esc(new Date(f.lastModified).toISOString())}` : ""}.</p>`
        + `<p><strong>Tracks in this file:</strong> ${f.trackNames.map(esc).join("; ") || "None recorded"}.</p>`
        + `<p><strong>Video relationship:</strong> ${f.parentVideo ? `Extracted from ${esc(f.parentVideo)}.`
            : source.media.some(v => !v.isImage) ? "Video is loaded in the scene; a derivation from that video is not recorded for this file."
                : "No video is loaded and no parent video is recorded for this file."}</p>`
        + `<p><strong>Columns present (${f.columns.length}):</strong> ${f.columns.length ? f.columns.map(c => `<code>${esc(c)}</code>`).join(", ") : "Column names are not available for this file format."}</p>`).join("")
        + (source.media.length ? `<p><strong>Loaded media:</strong> ${source.media.map(v => `${esc(v.name)}${v.isImage ? " (image)" : " (video)"}${v.width && v.height ? `, ${v.width} × ${v.height}` : ""}${v.frames ? `, ${v.frames} frames` : ""}`).join("; ")}.</p>` : "");
}

export function assembleTraverseReport({title, generated, metaHTML, overviewHTML = "", summaryHTML, sections, manifest = {}, version = ""}) {
    const esc = reportEscape;
    const usedTerms = new Set();
    metaHTML = explainTraverseHTML(metaHTML, usedTerms);
    overviewHTML = explainTraverseHTML(overviewHTML, usedTerms);
    summaryHTML = explainTraverseHTML(summaryHTML, usedTerms);
    sections = sections.map(s => ({...s, html: explainTraverseHTML(s.html, usedTerms),
        titleHTML: explainTraverseHTML(esc(s.title), usedTerms)}));
    if (usedTerms.size) sections.push({id: "terminology", title: "Glossary — terms and units", html: traverseGlossaryHTML(usedTerms)});
    const filename = `Traverse-Analysis-${title.replace(/[^A-Za-z0-9._-]+/g, "_")}`;
    const json = JSON.stringify(manifest, null, 2).replace(/</g, "\\u003c");
    return `<!DOCTYPE html>
<html lang="en" class="light"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Traverse Analysis — ${esc(title)}</title>
<style>
${TRAVERSE_TERM_CSS}
:root { color-scheme:dark; --page:#0d0f12; --text:#d8dce2; --heading:#e8eaed;
    --muted:#9ca5b2; --surface:#14161a; --line:#3c434c; --link:#72b3ff; }
html.light { color-scheme:light; --page:#fff; --text:#23262a; --heading:#111;
    --muted:#505963; --surface:#f6f7f9; --line:#c4cbd2; --link:#165ba5; }
* { box-sizing:border-box; }
body { margin:0; padding:28px 24px; background:var(--page); color:var(--text);
    font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; }
.wrap { max-width:960px; margin:auto; }
h1,h2,h3,h4,strong { color:var(--heading); }
h1 { font-size:28px; line-height:1.2; margin:0 0 8px; }
h2 { font-size:21px; margin:34px 0 14px; border-bottom:1px solid var(--line); padding-bottom:7px; }
h3 { font-size:18px; margin:24px 0 8px; }
h4 { font-size:15px; margin:16px 0 6px; }
p { margin:8px 0 14px; }
a { color:var(--link); text-underline-offset:2px; }
section,article { scroll-margin-top:18px; }
.sub,figcaption,.solution-sub,.solution-order,footer { color:var(--muted); font-size:13px; }
.toolbar { display:flex; flex-wrap:wrap; gap:10px; margin:0 0 24px; }
button,.toolbar a { background:var(--surface); color:var(--text); border:1px solid var(--line);
    border-radius:5px; padding:8px 12px; font:inherit; font-size:13px; cursor:pointer; text-decoration:none; }
.summary { border-left:4px solid #3987e5; padding:4px 18px; margin:24px 0; background:var(--surface); }
.summary h2 { margin-top:10px; }
.overview-pair { display:flex; gap:10px; }
.overview-pair img { width:calc(50% - 5px); min-width:0; align-self:start; }
.overview-key { margin:8px 0; padding:0; list-style:none; font-size:12px; }
.overview-key li { display:inline; margin-right:14px; }
.overview-swatch { display:inline-block; width:24px; border-top:3px solid; margin-right:7px; vertical-align:middle; }
code { overflow-wrap:anywhere; }
@media screen and (max-width:600px) { .overview-pair { flex-direction:column; } .overview-pair img { width:100%; } }
nav ol { padding-left:24px; }
nav li { margin:5px 0; }
.back { display:block; margin:12px 0; font-size:12px; }
figure { margin:18px 0 24px; padding:10px; border:1px solid var(--line); border-radius:6px; }
figure img { display:block; width:100%; height:auto; }
figcaption { margin-top:10px; }
/* Figures are dark raster plots; inversion preserves readable axes on paper. */
html.light figure img { filter:invert(1) hue-rotate(180deg); }
.dark-only { display:inline; } .light-only { display:none; }
html.light .dark-only { display:none; } html.light .light-only { display:inline; }
.tablebox { width:100%; overflow-x:auto; }
table { width:100%; border-collapse:collapse; font-size:13px; font-variant-numeric:tabular-nums; }
th,td { padding:8px 7px; border-bottom:1px solid var(--line); text-align:left;
    vertical-align:top; white-space:normal; overflow-wrap:normal; }
th { font-size:12px; color:var(--muted); }
tr.best td { background:var(--surface); }
.pill { display:inline-block; border:1px solid var(--line); border-radius:4px; padding:1px 6px;
    color:#101820; font-size:11px; font-weight:650; }
.solution-pills { margin:8px 0; }
.solution-pills .pill { margin:0 5px 5px 0; }
.solution-detail { margin:26px 0; padding-top:12px; border-top:2px solid var(--line); }
.solution-detail figure { max-width:600px; }
.solution-head h3 { margin:0 0 6px; }
.solution-metrics { margin:14px 0; }
/* Each metric is a complete, full-width row. Long explanations have full measure. */
.st { margin:0; padding:5px 0; border-bottom:1px solid var(--line); }
.stk { display:inline; font-weight:650; font-size:13px; color:var(--muted); }
.stk::after { content:": "; }
.stv { display:inline; font-size:14px; }
.rank-basis { background:var(--surface); padding:10px 12px; border-left:3px solid #3987e5; }
.warning { padding:12px; border:1px solid var(--line); background:var(--surface); }
details { margin:12px 0; }
summary { cursor:pointer; font-weight:650; }
pre { white-space:pre-wrap; overflow-wrap:anywhere; font:11px/1.5 ui-monospace,monospace; }
.wind-comparison { color:var(--text) !important; background:var(--surface) !important; }
.wind-comparison span { color:var(--muted) !important; }
.print-note { display:none; }
footer { border-top:1px solid var(--line); margin-top:30px; padding-top:12px; }
@media(max-width:600px) { body { padding:16px 12px; } h1 { font-size:24px; } th,td { padding:6px 4px; font-size:11px; } }
@page { size:auto; margin:15mm 13mm 17mm;
    @bottom-left { content:"Sitrec Traverse Analysis"; font:8pt system-ui,sans-serif; color:#555; }
    @bottom-right { content:"Page " counter(page) " of " counter(pages); font:8pt system-ui,sans-serif; color:#555; }
}
@media print {
    :root { color-scheme:light; --page:#fff; --text:#222; --heading:#111;
        --muted:#444; --surface:#fff; --line:#bbb; --link:#174d83; }
    body { padding:0; font-size:10pt; line-height:1.4; background:white; color:#222; }
    .wrap { width:100%; max-width:none; }
    .toolbar,.back,.manifest { display:none !important; }
    .print-note { display:block; }
    h1 { font-size:21pt; } h2 { font-size:15pt; margin-top:18pt; } h3 { font-size:12pt; }
    h1,h2,h3,h4,summary { break-after:avoid; page-break-after:avoid; }
    p,li { orphans:3; widows:3; }
    figure { break-inside:avoid; page-break-inside:avoid; padding:6px; margin:12pt 0; }
    figure img { max-height:205mm; object-fit:contain; filter:invert(1) hue-rotate(180deg); }
    .solution-detail figure { max-width:100mm; }
    .solution-head,.solution-order { break-after:avoid; page-break-after:avoid; }
    .solution-overview,.wind-comparison { break-inside:avoid; page-break-inside:avoid; }
    figcaption,.sub,.solution-order { font-size:9pt; }
    .tablebox,.wind-comparison > div { overflow:visible !important; }
    table { width:100%; font-size:8.5pt; }
    th { font-size:8pt; } th,td { padding:5px 4px; min-width:0 !important; }
    thead { display:table-header-group; }
    tr,.st { break-inside:avoid; page-break-inside:avoid; }
    .stk,.stv { font-size:9.5pt; }
    .solution-detail { break-inside:auto; }
    .pill { background:white !important; color:#222 !important; font-size:8pt; }
    .summary,.warning,.rank-basis,.wind-comparison { background:white !important; color:#222 !important; }
    .dark-only { display:none !important; } .light-only { display:inline !important; }
    a { color:#174d83; text-decoration:underline; }
}
</style></head><body>
<main class="wrap" id="report-top">
<div class="toolbar"><button id="print-report" type="button">Print / Save PDF</button>
<button id="theme-toggle" type="button">Dark view</button>
<a id="dl-report" download="${esc(filename)}.html" href="#">Download HTML</a>
<a id="dl-manifest" download="${esc(filename)}-manifest.json" href="#">Download run data</a></div>
<header><h1>Traverse Analysis — ${esc(title)}</h1>
<p class="sub">Generated ${esc(generated)}${version ? ` · ${esc(version)}` : ""}</p>${metaHTML}
</header>
${overviewHTML ? `<section id="opening-overview" aria-label="Leading trajectory overview">${overviewHTML}</section>` : ""}
<section class="summary" id="summary"><h2>Key findings</h2>${summaryHTML}</section>
${usedTerms.size ? '<p class="sub">Hover the dotted terms for explanations, or read the <a href="#terminology">glossary of terms and units</a>.</p>' : ''}
<nav id="contents" aria-label="Table of contents"><h2>Contents</h2><ol>
${overviewHTML ? '<li><a href="#opening-overview">Leading trajectory overview</a></li>' : ''}
<li><a href="#summary">Key findings</a></li>
${sections.map(s => `<li><a href="#${esc(s.id)}">${s.titleHTML ?? esc(s.title)}</a></li>`).join("\n")}
</ol></nav>
${sections.map(s => `<section id="${esc(s.id)}"><h2>${s.titleHTML ?? esc(s.title)}</h2>${s.html}
<a class="back" href="#contents">Back to contents</a></section>`).join("\n")}
<footer>Generated by Sitrec Traverse Analysis. This report contains the fitted results and comparison plots.
The original source files and application version are needed to reproduce the analysis.</footer>
</main>
<script type="application/json" id="run-manifest">${json}</script>
<script>
(() => {
    const root = document.documentElement;
    const theme = document.getElementById('theme-toggle');
    theme.onclick = () => { root.classList.toggle('light'); theme.textContent = root.classList.contains('light') ? 'Dark view' : 'Light view'; };
    document.getElementById('print-report').onclick = () => window.print();
    let wasLight, expanded = [];
    window.addEventListener('beforeprint', () => {
        wasLight = root.classList.contains('light'); root.classList.add('light');
        expanded = [...document.querySelectorAll('details:not(.manifest):not([open])')];
        expanded.forEach(d => d.open = true);
    });
    window.addEventListener('afterprint', () => {
        root.classList.toggle('light', wasLight); expanded.forEach(d => d.open = false);
    });
    for (const [id, type] of [['dl-report','text/html'], ['dl-manifest','application/json']]) {
        const a = document.getElementById(id);
        a.onclick = () => {
            if (a.href.startsWith('blob:')) URL.revokeObjectURL(a.href);
            const data = id === 'dl-report' ? '<!DOCTYPE html>\\n' + root.outerHTML : document.getElementById('run-manifest').textContent;
            a.href = URL.createObjectURL(new Blob([data], {type}));
        };
    }
})();
<\/script></body></html>`;
}
