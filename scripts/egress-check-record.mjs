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
    // A verdict counts only from a run that finished, which means an exit file that reads
    // 0. A run that ended early (the credit cap, a crash, a job timeout that cancelled the
    // step before it wrote the exit file) may still have printed a verdict line first.
    const exitCode = /^\d+$/.test(reviewExit) ? Number(reviewExit) : null;
    // The verdict is not always on the first line, whatever the prompt asks for: the model
    // sometimes prints a sentence that announces its plan ahead of it. So the line counts
    // from anywhere in the output — but only where it stands alone, and never from inside
    // a fenced block, because a review that quotes this prompt's own example lines back
    // must not be read as a verdict. A blockquote, a heading and a line that continues
    // past the word are all rejected for the same reason. Where the output states both,
    // the more serious wins, so that a stray line can never turn an ATTENTION into a CLEAR.
    const verdictLine = /^ {0,3}(?:\*\*|__)?Verdict:[ \t]*(CLEAR|ATTENTION)(?:\*\*|__)?[ \t]*\.?[ \t]*$/i;
    // A fence closes only on the same character, at least as long as the one that opened
    // the block, and with nothing else on its line — the CommonMark rule. A plain toggle
    // would let a three-backtick example nested inside a four-backtick block close the
    // outer block and re-expose the very lines it quotes.
    const fenceAt = line => line.match(/^ {0,3}((?:`{3,})|(?:~{3,}))(.*)$/);
    const stated = [];
    let fence = null;
    for (const line of reviewMd.split('\n')) {
        const at = fenceAt(line);
        if (fence) {
            if (at && at[1][0] === fence[0] && at[1].length >= fence.length && !at[2].trim()) fence = null;
            continue;
        }
        // An unterminated fence stays open to the end of the output. That drops every later
        // line, which is the safe direction: a missing verdict is INCOMPLETE, never CLEAR.
        if (at) { fence = at[1]; continue; }
        const hit = line.match(verdictLine);
        if (hit) stated.push(hit[1].toUpperCase());
    }
    const verdict = stated.includes('ATTENTION') ? 'ATTENTION'
        : stated.includes('CLEAR') ? 'CLEAR' : null;
    if (exitCode === null) {
        review = {status: 'incomplete', verdict: null,
            note: `the review did not record an exit status${reviewMd ? '; its output is partial' : ' and produced no output'}`};
    } else if (exitCode !== 0) {
        review = {status: 'incomplete', verdict: null,
            note: `the review ended with exit code ${exitCode}${reviewMd ? ' after partial output' : ' and no output'}`};
    } else if (verdict) review = {status: 'done', verdict, note: ''};
    else if (reviewMd) review = {status: 'incomplete', verdict: null, note: 'the review printed no verdict line'};
    else review = {status: 'incomplete', verdict: null, note: 'the review exited 0 but produced no output'};
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
    if (review.status === 'incomplete' && reviewMd) lines.push('', 'Partial output, not a verdict:', '', cap(reviewMd, 20000));
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
