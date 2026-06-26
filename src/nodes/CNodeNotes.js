import {CNodeView} from "./CNodeView";
import {guiShowHide, setRenderOne} from "../Globals";
import {blockViewEvents, clampBelowMenuBar} from "../DragResizeUtils";
import {ViewMan} from "../CViewManager";
import {t} from "../i18n";
import {linkifyToHTML, hasLinks} from "../linkify";

class CNodeNotes extends CNodeView {
    constructor(v) {
        // Standard consolidated-window chrome: draggable via the base CUIBar header (which the
        // base CNodeView builds) + Q-body-drag, instead of the old bespoke .cnodeview-tab with
        // its own close button and its own makeDraggable.
        v.draggable = v.draggable ?? true;
        v.poppable = v.poppable ?? true;       // ⧉ pop out into a separate browser window
        v.dockable = true;
        v.dockedTextScale = v.dockedTextScale ?? 0.8;
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

        // Keep clicks/drags inside the notes panel from leaking through to the 3D view behind.
        blockViewEvents(this.div);

        this.createTextArea();
        this.setupEventListeners();

        guiShowHide.add(this, 'visible')
            .listen()
            .name(t("misc.notes.label")).onChange(value => {
                this.visible = undefined;
                this.setVisible(value);
                if (value) {
                    this.recalculate();
                }
            })
            .tooltip(t("misc.notes.tooltip"))
            .moveToFirst();

        this.applyEarlyMods();
        this.setVisible(this.visible);
    }

    createTextArea() {
        this.textArea = document.createElement('textarea');
        this.textArea.style.cssText = `
            position: absolute;
            top: var(--sitrec-header-h, 26px);
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
            border-radius: 0 0 8px 8px;
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
            top: var(--sitrec-header-h, 26px);
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
            border-radius: 0 0 8px 8px;
        `;
        this.div.appendChild(this.linkOverlay);
    }

    setupEventListeners() {
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

    setBorderRadius(r) {
        this.div.style.borderRadius = r;
        const botR = r === '0' ? '0' : `0 0 ${r} ${r}`;
        if (this.textArea) this.textArea.style.borderRadius = botR;
        if (this.linkOverlay) this.linkOverlay.style.borderRadius = botR;
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
        
        this.setBorderRadius('0');
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

        if (!hasLinks(this.notesText)) {
            this.showTextArea();
            return;
        }

        // Shared with the AI chat (CNodeViewChat) so links look and behave identically.
        this.linkOverlay.innerHTML = linkifyToHTML(this.notesText);
        this.textArea.style.display = 'none';
        this.linkOverlay.style.display = 'block';
    }

    show(visible = true) {
        super.show(visible);
        if (visible) {
            this.linkifyContent();
        }
    }

    // Append text to the notes (preceded by a blank line when there's existing
    // content), make the window visible, and scroll to the end so the newly
    // added text is in view. Used e.g. when stashing an unrecognized dropped URL.
    appendAndShow(text) {
        const addition = String(text ?? "");
        const separator = this.notesText && this.notesText.length ? "\n\n" : "";
        this.notesText += separator + addition;
        if (this.textArea) {
            this.textArea.value = this.notesText;
        }
        this.setVisible(true);   // un-hide and clamp below the menu bar if needed
        this.show(true);         // also runs linkifyContent() (URLs become links)
        setRenderOne();
        // Scroll after layout has settled so scrollHeight is correct.
        this.scrollToEnd();
        requestAnimationFrame(() => this.scrollToEnd());
    }

    // Scroll whichever content element is currently displayed (the editable
    // textarea, or the linkified read-only overlay) to its bottom.
    scrollToEnd() {
        if (this.textArea && this.textArea.style.display !== 'none') {
            this.textArea.scrollTop = this.textArea.scrollHeight;
            try {
                const end = this.textArea.value.length;
                this.textArea.selectionStart = this.textArea.selectionEnd = end;
            } catch (e) { /* selection not supported while hidden */ }
        }
        if (this.linkOverlay && this.linkOverlay.style.display !== 'none') {
            this.linkOverlay.scrollTop = this.linkOverlay.scrollHeight;
        }
    }

    // When the window (re)appears as a floating panel, make sure it isn't stranded
    // off the top of the screen (e.g. after being dragged up under the menu bar).
    setVisible(visible) {
        const wasVisible = this.visible;
        super.setVisible(visible);
        if (visible && !wasVisible && !this.dockedMode && !this.dockedSidebar && this.div) {
            this.updateWH();              // apply the stored fractional position to the div
            clampBelowMenuBar(this.div);  // push it below the menu bar if it's above
            this.setFromDiv(this.div);    // persist the corrected position as fractions
        }
    }

    hide() {
        console.log(`hide: dockedMode=${this.dockedMode}, visible=${this.visible}`);
        if (this.dockedMode) {
            this.restoreViewPositions();
            this.setBorderRadius('8px');
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
