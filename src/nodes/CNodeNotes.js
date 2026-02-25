import {CNodeView} from "./CNodeView.js";
import {guiShowHide, setRenderOne} from "../Globals";
import {makeDraggable} from "../DragResizeUtils";
import {ViewMan} from "../CViewManager";

class CNodeNotes extends CNodeView {
    constructor(v) {
        v.draggable = false;
        v.excludeFromViewsMenu = true;
        super(v);

        this.alwaysOnTop = true;
        this.notesText = v.notesText || "";
        this.addSimpleSerial("notesText");
        
        this.dockedMode = false;
        this.savedViewPositions = null;

        this.div.id = 'notes-view-' + v.id;
        this.div.style.backgroundColor = '#222';
        this.div.style.borderRadius = '8px';
        this.div.style.overflow = 'hidden';

        this.createTab();
        this.createTextArea();
        this.setupDragging();
        this.setupEventListeners();

        guiShowHide.add(this, 'visible')
            .listen()
            .name("Notes").onChange(value => {
                this.visible = undefined;
                this.setVisible(value);
                if (value) {
                    this.recalculate();
                }
            })
            .tooltip("Show/Hide the notes editor. Notes are saved with the sitch and can contain clickable hyperlinks.")
            .moveToFirst();

        this.applyEarlyMods();
        this.setVisible(this.visible);
    }

    createTab() {
        const tab = document.createElement('div');
        tab.textContent = 'Notes';
        tab.className = 'cnodeview-tab';
        tab.style.cssText = `
            user-select: none;
            padding: 8px;
            height: 40px;
            box-sizing: border-box;
            font-size: 14px;
            font-weight: bold;
            background-color: #333;
            color: #eee;
            border-bottom: 1px solid #444;
            cursor: move;
        `;
        this.tab = tab;
        this.div.appendChild(tab);

        const closeButton = document.createElement('span');
        closeButton.textContent = 'X';
        closeButton.style.cssText = `
            float: right;
            cursor: pointer;
            margin-left: 8px;
        `;
        closeButton.addEventListener('click', (e) => {
            e.stopPropagation();
            this.hide();
        });
        tab.appendChild(closeButton);
    }

    createTextArea() {
        this.textArea = document.createElement('textarea');
        this.textArea.style.cssText = `
            position: absolute;
            top: 40px;
            left: 0;
            right: 0;
            bottom: 0;
            width: 100%;
            box-sizing: border-box;
            resize: none;
            padding: 10px;
            font-family: sans-serif;
            font-size: 14px;
            line-height: 1.5;
            background-color: #1a1a1a;
            color: #eee;
            border: none;
            outline: none;
        `;
        this.textArea.value = this.notesText;
        this.textArea.placeholder = "Enter your notes here...";
        
        this.textArea.addEventListener('input', () => {
            this.notesText = this.textArea.value;
            setRenderOne();
        });

        this.textArea.addEventListener('blur', () => {
            this.linkifyContent();
        });

        this.div.appendChild(this.textArea);

        this.linkOverlay = document.createElement('div');
        this.linkOverlay.style.cssText = `
            display: none;
            position: absolute;
            top: 40px;
            left: 0;
            right: 0;
            bottom: 0;
            box-sizing: border-box;
            padding: 10px;
            font-family: sans-serif;
            font-size: 14px;
            line-height: 1.5;
            background-color: #1a1a1a;
            color: #eee;
            overflow-y: auto;
            white-space: pre-wrap;
            word-wrap: break-word;
        `;
        this.div.appendChild(this.linkOverlay);
    }

    setupDragging() {
        makeDraggable(this.div, {
            handle: '.cnodeview-tab',
            viewInstance: this,
            onDrag: (event, data) => {
                const view = data.viewInstance;
                view.setFromDiv(view.div);
                return true;
            }
        });
    }

