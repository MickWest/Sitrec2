// Modal prompt helpers — return a Promise that resolves to the chosen
// value, or null on cancel/Escape. Two flavors:
//   promptForText   — text input with validation
//   promptForChoice — radio-button picker for a fixed set of options
//
// Both share the same modal shell (_openModal) so styling and keyboard
// behavior stay consistent. To add another prompt type, mount a DOM
// node into the shell and provide a getValue() that pulls the current
// answer out of it; you don't have to rebuild the chrome.

function tryNativePrompt(message, defaultValue = "") {
    if (typeof window === "undefined" || typeof window.prompt !== "function") {
        return null;
    }
    try {
        return window.prompt(message, defaultValue);
    } catch (error) {
        console.warn("Native prompt is unavailable, falling back to custom prompt UI.", error);
        return null;
    }
}

// Shared modal scaffolding. Caller provides:
//   title, message, cancelLabel, confirmLabel — header / button text
//   content        — the body DOM node (input, radio group, …)
//   getValue       — () => current value (called when OK / Enter)
//   validate       — optional (value) => "" | "error string"
//   onMount        — optional ({clearError, focus}) => void; called after
//                    the modal is in the DOM, used by callers to wire
//                    input listeners (e.g. clear error as user types) and
//                    set initial focus
//
// Returns a Promise that resolves to the value on confirm, null on cancel.
function _openModal({
    title,
    message,
    cancelLabel = "Cancel",
    confirmLabel = "OK",
    content,
    getValue,
    validate,
    onMount,
}) {
    return new Promise((resolve) => {
        const overlay = document.createElement("div");
        overlay.style.cssText = `
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.55);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 20000;
            padding: 24px;
        `;

        const modal = document.createElement("div");
        modal.style.cssText = `
            width: min(460px, 100%);
            background: #101418;
            color: #f4f7fb;
            border: 1px solid rgba(255, 255, 255, 0.14);
            border-radius: 12px;
            box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
            padding: 20px;
            font-family: Arial, sans-serif;
        `;

        const titleElement = document.createElement("div");
        titleElement.textContent = title;
        titleElement.style.cssText = `
            font-size: 18px;
            font-weight: 600;
            margin-bottom: 10px;
        `;

        const messageElement = document.createElement("div");
        messageElement.textContent = message ?? "";
        messageElement.style.cssText = `
            font-size: 14px;
            line-height: 1.45;
            color: rgba(244, 247, 251, 0.8);
            margin-bottom: 14px;
            white-space: pre-wrap;
        `;

        const errorElement = document.createElement("div");
        errorElement.style.cssText = `
            min-height: 18px;
            margin-top: 8px;
            color: #ff8f8f;
            font-size: 13px;
        `;

        const buttonRow = document.createElement("div");
        buttonRow.style.cssText = `
            display: flex;
            justify-content: flex-end;
            gap: 10px;
            margin-top: 18px;
        `;

        const cancelButton = document.createElement("button");
        cancelButton.type = "button";
        cancelButton.textContent = cancelLabel;
        cancelButton.style.cssText = `
            border: 1px solid rgba(255, 255, 255, 0.18);
            border-radius: 8px;
            background: transparent;
            color: #f4f7fb;
            padding: 9px 14px;
            cursor: pointer;
        `;

        const confirmButton = document.createElement("button");
        confirmButton.type = "button";
        confirmButton.textContent = confirmLabel;
        confirmButton.style.cssText = `
            border: 0;
            border-radius: 8px;
            background: #4aa3ff;
            color: #081018;
            padding: 9px 14px;
            font-weight: 600;
            cursor: pointer;
        `;

        const close = (value) => {
            document.removeEventListener("keydown", onKeyDown, true);
            overlay.remove();
            resolve(value);
        };

        const submit = () => {
            const value = typeof getValue === "function" ? getValue() : null;
            const validationMessage = typeof validate === "function" ? validate(value) : "";
            if (validationMessage) {
                errorElement.textContent = validationMessage;
                return;
            }
            close(value);
        };

        const onKeyDown = (event) => {
            if (event.key === "Escape") {
                event.preventDefault();
                close(null);
                return;
            }
            if (event.key === "Enter") {
                event.preventDefault();
                submit();
            }
        };

        cancelButton.addEventListener("click", () => close(null));
        confirmButton.addEventListener("click", submit);
        overlay.addEventListener("click", (event) => {
            if (event.target === overlay) close(null);
        });
        document.addEventListener("keydown", onKeyDown, true);

        buttonRow.append(cancelButton, confirmButton);
        modal.append(titleElement, messageElement, content, errorElement, buttonRow);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        if (typeof onMount === "function") {
            onMount({
                clearError: () => { errorElement.textContent = ""; },
                modal,
            });
        }
    });
}

