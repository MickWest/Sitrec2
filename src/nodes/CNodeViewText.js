import {CNodeView} from "./CNodeView";
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
        '--cnodeview-chat-color': '#222',
        '--cnodeview-bot-color': '#007',
        '--cnodeview-input-bg': '#fff',
        '--cnodeview-input-color': '#222'
    },
    dark: {
        '--cnodeview-bg': '#222',
        '--cnodeview-tab-bg': '#333',
        '--cnodeview-tab-color': '#eee',
        '--cnodeview-tab-border': '#444',
        '--cnodeview-text-color': '#eee',
        '--cnodeview-debug-color': '#aaa',
        '--cnodeview-chat-color': '#eee',
        '--cnodeview-bot-color': '#6cf',
        '--cnodeview-input-bg': '#333',
        '--cnodeview-input-color': '#eee'
    }
};

/**
 * Base class for text-based views with draggable tabs and scrollable output areas.
 * Provides common functionality for CNodeViewChat and CNodeViewDebug.
 */
export class CNodeViewText extends CNodeView {
    constructor(v) {
        v.dockable = v.dockable ?? v.draggable;
        v.dockedTextScale = v.dockedTextScale ?? 0.8;
        v.poppable = v.poppable ?? true;       // ⧉ pop out into a separate browser window


        super(v);
        this.alwaysOnTop = true;
        this.div.id = (v.idPrefix || 'text-view') + '-' + v.id;
        // Keep the absolute positioning from base class - don't override to relative

        // Default theme
        this.theme = v.theme || 'dark';

        // Configure whether this view should hide when files are dropped
        // Default is true for backward compatibility
        this.hideOnFileDrop = v.hideOnFileDrop !== undefined ? v.hideOnFileDrop : true;

        // Configure maximum number of messages (0 = unlimited)
        this.maxMessages = v.maxMessages || 1000;

        // Configure manual scrolling mode (default false = auto-scroll to bottom)
        this.manualScroll = v.manualScroll || false;

        // The UIBar header (created by CNodeView) provides the title, ✕ close and the drag
        // handle, so the legacy in-view .cnodeview-tab is redundant — skip it (and its
        // tab-drag) when a UIBar is present. CNodeView already wired the header-drag/Q-drag
        // for a draggable view. Fall back to the tab only when there's no UIBar.
        if (!this.uiBar) {
            this.createTab(v.title || 'Text View');
            if (v.draggable) this.setupDragging();
        }

        // Create the main output area
        this.createOutputArea();

        // Add additional buttons to the tab (subclasses can override)
        this.addTabButtons();

        // Set up event listeners
        this.setupEventListeners();

        // Apply theme
        this.setTheme(this.theme);
    }

    /**
     * Create the draggable tab with title and close button
     */
    createTab(title) {
        const tab = document.createElement('div');
        tab.textContent = title;
        tab.className = 'cnodeview-tab';
        tab.style.userSelect = 'none';
        tab.style.padding = '8px';
        tab.style.fontSize = '14px';
        tab.style.fontWeight = 'bold';
        tab.style.borderBottom = '1px solid var(--cnodeview-tab-border)';
        this.tab = tab;
        this.div.appendChild(tab);

        // Add close button
        const closeButton = document.createElement('span');
        closeButton.textContent = 'X';
        closeButton.style.float = 'right';
        closeButton.style.cursor = 'pointer';
        closeButton.style.marginLeft = '8px';
        closeButton.addEventListener('click', (e) => {
            e.stopPropagation();
            this.hide();
        });
        tab.appendChild(closeButton);
        this.closeButton = closeButton;
    }

    /**
     * Set up dragging functionality
     */
    setupDragging() {
        this.draggable = true;
        makeDraggable(this.div, {
            handle: '.cnodeview-tab',
            viewInstance: this,
            shiftKey: this.shiftDrag,
            onDrag: (event, data) => {
                const view = data.viewInstance;
                if (!view.draggable) return false;
                if (view.dockedSidebar) return true;
                if (view.shiftDrag && !event.shiftKey) return false;
                view.setFromDiv(view.div);
                return true;
            },
            onDragEnd: (event, data) => {
                data.viewInstance?.onViewDragEnd?.(event, data);
            }
        });
    }

