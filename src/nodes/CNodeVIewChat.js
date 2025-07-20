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
        tab.style.userSelect = 'none';
        this.tab = tab;
        this.div.appendChild(tab);

        //  double click events on title will close the chat view
        tab.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            e.preventDefault(); // Prevent default double-click behavior
            this.hide();
        });

        // Add an X button to close the chat
        const closeButton = document.createElement('span');
        closeButton.textContent = 'X';
        closeButton.style.float = 'right';
        closeButton.style.cursor = 'pointer';
        closeButton.style.marginLeft = '8px';
        closeButton.addEventListener('click', () => this.hide());
        tab.appendChild(closeButton);

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

        // Add a "New Chat" button to the top right corner of the chat log
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
        newChatButton.addEventListener('click', () => {
            this.chatLog.innerHTML = ''; // Clear chat log
            this.chatHistory = []; // Reset chat history
            this.addSystemMessage("New chat started.\n");
            this.inputBox.value = ''; // Reset the input box
            this.inputBox.focus(); // Focus the input box
        });
        this.div.appendChild(newChatButton);


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
        this.chatLog.tabIndex = 0; // Make it focusable
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

                // using this.historyPosition to navigate chat history
                // first get a list of all user messages in the chat history

                const userMessages = this.chatHistory.filter(msg => msg.role === 'user');
                if (userMessages.length === 0 || this.historyPosition === userMessages.length) return; // No user messages to show
                // Get the message at the current history position
                const index = userMessages.length - 1 - this.historyPosition;
                const message = userMessages[index];
                this.setInputTextAndFocus(message.text);
                this.historyPosition = (this.historyPosition + 1) // % userMessages.length; // Cycle through history
            } else if (e.key === 'ArrowDown') {
                // If down arrow go down the history
                const userMessages = this.chatHistory.filter(msg => msg.role === 'user');
                this.historyPosition--;
                if (this.historyPosition <= 0) {
                    this.historyPosition = 0; // Reset to 0 if we go past the start
                    this.setInputTextAndFocus("")
                }
                else {
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

        // swallow double click events on the inputBox
        this.inputBox.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            e.preventDefault(); // Prevent default double-click behavior
        });

        // Also stop key propagation on the chatLog
        this.chatLog.addEventListener('keydown', (e) => {
                e.stopPropagation()
              //  e.preventDefault()
                if (e.key === 'Tab') {
                    e.preventDefault();  // Stop tab from shifting focus
                    this.toggleChatVisibility();
                }
        });


        // swallow double click events on the chat log
        this.chatLog.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            e.preventDefault(); // Prevent default double-click behavior
        });

        // The tab key should toggle the chat view
        // this needs to be handled in the main Sitrec class


        this.chatHistory = [];
        this.historyPosition = 0; // For navigating chat history

        this.addSystemMessage("Hi! Welcome to Sitrec!\nYou can ask me to do things like adjust the position and time, e.g. 'go to London at 12pm yesterday'." +
            "\n\nYou can ask me to do things like 'show me orion's belt.'" +
            "\n\nOr simple math like 'what is 2+2' or 'how long is 1° of latitude.'" +
            "\n\nYou can toggle me on and off with Tab, or click on the X, or 'Assistant' in the Help menu" +
            "\n\nThis window can be resized and moved around, and you can scroll the chat log with the mouse wheel. Up arrow will repeat the last command" +
            "\n\nI'm a work in progress, so please be patient with me! Report bugs, quirks, and features you would like to Mick West on Metabunk" +

        "");

        guiMenus.help.add(this, "show").name("Assistant").moveToFirst().onChange(() => {
            guiMenus.help.close()
        })



        this.setTheme(this.theme);
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
        this.historyPosition = 0;  // Reset history position when sending a new message
        try {

            // use this to get a time string in the local timezone
            const timeString = GlobalDateTimeNode.timeWithTimeZone(new Date());

            const history = this.chatHistory.slice(-10);
            const body = JSON.stringify({
                history,
                prompt: text,
                sitrecDoc: sitrecAPI.getDocumentation(),
                dateTime: timeString,
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

export { CNodeViewChat, THEMES };
