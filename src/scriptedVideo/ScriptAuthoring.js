// ScriptAuthoring.js - small text helpers for Scripted Video authoring UI.
//
// The script text remains the source of truth. Palette inserts and timeline
// edits use these helpers to generate readable DSL-style lines, rewrite a line,
// then let the parser rebuild the event model.

const BARE_TOKEN_RE = /^[A-Za-z0-9_.,:\\/-]+$/;

export function formatScriptNumber(value, decimals = 1) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "0";
    if (Math.abs(n - Math.round(n)) < 1e-6) return String(Math.round(n));
    return n.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "");
}

export function scriptToken(value) {
    const s = String(value ?? "").trim();
    if (s && BARE_TOKEN_RE.test(s)) return s;
    return JSON.stringify(s);
}

export function scriptValue(value) {
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "number") return formatScriptNumber(value);
    return scriptToken(value);
}

export function buildScriptSnippet(kind, opts = {}) {
    const dur = formatScriptNumber(opts.duration ?? 3);
    const target = scriptToken(opts.target || "target");
    const view = scriptToken(opts.view || "main");
    const caption = scriptToken(opts.caption || "Caption");

    switch (kind) {
        case "text":
            return `text ${caption} ${dur}`;
        case "wait":
            return `wait ${dur}`;
        case "view":
            return opts.duration && Number(opts.duration) > 0
                ? `view ${view} ${dur}`
                : `view ${view}`;
        case "zoom":
            return opts.distance
                ? `zoom ${target} ${dur} ${formatScriptNumber(opts.distance)}`
                : `zoom ${target} ${dur}`;
        case "orbit":
            return `orbit ${target} ${dur} ${formatScriptNumber(opts.degrees ?? 90)}`;
        case "track":
            return `track ${target} ${dur}`;
        case "rise":
            return `rise ${target} ${dur} ${formatScriptNumber(opts.meters ?? 800)}`;
        case "flyto":
            return `flyto ${scriptToken(opts.target || "look")} ${dur}`;
        case "fade":
            return `fade ${view} ${dur} ${formatScriptNumber(opts.to ?? 0)}`;
        case "show":
            return `show ${scriptToken(opts.control || "Control Name")}`;
        case "hide":
            return `hide ${scriptToken(opts.control || "Control Name")}`;
        case "set":
            return `set ${scriptToken(opts.control || "Control Name")} ${scriptValue(opts.value ?? true)}`;
        default:
            return `wait ${dur}`;
    }
}

export function splitLines(text) {
    return String(text ?? "").split("\n");
}

export function replaceLine(text, row, line) {
    const lines = splitLines(text);
    if (row < 0 || row >= lines.length) return text;
    lines[row] = line;
    return lines.join("\n");
}

export function insertLineAfter(text, row, line) {
    const lines = splitLines(text);
    const at = Math.max(0, Math.min(lines.length, row + 1));
    lines.splice(at, 0, line);
    return lines.join("\n");
}

export function deleteLine(text, row) {
    const lines = splitLines(text);
    if (row < 0 || row >= lines.length) return text;
    lines.splice(row, 1);
    return lines.join("\n");
}

export function duplicateLine(text, row) {
    const lines = splitLines(text);
    if (row < 0 || row >= lines.length) return text;
    lines.splice(row + 1, 0, lines[row]);
    return lines.join("\n");
}

export function lineStartIndex(lines, row) {
    let idx = 0;
    for (let i = 0; i < row; i++) idx += lines[i].length + 1;
    return idx;
}

export function replaceNumberSpan(text, row, span, value, opts = {}) {
    const lines = splitLines(text);
    const line = lines[row];
    if (line === undefined || !span) return null;
    const min = opts.min ?? 0;
    const n = Math.max(min, Number(value));
    if (!Number.isFinite(n)) return null;
    const out = formatScriptNumber(n, opts.decimals ?? 1);
    lines[row] = line.slice(0, span.start) + out + line.slice(span.end);
    return {
        text: lines.join("\n"),
        span: {start: span.start, end: span.start + out.length},
        token: out,
    };
}

export function ensureAmpOffsetSpan(text, row) {
    const lines = splitLines(text);
    const line = lines[row];
    if (line === undefined) return null;
    const m = line.match(/^(\s*)&(\d*\.?\d*)/);
    if (!m) return null;
    if (m[2] !== "") {
        return {
            text,
            span: {start: m[1].length + 1, end: m[1].length + 1 + m[2].length},
        };
    }
    const insertAt = m[1].length + 1;
    lines[row] = `${line.slice(0, insertAt)}0${line.slice(insertAt)}`;
    return {
        text: lines.join("\n"),
        span: {start: insertAt, end: insertAt + 1},
    };
}
