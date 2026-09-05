// CDirectLLMClient.js
// Client-side direct-to-provider LLM client for BYOK (Bring Your Own Key) mode.
// Ports the relevant logic from sitrecServer/chatbot.php so the browser can
// talk to the LLM API directly — no PHP proxy — when the user has supplied
// their own key.
//
// Supports Anthropic and OpenAI directly, and OpenAI-family models through OpenRouter.
//
// The OpenRouter path predates the direct OpenAI one: api.openai.com used to answer a
// browser preflight with no CORS headers, so an aggregator was the only way to reach GPT
// from the page. It now returns "access-control-allow-origin: <the requesting origin>"
// with "authorization" among the allowed headers on /v1/chat/completions (and "*" on
// /v1/responses), so the direct path works and is one hop and one account fewer. Both are
// kept: OpenRouter still reaches models OpenAI does not serve, and reports the exact
// charged cost per completion, which OpenAI does not.
//
// The module is intentionally pure: no dependencies on sitrec globals,
// no direct calls to sitrecAPI. The caller injects an executeCall callback
// that performs tool execution (normally sitrecAPI.handleAPICall). This keeps
// the client unit-testable and cleanly separated from the chat UI.

import promptFileText from '../sitrecServer/chatbotSystemPrompt.txt';
import {emptyUsage} from './BYOKUsage';
import {
    DEFAULT_VOICE_MODEL, KIND_VOICE, filterToCurrentGeneration, getCatalogModels,
} from './BYOKModelCatalog';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

// Provider token for "call Anthropic directly with the user's own key". It is
// deliberately NOT plain "anthropic": the chat model setting is a single
// "provider:model" string, so a distinct token lets the chat view tell a BYOK
// selection from a server-proxied one without guessing. A user who has both a
// Sitrec account and a stored key keeps their existing server selection — and its
// billing — untouched, and only pays for their own key when they pick a
// "(your key)" entry.
export const BYOK_ANTHROPIC_PROVIDER = 'byok-anthropic';
export const BYOK_OPENROUTER_PROVIDER = 'byok-openrouter';
export const BYOK_OPENAI_PROVIDER = 'byok-openai';
// A server the user names themselves: on this machine, or inside their network. The
// address and wire format live in BYOKKeyStore alongside the (optional) credential.
export const BYOK_CUSTOM_PROVIDER = 'byok-custom';
// Backward-compatible name used by older imports and saved settings.
export const BYOK_PROVIDER = BYOK_ANTHROPIC_PROVIDER;

export function keyProviderForBYOK(provider) {
    if (provider === BYOK_ANTHROPIC_PROVIDER || provider === 'anthropic') return 'anthropic';
    if (provider === BYOK_OPENROUTER_PROVIDER || provider === 'openrouter') return 'openrouter';
    if (provider === BYOK_OPENAI_PROVIDER || provider === 'openai') return 'openai';
    if (provider === BYOK_CUSTOM_PROVIDER || provider === 'custom') return 'custom';
    return null;
}

export function isBYOKProvider(provider) {
    // Only the explicit dropdown tokens mean "bill the user's browser-stored key".
    // Plain "anthropic" is also accepted by chat() as a transport shorthand in tests and
    // internal callers, but it is the SERVER provider token in the saved model setting and
    // must never be rerouted around Sitrec's proxy.
    return provider === BYOK_ANTHROPIC_PROVIDER || provider === BYOK_OPENROUTER_PROVIDER
        || provider === BYOK_OPENAI_PROVIDER || provider === BYOK_CUSTOM_PROVIDER;
}

