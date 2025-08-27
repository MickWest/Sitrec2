import {CNodeViewText} from "./CNodeViewText.js";
import {guiMenus} from "../Globals";

class CNodeViewDebug extends CNodeViewText {
    constructor(v) {
        // Set up configuration for the base class
        v.title = 'Debug Console';
        v.idPrefix = 'debug-view';
        
        super(v);

        // Add to Help menu
        guiMenus.help.add(this, "show").name("Debug Console").onChange(() => {
            guiMenus.help.close();
        });

        // Add initial welcome message
        this.log("Debug Console initialized.");
        this.info("Use log(text) to add messages to this console.");
    }

    /**
     * Override to add a clear button to the tab instead of floating button
     */
    addTabButtons() {
        // Add clear button to tab (instead of floating button)
        const clearButton = document.createElement('span');
        clearButton.textContent = 'Clear';
        clearButton.style.cssText = `
            float: right;
            cursor: pointer;
            margin-left: 10px;
            font-size: 10px;
        `;
        clearButton.addEventListener('click', (e) => {
            e.stopPropagation();
            this.clearOutput();
        });
        this.tab.appendChild(clearButton);
    }

    /**
     * Override to adjust height for debug console
     */
    getOutputAreaHeight() {
        return 'calc(100% - 35px)'; // Slightly different height for debug console
    }

    /**
     * Override addMessage to use debug console styling
     */
    addMessage(text, color = '#ffffff') {
        const messageDiv = document.createElement('div');
        messageDiv.style.color = color;
        messageDiv.style.marginBottom = '2px';
        messageDiv.textContent = text;
        this.outputArea.appendChild(messageDiv);
        this.scrollToBottom();
    }

    // Helper function to log text to the debug console
    log(text) {
        const timestamp = new Date().toLocaleTimeString();
        this.addMessage(`[${timestamp}] ${text}`);
    }

    // Helper function to log debug messages with debug styling
    debug(text) {
        const timestamp = new Date().toLocaleTimeString();
        this.addMessage(`[${timestamp}] DEBUG: ${text}`, '#aaaaaa');
    }

    // Helper function to log errors in red
    error(text) {
        const timestamp = new Date().toLocaleTimeString();
        this.addMessage(`[${timestamp}] ERROR: ${text}`, '#ff4444');
    }

    // Helper function to log warnings in yellow
    warn(text) {
        const timestamp = new Date().toLocaleTimeString();
        this.addMessage(`[${timestamp}] WARNING: ${text}`, '#ffaa00');
    }

    // Helper function to log info in blue
    info(text) {
        const timestamp = new Date().toLocaleTimeString();
        this.addMessage(`[${timestamp}] INFO: ${text}`, '#4488ff');
    }
}

export { CNodeViewDebug };