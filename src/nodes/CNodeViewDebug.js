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

    /**
     * Get formatted timestamp for log messages
     */
    getTimeStamp() {
        const now = new Date();
        const time = now.toLocaleTimeString();
        const milliseconds = now.getMilliseconds().toString().padStart(3, '0');
        return '[' + time + '.' + milliseconds + '] ';
    }

    // Helper function to log text to the debug console
    log(text) {
        this.addMessage(`${this.getTimeStamp()}${text}`);
    }

    // Helper function to log debug messages with debug styling
    debug(text) {
        this.addMessage(`${this.getTimeStamp()}DEBUG: ${text}`, '#aaaaaa');
    }

    // Helper function to log errors in red
    error(text) {
        this.addMessage(`${this.getTimeStamp()}ERROR: ${text}`, '#ff4444');
    }

    // Helper function to log warnings in yellow
    warn(text) {
        this.addMessage(`${this.getTimeStamp()}WARNING: ${text}`, '#ffaa00');
    }

    // Helper function to log info in blue
    info(text) {
        this.addMessage(`${this.getTimeStamp()}INFO: ${text}`, '#4488ff');
    }
}

export { CNodeViewDebug };