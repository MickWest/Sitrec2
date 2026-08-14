// CDirectLLMClient.js
// Client-side direct-to-provider LLM client for BYOK (Bring Your Own Key) mode.
// Ports the relevant logic from sitrecServer/chatbot.php so the browser can
// talk to the LLM API directly — no PHP proxy — when the user has supplied
// their own key.
//
// Currently supports Anthropic only. OpenAI does not support browser CORS;
// Groq/Grok are untested.
//
// The module is intentionally pure: no dependencies on sitrec globals,
// no direct calls to sitrecAPI. The caller injects an executeCall callback
// that performs tool execution (normally sitrecAPI.handleAPICall). This keeps
// the client unit-testable and cleanly separated from the chat UI.

import promptFileText from '../sitrecServer/chatbotSystemPrompt.txt';
import {emptyUsage} from './BYOKUsage';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Provider token for "call Anthropic directly with the user's own key". It is
// deliberately NOT plain "anthropic": the chat model setting is a single
// "provider:model" string, so a distinct token lets the chat view tell a BYOK
// selection from a server-proxied one without guessing. A user who has both a
// Sitrec account and a stored key keeps their existing server selection — and its
// billing — untouched, and only pays for their own key when they pick a
// "(your key)" entry.
export const BYOK_PROVIDER = 'byok-anthropic';

