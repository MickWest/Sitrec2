import {CNodeView} from "./CNodeView.js";
import {Sit} from "../Globals";
import {SITREC_SERVER} from "../configUtils";

class CNodeViewChat extends CNodeView {
    constructor(v) {
        super(v);

        // Create scrollable chat log
        this.chatLog = document.createElement('div');
        this.chatLog.style.overflowY = 'auto';
        this.chatLog.style.height = 'calc(100% - 40px)';
        this.chatLog.style.padding = '8px';
        this.chatLog.style.backgroundColor = '#fff';
        this.chatLog.style.fontFamily = 'monospace';
        this.chatLog.style.fontSize = '15px';
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

        this.addSystemMessage("Hi! You can ask me to move the camera, e.g. 'go to London at 12pm yesterday'.");
    }

    addUserMessage(text) {
        const div = document.createElement('div');
        div.textContent = `You: ${text}`;
        div.style.margin = '4px 0';
        this.chatLog.appendChild(div);
        this.chatLog.scrollTop = this.chatLog.scrollHeight;
    }

    addSystemMessage(text) {
        const div = document.createElement('div');
        div.textContent = `Bot: ${text}`;
        div.style.margin = '4px 0';
        div.style.color = '#007';
        this.chatLog.appendChild(div);
        this.chatLog.scrollTop = this.chatLog.scrollHeight;
    }

    async sendToServer(text) {
        try {
            const res = await fetch(SITREC_SERVER + 'chatbot.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    prompt: text,
                    sitrecDoc: sitrecAPI.getDocumentation()
                })

            });
            const response = await res.json();
            console.log("Chatbot response:", response);
            if (response.text) this.addSystemMessage(response.text);
            if (response.apiCalls) this.handleAPICalls(response.apiCalls);
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
