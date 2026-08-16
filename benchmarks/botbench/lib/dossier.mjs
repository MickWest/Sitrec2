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

const DEG = 180 / Math.PI;

/**
 * The KINEMATIC PROFILE — a time-resolved, truth-free view of the sightlines.
 *
 * v1 of this dossier reported only SCALAR residual summaries, and the first
 * escalation pilot showed exactly what that costs: every spliced impulse was
 * missed, because a smooth model still fits a spliced track at 0.075-0.151 deg
 * and a single mean-residual number cannot show that the miss is concentrated
 * at one instant. Analysts read "small residual" as "ordinary motion".
 *
 * The fix is to publish what the sightlines say over TIME, at assumed ranges.
 * Angular rate is directly observed. Multiplying it by an assumed range gives
 * the cross-range speed that range would imply — the fast-far ambiguity made
 * explicit rather than hidden: the SAME angular track is a slow near object or
 * a fast far one, and the reader can see both readings side by side. A
 * velocity step appears as a step in every column at once, which is the
 * signature no scalar summary can carry.
 *
 * Truth-blindness: this uses only observedDirectionENU and the declared search
 * bracket. No truth, no fitted track, no generating range.
 */
export function kinematicProfile(observedDirectionENU, n, fps, rangesM) {
    const rateDegPerS = new Float64Array(n);   // frame-to-frame angular rate
    for (let f = 1; f < n; f++) {
        const a = (f - 1) * 3, b = f * 3;
        const dot = Math.max(-1, Math.min(1,
            observedDirectionENU[a] * observedDirectionENU[b]
            + observedDirectionENU[a + 1] * observedDirectionENU[b + 1]
            + observedDirectionENU[a + 2] * observedDirectionENU[b + 2]));
        rateDegPerS[f] = Math.acos(dot) * DEG * fps;
    }
    rateDegPerS[0] = rateDegPerS[1] ?? 0;

    // Decimate to at most ~24 rows so the table is readable at any clip length,
    // but keep the PEAK row: a one-frame impulse must survive decimation, and
    // averaging it away would reintroduce exactly the defect this section fixes.
    const stride = Math.max(1, Math.floor(n / 24));
    let peakF = 1;
    for (let f = 1; f < n; f++) if (rateDegPerS[f] > rateDegPerS[peakF]) peakF = f;
    const rows = [];
    const pushRow = (f) => rows.push({
        t: f / fps,
        rateDegPerS: rateDegPerS[f],
        // speed = range * angular rate (small-angle); one column per assumed range
        speeds: rangesM.map((R) => R * rateDegPerS[f] / DEG),
        peak: f === peakF,
    });
    for (let f = 0; f < n; f += stride) pushRow(f);
    if (!rows.some((r) => r.peak)) pushRow(peakF);
    rows.sort((a, b) => a.t - b.t);

    // Step statistic: the largest single-frame JUMP in angular rate, relative
    // to the median rate. A smooth trajectory keeps this small however fast it
    // is going; a velocity discontinuity spikes it. Reported as a number the
    // reader can weigh, never as a detector verdict.
    const sorted = [...rateDegPerS].sort((a, b) => a - b);
    const medRate = sorted[Math.floor(sorted.length / 2)];
    let maxJump = 0, maxJumpT = 0;
    for (let f = 2; f < n; f++) {
        const j = Math.abs(rateDegPerS[f] - rateDegPerS[f - 1]);
        if (j > maxJump) { maxJump = j; maxJumpT = f / fps; }
    }
    return {rows, medRate, maxJump, maxJumpT,
        jumpRatio: medRate > 0 ? maxJump / medRate : NaN};
}

export function buildDossier(record, {caseId, profile = null}) {
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
        // Name WHICH bound a pin sits on, not just how many pins there are.
        // The first pilot's analysts could see that a fit was pinned but not
        // whether the pinned parameter was decision-relevant (a range bound)
        // or incidental (a wind term), so they discounted every pinned fit
        // equally. The distinction is the difference between "this fit's range
        // is meaningless" and "this fit is fine and the screen is too strict".
        const pinNames = (h.activePins ?? [])
            .map((p) => (typeof p === "string" ? p : (p?.name ?? p?.param ?? "?")))
            .join("/");
        const flags = [
            h.incomplete ? "incomplete" : null,
            h.activePins?.length ? `pins:${h.activePins.length}${pinNames ? `(${pinNames})` : ""}` : null,
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
    if (profile) {
        const rs = profile.ranges;
        L.push("");
        L.push("## Kinematic profile (observed sightlines only — no fit, no truth)");
        L.push("");
        L.push("Angular rate is measured. The speed columns are that rate read at three");
        L.push("ASSUMED ranges: the same sightlines are a slow near object or a fast far");
        L.push("one, and both readings are shown so the ambiguity is explicit. A velocity");
        L.push("discontinuity appears as a step in every column at the same instant.");
        L.push("");
        L.push(`| t (s) | rate (°/s) | speed @ ${Math.round(rs[0] / 1000)} km | @ ${Math.round(rs[1] / 1000)} km | @ ${Math.round(rs[2] / 1000)} km |`);
        L.push("|---|---|---|---|---|");
        for (const r of profile.rows) {
            L.push(`| ${r.t.toFixed(1)}${r.peak ? " *" : ""} | ${fmt(r.rateDegPerS, 3)} `
                + r.speeds.map((s) => `| ${Math.round(s)} m/s `).join("") + "|");
        }
        L.push("");
        L.push(`Largest single-frame jump in angular rate: ${fmt(profile.maxJump, 3)}°/s `
            + `at t=${fmt(profile.maxJumpT, 1)} s, which is ${fmt(profile.jumpRatio, 1)}× the `
            + `median rate (${fmt(profile.medRate, 3)}°/s). A smooth trajectory keeps this `
            + "ratio small however fast it is travelling; this is a number to weigh, not a verdict.");
        L.push("`*` marks the peak-rate frame, preserved through decimation.");
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
