// Tests for the pure, transport-free parts of the voice assistant: the tool-schema
// reshape and the usage accounting. The WebRTC connection itself is not exercised here —
// it needs a live key and a real peer connection, so it is verified in the browser.

// CVoiceSession imports BYOKKeyStore, which reaches IndexedDB at call time. Mocked so the
// module loads under Node.
jest.mock('../src/IndexedDBManager', () => {
    const store = new Map();
    return {
        indexedDBManager: {
            async getSetting(key) { return store.has(key) ? store.get(key) : null; },
            async setSetting(key, value) { store.set(key, value); },
            async deleteSetting(key) { store.delete(key); },
            async getAllSettings() { return Object.fromEntries(store); },
            _reset() { store.clear(); },
        },
    };
});

import { CVoiceSession, toRealtimeTools, usageFromResponse, VOICE_MODEL } from '../src/voice/CVoiceSession';
import { estimateCostUSD, emptyUsage, addUsage } from '../src/BYOKUsage';

describe('voice topic scope', () => {
    test('updates the active session instructions when the focus preference changes', () => {
        const context = {sitrecDoc: {}, menuSummary: {}, availableDocs: {}, simDateTime: '2026-09-05'};
        const session = new CVoiceSession({getContext: () => context});
        const sent = [];
        session.dc = {readyState: 'open', send: message => sent.push(JSON.parse(message))};
        session.refreshTools();
        expect(sent[0].session.instructions).toContain('Do not discuss anything unrelated to Sitrec');
        context.sitrecFocused = false;
        session.refreshTools();
        expect(sent[1].session.instructions).toContain('You can discuss any topic');
        expect(sent[1].session.instructions).not.toContain('Do not discuss anything unrelated to Sitrec');
        expect(sent[1].session.tools).toEqual(sent[0].session.tools);
        context.sitrecFocused = true;
        session.refreshTools();
        expect(sent[2].session.instructions).toBe(sent[0].session.instructions);
    });
});

describe('toRealtimeTools', () => {
    const chatTool = {
        type: 'function',
        function: {
            name: 'setMenuValue',
            description: 'Set a menu control.',
            parameters: {type: 'object', properties: {id: {type: 'string'}}, required: ['id']},
        },
    };

    it('flattens the chat-completions shape onto the tool object', () => {
        const [tool] = toRealtimeTools([chatTool]);
        expect(tool).toEqual({
            type: 'function',
            name: 'setMenuValue',
            description: 'Set a menu control.',
            parameters: chatTool.function.parameters,
        });
        // The nested form is what the realtime transport rejects, so assert it is gone
        // rather than merely that the flat fields are present.
        expect(tool.function).toBeUndefined();
    });

    it('returns an empty list for no tools', () => {
        expect(toRealtimeTools(undefined)).toEqual([]);
        expect(toRealtimeTools([])).toEqual([]);
    });
});

describe('usageFromResponse', () => {
    it('separates audio, cached and text tokens', () => {
        const usage = usageFromResponse({
            usage: {
                input_tokens: 1000,
                output_tokens: 500,
                input_token_details: {audio_tokens: 600, cached_tokens: 300, text_tokens: 100},
                output_token_details: {audio_tokens: 400, text_tokens: 100},
            },
        });
        expect(usage.audioInputTokens).toBe(600);
        expect(usage.audioOutputTokens).toBe(400);
        expect(usage.cacheReadTokens).toBe(300);
        // The remainder after audio and cached come out of the reported total.
        expect(usage.inputTokens).toBe(100);
        expect(usage.outputTokens).toBe(100);
        expect(usage.requests).toBe(1);
    });

    it('never produces a negative token count from an inconsistent breakdown', () => {
        const usage = usageFromResponse({
            usage: {
                input_tokens: 100,
                output_tokens: 10,
                input_token_details: {audio_tokens: 900, cached_tokens: 50},
                output_token_details: {audio_tokens: 900},
            },
        });
        expect(usage.inputTokens).toBe(0);
        expect(usage.outputTokens).toBe(0);
    });

    it('falls back to the text counters when no breakdown is reported', () => {
        const usage = usageFromResponse({usage: {input_tokens: 80, output_tokens: 20}});
        expect(usage.inputTokens).toBe(80);
        expect(usage.outputTokens).toBe(20);
        expect(usage.audioInputTokens).toBe(0);
    });

    it('returns null when the response carries no usage at all', () => {
        expect(usageFromResponse({})).toBeNull();
        expect(usageFromResponse(undefined)).toBeNull();
    });
});

describe('voice model pricing', () => {
    it('prices audio tokens at the audio rate, not the text rate', () => {
        const audioOnly = {...emptyUsage(), audioInputTokens: 1e6};
        const textOnly = {...emptyUsage(), inputTokens: 1e6};
        // $32/1M audio in against $4/1M text in. Folding audio into the text counters
        // would have understated a voice session's cost eightfold, which is the whole
        // reason the audio counters exist.
        expect(estimateCostUSD(VOICE_MODEL, audioOnly)).toBeCloseTo(32, 6);
        expect(estimateCostUSD(VOICE_MODEL, textOnly)).toBeCloseTo(4, 6);
    });

    it('prices audio output at its own rate', () => {
        const usage = {...emptyUsage(), audioOutputTokens: 1e6};
        expect(estimateCostUSD(VOICE_MODEL, usage)).toBeCloseTo(64, 6);
    });

    it('uses the flat cached rate rather than a multiple of an input rate', () => {
        const usage = {...emptyUsage(), cacheReadTokens: 1e6};
        expect(estimateCostUSD(VOICE_MODEL, usage)).toBeCloseTo(0.40, 6);
    });

    it('accumulates audio counters through addUsage', () => {
        const total = emptyUsage();
        addUsage(total, {...emptyUsage(), audioInputTokens: 10, audioOutputTokens: 5});
        addUsage(total, {...emptyUsage(), audioInputTokens: 7});
        expect(total.audioInputTokens).toBe(17);
        expect(total.audioOutputTokens).toBe(5);
    });

    it('reads a record written before the audio counters existed as zero', () => {
        // Records stored by an earlier build have only the text fields; the audio ones
        // must default rather than make the cost NaN.
        const legacy = {inputTokens: 100, outputTokens: 50, requests: 1};
        expect(estimateCostUSD(VOICE_MODEL, legacy)).toBeCloseTo(100 * 4e-6 + 50 * 24e-6, 9);
    });
});
