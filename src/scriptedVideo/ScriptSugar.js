// ScriptSugar.js — optional DSL-flavored shortcuts for the Scripted Video JS language.
//
// The script language is JavaScript (executed by ScriptJSRunner.js), but a line
// that looks like a classic flat command — `zoom OE-LNC 6`, `& text "cap" 4`,
// `&2 wait 1`, `# comment` — is rewritten into the equivalent JS call before
// compilation. This keeps the friendliest possible syntax for linear shot lists,
// and keeps every script saved by the original line-based DSL working unchanged.
// Raw JS lines pass through untouched.
//
// The rewrite is strictly LINE-PRESERVING: line N of the generated code is line
// N of the source, so call-site capture (ScriptJSCallSites.js) maps events on
// sugar lines back to the right source line with no extra bookkeeping. For each
// sugar line we also record the character spans of its editable numbers
// (duration/distance/degrees/fov/&offset) in the ORIGINAL text — the same spans
// the old DSL tokenizer produced — so wheel-editing works on sugar lines.
//
// Sugar semantics (identical to the old DSL):
//   plain line  →  __sp = cmd(...); await __sp;          sequential "spine"
//   & line      →  atStart(__sp, 0, () => cmd(...));     starts WITH the spine line
//   &N line     →  atStart(__sp, N, () => cmd(...));     N seconds after its start
//   # comment   →  // comment

import {resolveCommand} from "./ScriptCommands";

// Split a line into tokens, treating "quoted strings" as one token. Each token
// carries its character span within `line` ({text,start,end,quoted}) so the
// desugarer can record exactly where each editable number lives.
export function tokenizeWithPos(line) {
    const out = [];
    const re = /"([^"]*)"|(\S+)/g;
    let m;
    while ((m = re.exec(line)) !== null) {
        out.push({text: m[1] !== undefined ? m[1] : m[2], start: m.index,
            end: m.index + m[0].length, quoted: m[1] !== undefined});
    }
    return out;
}

const CLEAN_NUM_RE = /^\d*\.?\d+$/;              // wheel-editable (non-negative, like the DSL)
const NUM_TOKEN_RE = /^-?(\d+\.?\d*|\.\d+)$/;    // emitted as a numeric literal
const BARE_TOKEN_RE = /^[A-Za-z0-9_.,:\\/-]+$/;  // plain target/word → quoted string

// a line starting with one of these is JS, never a typo'd command
const JS_KEYWORDS = new Set(("const let var return if else for while do break continue function async await " +
    "new typeof delete void throw try catch finally switch case default class import export yield " +
    "true false null undefined this").split(" "));

// Cross-line JS lexer state, so a DSL-looking line inside a template literal,
// block comment, or unclosed bracket is never rewritten. stack entries:
// "tpl" (template literal), "block" (block comment), number (brace depth
// inside a template's ${ }). st.depth = net ()[]{} depth in top-level code.
function advanceState(line, st) {
    let i = 0;
    while (i < line.length) {
        const ch = line[i], nx = line[i + 1];
        const top = st.stack[st.stack.length - 1];
        if (top === "block") {
            if (ch === "*" && nx === "/") { st.stack.pop(); i++; }
        } else if (top === "tpl") {
            if (ch === "\\") i++;
            else if (ch === "`") st.stack.pop();
            else if (ch === "$" && nx === "{") { st.stack.push(0); i++; }
        } else if (typeof top === "number") {        // inside a template's ${ }
            if (ch === "{") st.stack[st.stack.length - 1]++;
            else if (ch === "}") { if (top === 0) st.stack.pop(); else st.stack[st.stack.length - 1]--; }
            else if (ch === "`") st.stack.push("tpl");
            else if (ch === "/" && nx === "*") { st.stack.push("block"); i++; }
            else if (ch === "/" && nx === "/") break;
            else if (ch === '"' || ch === "'") i = skipString(line, i);
        } else {                                      // top-level code
            if (ch === "/" && nx === "/") break;
            if (ch === "/" && nx === "*") { st.stack.push("block"); i++; }
            else if (ch === "`") st.stack.push("tpl");
            else if (ch === '"' || ch === "'") i = skipString(line, i);
            else if ("([{".includes(ch)) st.depth++;
            else if (")]}".includes(ch)) st.depth = Math.max(0, st.depth - 1);
        }
        i++;
    }
}

