// ScriptParser.js — pure text → events parser for the Scripted Video language.
//
// Script language (one command per line, '#' outside quotes starts a comment):
//
//   view  <main|look>            cut to a view (instant, 0s)
//   text  "caption"  <secs>      overlay caption (does NOT advance the timeline)
//   zoom  <object>   <secs> [m]  dolly the camera in toward an object over <secs>
//   orbit <object>   <secs> [deg]orbit the camera around an object over <secs>
//   track <object>   <secs>      hold position, keep looking at a (moving) object
//   fov   <degrees>  <secs>      change the camera FOV (optical zoom) over <secs>
//   wait  <secs>                 hold the current camera
//
// Concurrency: a line with NO leading & is a "spine" line and starts when the
// previous spine line finished. A line WITH a leading & is concurrent and
// attaches to the current spine line's start ("&" = at its start, "&N" = N
// seconds after its start). Concurrent lines don't advance the spine.
//
// This module is pure (no DOM / scene access) — see ScriptCommands.js for the
// per-command parse hooks it drives.

import {resolveCommand} from "./ScriptCommands";

// Split a line into tokens, treating "quoted strings" as one token. Each token
// also carries its character span within `line` ({text,start,end}), so the parser
// can record exactly where each editable number lives, enabling number<->timeline-
// segment cross-highlighting and scroll-wheel duration editing from the timeline.
export function tokenizeWithPos(line) {
    const out = [];
    const re = /"([^"]*)"|(\S+)/g;
    let m;
    while ((m = re.exec(line)) !== null) {
        out.push({text: m[1] !== undefined ? m[1] : m[2], start: m.index, end: m.index + m[0].length});
    }
    return out;
}

// Assign each timed event to a horizontal "lane" so overlapping events stack on
// separate rows in the timeline display. Returns the lane count.
function assignLanes(events) {
    const timed = events.filter((e) => e.dur > 0).sort((a, b) => a.start - b.start || a.line - b.line);
    const laneEnds = [];
    for (const e of timed) {
        let placed = false;
        for (let i = 0; i < laneEnds.length; i++) {
            if (e.start >= laneEnds[i] - 1e-6) { e._lane = i; laneEnds[i] = e.start + e.dur; placed = true; break; }
        }
        if (!placed) { e._lane = laneEnds.length; laneEnds.push(e.start + e.dur); }
    }
    return Math.max(1, laneEnds.length);
}

// Parse a whole script. Returns {events, cameraBeats, totalDuration, errors, numLanes}.
export function parseScript(text) {
    const events = [];
    const cameraBeats = [];
    let spineStart = 0;   // start time of the most recent spine line
    let spineEnd = 0;     // end time of the most recent spine line
    let maxEnd = 0;
    const errors = [];

    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const fullLine = lines[i];
        // strip a trailing comment, but only a # OUTSIDE quotes — a # inside a
        // quoted caption (text "Flight #2" 4) is part of the caption
        let hash = -1, inQuote = false;
        for (let c = 0; c < fullLine.length; c++) {
            const ch = fullLine[c];
            if (ch === '"') inQuote = !inQuote;
            else if (ch === "#" && !inQuote) { hash = c; break; }
        }
        const body = hash >= 0 ? fullLine.slice(0, hash) : fullLine;
        const leadWS = (body.match(/^\s*/) || [""])[0].length;
        let raw = body.slice(leadWS);
        if (raw.trim().length === 0) continue;

        // leading & concurrency prefix. contentStart = char offset (within the
        // ORIGINAL line) where the command tokens begin, so token spans map back
        // to the textarea text. offSpan = the &N offset number's span (if any).
        let concurrent = false, start, contentStart = leadWS, offSpan = null;
        const amp = raw.match(/^&(\d*\.?\d*)\s*(.*)$/);
        if (amp) {
            concurrent = true;
            const off = amp[1] === "" ? 0 : parseFloat(amp[1]);
            start = spineStart + (isNaN(off) ? 0 : off);
            contentStart = leadWS + (amp[0].length - amp[2].length);
            if (amp[1] !== "") offSpan = {start: leadWS + 1, end: leadWS + 1 + amp[1].length};
            raw = amp[2];
        } else {
            start = spineEnd;   // wait until previous (spine) line completed
        }

        const tokensP = tokenizeWithPos(raw)
            .map((t) => ({text: t.text, start: t.start + contentStart, end: t.end + contentStart}));
        const tokens = tokensP.map((t) => t.text);
        if (tokens.length === 0) continue;
        const cmd = tokens[0].toLowerCase();
        const num = (s) => { const v = parseFloat(s); return isNaN(v) ? null : v; };
        // span of token idx, but only if it's a CLEAN numeric token — a malformed
        // token like "4hen" parses (parseFloat=4) yet must not be wheel-editable,
        // or editing it would silently truncate the line.
        const numSpan = (idx) => {
            const t = tokensP[idx];
            return (t && /^\d*\.?\d+$/.test(t.text)) ? {start: t.start, end: t.end} : null;
        };

        const resolved = resolveCommand(cmd);
        if (!resolved) { errors.push(`line ${i + 1}: unknown command "${tokens[0]}"`); continue; }

        const error = (msg) => { errors.push(`line ${i + 1}: ${msg}`); return null; };
        const partial = resolved.def.parse({cmd, tokens, num, numSpan, error});
        if (!partial) continue;

        const ev = {type: resolved.type, start, dur: 0, line: i + 1, concurrent, ...partial};
        if (ev.dur < 0) { errors.push(`line ${i + 1}: negative duration ${ev.dur}s`); continue; }
        ev.offSpan = offSpan;
        events.push(ev);
        if (resolved.def.cameraBeat) cameraBeats.push(ev);
        maxEnd = Math.max(maxEnd, start + ev.dur);
        if (!concurrent) { spineStart = start; spineEnd = start + ev.dur; }  // advance the spine
    }

    // camera beats sorted by start (for latest-start-wins resolution)
    cameraBeats.sort((a, b) => a.start - b.start);

    return {events, cameraBeats, totalDuration: maxEnd, errors, numLanes: assignLanes(events)};
}

// which friendly view name is active at time t (last "view" cut at or before t)
export function activeViewAt(events, defaultView, t) {
    let v = defaultView;
    for (const e of events) {
        if (e.type === "view" && e.start <= t + 1e-6) v = e.view;
    }
    return v;
}
