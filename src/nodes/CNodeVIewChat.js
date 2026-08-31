import {CNodeViewText} from "./CNodeViewText";
import {GlobalDateTimeNode, Globals, guiMenus, markSitchDirty, withTestUser} from "../Globals";
import {SITREC_APP, SITREC_SERVER} from "../configUtils";
import {sitrecAPI} from "../CSitrecAPI";
import {getEnvBool} from "../envUtils";
import {ModelFiles} from "./CNode3DObject";
import {clientNLU} from "../CClientNLU";
import {t} from "../i18n";
import {AI_DOC_CHAR_LIMIT, getChatAvailableDocs} from "../docsRegistry";
import {linkifyToHTML} from "../linkify";
import {mirrorMenuItem} from "../MenuMirror";
import {getKey as byokGetKey} from "../BYOKKeyStore";
import {formatTurnUsage, recordUsage} from "../BYOKUsage";
import {
    buildSystemPromptParts,
    buildToolSet,
    chat as chatDirect,
    isBYOKProvider,
    keyProviderForBYOK,
} from "../CDirectLLMClient";

// The "recording" pulse, shared by both microphone buttons.
//
// It has to be a BACKGROUND effect, not a text color. The button's glyph is the emoji
// U+1F3A4, which the platform paints from Apple Color Emoji / Noto Color Emoji — colour
// bitmaps in the font, immune to CSS `color`. The old indicator set color:#ff5555 and
// changed nothing visible on macOS or Windows, which is exactly why a live microphone was
// easy to miss. A filled, pulsing pill behind the glyph is unmistakable and works
// wherever the emoji does.
let voicePulseInstalled = false;

function installVoicePulseStyle() {
    if (voicePulseInstalled || typeof document === "undefined") return;
    voicePulseInstalled = true;
    const style = document.createElement("style");
    style.textContent = `
        @keyframes sitrec-mic-pulse {
            0%   { box-shadow: 0 0 0 0 rgba(217,48,37,0.85); }
            70%  { box-shadow: 0 0 0 7px rgba(217,48,37,0); }
            100% { box-shadow: 0 0 0 0 rgba(217,48,37,0); }
        }
        @media (prefers-reduced-motion: reduce) {
            .sitrec-mic-live { animation: none !important; }
        }
    `;
    document.head.appendChild(style);
}

// Names the server's copy of a user-supplied API key, so it has to be unguessable
// rather than merely unique - Math.random() is not a source for that. randomUUID()
// needs a secure context and is absent over plain http://, but getRandomValues() is
// there either way, so the fallback draws from it too.
function randomSessionId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return "sitrec-" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// What the model gets back from a tool call.
//
// On success that is just the return value, as before. On failure it is the whole
// handleAPICall envelope, because that is where the correctable detail lives: the
// error, near-miss control or function names, the parameter list a throw did not
// satisfy, and any error dialog raised underneath the call (which no longer goes to
// the screen when the model is the caller). Handing back only the inner result threw
// all of that away, and the model retried the same wrong call until the continuation
// depth ran out.
function toolPayloadForModel(callResult) {
    if (callResult.success === false || callResult.errorDialogs) return callResult;
    return callResult.result ?? callResult;
}

// One line of failure text, wherever the detail ended up. This is the MODEL's copy:
// full, with every candidate list intact, because that is what it repairs the call from.
function errorTextOf(callResult) {
    return callResult.error
        ?? callResult.result?.error
        ?? callResult.errorDialogs?.join("; ")
        ?? "the call failed";
}

// The same failure, trimmed for a person.
//
// A lookup failure carries the whole candidate set for the model to retry from —
// "Control 'Track Line Width' not found. Available: *Frustum, Toggle ALL [E]xtend To
// Ground, ... Did you mean: video:Annotate/Line Width, contents:w_gfca/Line Width, ...?"
// — which is several hundred tokens of scaffolding a user has no use for. Keep the
// reason, drop the lists. The full text still goes to the debug channel.
function userFacingErrorText(callResult) {
    return String(errorTextOf(callResult))
        .split(/\s+(?:Available|Menus|Did you mean|Available functions):/)[0]
        .trim();
}

// One turn's tool-failure state.
//
// A plain object owned by the turn, NOT fields on the view, because turns overlap: the
// input box takes a second message while the first is still waiting on the provider, and
// the voice session runs beside both. Held on the view, the second turn's start would
// wipe the first turn's buffer and the first turn's end would then wipe the second's.
//
// A turn is counted in ROUNDS — one round per provider round trip, i.e. one batch of tool
// calls issued together from a single model response. The distinction is what separates a
// repair from independent work: the model can only repair a call after it has SEEN the
// error, so a repair always lands in a LATER round. Two setMenuValue calls in the SAME
// round are two different pieces of the same request, and one succeeding says nothing
// about the other.
//
// `round` is the current round; `failures` remember the round they failed in;
// `successRounds` maps a function name to the last round it succeeded in.
function newTurn() {
    return {round: 0, failures: [], successRounds: new Map()};
}

// Called at each provider round trip, before that round's calls run.
function nextRound(turn) {
    if (turn) turn.round++;
}

