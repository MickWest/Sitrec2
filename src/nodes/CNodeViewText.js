import {CNodeView} from "./CNodeView.js";
import {guiMenus} from "../Globals";
import {EventManager} from "../CEventManager";
import {makeDraggable} from "../DragResizeUtils";

const THEMES = {
    light: {
        '--cnodeview-bg': '#fff',
        '--cnodeview-tab-bg': '#e0e0e0',
        '--cnodeview-tab-color': '#222',
        '--cnodeview-tab-border': '#ccc',
        '--cnodeview-text-color': '#222',
        '--cnodeview-debug-color': '#888',
    },
    dark: {
        '--cnodeview-bg': '#222',
        '--cnodeview-tab-bg': '#333',
        '--cnodeview-tab-color': '#eee',
        '--cnodeview-tab-border': '#444',
        '--cnodeview-text-color': '#eee',
        '--cnodeview-debug-color': '#aaa',
    }
};

export class CNodeViewText extends CNodeView {
    constructor(v) {
        // Store draggable setting for later
        const wasDraggable = v.draggable;
        // Temporarily disable draggable during super() call
        v.draggable = false;
        
        super(v);
        this.div.style.position = 'relative';

        // Default theme
        this.theme = 'dark';

        // Draggable Tab with Title
        const tab = document.createElement('div');
        tab.textContent = v.title || 'Text View';
        tab.className = 'cnodeview-tab';
        tab.style.userSelect = 'none';
        tab.style.padding = '8px';
        tab.style.fontSize = '14px';
        tab.style.fontWeight = 'bold';
        tab.style.borderBottom = '1px solid var(--cnodeview-tab-border)';
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

        // Double click events on title will close the view
        tab.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            e.preventDefault();
            this.hide();
        });

        // Add an X button to close the view
        const closeButton = document.createElement('span');
        closeButton.textContent = 'X';
        closeButton.style.float = 'right';
        closeButton.style.cursor = 'pointer';
        closeButton.style.marginLeft = '8px';
        closeButton.addEventListener('click', () => this.hide());
        tab.appendChild(closeButton);

        // Create scrollable output area
        this.outputArea = document.createElement('div');
        this.outputArea.style.overflowY = 'auto';
        this.outputArea.style.height = 'calc(100% - 40px)'; // 40px for tab
        this.outputArea.style.padding = '8px';
        this.outputArea.style.fontFamily = 'monospace';
        this.outputArea.style.fontSize = '13px';
        this.outputArea.style.whiteSpace = 'pre-line';
        this.outputArea.classList.add('cnodeview-output');
        this.div.appendChild(this.outputArea);

        // Add a "Clear" button to the top right corner of the output area
        const clearButton = document.createElement('button');
        clearButton.textContent = 'Clear';
        clearButton.style.position = 'absolute';
        clearButton.style.top = '28px';
        clearButton.style.right = '18px';
        clearButton.style.padding = '2px 10px';
        clearButton.style.fontSize = '12px';
        clearButton.style.borderRadius = '16px';
        clearButton.style.border = 'none';
        clearButton.style.background = 'var(--cnodeview-tab-bg)';
        clearButton.style.color = 'var(--cnodeview-tab-color)';
        clearButton.style.cursor = 'pointer';
        clearButton.style.boxShadow = '0 1px 4px rgba(0,0,0,0.08)';
        clearButton.addEventListener('click', () => {
            this.outputArea.innerHTML = '';
        });
        this.div.appendChild(clearButton);

        // Global capture of the Escape key to hide
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.visible) {
                this.hide();
            }
        });

        // Swallow double click events on the output area
        this.outputArea.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            e.preventDefault();
        });

        // Listen for file dropped events to hide the view
        EventManager.addEventListener("fileDropped", (e) => {
            this.hide();
        });

        this.setTheme(this.theme);
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
        this.outputArea.style.backgroundColor = `var(--cnodeview-bg)`;
        this.outputArea.style.color = `var(--cnodeview-text-color)`;
    }

    // Add text message to output area
    addMessage(text, color = null) {
        const div = document.createElement('div');
        div.textContent = text;
        div.style.margin = '2px 0';
        if (color) {
            div.style.color = color;
        } else {
            div.style.color = `var(--cnodeview-text-color)`;
        }
        this.outputArea.appendChild(div);
        this.outputArea.scrollTop = this.outputArea.scrollHeight;
    }

    // Add debug message to output area
    addDebugMessage(text) {
        const div = document.createElement('div');
        div.textContent = `Debug: ${text}`;
        div.style.margin = '2px 0';
        div.style.color = `var(--cnodeview-debug-color)`;
        this.outputArea.appendChild(div);
        this.outputArea.scrollTop = this.outputArea.scrollHeight;
    }

    update(f) {
        // Base implementation - can be overridden by subclasses
    }
}

export { THEMES };