// index of the closing quote (or end of line) for the string opening at i
function skipString(line, i) {
    const q = line[i]; i++;
    while (i < line.length && line[i] !== q) { if (line[i] === "\\") i++; i++; }
    return i;
}

// Try to rewrite one line as sugar. Returns {code, info} or null (raw JS).
// info = {spans, offSpan} for command lines (null for comment-only lines).
function trySugarLine(line) {
    const leadWS = line.match(/^\s*/)[0].length;
    let body = line.slice(leadWS);
    if (body === "") return null;
    const indent = line.slice(0, leadWS);
    if (body[0] === "#") return {code: indent + "//" + body.slice(1), info: null};

    // leading & concurrency prefix (offset number's span recorded for wheel-edit)
    const amp = body.match(/^&(\d*\.?\d*)\s*/);
    let off = 0, offSpan = null, contentStart = leadWS;
    if (amp) {
        off = amp[1] === "" ? 0 : parseFloat(amp[1]);
        if (isNaN(off)) off = 0;
        if (amp[1] !== "") offSpan = {start: leadWS + 1, end: leadWS + 1 + amp[1].length};
        contentStart = leadWS + amp[0].length;
        body = body.slice(amp[0].length);
    }

    // strip a trailing comment, but only a # OUTSIDE quotes — a # inside a
    // quoted caption (text "Flight #2" 4) is part of the caption
    let hash = -1, inQ = false;
    for (let i = 0; i < body.length; i++) {
        if (body[i] === '"') inQ = !inQ;
        else if (body[i] === "#" && !inQ) { hash = i; break; }
    }
    if (hash >= 0) body = body.slice(0, hash);

    const toks = tokenizeWithPos(body);
    if (toks.length === 0) return null;
    const cmdTok = toks[0];
    if (cmdTok.quoted || !/^[A-Za-z_]\w*$/.test(cmdTok.text) || JS_KEYWORDS.has(cmdTok.text)) return null;
    const resolved = resolveCommand(cmdTok.text.toLowerCase());

    // arguments: every token must be DSL-simple, else the line is JS.
    // Omitted leading name (assume-last target, or a defaulted name like
    // flyto's "look"): when the first arg token is a number, arg specs shift
    // by one so wheel-edit roles still line up.
    const a0 = resolved && resolved.def.args[0];
    const omittedTarget = a0 && (a0.assumeLast || (a0.type === "string" && a0.default !== undefined))
        && toks[1] && !toks[1].quoted && NUM_TOKEN_RE.test(toks[1].text);
    const args = [], spans = {};
    for (let i = 1; i < toks.length; i++) {
        const t = toks[i];
        const spec = resolved && resolved.def.args[i - 1 + (omittedTarget ? 1 : 0)];
        if (t.quoted) args.push(JSON.stringify(t.text));
        else if (t.text === "true" || t.text === "false") args.push(t.text);   // boolean literal (set/show flags)
        else if (NUM_TOKEN_RE.test(t.text)) {
            args.push(t.text);
            if (spec && spec.role && CLEAN_NUM_RE.test(t.text))
                spans[spec.role] = {start: contentStart + t.start, end: contentStart + t.end};
        } else if (BARE_TOKEN_RE.test(t.text)) args.push(JSON.stringify(t.text));
        else return null;
    }

    // a DSL-shaped line whose command word doesn't exist: report it like the old
    // parser did (with its line number) and blank the line so the rest still runs
    if (!resolved) return {code: indent, info: {error: `unknown command "${cmdTok.text}"`}};
    const call = resolved.type + "(" + args.join(", ") + ")";
    const code = amp
        ? indent + `atStart(__sp, ${off}, () => ${call});`
        : indent + `__sp = ${call}; await __sp;`;
    return {code, info: {spans, offSpan}};
}

// Desugar a whole script. Returns {code, lineInfo} where code has EXACTLY the
// same line count as `text`, and lineInfo[i] (0-based) is null for raw JS lines
// or {spans, offSpan} for sugar command lines.
export function desugarScript(text) {
    const out = [], lineInfo = [];
    const st = {stack: [], depth: 0};
    for (const line of String(text).split("\n")) {
        const sugared = (st.stack.length === 0 && st.depth === 0) ? trySugarLine(line) : null;
        if (sugared) {
            out.push(sugared.code);
            lineInfo.push(sugared.info);
        } else {
            advanceState(line, st);
            out.push(line);
            lineInfo.push(null);
        }
    }
    return {code: out.join("\n"), lineInfo};
}
