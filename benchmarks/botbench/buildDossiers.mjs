// buildDossiers.mjs — select escalation-pilot cases from the tractability
// records and emit truth-blind dossiers + a separate answer key.
//
//     node benchmarks/botbench/buildDossiers.mjs
//
// Case selection covers the four behaviors the pilot must probe:
//   - found-but-refused (dash: rank-1 fit near truth, class blocked)
//   - honest abstentions on mundane data (aguadilla, burst, circuits)
//   - true anomalies the verdict abstained on (gofast-anom, hover-anom)
//   - a confident WRONG answer (hypersonic-glide, consistent-one at 0.93)
//   - a clean solve as the do-no-harm control (gofast)
//
// Output: results/escalation/case-<id>.md (dossier, truth-blind) and
// results/escalation/keys.json (scoring key — never shown to the agent).

import fs from "fs";
import path from "path";
import {fileURLToPath} from "url";
import {buildDossier, buildAnswerKey} from "./lib/dossier.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, "results", "tractability");
const OUT = path.join(HERE, "results", "escalation");

const files = fs.readdirSync(DIR).filter((f) => f.startsWith("records") && f.endsWith(".jsonl"))
    .map((f) => path.join(DIR, f))
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
const byKey = new Map();
for (const f of files) {
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const r = JSON.parse(line);
        byKey.set(`${r.setId}|${r.label}`, r);
    }
}

const WANT = [
    "real|dash", "real|aguadilla", "real|burst", "real|circuits",
    "real|gofast-anom", "real|hover-anom", "maneuver|hypersonic-glide",
    "real|gofast",
];

fs.mkdirSync(OUT, {recursive: true});
const keys = {};
let i = 0;
for (const want of WANT) {
    const r = byKey.get(want);
    if (!r || r.error) { console.error(`missing/errored: ${want}`); continue; }
    i++;
    const caseId = `C${String(i).padStart(2, "0")}`;
    fs.writeFileSync(path.join(OUT, `case-${caseId}.md`),
        buildDossier(r, {caseId}));
    keys[caseId] = buildAnswerKey(r);
}
fs.writeFileSync(path.join(OUT, "keys.json"), JSON.stringify(keys, null, 2));
console.log(`wrote ${i} dossiers + keys.json to ${OUT}`);
