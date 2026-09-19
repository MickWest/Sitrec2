/** Read-only, truth-free comparison of the existing candidate assessments. */
import {KNOTS_TO_MS} from "./TraverseAnalysis";
import {
    botScoreBreakdown, BROAD_SCREEN_LIMITS, FIT_SCALE_TIERS, fitScaleDeg,
    hypothesisFitKind, rankAllHypotheses, rankingDecision, rankingPlacementExplanation,
} from "./TraverseRanking";
import {physicalClassChecks} from "./TraverseMundaneness";
import {MIRROR_MIN_SNR, MIRROR_PARTIAL_SHARE} from "./TraversePlatformMirror";
import {GROUND_CONTACT_TOL, UNDERGROUND_MIN_FRACTION, UNDERGROUND_TOL} from "./TraverseHypotheses";

const number = (v, digits = 3) => Number.isFinite(v) ? v.toFixed(digits) : "unavailable";
const escape = text => String(text).replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const cell = (status, value, detail = "") => ({status, value, detail});

export function comparisonCandidates(hypotheses, dataset = null) {
    return rankAllHypotheses(hypotheses, {useTruth: false, dataset}).filter(({h}) => {
        const kind = hypothesisFitKind(h);
        return kind !== "identity" && kind !== "directional-geometry";
    });
}

function limitCell(value, limit, unit, digits, passed, strict = false) {
    if (!Number.isFinite(value)) return cell("unknown", "Not assessed", "Measurement unavailable");
    const delta = limit - value;
    const margin = delta === 0 ? "at limit" : `${number(Math.abs(delta), digits)} ${unit} ${delta > 0 ? "below" : "above"} limit`;
    return cell(passed ? "pass" : "fail", `${number(value, digits)} ${unit}`,
        `${strict ? "<" : "≤"} ${number(limit, digits)} ${unit}; ${margin}`);
}

// These are the gates for the top screening tier, not object-class envelopes.
// Use the ranking's recorded grades and shared limits rather than the ribbon,
// which also contains class-specific checks, wind context and truth context.
export function comparisonGates({h, r}, {groundMode = null} = {}) {
    const m = h.metricsFull;
    const scale = fitScaleDeg(h);
    const losLimit = scale === null ? BROAD_SCREEN_LIMITS.losDeg : scale * FIT_SCALE_TIERS[0];
    const rejected = r.rank < 0 || !!h.groundMismatch;
    const notRun = () => cell("unknown", "Not assessed", "Candidate rejected before this check");
    const mirror = h.platformMirror;
    const pins = [...new Set(h.boundPinned || [])];
    const warnings = [...new Set(h.optimizerWarnings || [])];
    const ground = h.groundStats;
    const mode = groundMode ?? h.groundMismatch?.mode;
    const contactField = {"On the ground": "maxAGL", "Starts on ground": "startAGL", "Ends on ground": "endAGL"}[mode];
    return [
        {key: "valid", label: "Path validity", cell: rejected
            ? cell("fail", r.label, r.reasons?.[0])
            : cell("pass", "Finite path and ranking metrics", "No non-physical endpoints or invalid ranking metrics reported")},
        {key: "terrain", label: "Terrain clearance", cell: Number.isFinite(ground?.minAGL) && Number.isFinite(ground?.fracBelow)
            ? cell(h.underground ? "fail" : "pass", `Minimum ${number(ground.minAGL, 1)} m; ${number(ground.fracBelow * 100, 1)}% below tolerance`,
                `Fails if ≥ ${UNDERGROUND_MIN_FRACTION * 100}% of samples are more than ${UNDERGROUND_TOL} m below sampled terrain.`)
            : cell("unknown", "Not assessed", "Terrain samples unavailable; this does not block the current ranking.")},
        {key: "ground", label: "Ground-contact mode", cell: contactField
            ? {...limitCell(ground?.[contactField], GROUND_CONTACT_TOL, "m", 1, !h.groundMismatch),
                value: `${mode}: ${number(ground?.[contactField], 1)} m above terrain`}
            : cell(mode === "Airborne (any)" ? "pass" : "unknown", mode || "Mode not recorded",
                mode === "Airborne (any)" ? "No ground-contact constraint; terrain rejection still applies" : "Cannot display this check without the saved mode")},
        {key: "los", label: "Mean LOS error", cell: rejected ? notRun()
            : limitCell(h.errDeg, losLimit, "°", 5, r.fitRank === 3, scale !== null)},
        {key: "g", label: "Peak acceleration", cell: rejected ? notRun()
            : limitCell(m?.gLoad?.max, BROAD_SCREEN_LIMITS.peakG, "g", 2, m?.gLoad?.max <= BROAD_SCREEN_LIMITS.peakG)},
        {key: "speed", label: "Peak speed used by screen", cell: rejected ? notRun()
            : {...limitCell(m?.airSpeed?.max / KNOTS_TO_MS, BROAD_SCREEN_LIMITS.speedKt, "kt", 1,
                m?.airSpeed?.max / KNOTS_TO_MS <= BROAD_SCREEN_LIMITS.speedKt),
                value: `${number(m?.airSpeed?.max / KNOTS_TO_MS, 1)} kt (${h.params?.motionFrame === "ground" ? "ground" : "air"})`}},
        {key: "mirror", label: "Camera-motion mirroring", cell: rejected ? notRun()
            : !Number.isFinite(mirror?.share) || !Number.isFinite(mirror?.snr)
                ? cell("unknown", "Not assessed", "Geometry does not support this check; no penalty applied.")
                : cell(r.mirrorRank === 3 ? "pass" : "fail", `${number(100 * mirror.share, 1)}% share; ${number(mirror.snr, 2)}× resolving scale`,
                    `Fails at ≥ ${100 * MIRROR_PARTIAL_SHARE}% share AND ≥ ${MIRROR_MIN_SNR}× resolving scale.`)},
        {key: "pins", label: "Active model limits", cell: rejected ? notRun()
            : cell(pins.length ? "fail" : "pass", `${pins.length} reached`, pins.length ? pins.join(", ") : "Required: 0 load-bearing limits reached")},
        {key: "bounds", label: "Search boundary", cell: rejected ? notRun()
            : cell(h.params?.boundaryLimited ? "fail" : "pass", h.params?.boundaryLimited ? "Family reaches boundary" : "No boundary warning",
                h.params?.boundaryLimited ? (h.searchBounds || []).join(", ") : "Required: supported family stays inside the search")},
        {key: "optimizer", label: "Search completion", cell: rejected ? notRun()
            : cell(warnings.length ? "fail" : "pass", warnings.length ? "Incomplete" : "No completion warning",
                warnings.length ? warnings.join("; ") : "Required: no unfinished-search warning; not proof of a global optimum")},
    ];
}