// FALLBACK models only. The real list comes from the provider's own /v1/models — see
// getBYOKModels() below and src/BYOKModelCatalog.js. These are what the dropdown shows
// before the first catalogue fetch lands (or if it fails), so they are deliberately a few
// safe, known-good ids rather than an attempt at a complete list.
export const BYOK_MODELS = [
    {provider: BYOK_ANTHROPIC_PROVIDER, keyProvider: 'anthropic', model: 'claude-opus-5', label: 'Claude Opus 5 (your Anthropic key)'},
    {provider: BYOK_ANTHROPIC_PROVIDER, keyProvider: 'anthropic', model: 'claude-sonnet-5', label: 'Claude Sonnet 5 (your Anthropic key)'},
    {provider: BYOK_ANTHROPIC_PROVIDER, keyProvider: 'anthropic', model: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (your Anthropic key)'},
    {provider: BYOK_OPENAI_PROVIDER, keyProvider: 'openai', model: 'gpt-5-mini', label: 'OpenAI GPT-5 Mini (your OpenAI key)'},
    {provider: BYOK_OPENAI_PROVIDER, keyProvider: 'openai', model: 'gpt-5-nano', label: 'OpenAI GPT-5 Nano (your OpenAI key)'},
    {provider: BYOK_OPENROUTER_PROVIDER, keyProvider: 'openrouter', model: 'openai/gpt-5-mini', label: 'OpenAI GPT-5 Mini (your OpenRouter key)'},
    {provider: BYOK_OPENROUTER_PROVIDER, keyProvider: 'openrouter', model: 'openai/gpt-5-nano', label: 'OpenAI GPT-5 Nano (your OpenRouter key)'},
];

// Turn what the user typed into the two URLs the transports need.
//
// Deliberately forgiving about where they stopped typing, because every server documents
// its address differently: Ollama says http://localhost:11434/v1, LM Studio shows
// http://localhost:1234/v1, and a corporate gateway is as likely to be quoted as the full
// .../v1/chat/completions. All three are accepted, and a trailing slash never matters.
//
// The full-path form is honoured as given rather than being re-derived: a gateway that
// mounts the API somewhere unusual (/openai/deployments/x/chat/completions on Azure, say)
// is exactly the case a "custom endpoint" exists to serve, and second-guessing it would
// put this back in the business of knowing every vendor's layout.
export function resolveEndpoint(rawURL, format = 'openai') {
    const url = String(rawURL || '').trim().replace(/\/+$/, '');
    if (!url) return null;
    const chatPath = format === 'anthropic' ? '/messages' : '/chat/completions';
    // Already a full path to the completion endpoint: take it, and derive the sibling
    // model list from the segment above it.
    if (url.endsWith(chatPath)) {
        const base = url.slice(0, -chatPath.length);
        return {chatURL: url, modelsURL: `${base}/models`, base};
    }
    return {chatURL: url + chatPath, modelsURL: `${url}/models`, base: url};
}

// Only http and https, and nothing that smuggles credentials in the authority. Checked at
// entry (the dialog) and again at use, because the stored value outlives the dialog.
export function isUsableEndpointURL(rawURL) {
    let parsed;
    try {
        parsed = new URL(String(rawURL || '').trim());
    } catch (e) {
        return false;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return parsed.username === '' && parsed.password === '';
}

// Key-provider id -> the dropdown's provider token. The catalogue module deals only in the
// former; this is the one place the two vocabularies meet.
const PROVIDER_TOKEN_FOR_KEY_PROVIDER = {
    anthropic: BYOK_ANTHROPIC_PROVIDER,
    openai: BYOK_OPENAI_PROVIDER,
    openrouter: BYOK_OPENROUTER_PROVIDER,
    custom: BYOK_CUSTOM_PROVIDER,
};

// What a model from this provider is marked with in the dropdown. A custom endpoint says
// "your endpoint", not "your endpoint key" — it usually has no key at all, and the point of
// the marker is to say who is being billed, which here is nobody but the machine's owner.
const PROVIDER_SUFFIX = {
    anthropic: '(your Anthropic key)',
    openai: '(your OpenAI key)',
    openrouter: '(your OpenRouter key)',
    custom: '(your endpoint)',
};

// Every model the user's own keys can reach, for the AI Model dropdown.
//
// Per key provider this prefers the live catalogue and falls back to the BYOK_MODELS
// entries above — per provider, not all-or-nothing, so a working Anthropic key still shows
// its full catalogue when the OpenAI fetch has failed.
//
// `includeOlder` and `keep` are passed in rather than read from Globals: this module is
// deliberately free of sitrec globals so it stays unit-testable (see the header).
export function getBYOKModels({includeOlder = false, keep = null} = {}) {
    const out = [];
    for (const [keyProvider, provider] of Object.entries(PROVIDER_TOKEN_FOR_KEY_PROVIDER)) {
        const listed = getCatalogModels(keyProvider);
        const forProvider = listed
            ? listed.map(m => ({
                provider, keyProvider, model: m.id,
                label: `${m.label} ${PROVIDER_SUFFIX[keyProvider]}`,
            }))
            : BYOK_MODELS.filter(m => m.keyProvider === keyProvider);
        // Filtered per provider, so the newest Claude and the newest GPT both survive —
        // comparing version numbers across vendors would be meaningless.
        //
        // A custom endpoint is exempt: it serves whatever its owner put on it, under
        // whatever names they chose ("llama3.2:3b", "my-finetune"), and a version rule
        // built for vendor release trains has nothing to say about those.
        const skipFilter = includeOlder || keyProvider === 'custom';
        out.push(...(skipFilter ? forProvider : filterToCurrentGeneration(forProvider, keep)));
    }
    return out;
}

// The spoken assistant's models, for the Voice Model dropdown. OpenAI's realtime family,
// which serves /v1/realtime over WebRTC — a different API from everything above, which is
// exactly why these are a separate list rather than entries in the AI Model one.
//
// Deliberately NOT passed through filterToCurrentGeneration. That rule reads a version off
// the end of an id, and the realtime names defeat it inconsistently: "gpt-realtime-2.1"
// parses as 2.1 while "gpt-realtime-2.1-mini" parses as nothing, so filtering would hide
// the mini variant of the very generation it had just decided was current. There are under
// a dozen of them, so the whole list is offered and the heuristic is left out of it.
export function getVoiceModels() {
    const listed = getCatalogModels('openai', KIND_VOICE);
    if (!listed) return [{model: DEFAULT_VOICE_MODEL, label: DEFAULT_VOICE_MODEL}];
    const models = listed.map(m => ({model: m.id, label: m.label}));
    // The default has to be selectable even if a catalogue fetch has not listed it — it is
    // what an unset setting resolves to, so an option for it must always exist.
    if (!models.some(m => m.model === DEFAULT_VOICE_MODEL)) {
        models.push({model: DEFAULT_VOICE_MODEL, label: DEFAULT_VOICE_MODEL});
    }
    return models;
}

// ── SINGLE SOURCE OF TRUTH FOR THE SYSTEM PROMPT ─────────────────────────────
// chatbotSystemPrompt.txt holds the one copy of the assistant's prompt prose,
// split into @@SECTION blocks. sitrecServer/chatbot.php reads that same file at
// runtime with the same parsing rules; webpack inlines it here at build time (see
// the asset/source rule in webpack.common.js) so the serverless and desktop
// builds carry the prompt with no PHP server present.
//
// It lives under sitrecServer/ because that directory is copied wholesale into
// every deployed build and mounted directly in Docker dev, so the text is always
// present next to the PHP that reads it.
//
// This replaced two hand-synced copies that had already drifted apart: the
// browser copy was missing the camera point-vs-lock rules, the multi-part-request
// rule, the whole "[Tool Results]" handling section, and the help-doc link
// instruction. Only genuinely dynamic formatting (the menu/doc loops in
// buildSystemPrompt below) lives in code now.
const promptSections = (() => {
    const sections = {};
    // Split keeping the captured names: [preamble, name, body, name, body, ...]
    //
    // Anchored on (?:^|\n) rather than the /m flag on purpose: in JavaScript, /m's ^ also
    // matches after a lone \r, U+2028 and U+2029, while PCRE's (used by chatbot.php) matches
    // only after \n. With /m, a stray U+2028 pasted into the prompt file would silently
    // split a section in the browser but not on the server — the two would ship different
    // prompts, defeating the single-source-of-truth guarantee this file exists to provide.
    const parts = promptFileText.split(/(?:^|\n)@@SECTION[ \t]+(\w+)[ \t]*\r?\n/);
    for (let i = 1; i + 1 < parts.length; i += 2) {
        sections[parts[i]] = parts[i + 1].replace(/\r?\n$/, '');
    }
    return sections;
})();

function section(name) {
    const text = promptSections[name];
    // A malformed prompt file would otherwise mean asking the model to act with no
    // instructions at all, so surface it instead of sending an empty prompt.
    //
    // The empty check matters as much as the missing one, and must match chatbot.php's
    // promptSection(): a deploy truncated after a section marker leaves the key present
    // with a zero-length body. Without this the server would fail closed (500) while the
    // browser quietly shipped a prompt with a hole in it — the two diverging on exactly
    // the failure the shared file exists to prevent.
    if (text === undefined || text.trim() === '') {
        throw new Error(`chatbotSystemPrompt.txt: @@SECTION ${name} is missing or empty`);
    }
    return text;
}

// Substitute a {{placeholder}} with a literal value. Uses a replacer function so a
// value containing "$&" or "$1" is inserted literally, matching PHP's str_replace.
function fill(template, placeholder, value) {
    return template.replace(new RegExp(`\\{\\{${placeholder}\\}\\}`, 'g'), () => value);
}

// Ported from chatbot.php:358-518. Builds OpenAI-format tool schemas from the
// client-side sitrecAPI.getDocumentation() + menuSummary data. The schemas
// are produced in OpenAI format first (to mirror the PHP code path), then
// converted to Anthropic format via convertToolsForAnthropic().
const MENU_FUNCTION_NAMES = new Set([
    'setMenuValue', 'getMenuValue', 'executeMenuButton', 'listMenus', 'listMenuControls',
]);

// SECURITY (B1): JS-executing API entries that must never be offered to the LLM. Callers
// should already pass sitrecAPI.getLLMDocumentation() (which omits these), but re-deny here
// so this builder is safe regardless of the doc it's handed. Keep in sync with the
// CSitrecAPI entries tagged llmCallable:false and chatbot.php's $llmDenied.
const LLM_DENIED_FUNCTION_NAMES = new Set([
    'setScriptedVideoScript', 'previewScriptedVideo',
]);

// These four constructors account for roughly a quarter of the remaining schema but are
// irrelevant to almost every turn. Keep their full schemas out of the fixed prefix and let
// the model load the ones it needs through discoverSpecialistTools.
export const SPECIALIST_TOOL_NAMES = new Set([
    'createWalker', 'createSynthBuilding', 'createSynthOverlay', 'createSynthClouds',
]);

const SPECIALIST_TOOL_SUMMARIES = {
    createWalker: 'Create an animated object that follows geographic waypoints.',
    createSynthBuilding: 'Create a procedural 3D building.',
    createSynthOverlay: 'Create a georeferenced synthetic ground overlay.',
    createSynthClouds: 'Create a procedural cloud layer.',
};

function inferParamType(desc) {
    const d = desc.toLowerCase();
    if (d.includes('float') || d.includes('number')) return 'number';
    if (/\bint(eger)?\b/.test(d)) return 'integer';
    if (d.includes('bool')) return 'boolean';
    if (d.includes('array')) return 'array';
    return 'string';
}

export function buildToolSet(sitrecDoc, menuSummary) {
    const tools = [];
    const specialistTools = {};

    // 1. Convert each non-menu API entry into an OpenAI function tool.
    for (const [fn, desc] of Object.entries(sitrecDoc || {})) {
        if (MENU_FUNCTION_NAMES.has(fn)) continue;
        if (LLM_DENIED_FUNCTION_NAMES.has(fn)) continue;

        const tool = {
            type: 'function',
            function: {
                name: fn,
                description: desc,
                parameters: { type: 'object', properties: {}, required: [] },
            },
        };

        // Mirror the PHP regex: "Parameters: param1 (desc), param2 (desc)"
        const paramsMatch = desc.match(/Parameters:\s*(.+)$/i);
        if (paramsMatch) {
            const paramRegex = /(\w+)\s*\(([^)]+)\)/g;
            const properties = {};
            const required = [];
            let m;
            while ((m = paramRegex.exec(paramsMatch[1])) !== null) {
                const [, name, paramDesc] = m;
                const type = inferParamType(paramDesc);
                const prop = { type, description: paramDesc };
                if (type === 'array') prop.items = { type: 'string' };
                properties[name] = prop;
                if (!/optional/i.test(paramDesc)) required.push(name);
            }
            if (Object.keys(properties).length > 0) {
                tool.function.parameters.properties = properties;
                tool.function.parameters.required = required;
            }
        }

        // The tail has now been parsed into JSON Schema properties, each carrying the same
        // text. Leaving it in the description too sends every parameter's documentation
        // twice — ~24% of the whole tool block, re-sent on every request and every loop
        // iteration. Note this regex uses (.*) where the parse regex above uses (.+), so it
        // also removes the bare "Parameters:" that CSitrecAPI appends to no-argument
        // functions. Mirrors buildToolsFromDoc() in sitrecServer/chatbot.php.
        tool.function.description = desc.replace(/\s*Parameters:\s*.*$/is, '').trim();

        if (SPECIALIST_TOOL_NAMES.has(fn)) specialistTools[fn] = tool;
        else tools.push(tool);
    }

    // 2. Menu-control tools with curated schemas.
    //
    // These name NO menus on purpose. Tools render before the system prompt, so anything
    // per-request in a tool description invalidates the cached prefix for the whole
    // request — and the menu list is per-sitch. The system prompt's menu appendix already
    // names every menu and control, and listMenus/listMenuControls remain callable.
    // Mirrors buildToolsFromDoc() in sitrecServer/chatbot.php.
    tools.push({
        type: 'function',
        function: {
            name: 'setMenuValue',
            description: "Set a menu control's value. Use listMenuControls when you need the exact control path.",
            parameters: {
                type: 'object',
                properties: {
                    menu: { type: 'string', description: 'Menu ID' },
                    path: { type: 'string', description: "Control name or path with '/' for nested folders" },
                    // An explicit type UNION, not an omitted type. A control's value may
                    // genuinely be any of these, and OpenAI and Anthropic both accept a
                    // schema with no `type` at all — but a stricter consumer does not:
                    // Ollama's chat template does `index $prop.Type 0` on every property
                    // and died with "reflect: slice index out of range" on this one,
                    // failing the whole request before any model saw it. An array of types
                    // is what JSON Schema actually specifies for "one of these", so this is
                    // both more correct and portable.
                    value: {
                        type: ['number', 'boolean', 'string'],
                        description: 'New value (number, boolean, or string)',
                    },
                },
                required: ['menu', 'path', 'value'],
            },
        },
    });

    tools.push({
        type: 'function',
        function: {
            name: 'getMenuValue',
            description: 'Get the current value of a menu control.',
            parameters: {
                type: 'object',
                properties: {
                    menu: { type: 'string', description: 'Menu ID' },
                    path: { type: 'string', description: 'Control name or path' },
                },
                required: ['menu', 'path'],
            },
        },
    });

    tools.push({
        type: 'function',
        function: {
            name: 'executeMenuButton',
            description: 'Click/execute a button control in a menu.',
            parameters: {
                type: 'object',
                properties: {
                    menu: { type: 'string', description: 'Menu ID' },
                    path: { type: 'string', description: 'Button name or path' },
                },
                required: ['menu', 'path'],
            },
        },
    });

    tools.push({
        type: 'function',
        function: {
            name: 'listMenus',
            description: 'List all available menu IDs.',
            parameters: { type: 'object', properties: {} },
        },
    });

    tools.push({
        type: 'function',
        function: {
            name: 'listMenuControls',
            description: 'List all controls in a specific menu.',
            parameters: {
                type: 'object',
                properties: {
                    menu: { type: 'string', description: 'Menu ID to list controls for' },
                },
                required: ['menu'],
            },
        },
    });

    tools.push({
        type: 'function',
        function: {
            name: 'getHelpDoc',
            description: "Read a help documentation file. Use this to answer questions about Sitrec features, what's new, or how to use specific functionality.",
            parameters: {
                type: 'object',
                properties: {
                    docName: { type: 'string', description: "Name of the doc to read (e.g., 'WhatsNew', 'Starlink', 'UserInterface')" },
                },
                required: ['docName'],
            },
        },
    });

    if (Object.keys(specialistTools).length > 0) {
        const summaries = Object.keys(specialistTools)
            .map(name => `${name}: ${SPECIALIST_TOOL_SUMMARIES[name]}`)
            .join(' ');
        tools.push({
            type: 'function',
            function: {
                name: 'discoverSpecialistTools',
                description: `Load full schemas for uncommon constructors. ${summaries}`,
                parameters: {
                    type: 'object',
                    properties: {
                        names: {
                            type: 'array',
                            items: {type: 'string', enum: Object.keys(specialistTools)},
                            description: 'One or more specialist tool names to enable.',
                        },
                    },
                    required: ['names'],
                },
            },
        });
    }

    return {tools, specialistTools};
}

// Compatibility helper for callers that do not need the discovery catalog.
export function buildTools(sitrecDoc, menuSummary) {
    return buildToolSet(sitrecDoc, menuSummary).tools;
}

// Ported from chatbot.php:522-532. Converts OpenAI-format tools to Anthropic
// format (which uses input_schema instead of parameters).
export function convertToolsForAnthropic(tools) {
    return tools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
    }));
}

