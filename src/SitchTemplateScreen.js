/**
 * The start screen: a list of sitch templates for common tasks.
 *
 * This file only makes the DOM. CSitchBrowser owns the data, opens the overlay
 * that this goes in, and supplies the callbacks. That keeps one fetch and one
 * overlay for both the start screen and the sitch browser, so "Browse Sitches"
 * changes the screen without a second request to the server.
 */

const COLORS = {
    background: "#181825",
    card: "#1e1e2e",
    cardHover: "#252540",
    border: "#333",
    borderHover: "#8ab4f8",
    text: "#e0e0e0",
    dim: "#888",
    faint: "#666",
    placeholder: "#2a2a3e",
};

function makeButton(text, {background, hoverBackground, color, border}, onClick) {
    const button = document.createElement("button");
    button.textContent = text;
    Object.assign(button.style, {
        padding: "10px 18px", backgroundColor: background, color,
        border: "1px solid " + border, borderRadius: "6px", cursor: "pointer",
        fontSize: "14px", fontWeight: "600", letterSpacing: "0.3px",
    });
    button.addEventListener("mouseenter", () => { button.style.backgroundColor = hoverBackground; });
    button.addEventListener("mouseleave", () => { button.style.backgroundColor = background; });
    button.addEventListener("click", onClick);
    return button;
}

function makeTemplateCard(template, onOpenTemplate) {
    // A button, so the keyboard reaches it: Tab moves to a card, Enter or Space opens it.
    const card = document.createElement("button");
    card.type = "button";
    card.dataset.templateCard = template.key;
    card.title = template.name;
    Object.assign(card.style, {
        display: "block", padding: "0", textAlign: "left", font: "inherit", color: COLORS.text,
        backgroundColor: COLORS.card, borderRadius: "8px", border: "2px solid " + COLORS.border,
        overflow: "hidden", cursor: "pointer", transition: "border-color 0.15s",
    });
    const setActive = (active) => {
        card.style.borderColor = active ? COLORS.borderHover : COLORS.border;
        card.style.backgroundColor = active ? COLORS.cardHover : COLORS.card;
    };
    card.addEventListener("mouseenter", () => setActive(true));
    card.addEventListener("mouseleave", () => setActive(document.activeElement === card));
    card.addEventListener("focus", () => setActive(true));
    card.addEventListener("blur", () => setActive(false));

    const imageWrap = document.createElement("div");
    Object.assign(imageWrap.style, {
        width: "100%", aspectRatio: "16/9", backgroundColor: COLORS.placeholder,
        display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden",
    });
    const showNoPreview = () => {
        const placeholder = document.createElement("div");
        Object.assign(placeholder.style, {color: "#555", fontSize: "12px"});
        placeholder.textContent = "No preview";
        imageWrap.appendChild(placeholder);
    };
    if (template.screenshotUrl) {
        const image = document.createElement("img");
        Object.assign(image.style, {width: "100%", height: "100%", objectFit: "contain", display: "block"});
        image.alt = "";
        image.draggable = false;
        image.loading = "lazy";
        image.onerror = () => { image.remove(); showNoPreview(); };
        image.src = template.screenshotUrl;
        imageWrap.appendChild(image);
    } else {
        showNoPreview();
    }
    card.appendChild(imageWrap);

    const name = document.createElement("div");
    Object.assign(name.style, {
        padding: "10px 12px", fontSize: "14px", fontWeight: "600",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    });
    name.textContent = template.name;
    card.appendChild(name);

    card.addEventListener("click", () => onOpenTemplate(template));
    return card;
}

function makeSection(title, templates, onOpenTemplate) {
    const section = document.createElement("div");
    section.dataset.templateSection = title;
    section.style.marginTop = "28px";

    const heading = document.createElement("div");
    Object.assign(heading.style, {
        fontSize: "12px", color: COLORS.dim, textTransform: "uppercase",
        letterSpacing: "0.6px", fontWeight: "600", marginBottom: "12px",
    });
    heading.textContent = title;
    section.appendChild(heading);

    const grid = document.createElement("div");
    Object.assign(grid.style, {
        display: "grid", gap: "16px",
        gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
    });
    for (const template of templates) {
        grid.appendChild(makeTemplateCard(template, onOpenTemplate));
    }
    section.appendChild(grid);
    return section;
}

