// PromptSafety.js
// Defenses against indirect prompt injection through the AI assistant.
//
// Threat model: the user opens a KML/CSV, or a sitch fetched from an arbitrary URL via
// ?custom=. Names inside that file become GUI labels, and CSitrecAPI.getMenuSummary()
// interpolates GUI labels straight into the assistant's SYSTEM prompt — on both the
// server path (sitrecServer/chatbot.php) and the browser BYOK path (CDirectLLMClient).
// So a file the user merely opened can place text where the model reads it as Sitrec's
// own instructions.
//
// These live in their own module rather than inside CSitrecAPI because they are pure
// string/URL logic, and because CSitrecAPI transitively imports threeExt -> three/addons,
// which cannot be loaded under Jest — keeping them here means the security behaviour is
// directly unit-testable (tests/promptInjectionDefenses.test.js).

// Longest label allowed into the prompt. Long enough for every real Sitrec control name,
// short enough that one injected label cannot crowd out the actual instructions.
export const PROMPT_LABEL_MAX = 120;

// Flatten a data-derived label so it cannot forge prompt structure.
//
// This is sanitising for a PROMPT, not for HTML — the XSS side of the same untrusted data
// is handled at the DOM sink (the textContent patch in src/js/lil-gui.esm.js).
export function sanitizeLabelForPrompt(text) {
    if (text === undefined || text === null) return '';
    let s = String(text)
        // Everything the model could read as a line break, including separators that are
        // invisible in an editor (U+2028/U+2029, U+0085) and a bare CR.
        .replace(/[\r\n\u0085\u2028\u2029]+/g, ' ')
        // Remaining C0/C1 controls, which can hide structure from a human reviewing a file.
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
        .trim();
    if (s.length > PROMPT_LABEL_MAX) {
        s = s.slice(0, PROMPT_LABEL_MAX) + '…';
    }
    return s;
}

// Parameters that would let a chat-sourced call make the victim's browser fetch an
// arbitrary external URL. The LLM's choice of argument is attacker-influenceable by the
// injection route above, so a URL it picked must not be requested: the request itself is
// the exfiltration — put data in the query string and it leaves with the fetch. This is
// what closes the reported saveSitch -> getShareLink -> createSynthOverlay chain.
// UI-sourced calls (buttons, MCP bridge, programmatic call()) are unaffected.
export const CHAT_DENIED_URL_PARAMS = {
    createSynthOverlay: ['imageURL'],
};

// Same-origin and relative URLs are fine: they cannot carry data to a third party.
export function isSameOriginOrRelative(url) {
    if (typeof url !== 'string' || url === '') return true;
    const base = (typeof window !== 'undefined' && window.location)
        ? window.location.href
        : 'http://localhost/';
    try {
        const resolved = new URL(url, base);
        if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return false;
        return resolved.origin === new URL(base).origin;
    } catch (e) {
        return false;
    }
}

// Returns a refusal result to hand straight back to the caller, or null to allow.
export function refuseExternalURLParams(call) {
    const denied = CHAT_DENIED_URL_PARAMS[call?.fn];
    if (!denied || !call.args) return null;
    for (const param of denied) {
        const value = call.args[param];
        if (value !== undefined && value !== null && !isSameOriginOrRelative(value)) {
            console.warn(`Refusing chat-sourced external URL for ${call.fn}.${param}: ${value}`);
            return {
                success: false,
                fn: call.fn,
                error: `'${param}' cannot be set to an external URL from chat. `
                    + `Tell the user to set that image via the UI instead.`,
            };
        }
    }
    return null;
}