class CNodeViewChat extends CNodeViewText {
    constructor(v) {
        // Set up configuration for the base class
        v.title = 'Sitrec Assistant';
        v.idPrefix = 'chat-view';
        v.hideOnFileDrop = true; // Chat should hide when files are dropped

        super(v);

        // There's no mechanism to disable it in SitCustom,
        // so if it's not flagged enabled, just hide it
        if (!getEnvBool("CHATBOT_ENABLED", process.env.CHATBOT_ENABLED)) {
            this.hide();
            return;
        }

        // Rename outputArea to chatLog for consistency with existing code
        this.chatLog = this.outputArea;
        this.chatLog.classList.add('cnodeview-chatlog');
        this.chatLog.style.fontSize = '15px'; // Larger font for chat

        // Initialize chat-specific properties
        this.chatHistory = [];
        this.historyPosition = 0; // For navigating chat history
        this.byokSessionId = randomSessionId();

        // Voice state, initialised HERE rather than lazily on first press.
        //
        // voiceGeneration in particular: startVoice does `++this.voiceGeneration`,
        // and `++undefined` is NaN. NaN is never equal to itself, so the
        // `this.voiceGeneration !== generation` cancellation check fired on its
        // very first test and every startup returned silently right after the
        // dynamic import — the microphone button did nothing at all, with no
        // error and no message. A counter that is only ever compared for
        // inequality has to start as a number.
        this.voiceGeneration = 0;
        this.voiceSession = null;
        this.voiceStarting = false;

        // The voice session's implicit turn — see noteCallResult(). The typed paths carry
        // their own turn object down the call chain instead, so they can overlap safely.
        this.voiceTurn = null;

        // Create input box
        this.createInputBox();

        // Set up chat-specific event listeners
        this.setupChatEventListeners();

        // Add to Help menu
        guiMenus.help.add(this, "show").name(t("misc.aiAssistant.label")).moveToFirst().onChange(() => {
            guiMenus.help.close()
        });

        // Add welcome message
        this.addSystemMessage("Hi! Welcome to Sitrec!\nYou can ask me to do things like adjust the position and time, e.g. 'go to London at 12pm yesterday'." +
            "\n\nYou can ask me to do things like 'show me orion's belt.'" +
            "\n\nOr simple math like 'what is 2+2' or 'how long is 1° of latitude.'" +
            "\n\nOr anything that you can do with the menu commands, e.g. 'use OSM' or 'ambient only'" +
            "\n\nYou can toggle me on and off with Tab, or click on the X, or 'Assistant' in the Help menu" +
            "\n\nThis window can be resized and moved around, and you can scroll the chat log with the mouse wheel. Up arrow will repeat the last command" +
            "\n\nI'm a work in progress, so please be patient with me! Report bugs, quirks, and features you would like to Mick West on Metabunk" +
            "");
    }

    /**
     * Override to adjust height for chat with input box
     */
    getOutputAreaHeight() {
        return 'calc(100% - 40px)'; // Just the tab — input is inside the chat log
    }

    /**
     * Override to add "New Chat" button instead of "Clear" button
     */
    addTabButtons() {
        // With the UIBar: New Chat as a "+" icon (next to the "Assistant" title) plus
        // "New Chat" / "Clear" in the Assistant menu. The floating button is the fallback.
        if (this.uiBar) {
            this.uiBar.addIcon('+', () => this.newChat(), 'New chat', 'new-chat', true);
            // Speak to the assistant. Always shown, never conditional on a stored key:
            // pressing it with no key gives a message naming the setting to fill in, which
            // is how a user discovers the feature exists at all. The handler lazily
            // imports the whole voice implementation, so an untouched button costs nothing
            // beyond this line.
            this.voiceButton = this.uiBar.addIcon(
                '\u{1F3A4}', () => this.toggleVoice(), t("misc.voice.start"), 'voice', true);
            // A second microphone in the menu bar, left of the version panel. The header
            // one lives in auto-hiding view chrome that can be scrolled past, collapsed or
            // closed, so it is not a dependable "you are being recorded" indicator on its
            // own — and stopping a live microphone must never require finding a window.
            // Both buttons are the same control, styled together by _setVoiceButtonState.
            this.voiceBarButton = Globals.menuBar?.addBarIcon(
                '\u{1F3A4}', () => this.toggleVoiceFromBar(), t("misc.voice.start"), 'voice') ?? null;
            const m = this.uiBar.titleMenu;
            if (m) {
                m.add({newChat: () => this.newChat()}, 'newChat').name('New Chat');
                m.add({clear: () => this.clearOutput()}, 'clear').name('Clear');
                // Mirror the Settings "AI Model" dropdown here so the model can be switched
                // straight from the Assistant header; it stays in sync with Settings.
                mirrorMenuItem('chatModel', m, {name: 'AI Model'});
            }
            return;
        }
        // Fallback: floating "New Chat" button (no UIBar).
        const newChatButton = document.createElement('button');
        newChatButton.textContent = 'New Chat';
        newChatButton.style.position = 'absolute';
        newChatButton.style.top = '28px';
        newChatButton.style.right = '18px';
        newChatButton.style.padding = '2px 10px';
        newChatButton.style.fontSize = '13px';
        newChatButton.style.borderRadius = '16px';
        newChatButton.style.border = 'none';
        newChatButton.style.background = 'var(--cnodeview-tab-bg)';
        newChatButton.style.color = 'var(--cnodeview-tab-color)';
        newChatButton.style.cursor = 'pointer';
        newChatButton.style.boxShadow = '0 1px 4px rgba(0,0,0,0.08)';
        newChatButton.addEventListener('click', () => this.newChat());
        this.div.appendChild(newChatButton);
        this.newChatButton = newChatButton;
    }

    // Start a new chat (clear the log + history, reset the input).
    newChat() {
        // A live voice session holds its own conversation on OpenAI's side, and the
        // Realtime API has no "clear it" event — items can only be deleted one id at a
        // time. So the session is ended instead: clearing the log while the spoken
        // conversation silently continued would mean the next thing the user said was
        // answered in the context of a chat they had just been shown was gone.
        const hadVoice = !!this.voiceSession || this.voiceStarting;
        if (hadVoice) this.stopVoice(false);

        this.clearOutput();
        this.chatHistory = [];
        this.addSystemMessage("New chat started.\n"
            + (hadVoice ? "Voice stopped — press the microphone to start a new spoken session.\n" : ""));
        if (this.inputBox) {
            this.inputBox.value = '';
            this.inputBox.focus();
        }
    }

    // ── Voice ────────────────────────────────────────────────────────────────────────
    //
    // The spoken assistant is a separate transport onto the SAME assistant: identical
    // system prompt, identical tool set, identical execution guards. Only the model and
    // the medium differ, so everything below is wiring rather than a second assistant.
    //
    // The implementation is loaded on first press and never before — see the dynamic
    // import in startVoice(). src/voice/ is outside the require.context('./nodes') sweep
    // in RegisterNodes.js precisely so that split can happen.

    async toggleVoice() {
        if (this.voiceSession?.active) {
            this.stopVoice();
        } else {
            await this.startVoice();
        }
    }

    // The menu-bar microphone is reachable with the Assistant closed, and a spoken session
    // whose transcript, errors and "no key set" message all land in a hidden window is a
    // dead end. So starting from the bar opens the window first. Stopping does not: a user
    // silencing a live microphone wants it off, not a panel in their way.
    async toggleVoiceFromBar() {
        if (!this.voiceSession?.active && !this.visible) this.setVisible(true);
        await this.toggleVoice();
    }

