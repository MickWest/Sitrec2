import {CNodeView} from "./CNodeView.js";
import {guiMenus, Sit} from "../Globals";
import {SITREC_SERVER} from "../configUtils";

class CNodeViewChat extends CNodeView {
    constructor(v) {
        v.dragHandle = '.cnodeview-tab';
        super(v);
        this.div.style.position = 'relative';

        // Draggable Tabe with Title
        const tab = document.createElement('div');
        tab.textContent = 'Sitrec AI Chat';
        tab.className = 'cnodeview-tab';
        tab.style.background = '#e0e0e0';
        tab.style.padding = '8px 16px';
        tab.style.fontWeight = 'bold';
        tab.style.fontSize = '16px';
        tab.style.borderBottom = '1px solid #ccc';
        tab.style.textAlign = 'left';
        tab.style.userSelect = 'none';
        this.div.appendChild(tab);

        // add an X button to close the chat
        const closeButton = document.createElement('span');
        closeButton.textContent = 'X';
        closeButton.style.float = 'right';
        closeButton.style.cursor = 'pointer';
        closeButton.style.color = '#888';
        closeButton.style.marginLeft = '8px';
        closeButton.addEventListener('click', () => {
            this.hide();
        })
        tab.appendChild(closeButton);


        // Create scrollable chat log
        this.chatLog = document.createElement('div');
        this.chatLog.style.overflowY = 'auto';
        this.chatLog.style.height = 'calc(100% - 80px)'; // 40px for tab + 40px for input
        this.chatLog.style.padding = '8px';
        this.chatLog.style.backgroundColor = '#fff';
        this.chatLog.style.fontFamily = 'monospace';
        this.chatLog.style.fontSize = '15px';
        this.chatLog.style.whiteSpace = 'pre-line';
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
        this.div.appendChild(this.inputBox);

        this.inputBox.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
                const text = this.inputBox.value.trim();
                if (text) {
                    this.addUserMessage(text);
                    this.sendToServer(text);
                    this.inputBox.value = '';
                }
            }
        });

        // also stop key propogation onf the chatLog
        this.chatLog.addEventListener('keydown', (e) => {
            e.stopPropagation();
        });

        this.chatHistory = [];

        this.addSystemMessage("Hi! Welcome to Sitrec!\nYou can ask me to do things like adjust the position and time, e.g. 'go to London at 12pm yesterday'.");

        guiMenus.help.add(this, "show").name("AI Chat").moveToFirst();

    }



    addUserMessage(text) {
        const div = document.createElement('div');
        div.textContent = `You: ${text}`;
        div.style.margin = '4px 0';
        this.chatLog.appendChild(div);
        this.chatLog.scrollTop = this.chatLog.scrollHeight;
        this.chatHistory.push({ role: 'user', text });
    }

    addSystemMessage(text) {
        const div = document.createElement('div');
        div.textContent = `Bot: ${text}`;
        div.style.margin = '4px 0';
        div.style.color = '#007';
        this.chatLog.appendChild(div);
        this.chatLog.scrollTop = this.chatLog.scrollHeight;
        this.chatHistory.push({ role: 'bot', text });
    }

    addDebugMessage(text) {
        const div = document.createElement('div');
        div.textContent = `Debug: ${text}`;
        div.style.margin = '4px 0';
        div.style.color = '#888';
        this.chatLog.appendChild(div);
        this.chatLog.scrollTop = this.chatLog.scrollHeight;
    }

    async sendToServer(text) {
        try {
            // Add the new user message to history before sending
            const history = this.chatHistory.slice(-10); // last 10 messages

            const body = JSON.stringify({
                    history, // send the history array
                    prompt: text,
                    sitrecDoc: sitrecAPI.getDocumentation()
            });

            console.log("Sending to server:", body);

            const res = await fetch(SITREC_SERVER + 'chatbot.php', {
                body: body,
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
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

    handleAPICalls(calls) {
        for (const call of calls) {
            if (call.fn === 'SetLatLon' && Array.isArray(call.args) && call.args.length === 2) {
                Sit.setLatLon(call.args[0], call.args[1]);
            }
            // add more commands here as needed
        }
    }
}

// Client-side Sitrec API with callable functions and documentation
class CSitrecAPI {
    constructor() {
        this.docs = {
            gotoLLA: "Move the camera to the location specified by Lat/Lon/Alt (Alt optional, defaults to 0). Parameters: lat (float), lon (float), alt (float, optional).",
            setDateTime: "Set the date and time for the simulation. Parameter: dateTime (ISO 8601 string).",
        };
    }

    gotoLLA(lat, lon, alt = 0) {
        Sit.setLatLon(lat, lon); // Extend if altitude support is needed later
    }

    setDateTime(dateTime) {
        Sit.setDateTime(dateTime);
    }

    getDocumentation() {
        return this.docs;
    }
}

const sitrecAPI = new CSitrecAPI();

export {CNodeViewChat, sitrecAPI};