// The system prompt, split into three tiers of decreasing stability so callAnthropic can
// put a cache breakpoint at each boundary. Caching is a prefix match, so what makes the
// ~100 KB prompt cacheable at all is keeping the parts that never change ahead of the
// parts that do:
//
//   static    base prose + the help-doc index. Stable for each topic-scope setting.
//   menu      the menu appendix. Per-sitch, but getMenuSummary() reports structure and not
//             values, so it holds for a whole session unless a menu appears/disappears.
//   volatile  the simulation clock — the playhead, so it changes almost every message.
//
// simDateTime used to sit on line 8 of the base prose, inside the cached block, so the
// prefix never repeated: every call paid the 1.25x cache WRITE and never collected a 0.1x
// read, which is strictly worse than not caching. This assembly mirrors chatbot.php's.
export function buildSystemPromptParts({ simDateTime, menuSummary, availableDocs, sitrecFocused = true }) {
    // The real wall-clock time is deliberately NOT injected — the AI fetches it on demand
    // via getCurrentDateTime, precisely so it cannot churn the prefix. The simulation clock
    // now gets the same treatment by position rather than by omission.
    // Only an explicit opt-out removes the topic restriction. Server-provided models
    // always use scopeSitrec; this option belongs to the browser's own-key routes.
    let staticPart = fill(section('base'), 'topicScope',
        section(sitrecFocused === false ? 'scopeGeneral' : 'scopeSitrec'));

    // Help docs appendix. Build-constant, so it belongs in the cached block.
    if (availableDocs && Object.keys(availableDocs).length > 0) {
        staticPart += '\n\n' + section('docsHeader') + '\n';
        for (const [name, desc] of Object.entries(availableDocs)) {
            // {{name}} appears twice in the template (label and doc link path).
            staticPart += fill(fill(section('docsItem'), 'name', name), 'description', desc) + '\n';
        }
        staticPart += '\n' + section('docsFooter') + '\n';
    }

    // Menu appendix. Send IDs only: the live empty sitch had 409 controls / ~5,350 tokens,
    // while listMenuControls can fetch the one menu a request actually needs. This keeps
    // discovery possible without charging every unrelated turn for every control.
    let menuPart = '';
    if (menuSummary && Object.keys(menuSummary).length > 0) {
        menuPart += '\n\n' + section('menuHeader') + '\n';
        let menuCount = 0;
        for (const [menuId, controls] of Object.entries(menuSummary)) {
            if (!controls || controls.length === 0) continue;
            if (menuCount >= 128) {
                menuPart += '  - (more menus available - use listMenus)\n';
                break;
            }
            menuPart += '\n' + fill(section('menuGroup'), 'menuId', menuId) + '\n';
            menuCount++;
        }
        menuPart += '\n' + section('menuFooter') + '\n';
    }

    // Always emitted, matching chatbot.php: a null simDateTime renders as an empty value
    // rather than dropping the sentence, so both paths ship the same prompt shape.
    const volatilePart = '\n\n' + fill(section('simTime'), 'simDateTime', simDateTime || '') + '\n';

    return { staticPart, menuPart, volatilePart };
}