    async startVoice() {
        // Guard against a second press while the first is still connecting: start() opens
        // the microphone and spends a request, and two sessions would talk over each other.
        if (this.voiceStarting) return;
        this.voiceStarting = true;
        this._setVoiceButtonState('connecting');

        // Startup spans several awaits — the dynamic import, the microphone permission
        // prompt, the token mint, the SDP exchange — and the view can be hidden or
        // disposed during any of them. A generation counter is the cancellation signal:
        // every teardown path bumps it, so a startup that completes afterwards knows its
        // result is unwanted and closes it immediately. Without this, hiding the Assistant
        // or loading a sitch mid-connect left a live microphone owned by a view that no
        // longer had a button to stop it.
        const generation = ++this.voiceGeneration;
        const cancelled = () => this.voiceGeneration !== generation;

        try {
            const {CVoiceSession, VOICE_MODEL} = await import(
                /* webpackChunkName: "voice" */ "../voice/CVoiceSession");
            if (cancelled()) return;
            this.voiceModel = VOICE_MODEL;

            const session = new CVoiceSession({
                getContext: () => ({
                    sitrecDoc: sitrecAPI.getLLMDocumentation(),
                    menuSummary: sitrecAPI.getMenuSummary(),
                    availableDocs: getChatAvailableDocs(),
                    simDateTime: GlobalDateTimeNode.dateNow
                        ? GlobalDateTimeNode.dateNow.toISOString() : null,
                }),
                executeCall: (call) => this.executeVoiceCall(call),
                onStatus: (state) => this._setVoiceButtonState(state),
                // Spoken turns join the same log and the same chatHistory as typed ones.
                // The other half of that promise is in handleMessage(), which routes typed
                // input INTO the live session rather than down the typed path — both
                // halves are needed, or the two sides keep separate conversations.
                onUserText: (text) => this.addUserMessage(text),
                onAssistantText: (text) => this.addSystemMessage(text),
                // The session's own tool-loop boundaries, NOT the spoken transcript. A
                // tool-using exchange speaks in a later response than the one that made the
                // calls, so flushing on the transcript would split one turn in two and
                // report a repair still in progress. onTurnEnd fires when the model
                // completes a response without asking for tools — its work is done.
                onRound: () => nextRound(this.voiceTurn),
                onTurnEnd: () => {
                    const turn = this.voiceTurn;
                    this.voiceTurn = null;
                    this.endTurn(turn);
                },
                onToolCall: (call) => this.addDebugMessage(`Voice call: ${JSON.stringify(call)}`),
                onUsage: (usage) => {
                    this.addDebugMessage(formatTurnUsage(this.voiceModel, usage));
                    recordUsage(this.voiceModel, usage)
                        .catch(e => console.warn('Voice usage not recorded:', e));
                },
                onError: (message) => this.addSystemMessage(`[voice] ${message}`),
            });

            // Published only once the connection is up. Assigning before start() would
            // leave a half-built session reachable from stopVoice() and from handleMessage().
            await session.start();
            // The teardown that ran during start() could not see this session, so it is
            // closed here instead. The microphone was opened; it must not stay open.
            if (cancelled()) {
                session.stop();
                return;
            }
            this.voiceSession = session;
            this.addSystemMessage(t("misc.voice.listening"));
        } catch (e) {
            // start() throws messages already written for a user to act on, so this is
            // shown as-is rather than wrapped in a generic failure line.
            this.addSystemMessage(`[voice] ${e?.message || e}`);
            this.voiceSession = null;
            this._setVoiceButtonState('stopped');
        } finally {
            this.voiceStarting = false;
        }
    }

    // Every path that ends a voice session goes through here, so the generation bump that
    // cancels an in-flight startup cannot be forgotten at one of them.
    stopVoice(announce = true) {
        this.voiceGeneration = (this.voiceGeneration || 0) + 1;
        this.voiceSession?.stop();
        this.voiceSession = null;
        this._setVoiceButtonState('stopped');
        // A session stopped between a failed call and the reply that would have explained
        // it leaves a turn open. Close it here so the failure is not simply lost. Gated on
        // `announce` for the same reason the stopped notice is: dispose() comes through
        // with announce=false while the log is being torn down.
        const turn = this.voiceTurn;
        this.voiceTurn = null;
        if (announce) {
            this.endTurn(turn);
            this.addSystemMessage(t("misc.voice.stopped"));
        }
    }

    // Hiding the Assistant ends the voice session.
    //
    // setVisible is the single choke point every user-facing hide passes through — the
    // header X, the Show/Views checkbox, the title-menu close, Escape, Tab, and an API
    // hide() — which is why the override sits here and NOT on setVisibleRaw: that one
    // exists for render machinery mechanically forcing view flags around an offline pass,
    // and a Scripted Video render must not cut the user off mid-sentence.
    //
    // Without this the X button left the microphone streaming and billing with no visible
    // indicator at all, since the red button had just been hidden along with the view —
    // and docs/APIKeys.md promises the opposite.
    setVisible(visible) {
        if (!visible && (this.voiceSession || this.voiceStarting)) {
            this.stopVoice(false);
        }
        super.setVisible(visible);
    }

    // The voice path runs tool calls through exactly the same entry point and the same
    // "chat" source as the typed BYOK path, so llmCallable:false refusals, the external-URL
    // refusal and the external-sitch write confirmation all apply unchanged. A separate
    // dispatch here would be a second door into the API with none of those locks on it.
    async executeVoiceCall(call) {
        // getHelpDoc is implemented in chatbot.php and locally in fetchHelpDoc — it is NOT
        // a CSitrecAPI entry. The shared system prompt actively tells the model to use it
        // for "how do I…" questions, so without this branch every spoken documentation
        // question came back "Unknown API function: getHelpDoc". The typed BYOK path has
        // the same branch for the same reason.
        //
        // getChatAvailableDocs() is re-read rather than captured at session start: it is
        // built from the static docsRegistry, so it returns the same allowlist the prompt
        // advertised, and re-reading keeps the allowlist correct if the registry ever
        // becomes dynamic.
        if (call.fn === "getHelpDoc") {
            return await this.fetchHelpDoc(call.args?.docName, getChatAvailableDocs());
        }

        const callResult = await sitrecAPI.handleAPICall(call, "chat");
        if (sitrecAPI.callChangesSerializedState(call, callResult)) {
            markSitchDirty();
        }
        // The first tool call opens the turn; onTurnEnd closes it. Read and written on the
        // main thread with no await between, so a call can never land in a flushed turn.
        this.voiceTurn ??= newTurn();
        this.noteCallResult(this.voiceTurn, call, callResult);
        return toolPayloadForModel(callResult);
    }

