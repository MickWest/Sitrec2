import {GESTURE_PROFILES} from "./GestureActions";

let dialog;
export function showInteractionHelp() {
    if (dialog?.isConnected) { dialog.focus(); return; }
    const previousFocus = document.activeElement;
    dialog = document.createElement("dialog");
    dialog.setAttribute("aria-label", "Mouse, touch and pen controls");
    dialog.dataset.interactionNative = "true";
    dialog.style.cssText = "box-sizing:border-box;width:min(760px,94vw);max-height:88vh;overflow:auto;padding:24px;border:1px solid #888;border-radius:8px;background:var(--sitrec-bg-app,#202020);color:var(--sitrec-text,#eee);font:14px/1.5 system-ui;";
    const heading = document.createElement("h2");
    heading.textContent = "Mouse, touch and pen controls";
    heading.style.marginTop = "0";
    dialog.appendChild(heading);
    const intro = document.createElement("p");
    intro.textContent = "Drag a handle to edit. Escape restores the start of an edit; an interrupted edit keeps its latest result as one undo step. Right-click or touch and hold opens available menus. Scroll toward the top to zoom in. Text fields, sliders and menus keep their own controls.";
    dialog.appendChild(intro);
    for (const {label, gestures} of Object.values(GESTURE_PROFILES)) {
        const details = document.createElement("details");
        details.style.cssText = "padding:8px 0;border-top:1px solid #7775";
        const summary = document.createElement("summary");
        summary.textContent = label; summary.style.cursor = "pointer";
        details.appendChild(summary);
        const table = document.createElement("table");
        table.style.cssText = "width:100%;border-spacing:0 6px;text-align:left";
        for (const [gesture, action] of gestures) {
            const row = table.insertRow();
            const th = document.createElement("th"); th.scope = "row"; th.textContent = gesture;
            th.style.cssText = "width:42%;padding-right:16px;vertical-align:top;font-weight:500";
            row.appendChild(th); row.insertCell().textContent = action;
        }
        details.appendChild(table); dialog.appendChild(details);
    }
    const close = document.createElement("button"); close.textContent = "Close";
    close.style.cssText = "margin-top:16px;padding:6px 18px";
    close.onclick = () => dialog.close(); dialog.appendChild(close);
    dialog.addEventListener("close", () => { dialog.remove(); dialog = null; previousFocus?.focus?.(); }, {once: true});
    document.body.appendChild(dialog); dialog.showModal();
}
