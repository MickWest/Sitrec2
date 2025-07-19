import {CNodeView} from "./CNodeView.js";
import {GlobalDateTimeNode, guiMenus, Sit} from "../Globals";
import {SITREC_SERVER} from "../configUtils";
import {sitrecAPI} from "../CSitrecAPI";
const THEMES = {
    light: {
        '--cnodeview-bg': '#fff',
        '--cnodeview-tab-bg': '#e0e0e0',
        '--cnodeview-tab-color': '#222',
        '--cnodeview-tab-border': '#ccc',
        '--cnodeview-chat-color': '#222',
        '--cnodeview-bot-color': '#007',
        '--cnodeview-debug-color': '#888',
        '--cnodeview-input-bg': '#fff',
        '--cnodeview-input-color': '#222'
    },
    dark: {
        '--cnodeview-bg': '#222',
        '--cnodeview-tab-bg': '#333',
        '--cnodeview-tab-color': '#eee',
        '--cnodeview-tab-border': '#444',
        '--cnodeview-chat-color': '#eee',
        '--cnodeview-bot-color': '#6cf',
        '--cnodeview-debug-color': '#aaa',
        '--cnodeview-input-bg': '#333',
        '--cnodeview-input-color': '#eee'
    }
};

class CNodeViewChat extends CNodeView {
    constructor(v) {
        v.dragHandle = '.cnodeview-tab';
        super(v);
        this.div.style.position = 'relative';

        // Default theme
        this.theme = 'dark';

        // Draggable Tab with Title
        const tab = document.createElement('div');
        tab.textContent = 'Sitrec Assistant';
        tab.className = 'cnodeview-tab';
        this.tab = tab;
        this.div.appendChild(tab);

        // Add an X button to close the chat
        const closeButton = document.createElement('span');
        closeButton.textContent = 'X';
        closeButton.style.float = 'right';
        closeButton.style.cursor = 'pointer';
        closeButton.style.marginLeft = '8px';
        closeButton.addEventListener('click', () => this.hide());
        tab.appendChild(closeButton);

        // Add a "New Chat" button next to the X
        const newChatButton = document.createElement('button');
        newChatButton.textContent = 'New Chat';
        newChatButton.style.marginLeft = '8px';
        newChatButton.style.padding = '4px 8px';
        newChatButton.style.fontSize = '14px';
        newChatButton.addEventListener('click', () => {
            this.chatLog.innerHTML = ''; // Clear chat log
            this.chatHistory = []; // Reset chat history
            this.addSystemMessage("New chat started.\n");
            this.inputBox.value = ''; // Reset the input box
            this.inputBox.focus(); // Focus the input box
        });
        tab.appendChild(newChatButton);

        // Create scrollable chat log
        this.chatLog = document.createElement('div');
        this.chatLog.style.overflowY = 'auto';
        this.chatLog.style.height = 'calc(100% - 95px)'; // 40px for tab + 40px for input
        this.chatLog.style.padding = '8px';
        this.chatLog.style.fontFamily = 'monospace';
        this.chatLog.style.fontSize = '15px';
        this.chatLog.style.whiteSpace = 'pre-line';
        this.chatLog.classList.add('cnodeview-chatlog');
        this.div.appendChild(this.chatLog);

        // Create input box
        this.inputBox = document.createElement('input');
        this.inputBox.type = 'text';
        this.inputBox.placeholder = 'Ask something...';
        this.inputBox.style.position = 'absolute';
        this.inputBox.style.bottom = '0';
        this.inputBox.style.width = '100%';
        this.inputBox.style.boxSizing = 'border-box';
        this.inputBox.style.padding = '8px';
        this.inputBox.style.fontSize = '15px';
        this.inputBox.classList.add('cnodeview-input');
        this.div.appendChild(this.inputBox);


        // Global capture of the ` key to toggle visibility
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
                // If up arrow, show the last message in the input box
                const last = this.chatHistory.slice().reverse().find(msg => msg.role === 'user');
                if (last) this.inputBox.value = last.text;
            } else if (e.key === 'ArrowDown') {
                // If down arrow, clear the input box
                this.inputBox.value = '';
            } else if (e.key === 'Tab') {
                e.preventDefault();  // Stop tab from shifting focus
                this.toggleChatVisibility();
            } else if (e.key === 'Escape') {
                // If escape, hide the chat view
                this.hide();
            }
        });

        // Also stop key propagation on the chatLog
        this.chatLog.addEventListener('keydown', (e) => e.stopPropagation());

        // The tab key should toggle the chat view
        // this needs to be handled in the main Sitrec class


        this.chatHistory = [];

        this.addSystemMessage("Hi! Welcome to Sitrec!\nYou can ask me to do things like adjust the position and time, e.g. 'go to London at 12pm yesterday'.");

        guiMenus.help.add(this, "show").name("Assistant").moveToFirst().onChange(() => {
            guiMenus.help.close()
        })



        this.setTheme(this.theme);
    }

    toggleChatVisibility() {
        this.setVisible(!this.visible);
        if (this.visible) {
            this.inputBox.focus();
        }
    }

    // Apply theme using CSS variables
    setTheme(name) {
        const themeVars = THEMES[name];
        this.theme = name;
        for (const [key, value] of Object.entries(themeVars)) {
            this.div.style.setProperty(key, value);
        }

        // Apply base colors using CSS variables
        this.div.style.backgroundColor = `var(--cnodeview-bg)`;
        this.tab.style.backgroundColor = `var(--cnodeview-tab-bg)`;
        this.tab.style.color = `var(--cnodeview-tab-color)`;
        this.tab.style.borderBottom = `1px solid var(--cnodeview-tab-border)`;
        this.chatLog.style.backgroundColor = `var(--cnodeview-bg)`;
        this.chatLog.style.color = `var(--cnodeview-chat-color)`;
        this.inputBox.style.backgroundColor = `var(--cnodeview-input-bg)`;
        this.inputBox.style.color = `var(--cnodeview-input-color)`;
    }

    // Add user message to chat log
    addUserMessage(text) {
        const div = document.createElement('div');
        div.textContent = `You: ${text}`;
        div.style.margin = '4px 0';
        div.style.color = `var(--cnodeview-chat-color)`;
        this.chatLog.appendChild(div);
        this.chatLog.scrollTop = this.chatLog.scrollHeight;
        this.chatHistory.push({ role: 'user', text });
    }

    // Add bot/system message to chat log
    addSystemMessage(text) {
        const div = document.createElement('div');
        div.textContent = `Bot: ${text}`;
        div.style.margin = '4px 0';
        div.style.color = `var(--cnodeview-bot-color)`;
        this.chatLog.appendChild(div);
        this.chatLog.scrollTop = this.chatLog.scrollHeight;
        this.chatHistory.push({ role: 'bot', text });
    }

    // Add debug message to chat log (if enabled)
    addDebugMessage(text) {
        if (!sitrecAPI.debug) return;
        const div = document.createElement('div');
        div.textContent = `Debug: ${text}`;
        div.style.margin = '4px 0';
        div.style.color = `var(--cnodeview-debug-color)`;
        this.chatLog.appendChild(div);
        this.chatLog.scrollTop = this.chatLog.scrollHeight;
    }

    // Send message and history to server and process response
    async sendToServer(text) {
        try {
            const history = this.chatHistory.slice(-10);
            const body = JSON.stringify({
                history,
                prompt: text,
                sitrecDoc: sitrecAPI.getDocumentation(),
                dateTime: new Date().toISOString(),
            });

            const res = await fetch(SITREC_SERVER + 'chatbot.php', {
                body,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            });
            const response = await res.json();
            if (response.text) this.addSystemMessage(response.text);
            if (response.apiCalls) {
                this.addDebugMessage(`API calls: ${JSON.stringify(response.apiCalls)}`);
                this.handleAPICalls(response.apiCalls);
            }
        } catch (e) {
            this.addSystemMessage("[error contacting server]");
            console.error(e);
        }
    }

    // Process any API calls returned by the server
    handleAPICalls(calls) {
        for (const call of calls) {
            sitrecAPI.handleAPICall(call);
        }
    }


    update(f) {
        // find what document element has focus
        const focusedElement = document.activeElement;
        // log it
        console.log(`Focused element: ${focusedElement.tagName}#${focusedElement.id}.${focusedElement.className}`);


        if (focusedElement !== this.inputBox && focusedElement !== document.body) {

            document.body.tabIndex = 0;
            document.body.focus();
            document.body.removeAttribute('tabindex');
        }


    }
}

export { CNodeViewChat, THEMES };
