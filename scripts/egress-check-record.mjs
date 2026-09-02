#!/usr/bin/env node
// User data egress check — composes the public record.
//
// Reads the working directory the workflow fills in (.egress/): scan.json and scan.md from
// scripts/security-scan-egress.mjs, and review.md / review.exit / review.stderr from the
// LLM review. Decides the overall verdict and writes:
//   comment.md   the record posted as a comment on the commit (permanent and public)
//   verdict.txt  CLEAR, ATTENTION or INCOMPLETE — the workflow's exit status follows it
//
// Usage:
//   node scripts/egress-check-record.mjs --dir .egress --model NAME --run-url URL
//        [--repo-url URL] [--range a..b] [--max-credits N]

import fs from 'node:fs';
import path from 'node:path';

function arg(name, dflt = '') {
    const i = process.argv.indexOf(name);
    return i === -1 || i + 1 >= process.argv.length ? dflt : process.argv[i + 1];
}

const dir = path.resolve(arg('--dir', '.egress'));
const model = arg('--model', 'unknown model');
const runUrl = arg('--run-url');
const repoUrl = arg('--repo-url');
const maxCredits = arg('--max-credits');

const readIf = f => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : null);
const scanRaw = readIf('scan.json');
const scan = scanRaw ? JSON.parse(scanRaw) : null;
const scanMd = readIf('scan.md') || '';
const reviewMd = (readIf('review.md') || '').trim();
const reviewExit = (readIf('review.exit') || '').trim();
const reviewErr = (readIf('review.stderr') || '').trim();
const range = arg('--range', scan?.range || '');

// ─── The review's own verdict ─────────────────────────────────────────────────────────
let review;
if (!scan) {
    review = {status: 'missing', verdict: null, note: 'the scan did not run'};
} else if (scan.filesInScope.length === 0) {
    review = {status: 'skipped', verdict: 'CLEAR', note: 'no code changed in this push, so no review was needed'};
} else {
    const m = reviewMd.match(/^\s*Verdict:\s*(CLEAR|ATTENTION)\b/i);
    if (m) review = {status: 'done', verdict: m[1].toUpperCase(), note: ''};
    else if (reviewMd) review = {status: 'incomplete', verdict: null, note: 'the review did not begin with a verdict line'};
    else review = {status: 'incomplete', verdict: null, note: `the review produced no output (exit code ${reviewExit || 'unknown'})`};
}

// ─── Overall ──────────────────────────────────────────────────────────────────────────
let overall;
if (!scan || review.status === 'incomplete' || review.status === 'missing') overall = 'INCOMPLETE';
else if (scan.verdict === 'ATTENTION' || review.verdict === 'ATTENTION') overall = 'ATTENTION';
else overall = 'CLEAR';

// ─── comment.md ───────────────────────────────────────────────────────────────────────
const shortSha = s => s.replace(/[0-9a-f]{40}/g, m => m.slice(0, 7));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const cap = (text, limit) => (text.length > limit
    ? text.slice(0, limit) + `\n\n… truncated (${text.length - limit} more characters; the full text is in the workflow run's artifact for 90 days)`
    : text);

const facts = [`**Verdict: ${overall}**`];
if (range) facts.push(`range \`${shortSha(range)}\``);
if (scan) {
    facts.push(plural(scan.filesInScope.length, 'file') + ' in scope');
    facts.push(`scan: ${plural(scan.sinks.length, 'sink')} on added lines, ` +
        `${scan.unknownHosts.length + scan.unknownEndpoints.length} unlisted, ${scan.overBudget.length} over contract`);
}
facts.push(review.status === 'done' ? `review: ${model}` : `review: ${review.status}`);
if (runUrl) facts.push(`[workflow run](${runUrl})`);

const lines = [];
lines.push('### User data egress check');
lines.push(facts.join(' · '));
lines.push('');
if (scan?.reasons?.length) {
    lines.push('Scan: ' + scan.reasons.join('; ') + '.');
    lines.push('');
}
if (review.status !== 'done') {
    lines.push(`Review: ${review.note}.`);
    lines.push('');
}

lines.push('<details><summary>Review</summary>');
lines.push('');
if (review.status === 'done') lines.push(cap(reviewMd, 20000));
else {
    lines.push(`_${review.note}._`);
    if (reviewErr) lines.push('', '```', cap(reviewErr, 2000), '```');
}
lines.push('');
lines.push('</details>');
lines.push('');
lines.push('<details><summary>Automated scan</summary>');
lines.push('');
lines.push(scanMd ? cap(scanMd, 30000) : '_no scan output_');
lines.push('');
lines.push('</details>');
lines.push('');

const docLink = repoUrl ? `${repoUrl}/blob/main/docs/UserDataEgressCheck.md` : 'docs/UserDataEgressCheck.md';
lines.push(`<sub>User Data Egress Check${maxCredits ? `, review capped at ${maxCredits} AI credits` : ''}. ` +
    `What it checks and how to read the result: ${docLink}</sub>`);

fs.mkdirSync(dir, {recursive: true});
fs.writeFileSync(path.join(dir, 'comment.md'), lines.join('\n') + '\n');
fs.writeFileSync(path.join(dir, 'verdict.txt'), overall + '\n');
console.log(`egress record: ${overall} (scan ${scan?.verdict ?? 'missing'}, review ${review.status}${review.verdict ? ' ' + review.verdict : ''})`);
