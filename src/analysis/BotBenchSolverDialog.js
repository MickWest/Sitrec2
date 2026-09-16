// Shared solver selection UI for BOTBench and its charts.

import {describeSolvers, normalizeSolvers, SOLVERS} from "./BotBenchSolvers";

const SOLVERS_STORAGE_KEY = "botbench.solvers";

export function loadStoredSolvers() {
    try {
        const raw = localStorage.getItem(SOLVERS_STORAGE_KEY);
        return normalizeSolvers(raw ? JSON.parse(raw) : null);
    } catch (e) {
        return normalizeSolvers(null);
    }
}

export function storeSolvers(ids) {
    const normalized = normalizeSolvers(ids);
    try { localStorage.setItem(SOLVERS_STORAGE_KEY, JSON.stringify(normalized)); } catch (e) { /* private mode */ }
    return normalized;
}

export function solverButtonText(ids) {
    return `Solvers: ${describeSolvers(ids)}`;
}

function makeButton(label, color, title = "") {
    const button = document.createElement("button");
    button.textContent = label;
    button.title = title;
    button.style.cssText = `background:${color};color:#fff;border:0;border-radius:4px;padding:6px 12px;`
        + "font-size:13px;cursor:pointer;";
    return button;
}

function setDisabled(button, disabled) {
    button.disabled = disabled;
    button.style.opacity = disabled ? "0.5" : "1";
    button.style.cursor = disabled ? "default" : "pointer";
}

/**
 * Open the solver picker used by both the run controls and the chart controls.
 * Resolves to the chosen ids, or null when it is dismissed.
 */
export function chooseSolverSelection(selected, {fileCount = 0, charts = false} = {}) {
    return new Promise((resolve) => {
        const overlay = document.createElement("div");
        overlay.style.cssText = `
            position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 10002;
            display: flex; align-items: center; justify-content: center;
        `;
        const panel = document.createElement("div");
        panel.style.cssText = `
            background: #fff; color: #222; border-radius: 8px; padding: 16px 18px; width: min(680px, 94vw);
            max-height: 92vh; overflow: auto; box-shadow: 0 8px 40px rgba(0,0,0,0.4);
            font-family: Arial, sans-serif; font-size: 13px;
        `;
        const title = document.createElement("h3");
        title.textContent = charts ? "Solvers included in charts"
            : fileCount ? `Solvers for this run of ${fileCount} file(s)` : "Solvers for the next run";
        title.style.cssText = "margin: 0 0 6px; color: #1976d2; font-size: 16px;";
        const note = document.createElement("p");
        note.style.cssText = "margin: 0 0 10px; color: #52514e; line-height: 1.45;";
        note.textContent = charts
            ? "When Selected Solvers is checked, the charts use only the ticked solver candidates. "
                + "The same remembered selection is used for the next BOTBench run."
            : "Only the ticked solvers are fitted, and only their candidates are ranked, so the "
                + "top candidate and the verdict are those of this selection. Fits are stored per solver in the "
                + "folder: a later run with more solvers reuses these fits and fits only the missing ones, and a "
                + "run with fewer reads what it needs. Monte Carlo GPU presets require WebGPU and use order 1 with 0.1° uncertainty; "
                + "the separate GPU search checkbox controls supported search-heavy solvers.";
        panel.append(title, note);

        const boxes = new Map();
        const chosen = new Set(normalizeSolvers(selected));
        const groups = [...new Set(SOLVERS.map((s) => s.group))];
        const grid = document.createElement("div");
        grid.style.cssText = "display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px 18px;";
        for (const group of groups) {
            const head = document.createElement("div");
            head.textContent = group;
            head.style.cssText = "grid-column:1/-1;margin:8px 0 2px;font-weight:700;color:#4a5b6b;"
                + "font-size:11px;letter-spacing:.04em;text-transform:uppercase;";
            grid.appendChild(head);
            for (const solver of SOLVERS.filter((s) => s.group === group)) {
                const label = document.createElement("label");
                label.style.cssText = "display:flex;align-items:flex-start;gap:6px;cursor:pointer;line-height:1.35;";
                if (solver.note) label.title = solver.note;
                const box = document.createElement("input");
                box.type = "checkbox";
                box.checked = chosen.has(solver.id);
                box.style.marginTop = "2px";
                boxes.set(solver.id, box);
                label.append(box, document.createTextNode(solver.name));
                grid.appendChild(label);
            }
        }
        panel.appendChild(grid);

        const buttons = document.createElement("div");
        buttons.style.cssText = "display:flex;gap:8px;align-items:center;margin-top:14px;flex-wrap:wrap;";
        const allButton = makeButton("All", "#757575", "Tick every solver.");
        const noneButton = makeButton("None", "#757575", "Untick every solver.");
        const count = document.createElement("span");
        count.style.cssText = "color:#52514e;margin-left:auto;";
        const okButton = makeButton(charts ? "Use these" : (fileCount ? "Run" : "Use these"), "#1976d2");
        const cancelButton = makeButton("Cancel", "#757575");
        const refresh = () => {
            const n = [...boxes.values()].filter((box) => box.checked).length;
            count.textContent = `${n} of ${SOLVERS.length} selected`;
            setDisabled(okButton, n === 0);
            okButton.textContent = fileCount && !charts ? `Run with ${n} solver(s)` : `Use ${n} solver(s)`;
        };
        for (const box of boxes.values()) box.addEventListener("change", refresh);
        allButton.addEventListener("click", () => { for (const box of boxes.values()) box.checked = true; refresh(); });
        noneButton.addEventListener("click", () => { for (const box of boxes.values()) box.checked = false; refresh(); });
        refresh();
        buttons.append(allButton, noneButton, count, okButton, cancelButton);
        panel.appendChild(buttons);
        overlay.appendChild(panel);
        document.body.appendChild(overlay);

        const finish = (ids) => {
            if (overlay.parentNode) document.body.removeChild(overlay);
            resolve(ids);
        };
        okButton.addEventListener("click", () => finish(normalizeSolvers(
            [...boxes.entries()].filter(([, box]) => box.checked).map(([id]) => id))));
        cancelButton.addEventListener("click", () => finish(null));
        overlay.addEventListener("click", (event) => { if (event.target === overlay) finish(null); });
    });
}
