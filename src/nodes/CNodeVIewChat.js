import {CNodeViewText} from "./CNodeViewText.js";
import {GlobalDateTimeNode, guiMenus} from "../Globals";
import {SITREC_SERVER} from "../configUtils";
import {sitrecAPI} from "../CSitrecAPI";

class CNodeViewChat extends CNodeViewText {
    constructor(v) {
        // Set up configuration for the base class
        v.title = 'Sitrec Assistant';
        v.idPrefix = 'chat-view';
        v.hideOnFileDrop = true; // Chat should hide when files are dropped

        super(v);

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
        guiMenus.help.add(this, "show").name("Assistant").moveToFirst().onChange(() => {
            guiMenus.help.close()
        });

        // Add welcome message
        this.addSystemMessage("Hi! Welcome to Sitrec!\nYou can ask me to do things like adjust the position and time, e.g. 'go to London at 12pm yesterday'." +
            "\n\nYou can ask me to do things like 'show me orion's belt.'" +
            "\n\nOr simple math like 'what is 2+2' or 'how long is 1° of latitude.'" +
            "\n\nYou can toggle me on and off with Tab, or click on the X, or 'Assistant' in the Help menu" +
            "\n\nThis window can be resized and moved around, and you can scroll the chat log with the mouse wheel. Up arrow will repeat the last command" +
            "\n\nI'm a work in progress, so please be patient with me! Report bugs, quirks, and features you would like to Mick West on Metabunk" +
            "");
    }

    /**
     * Override to adjust height for chat with input box
     */
    getOutputAreaHeight() {
        return 'calc(100% - 95px)'; // 40px for tab + 55px for input area
    }

    /**
     * Override to add "New Chat" button instead of "Clear" button
     */
    addTabButtons() {
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
            this.clearOutput();
            this.chatHistory = []; // Reset chat history
            this.addSystemMessage("New chat started.\n");
            this.inputBox.value = ''; // Reset the input box
            this.inputBox.focus(); // Focus the input box
        });
        this.div.appendChild(newChatButton);
        this.newChatButton = newChatButton;
    }

    /**
     * Create the input box for chat
     */
    createInputBox() {
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
            // Only focus if we're not clicking on interactive elements
            if (e.target !== this.closeButton && e.target !== this.newChatButton) {
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

    /**
     * Override setTheme to also apply input box styling
     */
    setTheme(name) {
        super.setTheme(name);
        
        // Apply additional styling for input box
        if (this.inputBox) {
            this.inputBox.style.backgroundColor = `var(--cnodeview-input-bg)`;
            this.inputBox.style.color = `var(--cnodeview-input-color)`;
        }
    }

    // Add user message to chat log
    addUserMessage(text) {
        const div = document.createElement('div');
        div.textContent = `You: ${text}`;
        div.style.margin = '4px 0';
        div.style.color = `var(--cnodeview-chat-color)`;
        this.chatLog.appendChild(div);
        this.cullMessages();
        this.scrollToBottom();
        this.chatHistory.push({ role: 'user', text });
    }

    // Add bot/system message to chat log
    addSystemMessage(text) {
        const div = document.createElement('div');
        div.textContent = `Bot: ${text}`;
        div.style.margin = '4px 0';
        div.style.color = `var(--cnodeview-bot-color)`;
        this.chatLog.appendChild(div);
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
        this.chatLog.appendChild(div);
        this.cullMessages();
        this.scrollToBottom();
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

export { CNodeViewChat };
