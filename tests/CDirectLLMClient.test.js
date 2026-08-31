import {
    buildToolSet,
    buildTools,
    convertToolsForAnthropic,
    buildSystemPrompt,
    buildSystemPromptParts,
    chat,
    isBYOKProvider,
} from '../src/CDirectLLMClient';

test('only explicit own-key provider tokens select the browser BYOK route', () => {
    expect(isBYOKProvider('byok-anthropic')).toBe(true);
    expect(isBYOKProvider('byok-openrouter')).toBe(true);
    expect(isBYOKProvider('byok-openai')).toBe(true);
    // The bare names are the SERVER provider tokens in the saved chatModel setting. chat()
    // accepts them as a transport shorthand, but they must never reroute a server-proxied
    // selection around Sitrec's own billing.
    expect(isBYOKProvider('anthropic')).toBe(false);
    expect(isBYOKProvider('openai')).toBe(false);
});

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

    test('keeps specialist schemas out of the fixed tool block until discovered', () => {
        const {tools, specialistTools} = buildToolSet({
            gotoLLA: 'Go. Parameters: lat (number)',
            createWalker: 'Create a walker. Parameters: speed (number)',
        }, {});
        const names = tools.map(tool => tool.function.name);
        expect(names).toContain('gotoLLA');
        expect(names).toContain('discoverSpecialistTools');
        expect(names).not.toContain('createWalker');
        expect(specialistTools.createWalker.function.name).toBe('createWalker');
    });

    // COST GUARD. Every parameter's documentation is parsed out of the description into
    // JSON Schema properties; leaving the "Parameters: ..." tail in the description as well
    // shipped all of it twice, ~24% of the whole tool block, on every request and every
    // tool-loop iteration. The schema keeps the text, so nothing is lost.
    test('strips the Parameters tail from descriptions once it has been parsed into the schema', () => {
        const tools = buildTools({
            gotoLLA: 'Go to a place. Parameters: lat (number: latitude), lon (number: longitude)',
            play: 'Start playback. Parameters: ',
        }, {});

        const goto = tools.find(t => t.function.name === 'gotoLLA');
        expect(goto.function.description).toBe('Go to a place.');
        // The text survives where the model actually needs it.
        expect(goto.function.parameters.properties.lat.description).toBe('number: latitude');

        // CSitrecAPI appends a bare "Parameters: " to every no-argument function, which the
        // parse regex deliberately does not match — the strip regex must still remove it.
        const play = tools.find(t => t.function.name === 'play');
        expect(play.function.description).toBe('Start playback.');
        expect(play.function.description).not.toMatch(/Parameters:/);
    });

    // CACHE GUARD. Tools render BEFORE the system prompt, so anything per-request in a tool
    // description invalidates the cached prefix for the entire request. The menu list is
    // per-sitch, so it must not appear here — it is in the system prompt's menu appendix.
    test('produces byte-identical tools regardless of the menus present', () => {
        const doc = { gotoLLA: 'Go. Parameters: lat (number)' };
        const a = buildTools(doc, { view: ['Camera Pos'], satellites: ['showISS'] });
        const b = buildTools(doc, { terrain: ['Map Type'] });
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));

        const setMenu = a.find(t => t.function.name === 'setMenuValue');
        expect(setMenu.function.description).not.toMatch(/view|satellites|terrain/);
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
        // Simulation time is still present — it moved position, it was not dropped.
        expect(prompt).toContain('2004-11-14T20:30:00Z');
        expect(prompt).not.toContain('{{dateTime}}');
        expect(prompt).not.toContain('{{simDateTime}}');
    });

    // COST GUARD, and the point of the whole three-tier split. simDateTime is
    // GlobalDateTimeNode.dateNow — the playhead — so it changes on nearly every message.
    // It used to sit on line 8 of the base prose, 583 bytes into a ~100 KB prefix, which
    // meant the cached prefix never repeated: with cache_control set, every call paid the
    // 1.25x cache WRITE and never collected a 0.1x read. Nothing cacheable may follow it.
    test('places the volatile simulation clock after every cacheable section', () => {
        const { staticPart, menuPart, volatilePart } = buildSystemPromptParts({
            simDateTime: '2004-11-14T20:30:00Z',
            menuSummary: { view: ['Camera Pos'] },
            availableDocs: { WhatsNew: 'Recent changes' },
        });

        // The clock is confined to the one uncached tier.
        expect(volatilePart).toContain('2004-11-14T20:30:00Z');
        expect(staticPart).not.toContain('2004-11-14T20:30:00Z');
        expect(menuPart).not.toContain('2004-11-14T20:30:00Z');

        // The build-constant help-doc index rides in the cached tier; the per-sitch menu
        // appendix gets its own, so a menu change does not cost the static block.
        expect(staticPart).toContain('AVAILABLE HELP DOCUMENTATION');
        expect(menuPart).toContain('AVAILABLE MENUS');
        expect(staticPart).not.toContain('AVAILABLE MENUS');

        // And the assembled prompt really does end with the volatile part.
        const full = buildSystemPrompt({
            simDateTime: '2004-11-14T20:30:00Z',
            menuSummary: { view: ['Camera Pos'] },
            availableDocs: { WhatsNew: 'Recent changes' },
        });
        expect(full).toBe(staticPart + menuPart + volatilePart);
        expect(full.indexOf('2004-11-14T20:30:00Z'))
            .toBeGreaterThan(full.indexOf('AVAILABLE MENUS'));
    });

    // The static tier must not vary between users on the same build, or the cache entry
    // cannot be shared. Only the menu tier may differ with the sitch.
    test('keeps the static tier identical when only the menus differ', () => {
        const args = { simDateTime: 'a', availableDocs: { WhatsNew: 'Recent changes' } };
        const one = buildSystemPromptParts({ ...args, menuSummary: { view: ['Camera Pos'] } });
        const two = buildSystemPromptParts({ ...args, menuSummary: { terrain: ['Map Type'] } });
        expect(one.staticPart).toBe(two.staticPart);
        expect(one.menuPart).not.toBe(two.menuPart);
    });

    test('appends menu IDs without eagerly shipping every control', () => {
        const args = {
            dateTime: 'x', simDateTime: 'y',
            menuSummary: { view: ['Camera Pos', 'FOV'], satellites: ['showStarlink'] },
            availableDocs: {},
        };
        const prompt = buildSystemPrompt(args);
        const {menuPart} = buildSystemPromptParts(args);
        expect(prompt).toContain('AVAILABLE MENUS');
        expect(prompt).toContain('  - view');
        expect(prompt).toContain('  - satellites');
        expect(menuPart).not.toContain('Camera Pos');
        expect(menuPart).not.toContain('showStarlink');
    });

    test('appends help docs section when availableDocs is non-empty', () => {
        const prompt = buildSystemPrompt({
            dateTime: 'x', simDateTime: 'y',
            menuSummary: {},
            availableDocs: { WhatsNew: 'Recent changes' },
        });
        expect(prompt).toContain('AVAILABLE HELP DOCUMENTATION');
        // Each doc carries its link so the assistant can cite it — {{name}} appears
        // twice in the shared docsItem template, so both must be substituted.
        expect(prompt).toContain('- WhatsNew (docs/WhatsNew.html): Recent changes');
        expect(prompt).not.toContain('{{');
    });

    // Guards the DRY refactor: the prompt text now lives in the single shared file
    // sitrecServer/chatbotSystemPrompt.txt, parsed identically by chatbot.php. If a
    // section is renamed or dropped, buildSystemPrompt must fail loudly rather than
    // quietly sending the model a prompt with a hole in it.
    test('carries the full shared prompt, including sections the old browser copy had lost', () => {
        const prompt = buildSystemPrompt({simDateTime: 'y', menuSummary: {}, availableDocs: {}});
        // These four were present server-side but missing from the hand-synced JS copy.
        expect(prompt).toContain('CAMERA POINTING vs LOCKING');
        expect(prompt).toContain('MULTI-PART REQUESTS (CRITICAL)');
        expect(prompt).toContain('HOW TO READ "[Tool Results]" MESSAGES');
        expect(prompt).toContain('lockCameraOnRaDec');
        // No unsubstituted placeholders and no stray section markers leaked through.
        expect(prompt).not.toContain('@@SECTION');
        expect(prompt).not.toContain('{{');
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

    test('takes OpenAI-shaped tools and converts them exactly once', async () => {
        // Regression guard. callAnthropic() runs convertToolsForAnthropic() itself, so
        // callers must hand chat() the OpenAI shape from buildTools(). Passing already
        // converted tools threw on `t.function` of an Anthropic-shaped tool and no BYOK
        // request could be sent — invisible to the rest of this suite because every
        // other chat() test passes an empty tool list, which converts to [] either way.
        const fetchMock = mockFetchSequence([
            { body: { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' } },
        ]);

        await chat({
            apiKey: 'sk-ant-test',
            provider: 'anthropic',
            model: 'claude-opus-5',
            systemPrompt: 'you are a bot',
            history: [],
            userText: 'hi',
            tools: [{
                type: 'function',
                function: {
                    name: 'setMenuValue',
                    description: 'Set a menu control',
                    parameters: { type: 'object', properties: { path: { type: 'string' } } },
                },
            }],
            executeCall: async () => ({ success: true }),
        });

        const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(sent.tools).toEqual([{
            name: 'setMenuValue',
            description: 'Set a menu control',
            input_schema: { type: 'object', properties: { path: { type: 'string' } } },
        }]);
    });

    // CACHE GUARD. Nothing else in this suite looks at body.system, so a regression that
    // collapsed the tiers back into one block — or dropped a breakpoint — would be silent
    // and would only show up as a provider bill.
    test('sends one cache-marked system block per stable tier, and none on the volatile one', async () => {
        const fetchMock = mockFetchSequence([
            { body: { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' } },
        ]);

        await chat({
            apiKey: 'sk-ant-test',
            provider: 'anthropic',
            model: 'claude-opus-5',
            systemParts: { staticPart: 'STATIC', menuPart: 'MENU', volatilePart: 'CLOCK' },
            history: [],
            userText: 'hi',
            tools: [],
            executeCall: async () => ({ success: true }),
        });

        const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(sent.system).toEqual([
            { type: 'text', text: 'STATIC', cache_control: { type: 'ephemeral' } },
            { type: 'text', text: 'MENU', cache_control: { type: 'ephemeral' } },
            { type: 'text', text: 'CLOCK' },
        ]);
    });

    // The API rejects an empty text block, so a sitch with no menus must not produce one.
    test('omits system tiers that are empty', async () => {
        const fetchMock = mockFetchSequence([
            { body: { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' } },
        ]);

        await chat({
            apiKey: 'sk-ant-test',
            provider: 'anthropic',
            model: 'claude-opus-5',
            systemParts: { staticPart: 'STATIC', menuPart: '', volatilePart: 'CLOCK' },
            history: [],
            userText: 'hi',
            tools: [],
            executeCall: async () => ({ success: true }),
        });

        const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(sent.system).toEqual([
            { type: 'text', text: 'STATIC', cache_control: { type: 'ephemeral' } },
            { type: 'text', text: 'CLOCK' },
        ]);
    });

    // Back-compat: a caller that only has the concatenated string still works, and still
    // gets a cached block — this is the pre-split behavior.
    test('falls back to a single cached block when no split is supplied', async () => {
        const fetchMock = mockFetchSequence([
            { body: { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' } },
        ]);

        await chat({
            apiKey: 'sk-ant-test',
            provider: 'anthropic',
            model: 'claude-opus-5',
            systemPrompt: 'you are a bot',
            history: [],
            userText: 'hi',
            tools: [],
            executeCall: async () => ({ success: true }),
        });

        const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(sent.system).toEqual([
            { type: 'text', text: 'you are a bot', cache_control: { type: 'ephemeral' } },
        ]);
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

    test('loads a specialist schema only after the model discovers it', async () => {
        const {tools, specialistTools} = buildToolSet({
            createWalker: 'Create a walker. Parameters: speed (number)',
        }, {});
        mockFetchSequence([
            {
                body: {
                    content: [{
                        type: 'tool_use', id: 'toolu_discover',
                        name: 'discoverSpecialistTools', input: {names: ['createWalker']},
                    }],
                    stop_reason: 'tool_use',
                },
            },
            {body: {content: [{type: 'text', text: 'Ready.'}], stop_reason: 'end_turn'}},
        ]);

        const executeCall = jest.fn(async () => ({success: true}));
        await chat({
            apiKey: 'k', provider: 'anthropic', model: 'm', systemPrompt: 'sp',
            history: [], userText: 'make a walker', tools, specialistTools, executeCall,
        });

        const firstTools = JSON.parse(fetch.mock.calls[0][1].body).tools;
        const secondTools = JSON.parse(fetch.mock.calls[1][1].body).tools;
        expect(firstTools.map(tool => tool.name)).not.toContain('createWalker');
        expect(secondTools.map(tool => tool.name)).toContain('createWalker');
        expect(executeCall).not.toHaveBeenCalled();
    });

    test('does not buy a confirmation turn after successful action-only calls', async () => {
        mockFetchSequence([{
            body: {
                content: [{type: 'tool_use', id: 'toolu_play', name: 'play', input: {}}],
                stop_reason: 'tool_use',
            },
        }]);

        const result = await chat({
            apiKey: 'k', provider: 'anthropic', model: 'm', systemPrompt: 'sp',
            history: [], userText: 'play', tools: [],
            executeCall: async () => ({success: true}),
            needsModelResult: () => false,
        });

        expect(fetch).toHaveBeenCalledTimes(1);
        expect(result.text).toBe('Done.');
        expect(result.executedCalls).toHaveLength(1);
    });

    test('still buys a continuation when a call returns information', async () => {
        mockFetchSequence([
            {
                body: {
                    content: [{type: 'tool_use', id: 'toolu_get', name: 'getMenuValue', input: {}}],
                    stop_reason: 'tool_use',
                },
            },
            {body: {content: [{type: 'text', text: 'It is 42.'}], stop_reason: 'end_turn'}},
        ]);

        const result = await chat({
            apiKey: 'k', provider: 'anthropic', model: 'm', systemPrompt: 'sp',
            history: [], userText: 'what is it', tools: [],
            executeCall: async () => ({success: true, result: 42}),
            needsModelResult: () => true,
        });

        expect(fetch).toHaveBeenCalledTimes(2);
        expect(result.text).toBe('It is 42.');
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

    test('rejects unsupported providers', async () => {
        // 'openai' used to be the example here; it is now a real transport, so this needs a
        // provider that genuinely has no route.
        await expect(chat({
            apiKey: 'k', provider: 'gemini', model: 'm',
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

describe('chat (direct OpenAI BYOK)', () => {
    beforeEach(() => {
        jest.resetAllMocks();
    });

    // api.openai.com now answers a browser preflight on /v1/chat/completions with
    // access-control-allow-origin echoing the caller and 'authorization' among the allowed
    // headers, so the aggregator hop is no longer required to reach GPT from the page.
    test('calls api.openai.com directly, without OpenRouter-only fields', async () => {
        mockFetchSequence([{
            body: {
                choices: [{message: {role: 'assistant', content: 'Hello from OpenAI.'}, finish_reason: 'stop'}],
                usage: {
                    prompt_tokens: 100,
                    completion_tokens: 12,
                    prompt_tokens_details: {cached_tokens: 30},
                },
            },
        }]);

        const result = await chat({
            apiKey: 'sk-proj-secret', provider: 'byok-openai', model: 'gpt-5-mini',
            systemParts: {staticPart: 'STATIC', menuPart: 'MENUS', volatilePart: 'CLOCK'},
            history: [{role: 'bot', text: 'earlier'}], userText: 'hello', tools: [],
            executeCall: async () => ({success: true}), sessionId: 'sitrec-session-1',
        });

        const [url, init] = fetch.mock.calls[0];
        const sent = JSON.parse(init.body);
        expect(url).toBe('https://api.openai.com/v1/chat/completions');
        expect(init.headers.Authorization).toBe('Bearer sk-proj-secret');
        // OpenAI rejects unknown top-level body fields outright rather than ignoring them,
        // and X-Title is OpenRouter's attribution header — neither may be sent here.
        expect(sent.session_id).toBeUndefined();
        expect(init.headers['X-Title']).toBeUndefined();
        expect(sent.model).toBe('gpt-5-mini');
        expect(sent.messages[0]).toEqual({role: 'system', content: 'STATICMENUSCLOCK'});
        expect(result.text).toBe('Hello from OpenAI.');
        // No `cost` comes back from OpenAI, so the tokens are what the caller prices.
        expect(result.usage).toMatchObject({
            inputTokens: 70, outputTokens: 12, cacheReadTokens: 30, requests: 1, costUSD: 0,
        });
    });

    // The model list is now whatever the key exposes, so one fixed request body cannot
    // serve it. These two cases were both measured against a real key on 2026-08-31.
    test('drops reasoning_effort and retries when a model rejects it outright', async () => {
        mockFetchSequence([
            {ok: false, status: 400, body: {error: {message:
                'Unrecognized request argument supplied: reasoning_effort'}}},
            {body: {choices: [{message: {role: 'assistant', content: 'OK'}, finish_reason: 'stop'}]}},
        ]);

        const result = await chat({
            apiKey: 'k', provider: 'byok-openai', model: 'gpt-4o-quirk-drop',
            systemPrompt: 'sp', history: [], userText: 'u', tools: [],
            executeCall: async () => ({success: true}),
        });

        expect(fetch.mock.calls).toHaveLength(2);
        expect(JSON.parse(fetch.mock.calls[0][1].body).reasoning_effort).toBe('low');
        expect(JSON.parse(fetch.mock.calls[1][1].body).reasoning_effort).toBeUndefined();
        // The cap is not optional — dropping it would send an uncapped request.
        expect(JSON.parse(fetch.mock.calls[1][1].body).max_completion_tokens).toBeGreaterThan(0);
        expect(result.text).toBe('OK');
    });

    test('uses the value the provider names, rather than dropping the parameter', async () => {
        // gpt-5.6-sol's actual 400: it accepts reasoning_effort, but only as 'none' once
        // function tools are in play. Dropping it would be the wrong request.
        mockFetchSequence([
            {ok: false, status: 400, body: {error: {message:
                'Function tools with reasoning_effort are not supported for gpt-5.6-sol in '
                + "/v1/chat/completions. To use function tools, use /v1/responses or set "
                + "reasoning_effort to 'none'."}}},
            {body: {choices: [{message: {role: 'assistant', content: 'OK'}, finish_reason: 'stop'}]}},
        ]);

        const result = await chat({
            apiKey: 'k', provider: 'byok-openai', model: 'gpt-quirk-none',
            systemPrompt: 'sp', history: [], userText: 'u', tools: [],
            executeCall: async () => ({success: true}),
        });

        expect(JSON.parse(fetch.mock.calls[1][1].body).reasoning_effort).toBe('none');
        expect(result.text).toBe('OK');
    });

    test('gives up rather than looping when the same rejection repeats', async () => {
        const same = {ok: false, status: 400, body: {error: {message:
            'Unrecognized request argument supplied: reasoning_effort'}}};
        mockFetchSequence([same, same, same, same]);

        await expect(chat({
            apiKey: 'k', provider: 'byok-openai', model: 'gpt-quirk-stubborn',
            systemPrompt: 'sp', history: [], userText: 'u', tools: [],
            executeCall: async () => ({}),
        })).rejects.toThrow(/OpenAI API error/);
        // One remedy is available, so one retry — never an unbounded loop.
        expect(fetch.mock.calls.length).toBeLessThanOrEqual(3);
    });

    test('names OpenAI, not OpenRouter, when the key is rejected', async () => {
        mockFetchSequence([
            {ok: false, status: 401, body: {error: {message: 'Incorrect API key provided'}}},
        ]);

        await expect(chat({
            apiKey: 'bad', provider: 'byok-openai', model: 'gpt-5-mini',
            systemPrompt: 'sp', history: [], userText: 'u', tools: [],
            executeCall: async () => ({}),
        })).rejects.toThrow(/OpenAI API error: Incorrect API key provided/);
    });
});

describe('chat (OpenRouter BYOK)', () => {
    beforeEach(() => {
        jest.resetAllMocks();
    });

    test('uses the OpenAI-compatible endpoint and preserves exact charged usage', async () => {
        mockFetchSequence([{
            body: {
                choices: [{message: {role: 'assistant', content: 'Hello via OpenRouter.'}, finish_reason: 'stop'}],
                usage: {
                    prompt_tokens: 120,
                    completion_tokens: 15,
                    prompt_tokens_details: {cached_tokens: 20, cache_write_tokens: 5},
                    cost: 0.004321,
                },
            },
        }]);

        const result = await chat({
            apiKey: 'sk-or-secret', provider: 'byok-openrouter', model: 'openai/gpt-5-mini',
            systemParts: {staticPart: 'STATIC', menuPart: 'MENUS', volatilePart: 'CLOCK'},
            history: [{role: 'bot', text: 'earlier'}], userText: 'hello', tools: [],
            executeCall: async () => ({success: true}), sessionId: 'sitrec-session-1',
        });

        const [url, init] = fetch.mock.calls[0];
        const sent = JSON.parse(init.body);
        expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
        expect(init.headers.Authorization).toBe('Bearer sk-or-secret');
        expect(sent.model).toBe('openai/gpt-5-mini');
        expect(sent.messages[0]).toEqual({role: 'system', content: 'STATICMENUSCLOCK'});
        expect(sent.session_id).toBe('sitrec-session-1');
        expect(result.text).toBe('Hello via OpenRouter.');
        expect(result.usage).toMatchObject({
            inputTokens: 95, outputTokens: 15,
            cacheReadTokens: 20, cacheWriteTokens: 5,
            requests: 1, costUSD: 0.004321,
        });
    });

    test('round-trips OpenRouter tool calls and results using OpenAI message roles', async () => {
        mockFetchSequence([
            {
                body: {
                    choices: [{
                        message: {
                            role: 'assistant', content: null,
                            tool_calls: [{
                                id: 'call_1', type: 'function',
                                function: {name: 'getMenuValue', arguments: '{"menu":"view","path":"FOV"}'},
                            }],
                        },
                        finish_reason: 'tool_calls',
                    }],
                    usage: {prompt_tokens: 10, completion_tokens: 4, cost: 0.001},
                },
            },
            {
                body: {
                    choices: [{message: {role: 'assistant', content: 'The FOV is 30.'}, finish_reason: 'stop'}],
                    usage: {prompt_tokens: 20, completion_tokens: 6, cost: 0.002},
                },
            },
        ]);

        const executeCall = jest.fn(async () => ({success: true, result: 30}));
        const result = await chat({
            apiKey: 'k', provider: 'byok-openrouter', model: 'openai/gpt-5-nano',
            systemPrompt: 'sp', history: [], userText: 'FOV?', tools: [], executeCall,
            needsModelResult: () => true,
        });

        expect(executeCall).toHaveBeenCalledWith({
            fn: 'getMenuValue', args: {menu: 'view', path: 'FOV'},
        });
        const messages = JSON.parse(fetch.mock.calls[1][1].body).messages;
        expect(messages.some(message => message.role === 'assistant' && message.tool_calls)).toBe(true);
        expect(messages).toContainEqual({role: 'tool', tool_call_id: 'call_1', content: '30'});
        expect(result.text).toBe('The FOV is 30.');
        expect(result.usage).toMatchObject({requests: 2, costUSD: 0.003});
    });

    test('never executes a tool call from a length-truncated response', async () => {
        mockFetchSequence([{
            body: {
                choices: [{
                    message: {
                        content: null,
                        tool_calls: [{id: 'partial', function: {name: 'play', arguments: '{}'}}],
                    },
                    finish_reason: 'length',
                }],
                usage: {},
            },
        }]);
        const executeCall = jest.fn();

        const result = await chat({
            apiKey: 'k', provider: 'byok-openrouter', model: 'openai/gpt-5-mini',
            systemPrompt: 'sp', history: [], userText: 'play', tools: [], executeCall,
        });

        expect(executeCall).not.toHaveBeenCalled();
        expect(result.text).toMatch(/cut off/);
    });
});
