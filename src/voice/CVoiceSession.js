// CVoiceSession.js
// The spoken assistant: a WebRTC connection from this browser straight to OpenAI's
// Realtime API, running on the user's own key (BYOK). Sitrec's server is not in the path
// and never sees the credential, the audio, or the conversation.
//
// LAZY BY CONSTRUCTION. Nothing here is imported at startup. The chat view pulls this
// module in with a dynamic import() the first time the user presses the microphone, so
// the WebRTC plumbing, the tool reshaping and the voice prompt are a separate webpack
// chunk that a user who never speaks never downloads. That is also why this file lives in
// src/voice/ and not src/nodes/ — RegisterNodes.js does require.context('./nodes'), which
// would drag any file placed there into the main bundle whatever import() said.
//
// WHY WEBRTC RATHER THAN THE WEBSOCKET TRANSPORT
// The Realtime API offers both. WebSocket would mean capturing microphone audio, encoding
// PCM16 by hand, and scheduling playback of returned audio chunks against a jitter buffer
// we would have to write. WebRTC hands all of that to the browser's own media stack —
// including echo cancellation, without which the assistant hears its own voice through the
// speakers and interrupts itself on every reply. OpenAI documents WebRTC as the browser
// path for exactly this reason.

import {getKey as byokGetKey} from "../BYOKKeyStore";
import {buildToolSet, buildSystemPrompt} from "../CDirectLLMClient";
import {emptyUsage} from "../BYOKUsage";
import {DEFAULT_VOICE_MODEL} from "../BYOKModelCatalog";

// The default model. Realtime models are not interchangeable with the chat models in the
// AI Model list — they are restricted to /v1/realtime and cannot be called through chat
// completions at all — which is why they have their own Voice Model dropdown rather than
// appearing alongside models a user could pick for typed chat and get an error from.
//
// Re-exported rather than declared here: the constant lives in BYOKModelCatalog so the
// dropdown can name the default without importing this lazily-loaded module. See the note
// there.
export const VOICE_MODEL = DEFAULT_VOICE_MODEL;

// The spoken voice. Kept as a named constant because an unrecognised voice name is
// rejected at session configuration time, and the roster changes as models ship; if a
// future model drops this one the failure arrives as a readable `error` event (surfaced
// through onError) rather than silence.
export const VOICE_NAME = 'alloy';

const OPENAI_REALTIME_BASE = 'https://api.openai.com/v1/realtime';
const CLIENT_SECRETS_URL = `${OPENAI_REALTIME_BASE}/client_secrets`;
const CALLS_URL = `${OPENAI_REALTIME_BASE}/calls`;

// How the assistant should behave when it is speaking rather than writing. The shared
// chatbotSystemPrompt.txt is written for a text window — it permits markdown, encourages
// links, and says nothing about length — and a model handed it unmodified will happily
// read a bulleted list of menu paths aloud. This block is prepended, not substituted, so
// the voice assistant keeps every capability and rule the typed assistant has.
const VOICE_PREAMBLE = `You are speaking out loud, not writing. Everything you say is
converted to speech and heard by the user.

- Keep replies to one or two short sentences unless you are explicitly asked to explain
  something at length. The user can always ask for more.
- Never speak markdown: no asterisks, no bullet characters, no backticks, no URLs, no
  file paths, no code. If you need to refer the user to a document or a menu path, say it
  in plain words ("it is under Settings, then API Keys").
- Never read out an internal identifier, a node id, or a long number. Round numbers to
  something a person would say aloud: say "about twelve thousand feet", not
  "12043.7 feet".
- Do the thing first, then say what you did, in one short sentence. Do not narrate a plan
  before acting, and do not list the steps you are about to take.
- If you did not understand, say so in a few words and ask one short question. Do not
  guess at a location, a time, or an aircraft.
- The user may interrupt you at any time. If they do, stop and listen.

`;