    /**
     * Create the scrollable output area
     */
    createOutputArea() {
        this.outputArea = document.createElement('div');
        this.outputArea.style.overflowY = 'auto';
        if (this.uiBar) {
            // No in-flow tab — fill below the header overlay. (DOM content can inset below the
            // bar; only canvases must render full-size.)
            Object.assign(this.outputArea.style, {
                position: 'absolute', top: 'var(--sitrec-header-h, 26px)',
                left: '0', right: '0', bottom: '0', boxSizing: 'border-box',
            });
        } else {
            this.outputArea.style.height = this.getOutputAreaHeight();
        }
        this.outputArea.style.padding = '8px';
        this.outputArea.style.fontFamily = 'monospace';
        this.outputArea.style.fontSize = '13px';
        this.outputArea.style.whiteSpace = 'pre-line';
        this.outputArea.style.userSelect = 'text';
        this.outputArea.style.webkitUserSelect = 'text';
        this.outputArea.style.cursor = 'text';
        this.outputArea.classList.add('cnodeview-output');
        this.div.appendChild(this.outputArea);
    }

    /**
     * Get the height for the output area (can be overridden by subclasses)
     */
    getOutputAreaHeight() {
        return 'calc(100% - 40px)'; // 40px for tab
    }

    /**
     * Add additional buttons to the tab (can be overridden by subclasses)
     */
    addTabButtons() {
        // With a UIBar, the "Clear" action lives in the title menu instead of a floating button.
        if (this.uiBar && this.uiBar.titleMenu) {
            this.uiBar.titleMenu.add({clear: () => this.clearOutput()}, 'clear').name('Clear');
            return;
        }
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
            this.clearOutput();
        });
        this.div.appendChild(clearButton);
        this.clearButton = clearButton;
    }

    /**
     * Set up common event listeners
     */
    setupEventListeners() {
        // Double click events on title will close the view (legacy tab only; the UIBar has ✕)
        if (this.tab) {
            this.tab.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                e.preventDefault();
                this.hide();
            });
        }

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

        // Listen for file dropped events to hide the view (if configured to do so)
        EventManager.addEventListener("fileDropped", (e) => {
            if (this.hideOnFileDrop) {
                this.hide();
            }
        });
    }

    /**
     * Apply theme using CSS variables
     */
    setTheme(name) {
        const themeVars = THEMES[name];
        if (!themeVars) return;
        
        this.theme = name;
        for (const [key, value] of Object.entries(themeVars)) {
            this.div.style.setProperty(key, value);
        }

        // Apply base colors using CSS variables
        this.div.style.backgroundColor = `var(--cnodeview-bg)`;
        if (this.tab) {
            this.tab.style.backgroundColor = `var(--cnodeview-tab-bg)`;
            this.tab.style.color = `var(--cnodeview-tab-color)`;
            this.tab.style.borderBottom = `1px solid var(--cnodeview-tab-border)`;
        }
        this.outputArea.style.backgroundColor = `var(--cnodeview-bg)`;
        this.outputArea.style.color = `var(--cnodeview-text-color)`;
    }

    /**
     * Clear the output area
     */
    clearOutput() {
        this.outputArea.innerHTML = '';
    }

    /**
     * Add a message to the output area
     */
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
        this.cullMessages();
        if (!this.manualScroll) {
            this.scrollToBottom();
        }
    }

    /**
     * Add a debug message to the output area
     */
    addDebugMessage(text) {
        const div = document.createElement('div');
        div.textContent = `Debug: ${text}`;
        div.style.margin = '2px 0';
        div.style.color = `var(--cnodeview-debug-color)`;
        this.outputArea.appendChild(div);
        this.cullMessages();
        if (!this.manualScroll) {
            this.scrollToBottom();
        }
    }

    /**
     * Scroll the output area to the bottom
     */
    scrollToBottom() {
        this.outputArea.scrollTop = this.outputArea.scrollHeight;
    }

    /**
     * Cull old messages if maxMessages limit is exceeded
     */
    cullMessages() {
        if (this.maxMessages <= 0) return; // No limit set
        
        const children = this.outputArea.children;
        if (children.length > this.maxMessages) {
            // Remove the oldest messages (from the beginning)
            const messagesToRemove = children.length - this.maxMessages;
            for (let i = 0; i < messagesToRemove; i++) {
                this.outputArea.removeChild(children[0]);
            }
        }
    }

    /**
     * Update method - can be overridden by subclasses
     */
    update(f) {
        // Base implementation - can be overridden by subclasses
    }
}

export { THEMES };