// Models offered in the AI Model dropdown once an Anthropic key is stored. The
// user is paying for these directly, so the list spans the current price/capability
// range rather than being capped the way the server's per-tier table is.
export const BYOK_MODELS = [
    {provider: BYOK_PROVIDER, model: 'claude-opus-5', label: 'Claude Opus 5 (your key)'},
    {provider: BYOK_PROVIDER, model: 'claude-sonnet-5', label: 'Claude Sonnet 5 (your key)'},
    {provider: BYOK_PROVIDER, model: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (your key)'},
];

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
    if (text === undefined) throw new Error(`chatbotSystemPrompt.txt: missing @@SECTION ${name}`);
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

function inferParamType(desc) {
    const d = desc.toLowerCase();
    if (d.includes('float') || d.includes('number')) return 'number';
    if (/\bint(eger)?\b/.test(d)) return 'integer';
    if (d.includes('bool')) return 'boolean';
    if (d.includes('array')) return 'array';
    return 'string';
}

export function buildTools(sitrecDoc, menuSummary) {
    const tools = [];

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

        tools.push(tool);
    }

    // 2. Menu-control tools with curated schemas.
    const menuIds = menuSummary && Object.keys(menuSummary).length > 0
        ? Object.keys(menuSummary).join(', ')
        : 'view, camera, satellites, terrain';

    tools.push({
        type: 'function',
        function: {
            name: 'setMenuValue',
            description: `Set a menu control's value. Available menus: ${menuIds}. See system prompt for full control list.`,
            parameters: {
                type: 'object',
                properties: {
                    menu: { type: 'string', description: 'Menu ID' },
                    path: { type: 'string', description: "Control name or path with '/' for nested folders" },
                    value: { description: 'New value (number, boolean, or string)' },
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

    return tools;
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

export function buildSystemPrompt({ simDateTime, menuSummary, availableDocs }) {
    // NOTE: the real wall-clock time is deliberately NOT injected here — it would change
    // the cached prefix every request. The AI fetches it on demand via getCurrentDateTime.
    // simDateTime stays (it changes infrequently and is core context); when it does change
    // it invalidates the cache for that turn only.
    let prompt = fill(section('base'), 'simDateTime', simDateTime || '');

    // Menu controls appendix. Only the glue newlines and the loop live here — the
    // prose is shared, and this assembly mirrors chatbot.php's exactly.
    if (menuSummary && Object.keys(menuSummary).length > 0) {
        prompt += '\n\n' + section('menuHeader') + '\n';
        for (const [menuId, controls] of Object.entries(menuSummary)) {
            if (!controls || controls.length === 0) continue;
            prompt += '\n' + fill(section('menuGroup'), 'menuId', menuId) + '\n';
            for (const control of controls) {
                prompt += fill(section('menuItem'), 'control', control) + '\n';
            }
        }
        prompt += '\n' + section('menuFooter') + '\n';
    }

    // Help docs appendix. Same shape as the menu one above.
    if (availableDocs && Object.keys(availableDocs).length > 0) {
        prompt += '\n\n' + section('docsHeader') + '\n';
        for (const [name, desc] of Object.entries(availableDocs)) {
            // {{name}} appears twice in the template (label and doc link path).
            prompt += fill(fill(section('docsItem'), 'name', name), 'description', desc) + '\n';
        }
        prompt += '\n' + section('docsFooter') + '\n';
    }

    return prompt;
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

export async function callAnthropic({ apiKey, systemPrompt, messages, tools, model, maxTokens = 1024 }) {
    // ── PARITY WITH THE SERVER PROXY ──────────────────────────────────────────────────
    // This is the browser BYOK sibling of sitrecServer/chatbot.php callAnthropic(). The
    // two MUST stay behaviorally in sync — mirror changes to request shaping, the system
    // prompt, the getCurrentDateTime convention, or the tool loop (see chat() below)
    // across both, and vice-versa.
    // ──────────────────────────────────────────────────────────────────────────────────
    //
    // Prompt caching (max 4 breakpoints; prefix match over tools -> system -> messages):
    //   - Breakpoint 1 (system): tools render before system, so one marker on the system
    //     block caches the whole tools+system prefix. With the wall-clock time no longer in
    //     the prompt, that prefix is byte-stable across turns, so it caches cross-turn too.
    //   - Breakpoint 2 (last message): each of the up-to-5 tool-loop iterations re-sends the
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

    const body = {
        model,
        max_tokens: maxTokens,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: cachedMessages,
        tools: convertToolsForAnthropic(tools),
    };

    const res = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
            // Required for direct browser calls. Anthropic will reject
            // browser-origin requests without this header.
            'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
        const msg = data?.error?.message || `HTTP ${res.status}`;
        const err = new Error(`Anthropic API error: ${msg}`);
        err.status = res.status;
        err.body = data;
        throw err;
    }
    return data;
}

// Main entry point for BYOK chat. Maintains a provider-native message array
// with proper tool_use / tool_result blocks. Every executeCall is awaited so
// tool results are correctly fed back into the next model turn.
//
// Returns { text, executedCalls } where:
//   text — concatenated final assistant text (shown in chat UI)
//   executedCalls — list of {fn, args, result} for debug display and for the
//                   caller's sitch-dirty computation
export async function chat({
    apiKey,
    provider,
    model,
    systemPrompt,
    history,
    userText,
    tools,
    executeCall,
    maxIterations = 5,
}) {
    // Accept both the bare provider name and the BYOK dropdown token, so callers can
    // pass through whatever was stored in Globals.settings.chatModel unchanged.
    if (provider !== 'anthropic' && provider !== BYOK_PROVIDER) {
        throw new Error(`BYOK provider '${provider}' not supported. Only Anthropic is currently supported.`);
    }
    if (!apiKey) throw new Error('API key missing');
    if (!model) throw new Error('Model missing');
    if (typeof executeCall !== 'function') throw new Error('executeCall callback missing');

    const priorMessages = historyToAnthropicMessages(history);
    const messages = [
        ...priorMessages,
        { role: 'user', content: userText },
    ];

    let finalText = '';
    const executedCalls = [];
    // Accumulated across every iteration of the tool loop — one user turn can be up to
    // maxIterations round trips, and the user is paying for all of them, so reporting
    // only the last response's usage would understate a tool-heavy turn several-fold.
    const usage = emptyUsage();

    for (let iter = 0; iter < maxIterations; iter++) {
        const response = await callAnthropic({ apiKey, systemPrompt, messages, tools, model });
        const u = response.usage || {};
        usage.requests += 1;
        usage.inputTokens += u.input_tokens || 0;
        usage.outputTokens += u.output_tokens || 0;
        usage.cacheReadTokens += u.cache_read_input_tokens || 0;
        usage.cacheWriteTokens += u.cache_creation_input_tokens || 0;
        const content = Array.isArray(response.content) ? response.content : [];

        for (const block of content) {
            if (block.type === 'text' && block.text) {
                finalText += (finalText ? '\n' : '') + block.text;
            }
        }

        const toolUseBlocks = content.filter(b => b.type === 'tool_use');
        if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') {
            break;
        }

        // Echo the full assistant content back (preserving tool_use ids so the
        // subsequent tool_result blocks can reference them).
        messages.push({ role: 'assistant', content });

        const resultBlocks = [];
        for (const block of toolUseBlocks) {
            const call = { fn: block.name, args: block.input || {} };
            let apiResult;
            try {
                apiResult = await executeCall(call);
            } catch (e) {
                apiResult = { success: false, error: e?.message || String(e) };
            }
            executedCalls.push({ fn: call.fn, args: call.args, result: apiResult });

            const payload = apiResult?.result !== undefined ? apiResult.result : apiResult;
            resultBlocks.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: JSON.stringify(payload ?? null),
                is_error: apiResult?.success === false,
            });
        }

        messages.push({ role: 'user', content: resultBlocks });
    }

    return { text: finalText, executedCalls, usage };
}
