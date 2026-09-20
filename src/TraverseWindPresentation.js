import {formatWind} from "./TraverseWind";

const escape = s => String(s).replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));

export function windComparisonRows(hypotheses, dataset) {
    const groups = new Map();
    for (const h of hypotheses ?? []) {
        if (!h.windMode || !h.track) continue;
        if (!groups.has(h.key)) groups.set(h.key, {name: h.name.replace(/ \([^()]*wind[^()]*\)$/, ""), key: h.key});
        groups.get(h.key)[h.windMode] = h;
    }
    return [...groups.values()].sort((a, b) => (b.key === "lantern") - (a.key === "lantern"));
}

export function windSummary(samples) {
    if (!samples?.length) return "Not determined by this method";
    return [...new Set(samples.map(formatWind))].join(" → ");
}

export function windComparisonHTML(hypotheses, dataset) {
    const rows = windComparisonRows(hypotheses, dataset);
    if (!rows.length) return "";
    const cell = h => !h ? "—" : `${escape(windSummary(h.windSamples))}<br>`
        + `<span style="color:#9daab8">LOS ${h.errDeg.toFixed(5)}°</span>`
        + (h.params.windCorrectionSigmaMS ? `<br>Correction scale: ${(h.params.windCorrectionSigmaMS / 0.514444).toFixed(1)} kt` : "")
        + (h.windSearchBounds?.length ? `<br><span style="color:#f2b25d">Wind search edge — not resolved</span>` : "")
        + (h.optimizerWarnings?.length ? `<br><span style="color:#f2b25d">Optimizer incomplete</span>` : "");
    return `<details style="margin:10px 0;padding:10px;color:#dae3ee;background:#17212b;border-radius:6px" open>`
        + `<summary style="cursor:pointer;font-weight:600">Supplied wind and wind required by each interpretation</summary>`
        + `<p style="font-size:12px">${escape(dataset?.windSource ?? "Supplied wind is an input assumption unless independently measured.")} `
        + `Directions are FROM. Required winds depend on the motion model; they are not weather measurements. `
        + `Correction uncertainty is an explicit input assumption, not a confidence interval.</p>`
        + `<div style="overflow-x:auto"><table style="width:100%;font-size:12px;border-collapse:collapse;text-align:left">`
        + `<thead><tr><th>Interpretation</th><th>Supplied wind</th><th>Required wind</th><th>Supplied + correction</th></tr></thead><tbody>`
        + rows.map(row => `<tr style="border-top:1px solid #35404c"><td style="padding:6px">${escape(row.name)}</td>`
            + `<td style="padding:6px">${cell(row.supplied)}</td><td style="padding:6px">${cell(row.fitted)}</td>`
            + `<td style="padding:6px">${cell(row.corrected)}</td></tr>`).join("")
        + `</tbody></table></div></details>`;
}