// The concatenated form. Kept because it is the shape the tests and any non-Anthropic
// caller expect; callAnthropic uses the parts directly.
export function buildSystemPrompt(args) {
    const { staticPart, menuPart, volatilePart } = buildSystemPromptParts(args);
    return staticPart + menuPart + volatilePart;
}

// Convert the chat view's native {role:'user'|'bot', text} history into
// Anthropic's {role:'user'|'assistant', content:string} format.
function historyToAnthropicMessages(history) {
    const messages = [];
    for (const msg of history || []) {
        if (!msg || typeof msg.text !== 'string' || msg.text.length === 0) continue;
        messages.push({
            role: msg.role === 'bot' ? 'assistant' : 'user',
            content: msg.text,
        });
    }
    // Anthropic requires messages to alternate user/assistant and start with user.
    // Collapse consecutive same-role messages (concatenate text) to satisfy the API.
    const collapsed = [];
    for (const m of messages) {
        const last = collapsed[collapsed.length - 1];
        if (last && last.role === m.role) {
            last.content = last.content + '\n' + m.content;
        } else {
            collapsed.push({ ...m });
        }
    }
    // Drop leading assistant messages; Anthropic requires first message to be 'user'.
    while (collapsed.length > 0 && collapsed[0].role !== 'user') collapsed.shift();
    return collapsed;
}

