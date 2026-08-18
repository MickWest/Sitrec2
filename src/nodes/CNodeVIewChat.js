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
    BYOK_PROVIDER,
    buildSystemPrompt,
    buildTools,
    chat as chatDirect,
} from "../CDirectLLMClient";

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

// One line of failure text for the chat pane, wherever the detail ended up.
function errorTextOf(callResult) {
    return callResult.error
        ?? callResult.result?.error
        ?? callResult.errorDialogs?.join("; ")
        ?? "the call failed";
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
        this.clearOutput();
        this.chatHistory = [];
        this.addSystemMessage("New chat started.\n");
        if (this.inputBox) {
            this.inputBox.value = '';
            this.inputBox.focus();
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

    // Add bot/system message to chat log
    addSystemMessage(text) {
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
        this.chatHistory.push({ role: 'bot', text });
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

    clearOutput() {
        super.clearOutput();
        // Re-append the prompt line (innerHTML='' removed it)
        this.chatLog.appendChild(this.promptLine);
    }

    async handleMessage(text) {
        this.historyPosition = 0;

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

    async sendToLLM(text) {
        try {
            const timeString = GlobalDateTimeNode.timeWithTimeZone(new Date());
            const simDate = GlobalDateTimeNode.dateNow ? GlobalDateTimeNode.dateNow.toISOString() : null;

            const chatModelSetting = Globals.settings.chatModel || "";
            const [provider, model] = chatModelSetting.includes(':')
                ? chatModelSetting.split(':')
                : [null, null];

            // BYOK: the user picked a "(your key)" model, so go straight to Anthropic
            // from the browser instead of proxying through chatbot.php. The distinct
            // provider token makes this an explicit user choice, never an inference.
            if (provider === BYOK_PROVIDER) {
                await this.sendToLLMDirect(text, model, simDate);
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
                const {toolResults, changesSerializedState} = await this.handleAPICalls(response.apiCalls);
                if (changesSerializedState) {
                    markSitchDirty();
                }

                this.logUnhandledLLMCall(text, response.apiCalls);

                if (response.sessionContinue) {
                    await this.continueSession(toolResults, provider, model);
                }
            } else if (response.text) {
                this.logUnhandledLLMCall(text, null, response.text);
            }
        } catch (e) {
            this.addSystemMessage("[error contacting server]");
            console.error(e);
        }
    }

    // BYOK path: browser → Anthropic directly, using the user's own stored key.
    //
    // Differences from the server path above, all deliberate:
    //  - CDirectLLMClient.chat() owns the whole tool loop, so there is no
    //    sessionContinue round-trip and no continueSession() recursion here.
    //  - Nothing is POSTed to logNLU.php. A user who supplied their own key is
    //    asking to talk to Anthropic and not to us; quietly copying their prompts
    //    to the Sitrec server would break that expectation.
    //  - The system prompt and tools are built client-side, from the same shared
    //    chatbotSystemPrompt.txt the server uses, so the assistant behaves the same.
    async sendToLLMDirect(text, model, simDate) {
        const apiKey = await byokGetKey("anthropic");
        if (!apiKey) {
            this.addSystemMessage("[No Anthropic API key stored. Add one under Settings → AI Key, or choose a different AI Model.]");
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
            const result = await chatDirect({
                apiKey,
                provider: BYOK_PROVIDER,
                model,
                systemPrompt: buildSystemPrompt({
                    simDateTime: simDate,
                    menuSummary,
                    availableDocs,
                }),
                history: priorHistory.slice(-10),
                userText: text,
                // OpenAI-shaped on purpose: callAnthropic() runs convertToolsForAnthropic()
                // itself, so converting here too would double-convert and throw on t.function.
                tools: buildTools(sitrecAPI.getLLMDocumentation(), menuSummary),
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
                    if (callResult.success === false) {
                        this.addSystemMessage(`Error: ${errorTextOf(callResult)}`);
                    }
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
            this.addSystemMessage(`[Anthropic error: ${e && e.message ? e.message : e}]`);
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
            let content = (await res.text()).replace(/<!--[\s\S]*?-->/g, "");
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
    async handleAPICalls(calls) {
        const toolResults = [];
        let changesSerializedState = false;
        for (const call of calls) {
            // "chat" source: these calls came from the LLM, so llmCallable:false entries
            // (e.g. the JS-executing scripted-video functions) are refused (B1).
            // handleAPICall is async: without the await, `result` is a pending Promise, so
            // `result.result ?? result` yields the Promise itself and every tool result was
            // JSON.stringify'd to "{}" on its way back to the model — and both the
            // dirty-state check and the error message below silently read undefined.
            const result = await sitrecAPI.handleAPICall(call, "chat");
            toolResults.push({ fn: call.fn, args: call.args, result: toolPayloadForModel(result) });
            if (sitrecAPI.callChangesSerializedState(call, result)) {
                changesSerializedState = true;
            }

            // Only show user-facing messages for errors
            // Success messages will come from the LLM's natural language response.
            // Keyed off the OUTER success so a thrown error and an unknown function name
            // surface too, not just a function that returned {success:false} - and since
            // an agent's failure no longer raises a dialog, this line is the only place
            // the user learns the model asked for something Sitrec could not do.
            if (result.success === false) {
                this.addSystemMessage(`Error: ${errorTextOf(result)}`);
            }
        }
        return {toolResults, changesSerializedState};
    }
    
    async continueSession(toolResults, provider, model, depth = 0) {
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
                const {toolResults: newResults, changesSerializedState} = await this.handleAPICalls(response.apiCalls);
                if (changesSerializedState) {
                    markSitchDirty();
                }

                if (response.sessionContinue) {
                    await this.continueSession(newResults, provider, model, depth + 1);
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
