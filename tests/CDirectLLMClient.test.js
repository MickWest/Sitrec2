import {
    buildTools,
    convertToolsForAnthropic,
    buildSystemPrompt,
    chat,
} from '../src/CDirectLLMClient';

describe('buildTools', () => {
    test('builds OpenAI-format tool schemas from sitrecDoc with parsed params', () => {
        const sitrecDoc = {
            gotoLLA: 'Go to latitude/longitude/altitude. Parameters: lat (number: latitude), lon (number: longitude), alt (number: optional altitude)',
            play: 'Start playback. Parameters: ',
        };
        const tools = buildTools(sitrecDoc, {});
        const goto = tools.find(t => t.function.name === 'gotoLLA');
        expect(goto).toBeDefined();
        expect(goto.function.parameters.properties.lat.type).toBe('number');
        expect(goto.function.parameters.properties.lon.type).toBe('number');
        expect(goto.function.parameters.properties.alt.type).toBe('number');
        expect(goto.function.parameters.required).toEqual(['lat', 'lon']); // alt is optional
    });

    test('skips menu-control functions so they can be added with curated schemas', () => {
        const sitrecDoc = {
            setMenuValue: 'bad schema Parameters: menu (string)',
            gotoLLA: 'Go. Parameters: lat (number)',
        };
        const tools = buildTools(sitrecDoc, { view: ['ctrl'] });
        const setMenu = tools.filter(t => t.function.name === 'setMenuValue');
        // Exactly one setMenuValue tool — the curated version — not duplicated.
        expect(setMenu).toHaveLength(1);
        expect(setMenu[0].function.parameters.required).toEqual(['menu', 'path', 'value']);
    });

    test('adds getHelpDoc, listMenus, and other curated menu tools', () => {
        const tools = buildTools({}, {});
        const names = tools.map(t => t.function.name);
        expect(names).toEqual(expect.arrayContaining([
            'setMenuValue', 'getMenuValue', 'executeMenuButton',
            'listMenus', 'listMenuControls', 'getHelpDoc',
        ]));
    });
});

describe('convertToolsForAnthropic', () => {
    test('remaps function/parameters → name/input_schema (Anthropic format)', () => {
        const openAITools = [{
            type: 'function',
            function: {
                name: 'gotoLLA',
                description: 'go there',
                parameters: { type: 'object', properties: {}, required: [] },
            },
        }];
        const anthropic = convertToolsForAnthropic(openAITools);
        expect(anthropic).toEqual([{
            name: 'gotoLLA',
            description: 'go there',
            input_schema: { type: 'object', properties: {}, required: [] },
        }]);
    });
});

describe('buildSystemPrompt', () => {
    test('omits the real wall-clock time (keeps the prefix cacheable) but keeps simDateTime', () => {
        const prompt = buildSystemPrompt({
            simDateTime: '2004-11-14T20:30:00Z',
            menuSummary: {},
            availableDocs: {},
        });
        // The real wall-clock time is fetched on demand via getCurrentDateTime, not injected
        // into the prompt (injecting it would change the cached prefix every request).
        expect(prompt).toContain('getCurrentDateTime');
        // Simulation time stays in the prompt (changes infrequently).
        expect(prompt).toContain('2004-11-14T20:30:00Z');
        expect(prompt).not.toContain('{{dateTime}}');
        expect(prompt).not.toContain('{{simDateTime}}');
    });

    test('appends menu controls section when menuSummary is non-empty', () => {
        const prompt = buildSystemPrompt({
            dateTime: 'x', simDateTime: 'y',
            menuSummary: { view: ['Camera Pos', 'FOV'], satellites: ['showStarlink'] },
            availableDocs: {},
        });
        expect(prompt).toContain('AVAILABLE MENU CONTROLS');
        expect(prompt).toContain("Menu 'view':");
        expect(prompt).toContain('  - Camera Pos');
        expect(prompt).toContain('  - showStarlink');
    });

    test('appends help docs section when availableDocs is non-empty', () => {
        const prompt = buildSystemPrompt({
            dateTime: 'x', simDateTime: 'y',
            menuSummary: {},
            availableDocs: { WhatsNew: 'Recent changes' },
        });
        expect(prompt).toContain('AVAILABLE HELP DOCUMENTATION');
        expect(prompt).toContain('- WhatsNew: Recent changes');
    });
});