// Apply a prompt-caching breakpoint to a message's content. Returns a NEW content value
// (never mutates the input) with cache_control on the last content block:
//   - string content -> a single text block carrying cache_control
//   - array content  -> a shallow copy whose LAST block carries cache_control
// Returns null for empty/uncacheable content so the caller can skip it.
function withCacheBreakpoint(content) {
    if (typeof content === 'string') {
        if (content === '') return null;
        return [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }];
    }
    if (Array.isArray(content) && content.length > 0) {
        const copy = content.map(b => ({ ...b }));
        const last = copy.length - 1;
        copy[last] = { ...copy[last], cache_control: { type: 'ephemeral' } };
        return copy;
    }
    return null;
}

// systemParts is the {staticPart, menuPart, volatilePart} split from
// buildSystemPromptParts(). It is optional — callers that only have the concatenated
// string still work, they just get one cached block, which is the pre-split behavior.
export async function callAnthropic({ apiKey, systemPrompt, systemParts, messages, tools, model, maxTokens = 1024, endpoint }) {
    // ── PARITY WITH THE SERVER PROXY ──────────────────────────────────────────────────
    // This is the browser BYOK sibling of sitrecServer/chatbot.php callAnthropic(). The
    // two MUST stay behaviorally in sync — mirror changes to request shaping, the system
    // prompt, the getCurrentDateTime convention, or the tool loop (see chat() below)
    // across both, and vice-versa.
    // ──────────────────────────────────────────────────────────────────────────────────
    //
    // Prompt caching (max 4 breakpoints; prefix match over tools -> system -> messages).
    // A breakpoint caches everything from the START of the request up to it, and one byte
    // changing anywhere before it invalidates it. Anthropic then picks the longest prefix
    // that still matches, so splitting by stability means a menu change costs only the menu
    // block and still reads the static one:
    //   - Breakpoint 1 (static system block): tools render before system, so this marker
    //     caches the whole tools+static prefix, ~21k tokens, byte-identical for every user
    //     on a build.
    //   - Breakpoint 2 (menu block): per-sitch, but stable for a whole session because
    //     getMenuSummary() reports control structure, not control values.
    //   - No breakpoint on the volatile block: it holds the simulation clock, which is the
    //     playhead and changes almost every message. Nothing cacheable may follow it.
    //   - Breakpoint 3 (last message): each of the up-to-5 tool-loop iterations re-sends the
    //     growing message history; marking the final message caches that conversation prefix
    //     so later iterations read it at ~0.1x instead of full price.
    // IMPORTANT: chat() reuses `messages` across iterations, so do NOT mutate it — build a
    // shallow copy with only the last message replaced by a cache-marked clone (otherwise
    // stale breakpoints accumulate on middle messages and can exceed the 4-breakpoint cap).
    const cachedMessages = messages.slice();
    const lastIdx = cachedMessages.length - 1;
    if (lastIdx >= 0) {
        const marked = withCacheBreakpoint(cachedMessages[lastIdx].content);
        if (marked) cachedMessages[lastIdx] = { ...cachedMessages[lastIdx], content: marked };
    }

    // Empty text blocks are rejected by the API, so only non-empty tiers are sent.
    const systemBlocks = [];
    if (systemParts) {
        for (const cacheable of [systemParts.staticPart, systemParts.menuPart]) {
            if (cacheable && cacheable.trim() !== '') {
                systemBlocks.push({ type: 'text', text: cacheable, cache_control: { type: 'ephemeral' } });
            }
        }
        if (systemParts.volatilePart && systemParts.volatilePart.trim() !== '') {
            systemBlocks.push({ type: 'text', text: systemParts.volatilePart });
        }
    }
    if (systemBlocks.length === 0) {
        systemBlocks.push({ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } });
    }

    const body = {
        model,
        max_tokens: maxTokens,
        system: systemBlocks,
        messages: cachedMessages,
        tools: convertToolsForAnthropic(tools),
    };

    const url = endpoint?.chatURL || ANTHROPIC_API_URL;
    const custom = !!endpoint?.chatURL;

    const headers = {
        'Content-Type': 'application/json',
        'anthropic-version': ANTHROPIC_VERSION,
    };
    // Required for direct browser calls: Anthropic rejects a browser origin without it.
    //
    // NOT sent to a custom endpoint, and this is not a nicety. A non-standard request
    // header forces a CORS preflight and must appear in the server's
    // Access-Control-Allow-Headers, so sending it to a gateway that has never heard of it
    // makes every request fail before it is issued. Measured against a compatible server
    // whose allow-list covered anthropic-version but not this: the whole call died as
    // "Failed to fetch". Every header sent to a server we do not control is a preflight
    // term it has to know about, so only the ones it genuinely needs go.
    if (!custom) headers['anthropic-dangerous-direct-browser-access'] = 'true';
    // A self-hosted Anthropic-compatible gateway often needs no credential, and some
    // reject an empty header outright, so it is omitted rather than sent blank.
    if (apiKey) headers['x-api-key'] = apiKey;

    let res;
    try {
        res = await fetch(url, {method: 'POST', headers, body: JSON.stringify(body)});
    } catch (e) {
        // A self-hosted address fails here far more often than a hosted one, and the
        // browser's own message ("Failed to fetch") names neither cause. Say what the two
        // actually are, since the user is the only one who can fix either.
        if (!custom) throw e;
        throw new Error(`Could not reach ${url}. The server may be down, or it may not `
            + `allow requests from ${globalThis.location?.origin ?? 'this page'} — `
            + `a self-hosted server has to be told to permit this origin (CORS).`);
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
        const msg = data?.error?.message || `HTTP ${res.status}`;
        const err = new Error(`${custom ? 'Endpoint' : 'Anthropic'} API error: ${msg}`);
        err.status = res.status;
        err.body = data;
        throw err;
    }
    return data;
}