    setupEventListeners() {
        this.tab.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            e.preventDefault();
            this.hide();
        });

        this.keydownHandler = (e) => {
            if (e.key === 'Escape' && this.visible && document.activeElement !== this.textArea) {
                this.hide();
            }
            if ((e.key === 'n' || e.key === 'N') && !e.ctrlKey && !e.metaKey && !e.altKey) {
                const tag = document.activeElement?.tagName?.toLowerCase();
                if (tag === 'input' || tag === 'textarea') return;
                e.preventDefault();
                if (e.shiftKey) {
                    this.toggleDockedMode();
                } else {
                    this.toggleVisibility();
                }
            }
        };
        document.addEventListener('keydown', this.keydownHandler);

        this.textArea.addEventListener('focus', () => {
            this.showTextArea();
        });

        this.linkOverlay.addEventListener('click', (e) => {
            if (e.target.tagName !== 'A') {
                this.showTextArea();
                this.textArea.focus();
            }
        });
    }

    showTextArea() {
        this.textArea.style.display = 'block';
        this.linkOverlay.style.display = 'none';
    }

    toggleVisibility() {
        if (this.visible) {
            this.hide();
        } else {
            this.show(true);
        }
    }

    toggleDockedMode() {
        console.log(`toggleDockedMode: visible=${this.visible}, dockedMode=${this.dockedMode}, savedViewPositions=${!!this.savedViewPositions}`);
        if (this.visible && this.dockedMode) {
            this.hide();
        } else {
            this.showDocked();
        }
    }

    showDocked() {
        console.log(`showDocked: dockedMode=${this.dockedMode}, visible=${this.visible}, savedViewPositions=${!!this.savedViewPositions}`);
        if (this.dockedMode) {
            console.log("showDocked: already in docked mode, returning");
            return;
        }
        if (this.savedViewPositions) {
            console.warn("showDocked: savedViewPositions exists but dockedMode is false - clearing stale state");
            this.savedViewPositions = null;
        }
        
        const notesWidth = 0.2;
        
        this.savedViewPositions = {};
        ViewMan.iterate((id, view) => {
            if (view !== this && !view.overlayView && view.div) {
                this.savedViewPositions[id] = {
                    left: view.left,
                    top: view.top,
                    width: view.width,
                    height: view.height
                };
                view.left = view.left * (1 - notesWidth);
                if (view.width > 0) {
                    view.width = view.width * (1 - notesWidth);
                }
                view.updateWH();
            }
        });

        this.left = 1 - notesWidth;
        this.top = 0;
        this.width = notesWidth;
        this.height = 1;
        this.updateWH();
        
        this.div.style.borderRadius = '0';
        this.dockedMode = true;
        this.show(true);
    }

    restoreViewPositions() {
        console.log(`restoreViewPositions: savedViewPositions=${!!this.savedViewPositions}, dockedMode=${this.dockedMode}`);
        if (!this.savedViewPositions) return;
        
        ViewMan.iterate((id, view) => {
            const saved = this.savedViewPositions[id];
            if (saved) {
                view.left = saved.left;
                view.top = saved.top;
                view.width = saved.width;
                view.height = saved.height;
                view.updateWH();
            }
        });
        
        this.savedViewPositions = null;
        this.dockedMode = false;
    }

    linkifyContent() {
        if (!this.notesText.trim()) {
            this.showTextArea();
            return;
        }

        const urlPattern = /(https?:\/\/[^\s<]+[^\s<.,;:!?\])>"'])/gi;
        const hasLinks = urlPattern.test(this.notesText);
        
        if (!hasLinks) {
            this.showTextArea();
            return;
        }

        const escaped = this.notesText
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
        
        const linked = escaped.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?\])>"'])/gi, (url) => {
            const decodedUrl = url.replace(/&amp;/g, '&');
            return `<a href="${decodedUrl}" target="_blank" rel="noopener noreferrer" style="color: #6cf; text-decoration: underline;">${url}</a>`;
        });

        this.linkOverlay.innerHTML = linked;
        this.textArea.style.display = 'none';
        this.linkOverlay.style.display = 'block';
    }

    show(visible = true) {
        super.show(visible);
        if (visible) {
            this.linkifyContent();
        }
    }

    hide() {
        console.log(`hide: dockedMode=${this.dockedMode}, visible=${this.visible}`);
        if (this.dockedMode) {
            this.restoreViewPositions();
            this.div.style.borderRadius = '8px';
        }
        super.hide();
    }

    modSerialize() {
        return {
            ...super.modSerialize(),
            notesText: this.notesText,
        };
    }

    modDeserialize(v) {
        super.modDeserialize(v);
        if (v.notesText !== undefined) {
            this.notesText = v.notesText;
            if (this.textArea) {
                this.textArea.value = this.notesText;
            }
        }
    }

    dispose() {
        if (this.keydownHandler) {
            document.removeEventListener('keydown', this.keydownHandler);
        }
        this.savedViewPositions = null;
        this.dockedMode = false;
        super.dispose();
    }
}

export { CNodeNotes };
