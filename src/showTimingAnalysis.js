import {saveAs} from "file-saver";

// Modal dialog for displaying generated timing-analysis text. Mirrors the
// shape of showError() but with two action buttons (Copy / Download) plus
// Close, since the content is something the user typically wants to share
// with someone else looking at the data.
export function showTimingAnalysis(text, suggestedFilename = "sitrec-timing-analysis.txt") {
    const overlay = document.createElement("div");
    overlay.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0, 0, 0, 0.5); z-index: 10000;
        display: flex; align-items: center; justify-content: center;
    `;

    const modal = document.createElement("div");
    modal.style.cssText = `
        background: white; border-radius: 8px; padding: 20px;
        width: 80vw; max-width: 1100px;
        height: calc(100vh - 40px);
        box-shadow: 0 4px 20px rgba(0,0,0,0.3);
        font-family: Arial, sans-serif; display: flex; flex-direction: column;
        box-sizing: border-box;
    `;

    const titleEl = document.createElement("h3");
    titleEl.textContent = "MISB Timing Analysis";
    titleEl.style.cssText = "margin: 0 0 12px 0; color: #1976d2; font-size: 18px; flex: 0 0 auto;";

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.readOnly = true;
    textarea.style.cssText = `
        width: 100%; flex: 1 1 auto; min-height: 0;
        border: 1px solid #ccc; border-radius: 4px; padding: 10px;
        font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px;
        resize: none; box-sizing: border-box; white-space: pre;
        overflow: auto;
    `;

    const buttons = document.createElement("div");
    buttons.style.cssText = "display: flex; gap: 10px; justify-content: flex-end; margin-top: 12px; flex: 0 0 auto;";

    const mkButton = (label, color) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.style.cssText = `
            background: ${color}; color: white; border: none;
            padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 14px;
        `;
        return b;
    };

    const copyBtn = mkButton("Copy Analysis", "#1976d2");
    copyBtn.onclick = async () => {
        try {
            await navigator.clipboard.writeText(text);
            copyBtn.textContent = "Copied!";
            setTimeout(() => { copyBtn.textContent = "Copy Analysis"; }, 1500);
        } catch (e) {
            textarea.select();
            document.execCommand("copy");
            copyBtn.textContent = "Copied!";
            setTimeout(() => { copyBtn.textContent = "Copy Analysis"; }, 1500);
        }
    };

    const downloadBtn = mkButton("Download Analysis", "#388e3c");
    downloadBtn.onclick = () => {
        saveAs(new Blob([text], {type: "text/plain;charset=utf-8"}), suggestedFilename);
    };

    const closeBtn = mkButton("Close", "#757575");
    closeBtn.onclick = () => { document.body.removeChild(overlay); };

    buttons.appendChild(copyBtn);
    buttons.appendChild(downloadBtn);
    buttons.appendChild(closeBtn);
    modal.appendChild(titleEl);
    modal.appendChild(textarea);
    modal.appendChild(buttons);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
}