const MAX_DIRECT_HISTORY_MESSAGES = 10;
const MAX_DIRECT_MESSAGE_CHARS = 4000;
const MAX_TOOL_RESULT_CHARS = 60000;

function boundedHistory(history) {
    return (history || []).slice(-MAX_DIRECT_HISTORY_MESSAGES).map(msg => ({
        role: msg?.role === 'bot' ? 'bot' : 'user',
        text: typeof msg?.text === 'string' ? msg.text.slice(0, MAX_DIRECT_MESSAGE_CHARS) : '',
    })).filter(msg => msg.text.length > 0);
}

function historyToOpenAIMessages(history) {
    return boundedHistory(history).map(msg => ({
        role: msg.role === 'bot' ? 'assistant' : 'user',
        content: msg.text,
    }));
}

function fullSystemPrompt(systemPrompt, systemParts) {
    if (!systemParts) return systemPrompt || '';
    return (systemParts.staticPart || '') + (systemParts.menuPart || '') + (systemParts.volatilePart || '');
}

function serializeToolResult(payload) {
    let value;
    try {
        value = JSON.stringify(payload ?? null);
    } catch (e) {
        value = JSON.stringify({success: false, error: `Tool result was not serializable: ${e?.message || e}`});
    }
    if (value.length <= MAX_TOOL_RESULT_CHARS) return value;
    return JSON.stringify({
        truncated: true,
        originalCharacters: value.length,
        preview: value.slice(0, MAX_TOOL_RESULT_CHARS),
    });
}

// OpenAI and OpenRouter report usage in the same shape. `cost` is OpenRouter's exact
// charged amount; OpenAI omits it, and the caller then prices the tokens from the model
// table in BYOKUsage.
function addOpenAIFormatUsage(total, raw) {
    const details = raw?.prompt_tokens_details || {};
    const cached = Number(details.cached_tokens || 0);
    const written = Number(details.cache_write_tokens || 0);
    const prompt = Number(raw?.prompt_tokens ?? raw?.input_tokens ?? 0);
    total.requests += 1;
    total.inputTokens += Math.max(0, prompt - cached - written);
    total.outputTokens += Number(raw?.completion_tokens ?? raw?.output_tokens ?? 0);
    total.cacheReadTokens += cached;
    total.cacheWriteTokens += written;
    if (Number.isFinite(Number(raw?.cost))) total.costUSD += Number(raw.cost);
}

function enableSpecialistTools(args, specialistTools, activeTools) {
    const requested = Array.isArray(args?.names) ? args.names : [];
    const enabled = [];
    const unknown = [];
    const activeNames = new Set(activeTools.map(tool => tool.function.name));
    for (const name of requested) {
        const tool = specialistTools?.[name];
        if (!tool) {
            unknown.push(name);
            continue;
        }
        if (!activeNames.has(name)) {
            activeTools.push(tool);
            activeNames.add(name);
        }
        enabled.push(name);
    }
    return {
        success: unknown.length === 0 && enabled.length > 0,
        enabled,
        unknown,
        available: Object.keys(specialistTools || {}),
    };
}

async function executeOneCall(call, executeCall, specialistTools, activeTools) {
    if (call.fn === 'discoverSpecialistTools') {
        return enableSpecialistTools(call.args, specialistTools, activeTools);
    }
    try {
        return await executeCall(call);
    } catch (e) {
        return {success: false, error: e?.message || String(e)};
    }
}

function canSkipConfirmation(calls, results, needsModelResult) {
    if (typeof needsModelResult !== 'function' || calls.length === 0) return false;
    return calls.every((call, index) =>
        call.fn !== 'discoverSpecialistTools'
        && !needsModelResult(call.fn)
        && results[index]?.success !== false
    );
}

// OpenRouter and OpenAI speak the same /chat/completions wire format, so one function
// serves both; only the URL, two headers and OpenRouter's session_id differ. `keyProvider`
// picks between them and names the service in the error text, which is the difference the
// user needs to see when a key is rejected.
// How each model wants its optional request parameters, learned at run time from the
// provider's own 400 and remembered for the session.
//
//   model -> {drop: Set<string>, reasoningEffort: string|undefined}
//
// This exists because the model list is no longer a curated shortlist: it is whatever the
// user's key exposes, and the families disagree about the same parameters. Measured against
// a real key on 2026-08-31:
//   gpt-4o / gpt-4.1 / gpt-3.5-turbo  reject `reasoning_effort` outright
//   gpt-5.6-sol                       rejects it only WITH function tools, and says so:
//     "Function tools with reasoning_effort are not supported for gpt-5.6-sol in
//      /v1/chat/completions. To use function tools, use /v1/responses or set
//      reasoning_effort to 'none'."
// OpenAI rejects an unknown or wrongly-valued parameter rather than ignoring it, so one
// fixed body cannot serve the list. Predicting per model would be the same stale-table
// mistake in a new place; asking, and doing what the error says, cannot go stale. A 400
// costs only the round trip — nothing was processed, so no tokens were spent.
const MODEL_PARAM_QUIRKS = new Map();

function quirksFor(model) {
    if (!MODEL_PARAM_QUIRKS.has(model)) MODEL_PARAM_QUIRKS.set(model, {drop: new Set()});
    return MODEL_PARAM_QUIRKS.get(model);
}

// The parameters this may alter. Anything not listed is structural (model, messages, tools)
// and a rejection of one is a real error the caller must see, not something to retry around.
const OPTIONAL_PARAMS = new Set(['reasoning_effort', 'max_completion_tokens']);

