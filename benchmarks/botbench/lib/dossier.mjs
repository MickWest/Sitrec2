// dossier.mjs — build a TRUTH-BLIND analyst dossier from one tractability
// record, for the escalation experiment: can an AI agent add value on a case
// the automated verdict left ambiguous?
//
// The blindness rule is absolute: nothing derived from truth may appear.
// Excluded: truthSepM, derived.*RelSep, familyCoverage (computed against
// truth), meanTruthRangeM, anomalousDeclared, the target block of the spec,
// and the scenario label (labels name the case and sometimes the answer).
//
//     node -e "import('./benchmarks/botbench/lib/dossier.mjs').then(m => ...)"

const fmt = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");

export function buildDossier(record, {caseId}) {
    const o = record.outcome;
    const t = record.triage;
    const L = [];
    L.push(`# Case ${caseId} — bearings-only analysis dossier`);
    L.push("");
    L.push("You are given the OUTPUT of an automated bearings-only traverse analysis");
    L.push("of an unknown airborne object filmed from an airborne sensor. Positions");
    L.push("are unknown; only sightline directions were measured. The analysis fits");
    L.push("candidate object classes and ranks them. Truth is withheld.");
    L.push("");
    L.push("## Observation");
    L.push(`- ${t.n} samples at ${t.fps} Hz (${t.durationSeconds} s), FOV ${t.fovFullDeg}°, declared noise: ${t.observationKind}`);
    L.push(`- LOS sweep ${fmt(t.losSweepDeg, 1)}°, mean rate ${fmt(t.losMeanRateDegPerS, 2)}°/s, lag-1 autocorr ${fmt(t.losLag1Autocorr, 2)}`);
    L.push(`- Sensor path length ${fmt(t.sensorPathLengthM, 0)} m, span ${fmt(t.sensorSpanM, 0)} m`);
    L.push(`- CV-design conditioning log10(rcond) = ${fmt(t.cvDesignLog10RcondObserved, 2)}`);
    L.push("  (empirically: below -3 the linear-estimator family collapses 84% of the time;");
    L.push("   above -1, 0%. This grades the GEOMETRY, not any particular object.)");
    L.push("");
    L.push("## Search bracket");
    L.push(`- Requested ${fmt(o.requestedRangeLoM, 0)}-${fmt(o.requestedRangeHiM, 0)} m, resolved ${fmt(o.resolvedRangeLoM, 0)}-${fmt(o.resolvedRangeHiM, 0)} m (fixed 20 NM anchor policy)`);
    L.push("");
    L.push("## Automated verdict");
    L.push(`- Code: **${o.executive.code}** — "${o.executive.headline}"`);
    L.push("");
    L.push("## Hypotheses (as ranked; errDeg = mean angular residual)");
    L.push("");
    L.push("| rank | tier | eligible | hypothesis | errDeg | band lo-hi (m) | flags |");
    L.push("|---|---|---|---|---|---|---|");
    for (const h of o.hypotheses) {
        const flags = [
            h.incomplete ? "incomplete" : null,
            h.activePins?.length ? `pins:${h.activePins.length}` : null,
            h.modelClamps?.length ? `clamps:${h.modelClamps.length}` : null,
        ].filter(Boolean).join(",");
        const band = h.band && Number.isFinite(h.band.loM)
            ? `${Math.round(h.band.loM)}-${Math.round(h.band.hiM)}` : "";
        L.push(`| ${h.rank} | ${h.tier} | ${h.eligible ? "yes" : ""} | ${h.name} `
            + `| ${fmt(h.errDeg)} | ${band} | ${flags} |`);
    }
    L.push("");
    L.push("## Class screening");
    for (const c of o.classes) {
        L.push(`- ${c.key}: ${c.viable ? "viable" : "not viable"}`
            + (c.blocker ? ` — blocker: ${c.blocker}` : "")
            + (Number.isFinite(c.bestErrDeg) ? ` (best ${fmt(c.bestErrDeg)}°)` : ""));
    }
    if (o.failures?.length) {
        L.push("");
        L.push(`## Solver failures: ${o.failures.map((f) => String(f).slice(0, 60)).join("; ")}`);
    }
    L.push("");
    L.push("## Your task");
    L.push("1. State the most likely object class and a range estimate WITH an honest");
    L.push("   uncertainty statement, or state that the case cannot be resolved and why.");
    L.push("2. Say whether anything here suggests a GENUINELY anomalous object");
    L.push("   (motion outside every candidate class's physical envelope), as opposed");
    L.push("   to ordinary ambiguity. Anomaly claims need specific evidence.");
    L.push("3. Name the ONE additional measurement or computation that would most");
    L.push("   reduce the ambiguity (e.g. a specific platform maneuver, a longer clip,");
    L.push("   a specific re-fit), and say what result would discriminate.");
    L.push("Answer in under 300 words. Numbers over prose.");
    return L.join("\n");
}

// Truth key for SCORING an agent's answer later — kept separate from the
// dossier so a scorer can be handed both while the agent sees only the first.
export function buildAnswerKey(record) {
    return {
        truthKind: record.outcome?.truthKind ?? null,
        truthFamily: record.outcome?.truthFamily ?? null,
        anomalousDeclared: record.anomalousDeclared,
        meanTruthRangeM: record.meanTruthRangeM,
        bestRelSep: record.derived?.bestRelSep ?? null,
        topRelSep: record.derived?.topRelSep ?? null,
        label: record.label, setId: record.setId,
    };
}
