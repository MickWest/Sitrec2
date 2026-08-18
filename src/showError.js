import {Globals} from "./Globals";

/**
 * Show a copyable error dialog to the user.
 *
 * @param {string} message - Error message. NOTE: the second parameter is an Error
 *        OBJECT, not more message text - only its .stack is appended. Passing a
 *        plain string there drops it silently and yields a blank dialog, so
 *        concatenate extra text into `message` instead.
 * @param {Error} [error] - The Error whose stack to append
 * @returns {boolean} true if a dialog was put on screen, false if the text was
 *        routed to a waiting AI agent instead (see Globals.errorDialogCapture).
 */
export function showError(message, error=null) {

    // if message is an error object, extract its message,
    // otherwise use it as-is
    if (typeof message === 'object' && message !== null) {
        error = message;
        message = message.message || JSON.stringify(message);
    }

    // An AI agent is driving - the in-app chatbot, or an external agent over the
    // SitrecBridge MCP extension. A modal is the wrong place for the text: the agent
    // cannot read it, and the user did not ask for this call and cannot act on it.
    // Hand it to the waiting caller (CSitrecAPI.handleAPICall) so it goes back to the
    // agent as data it can correct against, and let the agent retry properly.
    if (Globals.errorDialogCapture) {
        Globals.errorDialogCapture.push(error?.stack ? message + '\n' + error.stack : message);
        console.error("showError (returned to agent): " + message);
        return false;
    }

    if (Globals.validationMode) {
        console.error("showError (suppressed dialog): " + message);
        // Reported as shown so showErrorOnce still fires only once per validation run.
        return true;
    }

    const title = "Error"

    message += '\n\n';
    // add stack trace if available
    if (error && error.stack) {
        message += error.stack + '\n';
    }

    // Create modal overlay
    const overlay = document.createElement('div');
    overlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.5);
        z-index: 10000;
        display: flex;
        align-items: center;
        justify-content: center;
    `;

    // Create modal dialog
    const modal = document.createElement('div');
    modal.style.cssText = `
        background: white;
        border-radius: 8px;
        padding: 20px;
        width: 60vw;
        max-width: 1200px;
        max-height: 400px;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
        font-family: Arial, sans-serif;
    `;

    // Create title
    const titleElement = document.createElement('h3');
    titleElement.textContent = title;
    titleElement.style.cssText = `
        margin: 0 0 15px 0;
        color: #d32f2f;
        font-size: 18px;
    `;

    // Create textarea for error message
    const textarea = document.createElement('textarea');
    textarea.value = message;
    textarea.readOnly = true;
    textarea.style.cssText = `
        width: 100%;
        height: 200px;
        border: 1px solid #ccc;
        border-radius: 4px;
        padding: 10px;
        font-family: monospace;
        font-size: 12px;
        resize: both;
        box-sizing: border-box;
    `;

    // Create button container
    const buttonContainer = document.createElement('div');
    buttonContainer.style.cssText = `
        display: flex;
        gap: 10px;
        justify-content: flex-end;
        margin-top: 15px;
    `;

    // Create copy button
    const copyButton = document.createElement('button');
    copyButton.textContent = 'Copy Error';
    copyButton.style.cssText = `
        background: #1976d2;
        color: white;
        border: none;
        padding: 8px 16px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 14px;
    `;

    copyButton.onclick = async () => {
        try {
            await navigator.clipboard.writeText(message);
            copyButton.textContent = 'Copied!';
            setTimeout(() => {
                copyButton.textContent = 'Copy Error';
            }, 2000);
        } catch (err) {
            // Fallback for older browsers
            textarea.select();
            document.execCommand('copy');
            copyButton.textContent = 'Copied!';
            setTimeout(() => {
                copyButton.textContent = 'Copy Error';
            }, 2000);
        }
    };

    // Create close button
    const closeButton = document.createElement('button');
    closeButton.textContent = 'Close';
    closeButton.style.cssText = `
        background: #757575;
        color: white;
        border: none;
        padding: 8px 16px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 14px;
    `;

    closeButton.onclick = () => {
        document.body.removeChild(overlay);
    };

    // Assemble the modal
    buttonContainer.appendChild(copyButton);
    buttonContainer.appendChild(closeButton);
    modal.appendChild(titleElement);
    modal.appendChild(textarea);
    modal.appendChild(buttonContainer);
    overlay.appendChild(modal);

    // Add to document
    document.body.appendChild(overlay);

    // Auto-select text for easy copying
    textarea.select();

    console.error(message);
    return true;
}

/**
 * Build the shared dark-backdrop modal shell used by all custom dialogs
 * (showConfirm, showChoice). Keeps the overlay/modal/title boilerplate in one
 * place so the individual dialogs stay DRY.
 * @param {string} title
 * @param {string} [message] - Optional body text (newlines preserved)
 * @returns {{overlay:HTMLElement, modal:HTMLElement}}
 */
function buildModalShell(title, message) {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0, 0, 0, 0.5); z-index: 10000;
        display: flex; align-items: center; justify-content: center;
    `;

    const modal = document.createElement('div');
    modal.style.cssText = `
        background: white; border-radius: 8px; padding: 20px;
        width: 60vw; max-width: 480px;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
        font-family: Arial, sans-serif;
    `;

    if (title) {
        const titleElement = document.createElement('h3');
        titleElement.textContent = title;
        titleElement.style.cssText = `margin: 0 0 12px 0; color: #1976d2; font-size: 18px;`;
        modal.appendChild(titleElement);
    }

    if (message) {
        const messageElement = document.createElement('div');
        messageElement.textContent = message;
        messageElement.style.cssText = `
            white-space: pre-wrap; word-break: break-word; color: #222;
            font-size: 14px; line-height: 1.5; max-height: 300px; overflow-y: auto;
            margin-bottom: 16px;
        `;
        modal.appendChild(messageElement);
    }

    overlay.appendChild(modal);
    return {overlay, modal};
}

