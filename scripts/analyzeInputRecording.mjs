#!/usr/bin/env node
// Read server JSONL directly or a private local copy. Does not contact a service.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {pathToFileURL} from 'node:url';

export async function summarizeInputRecordings(inputs) {
    const sessions = new Map();
    const paths = new Map();
    const candidates = [];
    let malformedLines = 0;
    function *files(input) {
        const stat = fs.statSync(input);
        if (!stat.isDirectory()) { yield input; return; }
        for (const entry of fs.readdirSync(input, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
            if (entry.isDirectory()) yield *files(path.join(input, entry.name));
            else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield path.join(input, entry.name);
        }
    }
    for (const input of inputs) for (const file of files(input)) {
        const lines = readline.createInterface({input: fs.createReadStream(file), crlfDelay: Infinity});
        for await (const line of lines) {
            if (!line.trim()) continue;
            let e;
            try { e = JSON.parse(line); } catch (_) { malformedLines++; continue; }
            if (e.schema !== 1 || !e.session || !Number.isSafeInteger(e.seq) || !Number.isFinite(e.ts)) {
                malformedLines++; continue;
            }
            const key = `${e.user_id}/${e.session}`;
            let s = sessions.get(key);
            if (!s) {
                s = {user: e.user_id, session: e.session, first: e.ts, last: e.ts, events: 0,
                    types: {}, errors: 0, dropped: 0, lastSeq: 0, clicks: [], build: null, sitches: new Set()};
                sessions.set(key, s);
            }
            // Server files are in sequence order; repeated input paths/copies are harmless.
            if (e.seq <= s.lastSeq) continue;
            s.lastSeq = e.seq;
            s.first = Math.min(s.first, e.ts); s.last = Math.max(s.last, e.ts);
            s.events++; s.types[e.type] = (s.types[e.type] || 0) + 1;
            if (e.build) s.build = e.build;
            if (e.context?.sitch) s.sitches.add(e.context.sitch);
            if (e.type === 'error') s.errors++;
            if (e.type === 'gap') s.dropped += e.count || 0;
            const target = e.target?.path;
            if (target && ['click', 'change', 'control_finish'].includes(e.type)) paths.set(target, (paths.get(target) || 0) + 1);
            if (e.type === 'click') {
                s.clicks = s.clicks.filter(click => e.ts - click.ts <= 1000 && click.path === target);
                s.clicks.push({ts: e.ts, seq: e.seq, path: target});
                if (s.clicks.length === 3 && candidates.length < 200) candidates.push({kind: 'rapid_repeated_clicks',
                    user: e.user_id, session: e.session, path: target, firstSeq: s.clicks[0].seq, lastSeq: e.seq, ts: e.ts});
            }
            if (e.type === 'error' && candidates.length < 200) candidates.push({kind: 'error',
                user: e.user_id, session: e.session, seq: e.seq, ts: e.ts, name: e.name, file: e.file, line: e.line});
        }
    }
    return {schema: 1, malformedLines,
        sessions: [...sessions.values()].map(({clicks, sitches, ...s}) => ({...s, sitches: [...sitches],
            start: new Date(s.first).toISOString(), durationSeconds: (s.last - s.first) / 1000})),
        frequentControls: [...paths].sort((a, b) => b[1] - a[1]).slice(0, 50).map(([path, count]) => ({path, count})),
        reviewCandidates: candidates,
        note: 'Candidates are clues, not confirmed UI defects. Read nearby event sequences and reproduce the interaction.'};
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const inputs = process.argv.slice(2);
    if (!inputs.length) {
        console.error('Usage: node scripts/analyzeInputRecording.mjs <file.jsonl or recording-directory> [...]');
        process.exitCode = 1;
    } else {
        try { console.log(JSON.stringify(await summarizeInputRecordings(inputs), null, 2)); }
        catch (error) { console.error(error.message); process.exitCode = 1; }
    }
}