export function promptForText({
    cancelLabel = "Cancel",
    confirmLabel = "OK",
    defaultValue = "",
    message = "",
    title = "Input",
    validate = null,
} = {}) {
    if (typeof document === "undefined" || !document.body) {
        return Promise.resolve(tryNativePrompt(message || title, defaultValue));
    }

    const input = document.createElement("input");
    input.type = "text";
    input.value = defaultValue ?? "";
    input.style.cssText = `
        width: 100%;
        box-sizing: border-box;
        border: 1px solid rgba(255, 255, 255, 0.18);
        border-radius: 8px;
        background: #0b0f13;
        color: #f4f7fb;
        padding: 10px 12px;
        font-size: 15px;
        outline: none;
    `;

    return _openModal({
        title, message, cancelLabel, confirmLabel,
        content: input,
        getValue: () => input.value,
        validate,
        onMount: ({clearError}) => {
            input.addEventListener("input", () => clearError());
            input.focus();
            input.select();
        },
    });
}

// Radio-button picker. options: array of
//   { value, label, description? }    — full form
//   "value-string"                    — short form (label and value the same)
//
// defaultValue: pre-selects the option whose value matches; otherwise the
// first option is selected so OK works without a click.
//
// Returns the selected value, or null on cancel.
export function promptForChoice({
    cancelLabel = "Cancel",
    confirmLabel = "OK",
    defaultValue = null,
    message = "",
    options = [],
    title = "Choose",
} = {}) {
    if (typeof document === "undefined" || !document.body) {
        // No DOM: fall back to the matching default, else the first option.
        if (defaultValue != null && options.some(o => _optionValue(o) === defaultValue)) {
            return Promise.resolve(defaultValue);
        }
        return Promise.resolve(options.length > 0 ? _optionValue(options[0]) : null);
    }

    const group = document.createElement("div");
    group.style.cssText = `
        display: flex;
        flex-direction: column;
        gap: 8px;
    `;
    // Per-call name so two pickers can't share radio-group state if they
    // ever overlap.
    const groupName = `prompt-choice-${Math.random().toString(36).slice(2, 9)}`;

    const radios = [];
    let firstRadio = null;
    let selectedRadio = null;
    for (const opt of options) {
        const value = _optionValue(opt);
        const label = _optionLabel(opt);
        const description = typeof opt === "object" && opt !== null ? opt.description : null;

        // Each option is a clickable row — clicking anywhere on the row
        // (not just the 14×14 dot) selects the radio. Using <label> for
        // the row gets that for free.
        const row = document.createElement("label");
        row.style.cssText = `
            display: flex;
            align-items: flex-start;
            gap: 10px;
            padding: 10px 12px;
            border: 1px solid rgba(255, 255, 255, 0.18);
            border-radius: 8px;
            background: #0b0f13;
            cursor: pointer;
            user-select: none;
        `;

        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = groupName;
        radio.value = value;
        radio.style.cssText = "margin-top: 3px;";
        if (defaultValue != null && value === defaultValue) {
            radio.checked = true;
            selectedRadio = radio;
        }

        const text = document.createElement("div");
        text.style.cssText = "flex: 1;";
        const labelEl = document.createElement("div");
        labelEl.textContent = label;
        labelEl.style.cssText = "font-size: 15px; font-weight: 500;";
        text.appendChild(labelEl);
        if (description) {
            const descEl = document.createElement("div");
            descEl.textContent = description;
            descEl.style.cssText = `
                font-size: 12px;
                color: rgba(244, 247, 251, 0.6);
                margin-top: 2px;
                line-height: 1.4;
            `;
            text.appendChild(descEl);
        }

        row.append(radio, text);
        group.appendChild(row);
        radios.push(radio);
        if (firstRadio === null) firstRadio = radio;
    }
    if (selectedRadio === null && firstRadio) {
        firstRadio.checked = true;
        selectedRadio = firstRadio;
    }

    return _openModal({
        title, message, cancelLabel, confirmLabel,
        content: group,
        getValue: () => {
            const checked = radios.find(r => r.checked);
            return checked ? checked.value : null;
        },
        onMount: () => {
            const checked = radios.find(r => r.checked) ?? firstRadio;
            if (checked) checked.focus();
        },
    });
}

function _optionValue(opt) {
    if (typeof opt === "string") return opt;
    return opt?.value ?? "";
}
function _optionLabel(opt) {
    if (typeof opt === "string") return opt;
    return opt?.label ?? opt?.value ?? "";
}