/**
 * Show a styled multi-choice dialog with optional per-option explanations.
 * This is the shared primitive behind all custom button dialogs — a promise-based
 * replacement for the native blocking confirm()/prompt() (which freeze the main
 * thread and stall automation). Buttons are stacked vertically, each showing a
 * bold label and an optional description line.
 *
 * Resolves to the chosen option's `value`. Escape, a backdrop click, or the
 * option flagged `cancel:true` resolve to the cancel option's value (or
 * `cancelValue` if none is flagged). Enter activates the option flagged
 * `primary:true` (or the first option).
 *
 * @param {string} message - Body text (newlines preserved)
 * @param {object} opts
 * @param {string} [opts.title="Choose"]
 * @param {Array<{label:string, value:*, description?:string, color?:string, primary?:boolean, cancel?:boolean}>} opts.options
 * @param {*} [opts.cancelValue=null] - Value resolved on dismissal when no option is flagged cancel
 * @returns {Promise<*>}
 */
export function showChoice(message, {title = "Choose", options = [], cancelValue = null} = {}) {
    return new Promise((resolve) => {
        const cancelOption = options.find(o => o.cancel);
        const dismissValue = cancelOption ? cancelOption.value : cancelValue;

        // In validation/regression runs there is no user to click; resolve to the
        // dismiss value so we never block or mutate state behind the harness's back.
        if (Globals.validationMode) {
            console.log("showChoice (suppressed dialog): " + message);
            resolve(dismissValue);
            return;
        }

        const {overlay, modal} = buildModalShell(title, message);

        const cleanup = (result) => {
            document.removeEventListener('keydown', onKey);
            if (overlay.parentNode) document.body.removeChild(overlay);
            resolve(result);
        };

        const primaryOption = options.find(o => o.primary) || options[0];
        const onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); cleanup(dismissValue); }
            else if (e.key === 'Enter' && primaryOption) { e.preventDefault(); cleanup(primaryOption.value); }
        };
        // Backdrop (outside the modal) click dismisses.
        overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) cleanup(dismissValue); });

        let firstButton = null;
        for (const opt of options) {
            const btn = document.createElement('button');
            btn.style.cssText = `
                display: block; width: 100%; text-align: left; box-sizing: border-box;
                padding: 10px 14px; margin: 6px 0; border: none; border-radius: 4px;
                cursor: pointer; font-family: inherit; color: white;
                background: ${opt.color || (opt.cancel ? '#757575' : '#1976d2')};
            `;
            const label = document.createElement('div');
            label.textContent = opt.label;
            label.style.cssText = `font-size: 14px; font-weight: bold;`;
            btn.appendChild(label);
            if (opt.description) {
                const desc = document.createElement('div');
                desc.textContent = opt.description;
                desc.style.cssText = `font-size: 12px; opacity: 0.85; margin-top: 3px; font-weight: normal;`;
                btn.appendChild(desc);
            }
            btn.onclick = () => cleanup(opt.value);
            modal.appendChild(btn);
            if (!firstButton) firstButton = btn;
        }

        document.addEventListener('keydown', onKey);
        document.body.appendChild(overlay);
        if (firstButton) firstButton.focus();
    });
}