/**
 * Build the start screen.
 *
 * A template is {key, name, screenshotUrl}. The screen shows the templates in the
 * order of each array.
 *
 * @param {object} options
 * @param {Array<{key: string, name: string, screenshotUrl: ?string}>} options.globalTemplates
 * @param {Array<{key: string, name: string, screenshotUrl: ?string}>} options.localTemplates
 * @param {string} [options.version] - build version text, shown at the top right
 * @param {function(object): void} options.onOpenTemplate - called with the template that was clicked
 * @param {function(): void} options.onNewSitch
 * @param {function(): void} options.onBrowse
 * @param {?function(): void} [options.onLogin] - null when there is no login to offer
 * @param {?function(): void} [options.onCancel] - null when there is nothing to go back to
 * @returns {HTMLElement}
 */
export function buildTemplateScreen({
    globalTemplates, localTemplates, version = "",
    onOpenTemplate, onNewSitch, onBrowse, onLogin = null, onCancel = null,
}) {
    const screen = document.createElement("div");
    screen.dataset.templateScreen = "1";
    Object.assign(screen.style, {
        flex: "1", minWidth: "0", overflowY: "auto", backgroundColor: COLORS.background,
        padding: "28px 40px 40px", boxSizing: "border-box",
    });

    const titleRow = document.createElement("div");
    Object.assign(titleRow.style, {display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "16px"});
    const title = document.createElement("div");
    Object.assign(title.style, {fontSize: "24px", fontWeight: "600"});
    title.textContent = "Start with a Template";
    titleRow.appendChild(title);
    const versionLabel = document.createElement("span");
    Object.assign(versionLabel.style, {fontSize: "12px", color: COLORS.faint, whiteSpace: "nowrap"});
    versionLabel.textContent = version;
    titleRow.appendChild(versionLabel);
    screen.appendChild(titleRow);

    const subtitle = document.createElement("div");
    Object.assign(subtitle.style, {fontSize: "14px", color: COLORS.dim, marginTop: "6px"});
    subtitle.textContent = "A template opens Sitrec set up for one task. Your work does not change the template.";
    screen.appendChild(subtitle);

    const actions = document.createElement("div");
    Object.assign(actions.style, {display: "flex", flexWrap: "wrap", gap: "10px", marginTop: "18px"});
    actions.appendChild(makeButton("New Sitch",
        {background: "#2ea043", hoverBackground: "#3fb950", color: "#ffffff", border: "#3fb950"}, onNewSitch));
    actions.appendChild(makeButton("Browse Sitches",
        {background: "#2a2a3e", hoverBackground: "#3a3a5e", color: "#8ab4f8", border: "#8ab4f8"}, onBrowse));
    if (onLogin) {
        actions.appendChild(makeButton("Login",
            {background: "#8ab4f8", hoverBackground: "#a6c8ff", color: "#0b1320", border: "#8ab4f8"}, onLogin));
    }
    if (onCancel) {
        actions.appendChild(makeButton("Cancel",
            {background: "#333", hoverBackground: "#444", color: COLORS.text, border: "#555"}, onCancel));
    }
    screen.appendChild(actions);

    if (globalTemplates.length > 0) {
        screen.appendChild(makeSection("Global Templates", globalTemplates, onOpenTemplate));
    }
    if (localTemplates.length > 0) {
        screen.appendChild(makeSection("Local Templates", localTemplates, onOpenTemplate));
    }
    if (globalTemplates.length === 0 && localTemplates.length === 0) {
        const empty = document.createElement("div");
        empty.dataset.templateEmpty = "1";
        Object.assign(empty.style, {fontSize: "14px", color: COLORS.dim, marginTop: "28px"});
        empty.textContent = "There are no templates.";
        screen.appendChild(empty);
    }

    return screen;
}
