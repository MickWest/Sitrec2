import {CNodeView} from "./CNodeView.js";
import {guiMenus} from "../Globals";
import {makeDraggable} from "../DragResizeUtils";

class CNodeViewDebug extends CNodeView {
    constructor(v) {
        
        // Store draggable setting for later
        const wasDraggable = v.draggable;
        // Temporarily disable draggable during super() call
        v.draggable = false;
        
        super(v);
        
        // Create the debug console UI
        this.div.id = 'debug-view-' + v.id;
        // Keep the absolute positioning from base class - don't override to relative
        this.div.style.backgroundColor = v.background || '#000000';
        this.div.style.color = '#ffffff';
        this.div.style.fontFamily = 'monospace';
        this.div.style.fontSize = '12px';
        this.div.style.overflow = 'hidden';
        
        // Draggable Tab with Title (similar to chatView)
        const tab = document.createElement('div');
        tab.textContent = 'Debug Console';
        tab.className = 'cnodeview-tab cnodeview-debug-tab';
        tab.style.cssText = `
            background: #333;
            color: #fff;
            padding: 5px 10px;
            font-weight: bold;
            border-bottom: 1px solid #555;
            user-select: none;
            cursor: move;
        `;
        this.tab = tab;
        this.div.appendChild(tab);

        // Now set up dragging with the correct handle after tab is created
        if (wasDraggable) {
            this.draggable = true;
            makeDraggable(this.div, {
                handle: '.cnodeview-tab',
                viewInstance: this,
                shiftKey: this.shiftDrag,
                onDrag: (event, data) => {
                    const view = data.viewInstance;
                    if (!view.draggable) return false;
                    if (view.shiftDrag && !event.shiftKey) return false;
                    return true;
                }
            });
        }

        // Add close button to tab
        const closeButton = document.createElement('span');
        closeButton.textContent = 'X';
        closeButton.style.cssText = `
            float: right;
            cursor: pointer;
            margin-left: 10px;
        `;
        closeButton.addEventListener('click', (e) => {
            e.stopPropagation();
            this.hide();
        });
        tab.appendChild(closeButton);

        // Add clear button to tab
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
            this.outputArea.innerHTML = '';
        });
        tab.appendChild(clearButton);
        
        // Create output area
        this.outputArea = document.createElement('div');
        this.outputArea.style.cssText = `
            height: calc(100% - 35px);
            overflow-y: auto;
            padding: 5px;
            white-space: pre-wrap;
            word-wrap: break-word;
        `;
        
        this.div.appendChild(this.outputArea);

        // Add to Help menu
        guiMenus.help.add(this, "show").name("Debug Console").onChange(() => {
            guiMenus.help.close();
        });

        // Add initial welcome message
        this.log("Debug Console initialized.");
        this.info("Use log(text) to add messages to this console.");
        

    }

    addMessage(text, color = '#ffffff') {
        const messageDiv = document.createElement('div');
        messageDiv.style.color = color;
        messageDiv.style.marginBottom = '2px';
        messageDiv.textContent = text;
        this.outputArea.appendChild(messageDiv);
        this.outputArea.scrollTop = this.outputArea.scrollHeight;
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