// The Realtime API takes a flatter tool schema than chat completions: the name,
// description and parameters sit on the tool object itself rather than inside a nested
// `function` object. buildToolSet() produces the nested chat-completions shape (it is
// shared with the OpenRouter and Anthropic paths), so it is reshaped here rather than
// forked — one tool definition, three wire formats.
export function toRealtimeTools(tools) {
    return (tools || []).map(tool => ({
        type: 'function',
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
    }));
}

// Ask OpenAI for a short-lived client secret using the user's standard key.
//
// Returns the ephemeral token on success, or null when the request cannot be made from a
// browser at all. The null path is not a failure: the caller then authenticates the SDP
// exchange with the standard key directly, which is the same credential the mint request
// would have used and is already sitting in this browser's IndexedDB. The ephemeral token
// is still preferred when it is available, because it expires in about a minute, so a
// token captured from a network log or a shared screen is worthless a minute later while
// a captured `sk-` key is not.
//
// UNVERIFIED AT THE TIME OF WRITING: OpenAI documents this endpoint as server-side, and
// does not state whether it answers a browser preflight. If it does not, the fetch
// rejects with a TypeError carrying no status (that is what a blocked CORS preflight
// looks like from JavaScript) and we fall through. A real HTTP error — a bad key, no
// credit — is a different thing entirely and is rethrown, because falling back on those
// would just reproduce the same failure one request later with a worse error message.
async function mintEphemeralKey(apiKey, model) {
    let res;
    try {
        res = await fetch(CLIENT_SECRETS_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            // Session configuration is deliberately NOT sent here even though the endpoint
            // accepts it. The tool list depends on the loaded sitch and grows during a
            // session (see discoverSpecialistTools), so it has to be settable over the data
            // channel anyway; configuring it in one place means the two paths cannot drift.
            body: JSON.stringify({session: {type: 'realtime', model}}),
        });
    } catch (e) {
        // Network-level rejection: blocked preflight, offline, or a proxy in the way.
        console.warn('Voice: ephemeral key mint unavailable, using the key directly:', e?.message || e);
        return null;
    }
    if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        const err = new Error(detail?.error?.message || `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
    }
    const data = await res.json().catch(() => ({}));
    // GA returns {value, expires_at, session}. Older shapes nested it under client_secret.
    return data?.value || data?.client_secret?.value || null;
}

// Pull the token counts out of a `response.done` payload into Sitrec's usage record shape.
// Audio and text are separated because they are billed at very different rates — see the
// note on gpt-realtime-2 in BYOKUsage.MODEL_PRICES.
export function usageFromResponse(response) {
    const raw = response?.usage;
    if (!raw) return null;
    const inDetails = raw.input_token_details || {};
    const outDetails = raw.output_token_details || {};
    const usage = emptyUsage();
    usage.requests = 1;
    // The detailed breakdown is authoritative when present. When it is absent, everything
    // lands in the text counters: that under-reports the cost of an audio turn, but the
    // alternative — assuming an undeclared split — would invent a number.
    const audioIn = inDetails.audio_tokens || 0;
    const audioOut = outDetails.audio_tokens || 0;
    const cached = inDetails.cached_tokens || 0;
    usage.audioInputTokens = audioIn;
    usage.audioOutputTokens = audioOut;
    usage.cacheReadTokens = cached;
    // input_tokens is the TOTAL, audio and cached included, so the text remainder is what
    // is left after both are taken out. Clamped at zero: a provider that reports a
    // breakdown exceeding its own total must not produce a negative charge.
    usage.inputTokens = Math.max(0, (raw.input_tokens || 0) - audioIn - cached);
    usage.outputTokens = Math.max(0, (raw.output_tokens || 0) - audioOut);
    return usage;
}

export class CVoiceSession {
    /**
     * @param {object} options
     * @param {function} options.executeCall   async ({fn, args}) => result payload. Normally
     *                                         the chat view's wrapper around
     *                                         sitrecAPI.handleAPICall(call, "chat"), so the
     *                                         voice path inherits every guard the typed path has.
     * @param {function} options.getContext    () => {sitrecDoc, simDateTime, menuSummary,
     *                                         availableDocs}, read at connect time and again
     *                                         on every refreshTools().
     * @param {function} [options.onStatus]    (state, detail) => void. state is one of
     *                                         'connecting' | 'listening' | 'stopped' | 'error'.
     * @param {function} [options.onUserText]  (text) => void, a finished user utterance.
     * @param {function} [options.onAssistantText] (text) => void, a finished spoken reply.
     * @param {function} [options.onToolCall]  ({fn, args}) => void, for the debug log.
     * @param {function} [options.onUsage]     (usage) => void, once per completed response.
     * @param {function} [options.onRound]     () => void, a further round of tool calls is
     *                                         about to be requested — the model has seen the
     *                                         previous round's results.
     * @param {function} [options.onTurnEnd]   () => void, the model finished a response
     *                                         without asking for tools, so its tool loop for
     *                                         this turn is over.
     * @param {function} [options.onError]     (message) => void.
     */
    constructor(options) {
        this.options = options;
        // Pinned for the session's lifetime rather than read per request: the ephemeral
        // key is minted FOR a model, so a mid-session change would leave the token and the
        // SDP exchange disagreeing about which model is being connected to.
        this.model = options.model || DEFAULT_VOICE_MODEL;
        this.pc = null;
        this.dc = null;
        this.micStream = null;
        this.audioEl = null;
        this.active = false;
        this.muted = false;

        // Which of the two authentication routes this session actually took (see
        // mintEphemeralKey). Recorded rather than merely logged, because the fallback is
        // silent by design and the console line scrolls away: with this, "did the browser
        // manage to mint an ephemeral token?" is answerable at any point from the live
        // session object.
        this.usedEphemeralKey = null;

        // Tools that are live in the session right now, in the chat-completions shape.
        // Starts as the common set and grows when the model calls discoverSpecialistTools.
        this.activeTools = [];
        this.specialistTools = {};

        // Tool calls whose execution is still in flight for the current response. The
        // model can emit several calls in one response, and a fresh response must be
        // requested exactly ONCE after the last of them has answered — one response.create
        // per tool call would make the assistant speak N times over itself.
        this.pendingCalls = new Set();
        this.answeredThisResponse = false;
        this.responseComplete = false;
    }

    _status(state, detail) {
        this.options.onStatus?.(state, detail);
    }

    _error(message) {
        console.warn('Voice:', message);
        this.options.onError?.(message);
    }

    /**
     * Open the microphone and connect. Resolves once the data channel is configured, or
     * throws with a message already fit to show the user.
     */
    async start() {
        if (this.active) return;
        this._status('connecting');

        const apiKey = await byokGetKey('openai');
        if (!apiKey) {
            throw new Error('No OpenAI API key stored. Add one under Settings → API Keys… → OpenAI (voice).');
        }

        // The microphone is requested BEFORE any network call so that a user who declines
        // the browser permission prompt has not already spent a request against their key.
        try {
            this.micStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    // Without echo cancellation the microphone picks the assistant's own
                    // voice out of the speakers, server-side turn detection reads that as
                    // the user speaking, and the assistant interrupts itself mid-sentence.
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                },
            });
        } catch (e) {
            throw new Error(e?.name === 'NotAllowedError'
                ? 'Microphone access was refused. Allow it for this site and press the microphone again.'
                : `Could not open the microphone: ${e?.message || e}`);
        }

        let token;
        try {
            token = await mintEphemeralKey(apiKey, this.model);
        } catch (e) {
            this._stopMic();
            throw new Error(`OpenAI refused the key: ${e.message}`);
        }
        // Null means the mint could not be made from a browser at all; the standard key is
        // then used as the bearer for the SDP exchange. See mintEphemeralKey.
        this.usedEphemeralKey = !!token;
        console.log(`Voice: authenticating with ${token ? 'an ephemeral client secret' : 'the stored key directly'}.`);
        const bearer = token || apiKey;

        try {
            await this._connect(bearer);
        } catch (e) {
            this._stopMic();
            throw e;
        }

        this.active = true;
    }

    async _connect(bearer) {
        const pc = new RTCPeerConnection();
        this.pc = pc;

        // Remote audio. An <audio> element is used rather than a WebAudio graph because
        // the browser then owns playback scheduling and device routing, which is the whole
        // reason for choosing WebRTC over the WebSocket transport.
        this.audioEl = document.createElement('audio');
        this.audioEl.autoplay = true;
        pc.ontrack = (e) => {
            this.audioEl.srcObject = e.streams[0];
        };

        for (const track of this.micStream.getTracks()) {
            pc.addTrack(track, this.micStream);
        }

        const dc = pc.createDataChannel('oai-events');
        this.dc = dc;
        dc.addEventListener('message', (e) => {
            let event;
            try {
                event = JSON.parse(e.data);
            } catch (parseError) {
                return;
            }
            // A throw inside an event listener would leave the session running with the
            // handler chain broken and nothing to show for it.
            try {
                this._handleEvent(event);
            } catch (handlerError) {
                this._error(`Voice event handling failed: ${handlerError?.message || handlerError}`);
            }
        });

        // The connection is only usable once the channel opens, and the session must be
        // configured before the user's first words arrive — otherwise the model answers
        // with no tools and no instructions.
        //
        // The same state listener serves both halves of the connection's life. Before the
        // channel opens it rejects the startup promise; afterwards that promise is already
        // settled and rejecting it does nothing, so a later failure has to tear the session
        // down explicitly. Without that second half a dropped connection left the session
        // marked active with the microphone still open and the button still red, waiting
        // for a reply that could never arrive.
        let opening = true;
        const opened = new Promise((resolve, reject) => {
            dc.addEventListener('open', () => {
                opening = false;
                resolve();
            }, {once: true});
            pc.addEventListener('connectionstatechange', () => {
                // 'disconnected' is deliberately NOT terminal: it is the transient state a
                // WebRTC connection passes through while ICE re-establishes, and tearing
                // down there would kill sessions that were about to recover on their own.
                // A connection that does not recover proceeds to 'failed'.
                const state = pc.connectionState;
                if (state !== 'failed' && state !== 'closed') return;
                if (opening) {
                    opening = false;
                    reject(new Error('The voice connection failed.'));
                    return;
                }
                this._connectionLost();
            });
        });

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        const sdpResponse = await fetch(`${CALLS_URL}?model=${encodeURIComponent(this.model)}`, {
            method: 'POST',
            body: offer.sdp,
            headers: {
                'Authorization': `Bearer ${bearer}`,
                'Content-Type': 'application/sdp',
            },
        });
        if (!sdpResponse.ok) {
            const text = await sdpResponse.text().catch(() => '');
            throw new Error(`OpenAI refused the voice connection (HTTP ${sdpResponse.status}). ${text.slice(0, 200)}`);
        }
        await pc.setRemoteDescription({type: 'answer', sdp: await sdpResponse.text()});

        await opened;
        this.refreshTools();
        this._status('listening');
    }

    /**
     * Send the session configuration: instructions, voice, turn detection and the current
     * tool set. Called once on connect, and again whenever the tool set changes — either
     * because the model asked for specialist tools or because a different sitch loaded and
     * the menu summary moved underneath us.
     */
    refreshTools() {
        if (!this.dc || this.dc.readyState !== 'open') return;

        const {sitrecDoc, simDateTime, menuSummary, availableDocs, sitrecFocused} = this.options.getContext();
        const toolSet = buildToolSet(sitrecDoc, menuSummary);
        this.specialistTools = toolSet.specialistTools;
        // Specialist tools already enabled in this session are kept: a rebuild would
        // otherwise silently withdraw a tool the model had just been told it could use.
        const enabledNames = new Set(this.activeTools.map(tool => tool.function.name));
        this.activeTools = toolSet.tools.slice();
        for (const [name, tool] of Object.entries(this.specialistTools)) {
            if (enabledNames.has(name)) this.activeTools.push(tool);
        }

        const instructions = VOICE_PREAMBLE + buildSystemPrompt({
            simDateTime,
            menuSummary,
            availableDocs,
            sitrecFocused,
        });

        this._send({
            type: 'session.update',
            session: {
                type: 'realtime',
                model: this.model,
                instructions,
                // "low" is OpenAI's own recommendation for voice agents: a spoken reply
                // that arrives two seconds late reads as a broken assistant, and the work
                // this one does is tool dispatch rather than analysis.
                reasoning: {effort: 'low'},
                audio: {
                    input: {
                        // Transcription is what puts the user's words into the chat log, so
                        // a voice session leaves the same readable record a typed one does.
                        transcription: {model: 'whisper-1'},
                        turn_detection: {type: 'server_vad'},
                    },
                    output: {voice: VOICE_NAME},
                },
                tools: toRealtimeTools(this.activeTools),
                tool_choice: 'auto',
            },
        });
    }

    _send(event) {
        if (this.dc && this.dc.readyState === 'open') {
            this.dc.send(JSON.stringify(event));
        }
    }

    _handleEvent(event) {
        switch (event.type) {
            case 'error':
                this._error(event.error?.message || 'The voice service reported an error.');
                break;

            // The user's finished utterance, transcribed. Event names have been renamed
            // across Realtime API revisions; both spellings are accepted at this one
            // normalisation point so a rename shows up as a missing transcript in the log
            // rather than as a silent session.
            case 'conversation.item.input_audio_transcription.completed':
            case 'conversation.item.audio_transcription.completed':
                if (event.transcript) this.options.onUserText?.(event.transcript);
                break;

            case 'response.output_audio_transcript.done':
            case 'response.audio_transcript.done':
                if (event.transcript) this.options.onAssistantText?.(event.transcript);
                break;

            case 'response.function_call_arguments.done':
                this._runToolCall(event);
                break;

            case 'response.done': {
                const usage = usageFromResponse(event.response);
                if (usage) this.options.onUsage?.(usage);
                this.responseComplete = true;
                this._maybeContinue();
                break;
            }

            default:
                break;
        }
    }

    /**
     * Execute one tool call and return its result to the model.
     *
     * Every call is answered, including ones that throw. An unanswered function_call_output
     * strands the model: it waits for a result that never arrives and the session goes
     * quiet with the microphone still open, which reads to the user as a crash.
     */
    async _runToolCall(event) {
        const callId = event.call_id;
        let args = {};
        try {
            args = event.arguments ? JSON.parse(event.arguments) : {};
        } catch (e) {
            this._sendToolResult(callId, {success: false, error: 'Malformed arguments.'});
            return;
        }

        const call = {fn: event.name, args};
        this.options.onToolCall?.(call);
        this.pendingCalls.add(callId);

        let result;
        try {
            result = (call.fn === 'discoverSpecialistTools')
                ? this._enableSpecialistTools(args)
                : await this.options.executeCall(call);
        } catch (e) {
            result = {success: false, error: e?.message || String(e)};
        }

        this.pendingCalls.delete(callId);
        this._sendToolResult(callId, result);
        this._maybeContinue();
    }

    // Mirrors enableSpecialistTools() in CDirectLLMClient: the model asks for the full
    // schema of an uncommon constructor, and it is added to the live tool set. On the
    // realtime transport "adding a tool" means resending the session configuration, which
    // is why this cannot simply be delegated to the shared helper.
    _enableSpecialistTools(args) {
        const requested = Array.isArray(args?.names) ? args.names : [];
        const enabled = [];
        const unknown = [];
        const activeNames = new Set(this.activeTools.map(tool => tool.function.name));
        for (const name of requested) {
            const tool = this.specialistTools[name];
            if (!tool) {
                unknown.push(name);
                continue;
            }
            if (!activeNames.has(name)) {
                this.activeTools.push(tool);
                activeNames.add(name);
            }
            enabled.push(name);
        }
        if (enabled.length > 0) {
            this._send({
                type: 'session.update',
                session: {tools: toRealtimeTools(this.activeTools)},
            });
        }
        return {
            success: unknown.length === 0 && enabled.length > 0,
            enabled,
            unknown,
            available: Object.keys(this.specialistTools),
        };
    }

    _sendToolResult(callId, payload) {
        this._send({
            type: 'conversation.item.create',
            item: {
                type: 'function_call_output',
                call_id: callId,
                output: JSON.stringify(payload ?? {success: true}),
            },
        });
        this.answeredThisResponse = true;
    }

    /**
     * Ask for a new response once every tool call from the finished response has answered.
     *
     * Both conditions are needed and neither is enough alone. Requesting on response.done
     * alone would fire while a slow tool was still running, and the model would speak
     * without its result; requesting when the last tool answers would fire before the
     * model had finished emitting the rest of its calls.
     */
    _maybeContinue() {
        if (!this.responseComplete || this.pendingCalls.size > 0) return;
        // A completed response that asked for no tools ends the model's tool loop, and so
        // ends the turn. This — not the spoken transcript — is the boundary a caller
        // tracking a turn's tool calls wants: a tool-using exchange speaks in a LATER
        // response than the one that made the calls, so flushing on the transcript would
        // cut the turn in half and call a repair-in-progress a failure.
        if (!this.answeredThisResponse) {
            this.options.onTurnEnd?.();
            return;
        }
        this.answeredThisResponse = false;
        this.responseComplete = false;
        this.options.onRound?.();
        this._send({type: 'response.create'});
    }

    // The connection died after it had been established. stop() releases the microphone
    // and fires onStatus('stopped'), which is what returns the button to its idle state —
    // so the user sees the session end rather than a red button that no longer listens.
    _connectionLost() {
        if (!this.active) return;   // already torn down; pc.close() re-enters here
        this._error('The voice connection was lost. The microphone is off.');
        this.stop();
    }

    /**
     * Put a typed message into the live spoken conversation and ask for a reply.
     *
     * Returns false when there is no live session, which is the caller's signal to send
     * the message down the ordinary typed path instead. Without this, typing while the
     * microphone was open started a SECOND, separate conversation against a different
     * provider: the spoken session never saw the typed turns, so a later spoken follow-up
     * referred to a conversation it had no record of.
     */
    sendUserText(text) {
        if (!this.active || !this.dc || this.dc.readyState !== 'open') return false;
        this._send({
            type: 'conversation.item.create',
            item: {
                type: 'message',
                role: 'user',
                content: [{type: 'input_text', text}],
            },
        });
        // A conversation item on its own is only added to the history; the model does not
        // act on it until a response is requested.
        this._send({type: 'response.create'});
        return true;
    }

    /** Stop sending microphone audio without tearing the session down. */
    setMuted(muted) {
        this.muted = muted;
        for (const track of this.micStream?.getAudioTracks() || []) {
            track.enabled = !muted;
        }
    }

    _stopMic() {
        for (const track of this.micStream?.getTracks() || []) track.stop();
        this.micStream = null;
    }

    /** Close the connection and release the microphone. Safe to call more than once. */
    stop() {
        // The microphone indicator staying lit after the user pressed stop is the single
        // most alarming thing this feature can do, so the tracks are stopped first and
        // unconditionally — before anything that could throw.
        this._stopMic();
        try {
            this.dc?.close();
        } catch (e) { /* already closed */ }
        try {
            this.pc?.close();
        } catch (e) { /* already closed */ }
        if (this.audioEl) {
            this.audioEl.srcObject = null;
            this.audioEl = null;
        }
        this.dc = null;
        this.pc = null;
        this.pendingCalls.clear();
        this.answeredThisResponse = false;
        this.responseComplete = false;
        if (this.active) {
            this.active = false;
            this._status('stopped');
        }
    }
}