function compatibilityCells(h, dataset) {
    const checks = physicalClassChecks(dataset, h);
    if (!checks) return [];
    return checks.classes.map(c => {
        const unknown = [];
        if (!c.impliedM) unknown.push("size");
        if (![c.speedMinKt, c.speedMaxKt].every(Number.isFinite)) unknown.push("speed");
        if (!Number.isFinite(checks.gMax)) unknown.push("acceleration");
        if (c.key === "balloon" && !checks.motion) unknown.push("drift shape");
        const sizeConflict = checks.angularSize?.status === "conflict";
        const failed = c.total > 0 || c.motionRejected || sizeConflict;
        const details = [
            `${c.speedBasis === "horizontal" ? "Horizontal " : ""}${h.params?.motionFrame === "ground" ? "Ground" : "Air"} speed: ${number(c.speedMinKt, 1)}–${number(c.speedMaxKt, 1)} kt (allowed ${c.cls.speedKt.map(v => number(v, 1)).join("–")} kt)`,
            `Peak: ${number(checks.gMax, 2)} g (≤ ${number(c.cls.gMax, 2)} g)`,
            c.impliedM ? `Size: ${c.impliedM.oneSided ? "≤ " : `${number(c.impliedM.lo, 2)}–`}${number(c.impliedM.hi, 2)} m (class ${c.cls.sizeM.join("–")} m; intervals must overlap)` : checks.sizeOff ? "Size not assessed: angular-size judging is off" : "Size unmeasured",
        ];
        if (c.key === "balloon" && checks.motion) {
            details.push(checks.motion.horizontalPathM >= 20
                ? `Steady drift: ${number(100 * checks.motion.horizontalDirectness, 1)}% net displacement / distance (≥ 45%)`
                : "Under 20 m horizontal travel; no steady-drift rejection");
        }
        const failures = [c.speedCost > 0 && "speed", c.gCost > 0 && "acceleration", c.sizeCost > 0 && "size",
            c.motionRejected && "steady drift", sizeConflict && "angular-size change"].filter(Boolean);
        const unknownText = unknown.map(k => k === "size" && checks.sizeOff ? "size judging off" : `${k} unknown`).join(", ");
        return {key: c.key, label: c.label, cell: cell(failed ? "fail" : unknown.length ? "partial" : "pass",
            failed ? `Outside limits: ${failures.join(", ")}` : unknown.length
                ? `Passes measured checks · ${unknownText}` : "Within tested limits",
            details.join("\n") + (unknown.length ? `\nUnassessed: ${unknown.join(", ")}` : ""))};
    });
}