// Mock fetch for chat() tests. Each test pushes sequential responses onto
// the queue, and the mock returns them in order.
function mockFetchSequence(responses) {
    const queue = [...responses];
    global.fetch = jest.fn(async (url, init) => {
        const next = queue.shift();
        if (!next) throw new Error('No more mocked responses');
        next.__url = url;
        next.__body = init?.body ? JSON.parse(init.body) : null;
        next.__headers = init?.headers;
        return {
            ok: next.ok !== false,
            status: next.status || 200,
            json: async () => next.body,
        };
    });
    return global.fetch;
}

describe('chat (tool loop)', () => {
    beforeEach(() => {
        jest.resetAllMocks();
    });

    test('returns final text and executes no tools when model ends turn directly', async () => {
        mockFetchSequence([
            { body: { content: [{ type: 'text', text: 'Hello there!' }], stop_reason: 'end_turn' } },
        ]);

        const result = await chat({
            apiKey: 'sk-ant-test',
            provider: 'anthropic',
            model: 'claude-sonnet-4-5-20250929',
            systemPrompt: 'you are a bot',
            history: [],
            userText: 'hi',
            tools: [],
            executeCall: async () => ({ success: true }),
        });

        expect(result.text).toBe('Hello there!');
        expect(result.executedCalls).toEqual([]);
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    test('executes tool_use blocks and feeds results back as tool_result', async () => {
        mockFetchSequence([
            {
                body: {
                    content: [
                        { type: 'text', text: 'Loading satellites...' },
                        { type: 'tool_use', id: 'toolu_01', name: 'satellitesLoadLEO', input: {} },
                    ],
                    stop_reason: 'tool_use',
                },
            },
            {
                body: {
                    content: [{ type: 'text', text: 'Done!' }],
                    stop_reason: 'end_turn',
                },
            },
        ]);

        const executeCall = jest.fn(async (call) => ({ success: true, result: { loaded: 42 } }));
        const result = await chat({
            apiKey: 'sk-ant-test',
            provider: 'anthropic',
            model: 'claude-sonnet-4-5-20250929',
            systemPrompt: 'sp',
            history: [],
            userText: 'load satellites',
            tools: [],
            executeCall,
        });

        expect(executeCall).toHaveBeenCalledTimes(1);
        expect(executeCall.mock.calls[0][0]).toEqual({ fn: 'satellitesLoadLEO', args: {} });
        expect(result.text).toBe('Loading satellites...\nDone!');
        expect(result.executedCalls).toHaveLength(1);
        expect(result.executedCalls[0].fn).toBe('satellitesLoadLEO');

        // Verify the SECOND request echoed the tool_use (with id) and appended
        // a matching tool_result block — Anthropic's protocol requires this.
        const secondCall = fetch.mock.calls[1];
        const secondBody = JSON.parse(secondCall[1].body);
        const asstMsg = secondBody.messages.find(m => m.role === 'assistant');
        expect(asstMsg.content.some(b => b.type === 'tool_use' && b.id === 'toolu_01')).toBe(true);
        const toolResultMsg = secondBody.messages[secondBody.messages.length - 1];
        expect(toolResultMsg.role).toBe('user');
        // The last message's last block carries the prompt-caching breakpoint (#2).
        expect(toolResultMsg.content[0]).toEqual({
            type: 'tool_result',
            tool_use_id: 'toolu_01',
            content: JSON.stringify({ loaded: 42 }),
            is_error: false,
            cache_control: { type: 'ephemeral' },
        });
    });

    test('marks tool_result as error when executeCall returns success: false', async () => {
        mockFetchSequence([
            {
                body: {
                    content: [{ type: 'tool_use', id: 'toolu_x', name: 'badFn', input: {} }],
                    stop_reason: 'tool_use',
                },
            },
            {
                body: {
                    content: [{ type: 'text', text: 'Failed.' }],
                    stop_reason: 'end_turn',
                },
            },
        ]);

        const executeCall = async () => ({ success: false, error: 'Unknown API function: badFn' });
        await chat({
            apiKey: 'k', provider: 'anthropic', model: 'm',
            systemPrompt: 'sp', history: [], userText: 'u', tools: [], executeCall,
        });

        const secondCall = fetch.mock.calls[1];
        const body = JSON.parse(secondCall[1].body);
        const toolResult = body.messages[body.messages.length - 1].content[0];
        expect(toolResult.is_error).toBe(true);
    });

    test('catches thrown errors from executeCall and surfaces them as tool_result errors', async () => {
        mockFetchSequence([
            {
                body: {
                    content: [{ type: 'tool_use', id: 'toolu_y', name: 'boom', input: {} }],
                    stop_reason: 'tool_use',
                },
            },
            {
                body: { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' },
            },
        ]);

        const executeCall = async () => { throw new Error('kaboom'); };
        const result = await chat({
            apiKey: 'k', provider: 'anthropic', model: 'm',
            systemPrompt: 'sp', history: [], userText: 'u', tools: [], executeCall,
        });

        expect(result.executedCalls[0].result.success).toBe(false);
        expect(result.executedCalls[0].result.error).toBe('kaboom');
    });

    test('stops at maxIterations to prevent runaway loops', async () => {
        const toolUseResp = {
            body: {
                content: [{ type: 'tool_use', id: 'toolu_loop', name: 'noop', input: {} }],
                stop_reason: 'tool_use',
            },
        };
        mockFetchSequence([toolUseResp, toolUseResp, toolUseResp]);

        const executeCall = async () => ({ success: true, result: {} });
        await chat({
            apiKey: 'k', provider: 'anthropic', model: 'm',
            systemPrompt: 'sp', history: [], userText: 'u', tools: [], executeCall,
            maxIterations: 3,
        });

        expect(fetch).toHaveBeenCalledTimes(3);
    });

    test('sends the required Anthropic browser-access headers', async () => {
        mockFetchSequence([
            { body: { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' } },
        ]);

        await chat({
            apiKey: 'sk-ant-SECRET',
            provider: 'anthropic', model: 'm',
            systemPrompt: 'sp', history: [], userText: 'u', tools: [], executeCall: async () => ({}),
        });

        const headers = fetch.mock.calls[0][1].headers;
        expect(headers['x-api-key']).toBe('sk-ant-SECRET');
        expect(headers['anthropic-version']).toBe('2023-06-01');
        expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    });

    test('converts {role:"bot"} chat history to {role:"assistant"} for Anthropic', async () => {
        mockFetchSequence([
            { body: { content: [{ type: 'text', text: 'reply' }], stop_reason: 'end_turn' } },
        ]);

        await chat({
            apiKey: 'k', provider: 'anthropic', model: 'm',
            systemPrompt: 'sp',
            history: [
                { role: 'user', text: 'first q' },
                { role: 'bot', text: 'first a' },
            ],
            userText: 'second q',
            tools: [], executeCall: async () => ({}),
        });

        const body = JSON.parse(fetch.mock.calls[0][1].body);
        expect(body.messages.map(m => m.role)).toEqual(['user', 'assistant', 'user']);
        // Middle messages keep plain-string content; only the LAST message is converted to
        // block form to carry the cache breakpoint (#2).
        expect(body.messages[1].content).toBe('first a');
        expect(body.messages[2].content[0].text).toBe('second q');
        expect(body.messages[2].content[0].cache_control).toEqual({ type: 'ephemeral' });
    });

    test('rejects non-Anthropic providers', async () => {
        await expect(chat({
            apiKey: 'k', provider: 'openai', model: 'm',
            systemPrompt: 'sp', history: [], userText: 'u', tools: [], executeCall: async () => ({}),
        })).rejects.toThrow(/not supported/);
    });

    test('throws when API returns non-OK status', async () => {
        mockFetchSequence([
            { ok: false, status: 401, body: { error: { message: 'invalid api key' } } },
        ]);

        await expect(chat({
            apiKey: 'bad', provider: 'anthropic', model: 'm',
            systemPrompt: 'sp', history: [], userText: 'u', tools: [], executeCall: async () => ({}),
        })).rejects.toThrow(/invalid api key/);
    });
});