    // A live microphone must not outlive the view that owns it. Loading a new sitch
    // disposes this view and builds another, so without this the tracks stay open, the
    // browser's recording indicator stays lit, and the old session keeps billing the
    // user's key while answering questions about a sitch that is no longer loaded.
    //
    // stop() is called directly rather than through stopVoice(), which writes to the chat
    // log — the log is being torn down around us.
    dispose() {
        // stopVoice(false) rather than stop() on the session: the generation bump also
        // cancels a startup still in flight, which owns a microphone this object cannot
        // yet see. `false` suppresses the chat-log line — the log is being torn down.
        this.stopVoice(false);
        // The menu bar outlives this view (it is rebuilt per sitch, the bar is not), so the
        // icon we added to it would otherwise accumulate one stale, dead copy per reload.
        if (this.voiceBarButton) {
            Globals.menuBar?.removeBarIcon(this.voiceBarButton);
            this.voiceBarButton = null;
        }
        super.dispose();
    }

    // Paint both microphone buttons — the view header's and the menu bar's — from one
    // state, so they can never disagree about whether the page is recording.
    _setVoiceButtonState(state) {
        installVoicePulseStyle();
        const listening = state === 'listening';
        const connecting = state === 'connecting';
        const title = listening ? t("misc.voice.stop") : t("misc.voice.start");

        for (const btn of [this.voiceButton, this.voiceBarButton]) {
            if (!btn) continue;
            // A filled pill, not a text color: see installVoicePulseStyle() for why the
            // emoji glyph cannot be recolored.
            btn.style.background = listening ? '#d93025' : (connecting ? '#8a6d00' : 'transparent');
            btn.style.borderRadius = '10px';
            btn.style.boxShadow = 'none';       // cleared so the animation owns it
            btn.style.animation = listening ? 'sitrec-mic-pulse 1.6s ease-out infinite' : 'none';
            btn.classList.toggle('sitrec-mic-live', listening);
            btn.style.opacity = (listening || connecting) ? '1' : '0.7';
            // Both bars re-apply this on pointerleave, and read it to decide the resting
            // opacity — so a live microphone stays fully lit when the pointer moves away.
            btn.dataset.uibarPinned = listening ? 'true' : 'false';
            btn.dataset.barPinned = listening ? 'true' : 'false';
            btn.title = title;
            btn.setAttribute('aria-label', title);
        }

        // The menu-bar copy has room for a word, and a word is what reads at a glance from
        // across the screen — the header copy sits in a cramped icon row and keeps to the
        // pill alone.
        if (this.voiceBarButton) {
            this.voiceBarButton.textContent = listening
                ? '\u{1F3A4} REC'
                : (connecting ? '\u{1F3A4} \u2026' : '\u{1F3A4}');
            this.voiceBarButton.style.color = 'white';
            this.voiceBarButton.style.fontWeight = listening ? 'bold' : 'normal';
            this.voiceBarButton.style.fontSize = listening ? '11px' : '14px';
            this.voiceBarButton.style.letterSpacing = listening ? '0.06em' : 'normal';
        }
    }

    /**
     * Create the input box for chat
     */
    createInputBox() {
        // Terminal-style: prompt line lives inside the scrollable chat log
        this.promptLine = document.createElement('div');
        this.promptLine.style.display = 'flex';
        this.promptLine.style.alignItems = 'baseline';
        this.promptLine.style.margin = '4px 0';

        const promptPrefix = document.createElement('span');
        promptPrefix.textContent = '> ';
        promptPrefix.style.color = 'var(--cnodeview-chat-color)';
        promptPrefix.style.flexShrink = '0';
        this.promptLine.appendChild(promptPrefix);

        this.inputBox = document.createElement('input');
        this.inputBox.type = 'text';
        this.inputBox.style.flex = '1';
        this.inputBox.style.border = 'none';
        this.inputBox.style.outline = 'none';
        this.inputBox.style.backgroundColor = 'transparent';
        this.inputBox.style.color = 'var(--cnodeview-chat-color)';
        this.inputBox.style.fontFamily = 'monospace';
        this.inputBox.style.fontSize = '15px';
        this.inputBox.style.padding = '0';
        this.inputBox.style.margin = '0';
        this.inputBox.style.width = '0';        // flex handles sizing
        this.inputBox.style.minWidth = '0';
        this.inputBox.classList.add('cnodeview-input');
        this.promptLine.appendChild(this.inputBox);

        this.chatLog.tabIndex = 0; // Make chatLog focusable
        this.chatLog.appendChild(this.promptLine);
    }