// Turn a 400 into a change to make, or null to give up and report it. Returns a short tag
// so the caller can tell whether the last attempt actually changed anything.
//
// Three strategies, most specific first. The last one is deliberately a blind guess,
// because the set of servers this now talks to is open-ended: anyone's gateway, anyone's
// local runner, each with its own wording for "I do not accept that field".
function remedyFor(model, message) {
    const text = String(message || '');
    const quirks = quirksFor(model);

    // 1. The provider naming a value to use is the strongest signal there is — follow it
    //    rather than dropping the parameter, which for these models is a different request.
    //    (gpt-5.6-sol: "...or set reasoning_effort to 'none'.")
    const wants = /reasoning_effort[^.]*?to '([a-z]+)'/i.exec(text);
    if (wants && quirks.reasoningEffort !== wants[1]) {
        quirks.reasoningEffort = wants[1];
        return `reasoning_effort='${wants[1]}'`;
    }

    // 2. The provider naming the parameter it will not take. Phrasings seen:
    //      "Unrecognized request argument supplied: reasoning_effort"        (OpenAI)
    //      "Unsupported parameter: 'max_completion_tokens' is not supported…" (OpenAI)
    //      "Unsupported value: 'reasoning_effort' does not support 'low'…"    (OpenAI)
    const named = /(?:Unrecognized request argument supplied|Unsupported parameter|Unsupported value)\s*:?\s*'?([A-Za-z_][A-Za-z0-9_]*)'?/i
        .exec(text);
    const param = named?.[1];
    if (param && OPTIONAL_PARAMS.has(param) && !quirks.drop.has(param)) {
        quirks.drop.add(param);
        return `drop ${param}`;
    }

    // 3. Last resort: drop reasoning_effort and try once more.
    //
    //    Nothing above matches Ollama's wording for the same complaint — it answers
    //    `"llama3.2" does not support thinking` — and enumerating every server's phrasing
    //    is a list that can only ever be behind. reasoning_effort is the one genuinely
    //    optional field in the request, so on a 400 we cannot otherwise explain it is by
    //    far the likeliest cause; if it was not, the retry costs one round trip (a 400
    //    processes nothing) and the real error is then reported unchanged.
    if (!quirks.drop.has('reasoning_effort')) {
        quirks.drop.add('reasoning_effort');
        return 'drop reasoning_effort (guessed)';
    }
    return null;
}

export async function callOpenAIFormat({apiKey, keyProvider = 'openrouter', systemPrompt,
    systemParts, messages, tools, model, maxTokens = 2048, sessionId, endpoint}) {
    const custom = keyProvider === 'custom';
    const direct = keyProvider === 'openai';
    const url = custom ? endpoint?.chatURL : (direct ? OPENAI_API_URL : OPENROUTER_API_URL);
    if (!url) throw new Error('No endpoint address is set for the custom provider.');
    const serviceName = custom ? 'Endpoint' : (direct ? 'OpenAI' : 'OpenRouter');

    const headers = {'Content-Type': 'application/json'};
    // A self-hosted server usually wants no credential at all, and some reject an empty
    // bearer outright, so the header is omitted rather than sent blank.
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    if (!direct && !custom) headers['X-Title'] = 'Sitrec';   // OpenRouter's attribution header

    const buildBody = () => {
        const quirks = quirksFor(model);
        const body = {
            model,
            messages: [{role: 'system', content: fullSystemPrompt(systemPrompt, systemParts)}, ...messages],
            tools,
        };
        // A token cap is not optional — if the modern name is refused, use the legacy one
        // rather than sending an uncapped request.
        if (quirks.drop.has('max_completion_tokens')) body.max_tokens = maxTokens;
        else body.max_completion_tokens = maxTokens;
        if (!quirks.drop.has('reasoning_effort')) {
            body.reasoning_effort = quirks.reasoningEffort ?? 'low';
        }
        // OpenRouter-only: it uses session_id for its own request grouping, and OpenAI
        // rejects unknown top-level body fields outright rather than ignoring them.
        if (sessionId && !direct && !custom) body.session_id = sessionId;
        return body;
    };

    // Bounded at three, and each pass must make a change remedyFor() has not made before,
    // so a model that keeps refusing cannot loop: the second identical rejection returns
    // null and the error is reported.
    for (let attempt = 0; attempt < 3; attempt++) {
        let res;
        try {
            res = await fetch(url, {
                method: 'POST', headers, body: JSON.stringify(buildBody()),
            });
        } catch (e) {
            // A self-hosted address fails here far more often than a hosted one, and the
            // browser's own message ("Failed to fetch") names neither cause. Say what the
            // two actually are, since the user is the only one who can fix either.
            if (!custom) throw e;
            throw new Error(`Could not reach ${url}. The server may be down, or it may not `
                + `allow requests from ${globalThis.location?.origin ?? 'this page'} — `
                + `a self-hosted server has to be told to permit this origin (CORS).`);
        }
        const data = await res.json().catch(() => ({}));
        if (res.ok && !data.error) return data;

        const msg = data?.error?.message || `HTTP ${res.status}`;
        const remedy = res.status === 400 ? remedyFor(model, msg) : null;
        if (remedy) {
            console.log(`BYOK: ${model} needs ${remedy}; retrying.`);
            continue;
        }
        const err = new Error(`${serviceName} API error: ${msg}`);
        err.status = res.status;
        err.body = data;
        throw err;
    }
    throw new Error(`${serviceName} API error: ${model} rejected the request repeatedly.`);
}

// Kept as the pre-existing name; callers and tests that only ever meant OpenRouter are
// unaffected by the generalisation above.
export async function callOpenRouter(args) {
    return callOpenAIFormat({...args, keyProvider: 'openrouter'});
}

