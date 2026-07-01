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

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Ported from chatbot.php:559-622. Keep in sync with the PHP version to
// preserve behavior parity between server-proxied and BYOK paths.
const BASE_SYSTEM_PROMPT = `You are a helpful assistant for the Sitrec app.

You should reply in the same language as the user's prompt, unless instructed otherwise.

You are NOT automatically given the current real-world (wall-clock) date and time. If a request depends on the actual present moment (e.g. "right now", "tonight", "in an hour"), or you need the user's local timezone, call the getCurrentDateTime function — it returns the real date/time as an ISO 8601 string with the user's timezone offset. (Keeping this out of the prompt by default lets the request prefix be cached; fetch it on demand.)

The current SIMULATION date/time is: {{simDateTime}}. This is the date the app is showing - satellites are loaded for this date. If this changes between requests, the user may need to reload satellites.

When giving a time, always use the user's local time, unless they specify UTC or another timezone.

When setting a time in conjunction with a location and date, use that location's time

You can answer questions about Sitrec and call functions to control the application.

Sitrec is a Situation Recreation application written by Mick West. It can:
- Show satellite positions in the sky (Starlink, ISS, LEO satellites, etc.)
- Show ADS-B aircraft positions from loaded track files
- Show astronomy objects (stars, planets, Sun, Moon, constellations)
- Visualize 3D terrain with various map and elevation sources
- Overlay video footage for comparison with the simulated view
- Set camera position, orientation, and field of view
- Display 3D objects (aircraft models, geometric shapes) along tracks
- Calculate and display lines of sight and traverse paths
The primary use is for resolving UAP sightings and other events by showing what was in the sky at a given time.

SATELLITE LOADING:
- "load satellites" or general satellite requests → use satellitesLoadLEO
- "load current starlink" specifically → use satellitesLoadCurrentStarlink
- After loading, filter with: showStarlink, showISS, showBrightest, showOtherSatellites

VISIBILITY CONTROLS:
- The "satellites" menu has "showSatelliteNames" (for look view) and "showSatelliteNamesMain" (for main view) to toggle satellite name labels.
- When the user asks to show satellite labels "in look" or "in the look view", use setMenuValue on the satellites menu with showSatelliteNames = true.
- Stars visibility: use setMenuValue on "showhide" menu with "Show Stars".
- Terrain/ground visibility: check the "terrain" menu for map type and elevation options.

3D OBJECTS:
- Use listAvailableModels to see aircraft/object models (jets, helicopters, drones, etc.)
- Use setObjectModel to set a specific object to use a 3D model
- Use setObjectGeometry to use procedural shapes (sphere, box, superegg, etc.)
- Use listAvailableGeometries to see geometry types and their dimension parameters
- Objects are organized in the "objects" menu with folders like "cameraObject", "targetObject"

LIGHTING:
- The "lighting" menu controls scene lighting (ambient, directional, sun position)
- "Ambient Only" mode available for silhouette-style views

When the user asks you to DO something (set, change, move, show, hide, point, go to, etc.):
- If you know the correct function or menu control, call it immediately.
- The system uses FLEXIBLE MATCHING - partial names and keywords work. For example, "frustum off" can use setMenuValue with path "frustum" and the system will find "Camera View Frustum".
- When the user uses a keyword that likely matches a control (like "frustum", "LOS", "labels"), TRY IT - the flexible matching will find the right control.
- Only say you don't know if you truly have no idea what the user is asking for.

CRITICAL RULE - MUST FOLLOW: When the user requests an action (like "load sats"), you MUST call the appropriate function. Do NOT just respond with text like "Loading..." - you must actually invoke the function tool. Even if you see the same request in the history, you MUST call the function again. The conversation history does NOT mean the action persists - each request requires a new function call.

If the user confirms with "yes", "ok", "sure", "do it", etc., EXECUTE the action you proposed by calling the function.

ALWAYS provide a brief text response describing what you did or are doing, even when making function calls. For example: "Loading LEO satellites..." or "Turned on satellite labels in look view." Never return an empty response.

Keep responses brief. Focus on being helpful.

Do not discuss anything unrelated to Sitrec, including people, events, or politics. But you can talk about Mick West.`;

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
    let prompt = BASE_SYSTEM_PROMPT
        .replace('{{simDateTime}}', simDateTime || '');

    // Menu controls appendix (matches chatbot.php:537-557 formatting).
    if (menuSummary && Object.keys(menuSummary).length > 0) {
        prompt += '\n\nAVAILABLE MENU CONTROLS:\n';
        for (const [menuId, controls] of Object.entries(menuSummary)) {
            if (!controls || controls.length === 0) continue;
            prompt += `\nMenu '${menuId}':\n`;
            for (const control of controls) {
                prompt += `  - ${control}\n`;
            }
        }
        prompt += "\nUse setMenuValue with menu ID and control path (e.g., 'Flow Orbs/Visible' for nested). Use listMenuControls to see all controls in a menu.\n";
    }

    // Help docs appendix (matches chatbot.php:633-640).
    if (availableDocs && Object.keys(availableDocs).length > 0) {
        prompt += '\n\nAVAILABLE HELP DOCUMENTATION:\n';
        prompt += 'Use getHelpDoc to read these docs when answering questions about features or how to do things:\n';
        for (const [name, desc] of Object.entries(availableDocs)) {
            prompt += `- ${name}: ${desc}\n`;
        }
        prompt += "\nFor questions like 'what's new' or 'how do I do X', use getHelpDoc to get accurate information.\n";
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
    if (provider !== 'anthropic') {
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

    for (let iter = 0; iter < maxIterations; iter++) {
        const response = await callAnthropic({ apiKey, systemPrompt, messages, tools, model });
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

    return { text: finalText, executedCalls };
}