    /**
     * Set up chat-specific event listeners
     */
    setupChatEventListeners() {
        // Global capture of the Tab key to toggle visibility
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
                e.preventDefault();  // prevent character insertion
                e.stopPropagation(); // stop other handlers
                this.toggleChatVisibility();
            } else if (e.key === 'Escape') {
                // If escape, hide the chat view
                this.hide();
            }
        });

        // Handle input box key events
        this.inputBox.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
                const text = this.inputBox.value.trim();
                if (text) {
                    this.addUserMessage(text);
                    this.sendToServer(text);
                    this.inputBox.value = '';
                }
            } else if (e.key === 'ArrowUp') {
                // Navigate chat history up
                const userMessages = this.chatHistory.filter(msg => msg.role === 'user');
                if (userMessages.length === 0 || this.historyPosition === userMessages.length) return;
                const index = userMessages.length - 1 - this.historyPosition;
                const message = userMessages[index];
                this.setInputTextAndFocus(message.text);
                this.historyPosition = (this.historyPosition + 1);
            } else if (e.key === 'ArrowDown') {
                // Navigate chat history down
                const userMessages = this.chatHistory.filter(msg => msg.role === 'user');
                this.historyPosition--;
                if (this.historyPosition <= 0) {
                    this.historyPosition = 0;
                    this.setInputTextAndFocus("");
                } else {
                    const index = userMessages.length - 0 - this.historyPosition;
                    const message = userMessages[index];
                    this.setInputTextAndFocus(message.text);
                }
            } else if (e.key === 'Tab') {
                e.preventDefault();  // Stop tab from shifting focus
                this.toggleChatVisibility();
            } else if (e.key === 'Escape') {
                // If escape, hide the chat view
                this.hide();
            }
        });

        // Swallow double click events on the inputBox
        this.inputBox.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            e.preventDefault();
        });

        // Also stop key propagation on the chatLog
        this.chatLog.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Tab') {
                e.preventDefault();
                this.toggleChatVisibility();
            }
        });

        // Add click handler to the main div to focus input box when clicking in the chat area
        this.div.addEventListener('click', (e) => {
            // The header bar is a child of this div, so its controls click through to here. Taking
            // focus off one breaks it: a <select> loses its open drop-down list the moment it
            // blurs, so the "AI Model" menu flashed up and closed again. One contains() covers the
            // title, the icons and the open menu — the dropdown is a descendant of the bar.
            if (this.uiBar && this.uiBar.bar.contains(e.target)) return;
            // Only focus if we're not clicking on interactive elements and no text is selected
            const selection = window.getSelection();
            const hasSelection = selection && selection.toString().length > 0;
            if (e.target !== this.closeButton && e.target !== this.newChatButton && !hasSelection) {
                this.inputBox.focus();
            }
        });
    }

    setInputTextAndFocus(text) {
        this.inputBox.value = text;
        // move the cursor to the end of the input box
        setTimeout(() => {
            this.inputBox.focus();
            this.inputBox.setSelectionRange(this.inputBox.value.length, this.inputBox.value.length);
        }, 0);
    }

    toggleChatVisibility() {
        this.setVisible(!this.visible);
        if (this.visible) {
            this.inputBox.focus();
        }
    }

    // Add user message to chat log
    addUserMessage(text) {
        const div = document.createElement('div');
        div.textContent = `You: ${text}`;
        div.style.margin = '4px 0';
        div.style.color = `var(--cnodeview-chat-color)`;
        this.chatLog.insertBefore(div, this.promptLine);
        this.cullMessages();
        this.scrollToBottom();
        this.chatHistory.push({ role: 'user', text });
    }

    // Add bot/system message to chat log.
    //
    // recordInHistory:false writes to the pane ONLY. chatHistory is not just the scroll-back
    // — historyToAnthropicMessages() in CDirectLLMClient turns every `bot` entry into an
    // assistant message on the next request, so anything recorded here is read back by the
    // model as words it said itself. That is right for its own replies and wrong for
    // locally generated notices about it, which is what the flag is for.
    addSystemMessage(text, recordInHistory = true) {
        const div = document.createElement('div');
        // Render clickable links (help-doc links, URLs) the same way the Notes view
        // does. linkifyToHTML HTML-escapes the text before inserting anchors, so
        // assigning innerHTML here is safe from injection.
        div.innerHTML = 'Bot: ' + linkifyToHTML(text);
        div.style.margin = '4px 0';
        div.style.color = `var(--cnodeview-bot-color)`;
        this.chatLog.insertBefore(div, this.promptLine);
        this.cullMessages();
        this.scrollToBottom();
        if (recordInHistory) this.chatHistory.push({ role: 'bot', text });
    }

    // Add debug message to chat log (if enabled)
    addDebugMessage(text) {
        if (!sitrecAPI.debug) return;
        const div = document.createElement('div');
        div.textContent = `Debug: ${text}`;
        div.style.margin = '4px 0';
        div.style.color = `var(--cnodeview-debug-color)`;
        this.chatLog.insertBefore(div, this.promptLine);
        this.cullMessages();
        this.scrollToBottom();
    }

    // ---- Per-turn tool-failure reporting -------------------------------------------
    //
    // A failed tool call is not, by itself, news. The whole failure envelope goes back to
    // the model (toolPayloadForModel), which is exactly what lets it repair the call on the
    // next iteration of its tool loop — up to maxIterations, and across continueSession()
    // round trips on the server path. Printing each failure as it happened therefore showed
    // the user the model's SEARCH, not a failure:
    //
    //     Bot: Error: Control 'Track Line Width' not found. Available: *Frustum, ...
    //     Bot: Error: Folder 'Line Width' not found. Available: Views, Graphs, ...
    //     Bot: Error: Control 'Track Line Width' not found. Available: *HUD Color, ...
    //     Bot: Done.
    //
    // and, because addSystemMessage recorded each line in chatHistory, fed all three back
    // on the next request as assistant turns the model never wrote — crowding real turns
    // out of the 10-message window.
    //
    // So the failures are buffered instead, and what the user actually needs to be told is
    // narrower than "a call failed": it is that SOMETHING THEY ASKED FOR DID NOT HAPPEN.
    // Two things follow.
    //
    // Only failed ACTIONS are buffered. A failed query — listMenuControls, getMenuValue,
    // everything in CHAT_MODEL_RESULT_CALLS — changed nothing; it IS the model looking
    // around, and it is the bulk of the noise. Those go to the debug channel only.
    //
    // A buffered failure is dropped only when the same function succeeded in a LATER round
    // — which is what a repair looks like: setMenuValue(menu:"tracks") fails, the model
    // reads the error, and in the next round setMenuValue(menu:"contents") succeeds.
    //
    // Both halves of that test are load-bearing. Not "anything succeeded", or a successful
    // lookup would license hiding a failed action under a confident "Done." And not "the
    // same function succeeded", or one failed and one successful setMenuValue in the SAME
    // batch — two different tracks, one of which did not get set — would cancel out.
    noteCallResult(turn, call, callResult) {
        const fn = call?.fn ?? callResult.fn ?? "call";
        if (callResult.success !== false) {
            turn?.successRounds.set(fn, turn.round);
            return;
        }
        // The debug channel always gets the untrimmed text, for every failure.
        this.addDebugMessage(`${fn} failed: ${errorTextOf(callResult)}`);
        if (sitrecAPI.callNeedsModelResult(fn)) return;
        turn?.failures.push({fn, text: userFacingErrorText(callResult), round: turn.round});
    }

    // End of turn: report whatever was never repaired.
    endTurn(turn) {
        if (!turn) return;
        const unrepaired = turn.failures.filter(
            f => (turn.successRounds.get(f.fn) ?? -1) <= f.round);
        if (unrepaired.length === 0) return;

        // Deduplicated because a repaired call is retried with near-identical arguments,
        // and capped because a batch over every track fails once per track with the same
        // reason. Not recorded in chatHistory: this is Sitrec talking, not the model.
        const unique = [...new Set(unrepaired.map(f => f.text))];
        const shown = unique.slice(0, 3).join("\n");
        const rest = unique.length > 3 ? `\n(and ${unique.length - 3} more)` : "";
        this.addSystemMessage(`Error: ${shown}${rest}`, false);
    }

    clearOutput() {
        super.clearOutput();
        // Re-append the prompt line (innerHTML='' removed it)
        this.chatLog.appendChild(this.promptLine);
    }

    async handleMessage(text) {
        this.historyPosition = 0;

        // While the microphone is open, typing is another turn in the SAME conversation:
        // the text goes into the live session and is answered out loud. Anything else
        // starts a second conversation with a second provider that the spoken one cannot
        // see, so a later spoken "do that again" refers to a turn no one remembers.
        //
        // This deliberately bypasses the local NLU as well. A command matched and executed
        // locally would be exactly such an invisible turn — cheaper, but it puts the two
        // sides back out of step.
        if (this.voiceSession?.sendUserText(text)) {
            return;
        }

        // Interrogatives ("how ...", "why ...") are knowledge / how-to questions, not
        // UI commands. Send them straight to the LLM (which can answer or read a help
        // doc) instead of letting the command-matching NLU fuzzy-match them into a
        // toggle. Without this, "how do I have a track of az/el" became "Enabled ...".
        if (/^\s*(?:how|why)\b/i.test(text)) {
            await this.sendToLLM(text);
            return;
        }

        const parseResult = clientNLU.parse(text);
        this.addDebugMessage(`NLU: ${parseResult.patternName || 'none'} (${parseResult.confidence})`);

        if (parseResult.intent && parseResult.confidence > 0) {
            const executeResult = await clientNLU.execute(parseResult);

            if (executeResult.success || (executeResult.success !== false && !executeResult.needsLLM)) {
                const response = clientNLU.generateResponse(parseResult, executeResult);
                this.addSystemMessage(response);
                this.addDebugMessage(`Local: ${JSON.stringify(executeResult)}`);
                // Only mark dirty for commands that change serialized sitch state
                // Navigation/transient commands (camera, frame, time, math) don't count
                const navigationalIntents = new Set([
                    "MATH", "SET_FRAME", "SET_DATETIME", "SET_TIME_RELATIVE",
                    "ZOOM_IN", "ZOOM_OUT", "POINT_AT", "LOCK_ON", "UNLOCK",
                    "PLAY", "PAUSE", "GOTO_LLA", "GOTO_NAMED_LOCATION",
                ]);
                if (!navigationalIntents.has(parseResult.intent)) {
                    markSitchDirty();
                }
                return;
            }

            if (executeResult.needsLLM) {
                this.addDebugMessage(`Local failed, falling back to LLM: ${executeResult.error}`);
            }
        }

        await this.sendToLLM(text);
    }

    // The single owner of the tool-failure turn: both the server route below and the BYOK
    // route it delegates to buffer their failures in `turn`, and the finally reports
    // whatever was never repaired. That covers the whole turn including the
    // continueSession() chain, which is awaited inside, so a call repaired three round
    // trips later still counts as repaired.
    //
    // `turn` is a local carried down the call chain, not a field on the view: the input box
    // accepts a second message while this one is still waiting on the provider, and two
    // turns sharing one buffer would erase each other's failures.
    async sendToLLM(text) {
        const turn = newTurn();
        try {
            const timeString = GlobalDateTimeNode.timeWithTimeZone(new Date());
            const simDate = GlobalDateTimeNode.dateNow ? GlobalDateTimeNode.dateNow.toISOString() : null;

            const chatModelSetting = Globals.settings.chatModel || "";
            const [provider, model] = chatModelSetting.includes(':')
                ? chatModelSetting.split(':')
                : [null, null];

            // BYOK: the user picked a "(your key)" model, so call its direct browser route
            // instead of proxying through chatbot.php. The distinct provider token makes
            // this an explicit user choice, never an inference.
            if (isBYOKProvider(provider)) {
                await this.sendToLLMDirect(text, provider, model, simDate, turn);
                return;
            }

            const history = this.chatHistory.slice(-10);
            // Help docs the AI assistant may read via the getHelpDoc tool to answer
            // "how do I..." / UI / feature questions. The list (and its descriptions)
            // lives in src/docsRegistry.js — the same source the Help menu is built
            // from — so the menu and the AI can't drift apart, and every doc name is
            // guaranteed to match a real docs/<name>.md.
            const availableDocs = getChatAvailableDocs();
            const body = JSON.stringify({
                history,
                prompt: text,
                sitrecDoc: sitrecAPI.getLLMDocumentation(),
                menuSummary: sitrecAPI.getMenuSummary(),
                availableModels: Object.keys(ModelFiles),
                availableDocs: availableDocs,
                dateTime: timeString,
                simDateTime: simDate,
                provider: provider,
                model: model,
            });

            const res = await fetch(withTestUser(SITREC_SERVER + 'chatbot.php'), {
                body,
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                credentials: 'include',
            });
            const response = await res.json();
            console.log("Chatbot response:", response);
            if (response.debug) {
                this.addDebugMessage(`Server debug: ${JSON.stringify(response.debug)}`);
            }
            if (response.text) this.addSystemMessage(response.text);
            if (response.apiCalls && response.apiCalls.length > 0) {
                this.addDebugMessage(`API calls: ${JSON.stringify(response.apiCalls)}`);
                const {toolResults, changesSerializedState, allSucceeded, actionOnly} = await this.handleAPICalls(response.apiCalls, turn);
                if (changesSerializedState) {
                    markSitchDirty();
                }

                this.logUnhandledLLMCall(text, response.apiCalls);

                // A successful batch containing actions only needs no second provider call
                // just to say "Done". Reads and failures still continue so the model can use
                // their result or repair the call.
                if (response.sessionContinue
                    && !(allSucceeded && actionOnly && !response.requiresContinuation)) {
                    await this.continueSession(toolResults, provider, model, 0, turn);
                } else if (allSucceeded && actionOnly && !response.text) {
                    this.addSystemMessage("Done.");
                }
            } else if (response.text) {
                this.logUnhandledLLMCall(text, null, response.text);
            }
        } catch (e) {
            this.addSystemMessage("[error contacting server]");
            console.error(e);
        } finally {
            this.endTurn(turn);
        }
    }

    // BYOK path: browser → Anthropic directly, or browser → OpenRouter → the selected
    // upstream model, using the user's own stored key. This is an explicit model choice;
    // Sitrec's server receives neither the credential nor the conversation.
    //
    // Differences from the server path above, all deliberate:
    //  - CDirectLLMClient.chat() owns the whole tool loop, so there is no
    //    sessionContinue round-trip and no continueSession() recursion here.
    //  - Nothing is POSTed to logNLU.php. A user who supplied their own key is
    //    asking to talk to Anthropic and not to us; quietly copying their prompts
    //    to the Sitrec server would break that expectation.
    //  - The system prompt and tools are built client-side, from the same shared
    //    chatbotSystemPrompt.txt the server uses, so the assistant behaves the same.
    async sendToLLMDirect(text, provider, model, simDate, turn) {
        const keyProvider = keyProviderForBYOK(provider);
        const apiKey = await byokGetKey(keyProvider);
        if (!apiKey) {
            // Name the service that actually failed. This said "Anthropic" for every BYOK
            // provider, so an OpenAI key problem was reported against the wrong account.
            const label = {openrouter: "OpenRouter", openai: "OpenAI", anthropic: "Anthropic"}
                [keyProvider] ?? "AI provider";
            this.addSystemMessage(`[No ${label} API key stored. Add one under Settings → AI Key, or choose a different AI Model.]`);
            return;
        }

        let changesSerializedState = false;
        const executedForLog = [];

        // The caller pushes the user's message into chatHistory *before* dispatching,
        // and chat() appends userText itself — so trim that duplicate tail or the model
        // sees the current request twice and may repeat the action. The server path
        // relies on the same convention from the other side: chatbot.php builds its
        // messages from `history` alone and uses `prompt` only for logging and length
        // validation, never appending it.
        const priorHistory = this.chatHistory.slice();
        const lastEntry = priorHistory[priorHistory.length - 1];
        if (lastEntry && lastEntry.role === 'user' && lastEntry.text === text) {
            priorHistory.pop();
        }

        try {
            const menuSummary = sitrecAPI.getMenuSummary();
            // Hoisted: the prompt advertises these docs and fetchHelpDoc() below uses the
            // same object as its allowlist, so the two can never disagree about what the
            // model was told it may read.
            const availableDocs = getChatAvailableDocs();
            const toolSet = buildToolSet(sitrecAPI.getLLMDocumentation(), menuSummary);
            const result = await chatDirect({
                apiKey,
                provider,
                model,
                // Split by stability so callAnthropic can put a cache breakpoint at each
                // boundary — see buildSystemPromptParts(). The concatenated string is not
                // needed here; callAnthropic assembles the blocks itself.
                systemParts: buildSystemPromptParts({
                    simDateTime: simDate,
                    menuSummary,
                    availableDocs,
                }),
                history: priorHistory.slice(-10),
                userText: text,
                // OpenAI-shaped on purpose: Anthropic converts it at its boundary, while
                // OpenRouter accepts this shape directly.
                tools: toolSet.tools,
                specialistTools: toolSet.specialistTools,
                // getHelpDoc is implemented locally on the BYOK path rather than as a
                // CSitrecAPI entry, so name it explicitly alongside the API's result set.
                needsModelResult: fn => fn === "getHelpDoc" || sitrecAPI.callNeedsModelResult(fn),
                sessionId: this.byokSessionId,
                // Marks each provider round trip, so a repaired call can be told from an
                // independent one. See newTurn().
                onRound: () => nextRound(turn),
                executeCall: async (call) => {
                    // getHelpDoc is implemented in chatbot.php, not in CSitrecAPI, so on the
                    // BYOK path it has to be served locally — otherwise the model, which the
                    // shared prompt actively tells to use it, burns a tool-loop iteration on
                    // a guaranteed "Unknown API function".
                    if (call.fn === "getHelpDoc") {
                        return await this.fetchHelpDoc(call.args?.docName, availableDocs);
                    }

                    // "chat" source, exactly as the server path uses, so llmCallable:false
                    // entries (e.g. the JS-executing scripted-video functions) stay refused.
                    // handleAPICall is async — without the await, every check below would
                    // inspect a pending Promise instead of a result, so markSitchDirty()
                    // would never fire and tool errors would never surface to the user.
                    const callResult = await sitrecAPI.handleAPICall(call, "chat");
                    if (sitrecAPI.callChangesSerializedState(call, callResult)) {
                        changesSerializedState = true;
                    }
                    const payload = toolPayloadForModel(callResult);
                    this.noteCallResult(turn, call, callResult);
                    executedForLog.push({fn: call.fn, args: call.args});
                    // Returning the failure-bearing object lets the client set is_error correctly.
                    return payload;
                },
            });

            // The user is billed directly for this turn, so surface what it cost and add
            // it to the running total shown in Settings. Failures here must never take
            // down the chat turn itself.
            if (result.usage) {
                this.addDebugMessage(formatTurnUsage(model, result.usage));
                recordUsage(model, result.usage)
                    .catch(e => console.warn('BYOK usage not recorded:', e));
            }

            if (executedForLog.length > 0) {
                this.addDebugMessage(`API calls: ${JSON.stringify(executedForLog)}`);
            }
            if (changesSerializedState) {
                markSitchDirty();
            }
            if (result.text) {
                this.addSystemMessage(result.text);
            } else if (executedForLog.length === 0) {
                this.addSystemMessage("[no response]");
            }
        } catch (e) {
            // Surface the provider's own message — an invalid or expired key is the
            // most likely cause and the user is the only one who can fix it.
            const label = keyProvider === "openrouter" ? "OpenRouter" : "Anthropic";
            this.addSystemMessage(`[${label} error: ${e && e.message ? e.message : e}]`);
            console.error(e);
        }
    }

    // Client-side getHelpDoc for the BYOK path. Mirrors getHelpDocContent() in
    // chatbot.php: same name-shape allowlist, same availableDocs membership check, same
    // comment stripping and character limit. The docName comes from the model, so both
    // checks are load-bearing — the shape test blocks path traversal ("../../config"),
    // and the membership test keeps it to docs we chose to expose.
    async fetchHelpDoc(docName, availableDocs) {
        if (typeof docName !== "string" || !/^[A-Za-z0-9_-]+$/.test(docName)) {
            return {success: false, error: `Invalid doc name: ${docName}`};
        }
        if (!availableDocs || !availableDocs[docName]) {
            return {
                success: false,
                error: `Unknown doc: ${docName}. Available: ${Object.keys(availableDocs || {}).join(", ")}`,
            };
        }
        try {
            const res = await fetch(`${SITREC_APP}docs/${docName}.md`);
            if (!res.ok) {
                return {success: false, error: `Doc file not found: ${docName} (HTTP ${res.status})`};
            }
            // (?:-->|$) so an unterminated "<!--" at the end of a truncated file is
            // dropped too, rather than leaving a half-comment in the text handed to the model.
            let content = (await res.text()).replace(/<!--[\s\S]*?(?:-->|$)/g, "");
            if (content.length > AI_DOC_CHAR_LIMIT) {
                content = content.slice(0, AI_DOC_CHAR_LIMIT)
                    + `\n\n[Content truncated - showing first ${AI_DOC_CHAR_LIMIT} characters of this document.`
                    + ` Tell the user that your answer may be incomplete and point them at the full document.]`;
            }
            return {success: true, content};
        } catch (e) {
            return {success: false, error: `Could not read doc ${docName}: ${e && e.message ? e.message : e}`};
        }
    }

    async logUnhandledLLMCall(prompt, apiCalls, textResponse = null) {
        try {
            await fetch(withTestUser(SITREC_SERVER + 'logNLU.php'), {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                credentials: 'include',
                body: JSON.stringify({
                    prompt,
                    apiCalls,
                    textResponse,
                    timestamp: Date.now(),
                }),
            });
        } catch (e) {
            console.warn("Failed to log unhandled LLM call:", e);
        }
    }

    // Legacy method name for compatibility
    async sendToServer(text) {
        return this.handleMessage(text);
    }

    // Process any API calls returned by the server - returns results for session continuation
    async handleAPICalls(calls, turn) {
        // One batch from one model response = one round. Everything in it was decided
        // before the model saw any of these results, so nothing in it can repair anything
        // else in it.
        nextRound(turn);
        const toolResults = [];
        let changesSerializedState = false;
        let allSucceeded = true;
        let actionOnly = calls.length > 0;
        for (const call of calls) {
            // "chat" source: these calls came from the LLM, so llmCallable:false entries
            // (e.g. the JS-executing scripted-video functions) are refused (B1).
            // handleAPICall is async: without the await, `result` is a pending Promise, so
            // `result.result ?? result` yields the Promise itself and every tool result was
            // JSON.stringify'd to "{}" on its way back to the model — and both the
            // dirty-state check and the error message below silently read undefined.
            const result = await sitrecAPI.handleAPICall(call, "chat");
            toolResults.push({ fn: call.fn, args: call.args, result: toolPayloadForModel(result) });
            if (result.success === false || result.result?.success === false) allSucceeded = false;
            if (sitrecAPI.callNeedsModelResult(call)) actionOnly = false;
            if (sitrecAPI.callChangesSerializedState(call, result)) {
                changesSerializedState = true;
            }

            // Buffered, not printed. Keyed off the OUTER success so a thrown error and an
            // unknown function name are recorded too, not just a function that returned
            // {success:false} — and since an agent's failure no longer raises a dialog,
            // endTurn() is the only place the user learns the model asked for something
            // Sitrec could not do. Success messages come from the model's own reply.
            this.noteCallResult(turn, call, result);
        }
        return {toolResults, changesSerializedState, allSucceeded, actionOnly};
    }
    
    async continueSession(toolResults, provider, model, depth = 0, turn = null) {
        const maxContinuationDepth = 5;
        if (depth >= maxContinuationDepth) {
            console.warn(`Session continuation stopped: reached max depth (${maxContinuationDepth})`);
            return;
        }
        try {
            const body = JSON.stringify({
                continueSession: true,
                toolResults,
                provider,
                model,
            });

            const res = await fetch(withTestUser(SITREC_SERVER + 'chatbot.php'), {
                body,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
            });
            const response = await res.json();
            console.log("Session continue response:", response);
            if (response.debug) {
                this.addDebugMessage(`Continue debug: ${JSON.stringify(response.debug)}`);
            }
            if (response.text) this.addSystemMessage(response.text);
            if (response.apiCalls && response.apiCalls.length > 0) {
                this.addDebugMessage(`Continue API calls: ${JSON.stringify(response.apiCalls)}`);
                const {
                    toolResults: newResults,
                    changesSerializedState,
                    allSucceeded,
                    actionOnly,
                } = await this.handleAPICalls(response.apiCalls, turn);
                if (changesSerializedState) {
                    markSitchDirty();
                }

                if (response.sessionContinue
                    && !(allSucceeded && actionOnly && !response.requiresContinuation)) {
                    await this.continueSession(newResults, provider, model, depth + 1, turn);
                } else if (allSucceeded && actionOnly && !response.text) {
                    this.addSystemMessage("Done.");
                }
            }
        } catch (e) {
            this.addSystemMessage("[error continuing session]");
            console.error(e);
        }
    }
    
    // Format function name for display (e.g., "satellitesLoadLEO" -> "Satellites Load LEO")
    formatFunctionName(fn) {
        return fn
            .replace(/([A-Z])/g, ' $1')  // Add space before capitals
            .replace(/^./, s => s.toUpperCase())  // Capitalize first letter
            .trim();
    }


    update(f) {
        // find what document element has focus
        const focusedElement = document.activeElement;
        // log it
//        console.log(`Focused element: ${focusedElement.tagName}#${focusedElement.id}.${focusedElement.className}`);


       //  if (this.visible) {
       //      if (focusedElement === document.body) {
       //          // If the input box is not focused, focus it
       // //         this.inputBox.focus();
       //      }
       //  } else {
       //      if (focusedElement !== document.body) {
       //          document.body.tabIndex = 0;
       //          document.body.focus();
       //          document.body.removeAttribute('tabindex');
       //      }
       //  }
    }
}

export { CNodeViewChat };