async function chatAnthropic({apiKey, model, systemPrompt, systemParts, history, userText,
    tools, specialistTools, executeCall, needsModelResult, maxIterations, onRound, endpoint}) {
    const messages = [
        ...historyToAnthropicMessages(boundedHistory(history)),
        {role: 'user', content: String(userText || '').slice(0, MAX_DIRECT_MESSAGE_CHARS)},
    ];
    const activeTools = [...(tools || [])];
    const final = {text: '', executedCalls: [], usage: emptyUsage()};

    for (let iter = 0; iter < maxIterations; iter++) {
        const response = await callAnthropic({apiKey, systemPrompt, systemParts, messages, tools: activeTools, model, endpoint});
        const u = response.usage || {};
        final.usage.requests += 1;
        final.usage.inputTokens += u.input_tokens || 0;
        final.usage.outputTokens += u.output_tokens || 0;
        final.usage.cacheReadTokens += u.cache_read_input_tokens || 0;
        final.usage.cacheWriteTokens += u.cache_creation_input_tokens || 0;
        const content = Array.isArray(response.content) ? response.content : [];
        for (const block of content) {
            if (block.type === 'text' && block.text) final.text += (final.text ? '\n' : '') + block.text;
        }

        const toolBlocks = content.filter(block => block.type === 'tool_use');
        if (toolBlocks.length === 0 || response.stop_reason === 'end_turn') break;
        messages.push({role: 'assistant', content});

        const calls = toolBlocks.map(block => ({fn: block.name, args: block.input || {}}));
        // One model response's worth of calls is one round. The caller uses the boundary to
        // tell a repair (a later round) from independent work (the same round).
        onRound?.();
        const results = [];
        const resultBlocks = [];
        for (let i = 0; i < calls.length; i++) {
            const apiResult = await executeOneCall(calls[i], executeCall, specialistTools, activeTools);
            results.push(apiResult);
            final.executedCalls.push({...calls[i], result: apiResult});
            const payload = apiResult?.result !== undefined ? apiResult.result : apiResult;
            resultBlocks.push({
                type: 'tool_result',
                tool_use_id: toolBlocks[i].id,
                content: serializeToolResult(payload),
                is_error: apiResult?.success === false,
            });
        }
        if (canSkipConfirmation(calls, results, needsModelResult)) {
            if (!final.text) final.text = 'Done.';
            break;
        }
        messages.push({role: 'user', content: resultBlocks});
    }
    return final;
}

async function chatOpenAIFormat({apiKey, keyProvider, model, systemPrompt, systemParts, history,
    userText, tools, specialistTools, executeCall, needsModelResult, maxIterations, sessionId,
    onRound, endpoint}) {
    const messages = [
        ...historyToOpenAIMessages(history),
        {role: 'user', content: String(userText || '').slice(0, MAX_DIRECT_MESSAGE_CHARS)},
    ];
    const activeTools = [...(tools || [])];
    const final = {text: '', executedCalls: [], usage: emptyUsage()};

    for (let iter = 0; iter < maxIterations; iter++) {
        const response = await callOpenAIFormat({
            apiKey, keyProvider, systemPrompt, systemParts, messages, tools: activeTools,
            model, sessionId, endpoint,
        });
        addOpenAIFormatUsage(final.usage, response.usage || {});
        const choice = response.choices?.[0] || {};
        const message = choice.message || {};
        if (typeof message.content === 'string' && message.content) {
            final.text += (final.text ? '\n' : '') + message.content;
        }
        const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        if (toolCalls.length === 0) break;
        if (choice.finish_reason === 'length') {
            final.text += (final.text ? '\n' : '')
                + 'That answer was cut off before I could finish the action, so I have not run it.';
            break;
        }
        messages.push({role: 'assistant', content: message.content || null, tool_calls: toolCalls});

        const calls = toolCalls.map(toolCall => {
            let args = {};
            try { args = JSON.parse(toolCall.function?.arguments || '{}'); } catch (e) {
                args = {__parseError: e?.message || String(e)};
            }
            return {fn: toolCall.function?.name, args};
        });
        onRound?.();
        const results = [];
        for (let i = 0; i < calls.length; i++) {
            const call = calls[i];
            const invalidArgs = call.args?.__parseError;
            const apiResult = invalidArgs
                ? {success: false, error: `Invalid tool arguments: ${invalidArgs}`}
                : await executeOneCall(call, executeCall, specialistTools, activeTools);
            results.push(apiResult);
            final.executedCalls.push({...call, result: apiResult});
            const payload = apiResult?.result !== undefined ? apiResult.result : apiResult;
            messages.push({
                role: 'tool',
                tool_call_id: toolCalls[i].id,
                content: serializeToolResult(payload),
            });
        }
        if (canSkipConfirmation(calls, results, needsModelResult)) {
            if (!final.text) final.text = 'Done.';
            break;
        }
    }
    return final;
}

// Main entry point for BYOK chat. Both transports expose one provider-independent result:
// {text, executedCalls, usage}. Tool calls are always awaited before another model call.
export async function chat({
    apiKey,
    provider,
    model,
    systemPrompt,
    systemParts,
    history,
    userText,
    tools,
    specialistTools = {},
    executeCall,
    needsModelResult,
    sessionId,
    maxIterations = 5,
    onRound,
    // {url, format} for a user-named server. Required for the 'custom' provider and
    // ignored for the rest, whose addresses are fixed.
    endpoint: endpointConfig,
}) {
    const keyProvider = keyProviderForBYOK(provider);
    if (!keyProvider) throw new Error(`BYOK provider '${provider}' not supported.`);
    const custom = keyProvider === 'custom';
    // A key is required everywhere EXCEPT a custom endpoint, where the commonest case — a
    // model running on your own machine — has no credential at all.
    if (!apiKey && !custom) throw new Error('API key missing');
    if (!model) throw new Error('Model missing');
    if (typeof executeCall !== 'function') throw new Error('executeCall callback missing');

    let endpoint = null;
    let format = null;
    if (custom) {
        if (!endpointConfig?.url) throw new Error('No endpoint address is set. Add one in Settings, API Keys.');
        if (!isUsableEndpointURL(endpointConfig.url)) {
            throw new Error(`'${endpointConfig.url}' is not a usable http(s) address.`);
        }
        format = endpointConfig.format === 'anthropic' ? 'anthropic' : 'openai';
        endpoint = resolveEndpoint(endpointConfig.url, format);
    }

    const args = {apiKey, keyProvider, model, systemPrompt, systemParts, history, userText, tools,
        specialistTools, executeCall, needsModelResult, maxIterations, sessionId, onRound, endpoint};
    // For a custom endpoint the TRANSPORT is chosen by the wire format the server speaks,
    // not by who is being billed — that is the whole point of asking for the format.
    const useAnthropic = custom ? format === 'anthropic' : keyProvider === 'anthropic';
    return useAnthropic ? chatAnthropic(args) : chatOpenAIFormat(args);
}
