/**
 * The instructions of a sitch template.
 *
 * The Notes of a template are its instructions. "##name" starts the section
 * "name". The section ends at the next "##", or at the end of the Notes. Text
 * before the first "##" is in no section.
 *
 *   ##intro
 *   Drop a video on the window to start.
 *   ##tips
 *   ...
 *
 * The "intro" section shows in a box when a sitch opens from the template. The
 * box fades out when the user clicks on something or drops a file.
 */

const SECTION_MARK = "##";
// The name is on the same line as the mark, with optional spaces between them.
const SECTION_NAME = /^[ \t]*([A-Za-z0-9_-]+)/;
export const INTRO_FADE_MS = 600;

/**
 * Divide the Notes of a template into its sections.
 *
 * A section name is not case-sensitive: "##Intro" is the section "intro". If a
 * name is there two times, the first one is used. A "##" with no name after it
 * ends the section before it and starts none.
 *
 * @param {string} notesText
 * @returns {Object<string, string>} section name (lower case) -> text, with no space at the two ends
 */
export function parseTemplateSections(notesText) {
    const sections = {};
    const parts = String(notesText ?? "").split(SECTION_MARK);
    // parts[0] is the text before the first mark.
    for (const part of parts.slice(1)) {
        const match = part.match(SECTION_NAME);
        if (!match) continue;
        const name = match[1].toLowerCase();
        if (name in sections) continue;
        sections[name] = part.slice(match[0].length).trim();
    }
    return sections;
}

/**
 * The text of the intro box for a sitch, or "" when it must show no box.
 * Only a sitch that opened from a template shows the box. The same Notes in a
 * sitch that opened by its own name are only notes.
 *
 * @param {?{name: string, userID: number}} templateSource - Sit.templateSource
 * @param {string} notesText
 * @returns {string}
 */
export function templateIntroText(templateSource, notesText) {
    if (!templateSource) return "";
    return parseTemplateSections(notesText).intro || "";
}

// The intro box that shows now: {box, stopListening}. There is only one at a time.
let activeIntro = null;

/**
 * Remove the intro box at once, with no fade. For a change of sitch.
 */
export function removeTemplateIntro() {
    if (!activeIntro) return;
    activeIntro.stopListening();
    activeIntro.box.remove();
    activeIntro = null;
}

/**
 * Fade the intro box out, then remove it.
 */
export function dismissTemplateIntro() {
    if (!activeIntro) return;
    const intro = activeIntro;
    activeIntro = null;
    intro.stopListening();
    intro.box.style.opacity = "0";
    // A timer, not "transitionend": that event does not come when the tab is hidden.
    setTimeout(() => intro.box.remove(), INTRO_FADE_MS);
}

/**
 * Show the intro box with this text. An empty text shows no box.
 * The box fades out on the first click (pointer down) or file drop, on any part
 * of the page.
 *
 * @param {string} text
 * @returns {?HTMLElement} the box, or null
 */
export function showTemplateIntro(text) {
    removeTemplateIntro();
    if (!text) return null;

    const box = document.createElement("div");
    box.dataset.templateIntro = "1";
    box.setAttribute("role", "status");
    Object.assign(box.style, {
        position: "fixed", left: "50%", top: "20%", transform: "translateX(-50%)",
        width: "max-content", maxWidth: "min(560px, calc(100vw - 48px))",
        maxHeight: "60vh", overflow: "hidden", boxSizing: "border-box",
        padding: "18px 22px",
        backgroundColor: "rgba(24, 24, 37, 0.92)", color: "#e0e0e0",
        border: "1px solid #8ab4f8", borderRadius: "10px",
        boxShadow: "0 8px 30px rgba(0, 0, 0, 0.5)",
        fontFamily: "system-ui, -apple-system, sans-serif", fontSize: "15px", lineHeight: "1.5",
        whiteSpace: "pre-wrap", overflowWrap: "anywhere",
        // Above the views, and below the sitch browser (4999) and the menus.
        zIndex: "4998",
        // A click or a drop goes to the control below the box, and also fades the box.
        // So the box never stops the thing that the user wants to do.
        pointerEvents: "none",
        opacity: "0", transition: `opacity ${INTRO_FADE_MS}ms ease`,
    });
    // The Notes are text that a user typed. textContent shows it as text, never as HTML.
    box.textContent = text;
    document.body.appendChild(box);
    // Read the layout, so that the browser has the start opacity, then fade in.
    void box.offsetWidth;
    box.style.opacity = "1";

    // Capture phase: a handler lower in the page that stops the event cannot hide it.
    const onUserAction = () => dismissTemplateIntro();
    document.addEventListener("pointerdown", onUserAction, true);
    document.addEventListener("drop", onUserAction, true);
    activeIntro = {
        box,
        stopListening() {
            document.removeEventListener("pointerdown", onUserAction, true);
            document.removeEventListener("drop", onUserAction, true);
        },
    };
    return box;
}
