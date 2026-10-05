import {CNodeViewText} from "./CNodeViewText";
import {t} from "../i18n";

// The physical thermal sensor's readout (sensor size, field of view, camera data, model
// notes and warnings) as a separate text window. The text is read-only, but it can be
// selected and copied. The Look View sends its text here through thermalStatus().
export class CNodeViewThermalReadout extends CNodeViewText {
    constructor(v) {
        v.menuName = v.menuName ?? t("thermal.readoutView.title");
        v.idPrefix = "thermal-readout";
        v.hideOnFileDrop = false;
        v.manualScroll = true;
        super(v);
        this.text = "";
        this.setText(null);

        // The readout changes on each thermal frame (for example the cloud timings). A
        // replacement of the text removes the selection, so setText() does not replace the
        // text while a selection is in it. When the selection ends, the latest text shows.
        this.selectionHandler = () => this.showText();
        this.watchSelection();
    }

    // Listen for selection changes in the document that holds the text: the page, or the
    // popup window while the view is popped out (CNodeView.popOut adopts the text into it).
    watchSelection() {
        this.selectionDocument?.removeEventListener("selectionchange", this.selectionHandler);
        this.selectionDocument = this.outputArea.ownerDocument;
        this.selectionDocument.addEventListener("selectionchange", this.selectionHandler);
    }

    popOut() {
        super.popOut();
        this.watchSelection();
    }

    dockWindow() {
        super.dockWindow();
        this.watchSelection();
        this.showText(); // a selection in the closed popup no longer holds back the text
    }

    // A live readout has nothing to clear, so no "Clear" item in the title menu.
    addTabButtons() {}

    // null: the Look View does not draw a physical thermal image now.
    setText(text) {
        this.text = text ?? t("thermal.readoutView.idle");
        this.showText();
    }

    showText() {
        if (this.outputArea.textContent === this.text || this.selectionInText()) return;
        this.outputArea.textContent = this.text;
    }

    selectionInText() {
        const selection = this.outputArea.ownerDocument.getSelection();
        return !!selection && !selection.isCollapsed && this.outputArea.contains(selection.anchorNode);
    }

    dispose() {
        this.selectionDocument?.removeEventListener("selectionchange", this.selectionHandler);
        super.dispose();
    }
}