export function buildTraverseComparison(left, right, dataset, options) {
    const items = [left, right];
    const scores = items.map(({h, r}) => Number.isFinite(r.secondaryScore) ? botScoreBreakdown(h) : null);
    const decision = rankingDecision(left, right, {useTruth: false});
    const better = decision.delta <= 0 ? left : right;
    const other = better === left ? right : left;
    const explanation = rankingPlacementExplanation(better, other, {useTruth: false, first: true});
    const gates = items.map(item => comparisonGates(item, options));
    const physical = items.map(({h, r}) => r.rank < 0 ? [] : compatibilityCells(h, dataset));
    const delta = scores.every(s => Number.isFinite(s?.total)) ? scores[1].total - scores[0].total : null;
    const rows = (lists) => [...new Map(lists.flat().map(row => [row.key, row.label])).entries()]
        .map(([key, label]) => ({key, label, cells: lists.map(list => list.find(row => row.key === key)?.cell
            || cell("unknown", "Not assessed", "Physical path metrics unavailable"))}));
    return {items, scores, delta, decision, explanation, gates: rows(gates), physical: rows(physical)};
}

function statusHTML(c) {
    const label = {pass: "Pass", fail: "Fail", unknown: "Unassessed"}[c.status];
    return (label ? `<span class="tc-status tc-${c.status}">${label}</span> ` : "") + `<b>${escape(c.value)}</b>`
        + (c.detail ? `<small>${escape(c.detail).replace(/\n/g, "<br>")}</small>` : "");
}

export function traverseComparisonHTML(comparison) {
    const {items, scores, delta, explanation, decision} = comparison;
    const names = items.map(({h}) => escape(h.name));
    const headers = extra => `<thead><tr><th scope="col">Measure</th>${names.map(n => `<th scope="col">${n}</th>`).join("")}${extra || ""}</tr></thead>`;
    const rowsHTML = rows => rows.map(row => `<tr><th scope="row">${escape(row.label)}</th>`
        + row.cells.map(c => `<td>${statusHTML(c)}</td>`).join("") + "</tr>").join("");
    const signed = v => Number.isFinite(v) ? `${v > 0 ? "+" : ""}${v.toFixed(3)}` : "—";
    const scoreKeys = scores.find(Boolean)?.terms || [];
    const deltas = scoreKeys.map((_, i) => scores.every(Boolean) ? scores[1].terms[i].contribution - scores[0].terms[i].contribution : NaN);
    const largest = deltas.length ? Math.max(...deltas.map(Math.abs)) : 0;
    const scoreRows = scoreKeys.map((term, i) => `<tr${largest > 0 && Math.abs(deltas[i]) === largest ? ' class="tc-largest"' : ""}>`
        + `<th scope="row">${escape(term.label)}<small>${escape(term.formula)}</small></th>`
        + scores.map(score => {
            const t = score?.terms[i];
            return `<td>${t ? `<b>${number(t.contribution)}</b><small>${number(t.value, t.digits)} ${escape(t.unit)}</small>` : "Unavailable"}</td>`;
        }).join("") + `<td class="tc-delta">${signed(deltas[i])}</td></tr>`).join("");
    const summary = delta !== null && decision.key === "score"
        ? `${items.every(x => x.r.eligible) ? "Both pass all ranking gates. " : "Earlier ranking checks tie. "}${escape(delta >= 0 ? items[0].h.name : items[1].h.name)} has the lower BOT Score by ${number(Math.abs(delta))}. This is a heuristic tie-break.`
        : escape(explanation.text);
    return `<p class="tc-summary">${summary}</p>`
        + `<h3>BOT Score</h3><p class="tc-note">Lower is better. Weighted contributions add to the total. Difference = right − left; positive favors the left. The largest difference is highlighted.</p>`
        + `<div class="tc-scroll"><table>${headers('<th scope="col">Difference</th>')}<tbody>${scoreRows}`
        + `<tr class="tc-total"><th scope="row">Total BOT Score</th>${scores.map(s => `<td>${number(s?.total)}</td>`).join("")}<td>${signed(delta)}</td></tr></tbody></table></div>`
        + `<p class="tc-note">No pass/fail cutoff or probability. Values are rounded; totals use full precision. Camera-motion adjustment is zero when mirroring is not significant or cannot be assessed.</p>`
        + `<h3>Gates for a full pass</h3><p class="tc-note">These checks decide before the BOT Score. A pass can be close to a limit. Unassessed checks are marked explicitly; the current ranking may still pass.</p>`
        + `<div class="tc-scroll"><table>${headers()}<tbody>${rowsHTML(comparison.gates)}</tbody></table></div>`
        + `<h3>Physical compatibility</h3><p class="tc-note">The same class limits apply to both paths, regardless of solver. These checks do not change the BOT Score or establish an object type. Missing measurements are named beside the result.</p>`
        + (comparison.physical.length
            ? `<div class="tc-scroll"><table>${headers()}<tbody>${rowsHTML(comparison.physical)}</tbody></table></div>`
            : `<p class="tc-note">Physical compatibility is unavailable for these rejected or unmeasured paths.</p>`);
}