/**
 * Show a styled Yes/No confirmation dialog. Returns a Promise that resolves to
 * true (Yes) or false (No). Promise-based replacement for the native blocking
 * confirm(); implemented on top of showChoice so all dialogs share one code path.
 * @param {string} message - The question/body text (newlines preserved)
 * @param {object} [opts]
 * @param {string} [opts.title="Confirm"]
 * @param {string} [opts.yesLabel="Yes"]
 * @param {string} [opts.noLabel="No"]
 * @returns {Promise<boolean>}
 */
export function showConfirm(message, {title = "Confirm", yesLabel = "Yes", noLabel = "No"} = {}) {
    return showChoice(message, {
        title,
        cancelValue: false,
        options: [
            {label: yesLabel, value: true, primary: true, color: "#1976d2"},
            {label: noLabel, value: false, cancel: true, color: "#757575"},
        ],
    });
}

/**
 * Show a styled single-line input prompt. Promise-based replacement for the native
 * blocking prompt() (which freezes the main thread and stalls automation). Resolves to
 * the entered string on OK/Enter, or null on Cancel/Escape/backdrop-click. The input is
 * a real <input>, so while it's focused the global keyboard shortcuts (which bail on
 * text-input focus) are naturally suppressed.
 * @param {string} message - Body/label text
 * @param {object} [opts]
 * @param {string} [opts.title="Enter Value"]
 * @param {string} [opts.defaultValue=""]
 * @param {string} [opts.okLabel="OK"]
 * @param {string} [opts.cancelLabel="Cancel"]
 * @param {string} [opts.inputType="text"] - HTML input type (e.g. "text", "number")
 * @returns {Promise<string|null>}
 */
export function showPrompt(message, {title = "Enter Value", defaultValue = "", okLabel = "OK", cancelLabel = "Cancel", inputType = "text"} = {}) {
    return new Promise((resolve) => {
        // No user to type in validation/regression runs — resolve to null (cancelled).
        if (Globals.validationMode) {
            console.log("showPrompt (suppressed dialog): " + message);
            resolve(null);
            return;
        }

        const {overlay, modal} = buildModalShell(title, message);

        const input = document.createElement('input');
        input.type = inputType;
        input.value = defaultValue;
        input.style.cssText = `
            width: 100%; box-sizing: border-box; padding: 8px 10px; margin-bottom: 14px;
            font-family: inherit; font-size: 14px; border: 1px solid #ccc; border-radius: 4px;
        `;
        modal.appendChild(input);

        const cleanup = (result) => {
            if (overlay.parentNode) document.body.removeChild(overlay);
            resolve(result);
        };

        // Handle Enter/Escape on the input itself (it's focused, so it receives them).
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); cleanup(input.value); }
            else if (e.key === 'Escape') { e.preventDefault(); cleanup(null); }
        });

        const btnRow = document.createElement('div');
        btnRow.style.cssText = `display: flex; gap: 8px; justify-content: flex-end;`;
        const mkBtn = (label, color, onClick) => {
            const b = document.createElement('button');
            b.textContent = label;
            b.style.cssText = `padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer;
                color: white; font-weight: bold; font-family: inherit; background: ${color};`;
            b.onclick = onClick;
            return b;
        };
        btnRow.appendChild(mkBtn(cancelLabel, '#757575', () => cleanup(null)));
        btnRow.appendChild(mkBtn(okLabel, '#1976d2', () => cleanup(input.value)));
        modal.appendChild(btnRow);

        // Backdrop click dismisses.
        overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) cleanup(null); });

        document.body.appendChild(overlay);
        input.focus();
        input.select();
    });
}

const shownErrors = new Set();

/**
 * Show an error dialog only once per unique ID
 * @param {string} ID - Unique identifier for the error
 * @param {string} message - Error message
 */
export function showErrorOnce(ID, message, error=null) {
    if (shownErrors.has(ID)) {
        return;
    }
    // Only burn the ID if the user actually saw it. When the text was routed to an
    // AI agent instead, a later occurrence still deserves its dialog.
    if (showError(message, error)) {
        shownErrors.add(ID);
    }
}