import {saveAs} from "file-saver";
import {isAbortLikeError, showLocalFolderAccessUnsupportedMessage, supportsDirectoryPicker} from "../CFileManagerUtils";
import {createDesktopDirectoryHandle, getDesktopFileSystemBridge} from "../DesktopFileSystem";
import {t} from "../i18n";
import {createNoisePatternFolderScan, noisePatternFolderCSV} from "./NoisePatternFolderScan";
import {normalizeNoisePatternFolderLimit} from "./NoisePatternFile";
import {createNoisePatternFileLink} from "./NoisePatternHandoff";

const tr = (key, values) => t(`videoNoisePattern.folderScan.${key}`, values);
const pct = value => Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "—";
const num = value => Number.isFinite(value) ? value.toFixed(2) : "—";
const repeat = row => row.status === "done" && row.kind === "repeat";
let active = null;

function element(tag, parent, text, style = {}) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    Object.assign(node.style, style);
    parent?.appendChild(node);
    return node;
}

export function showNoisePatternFolderScan(getOptions) {
    if (active) { active.panel.focus(); return active; }
    active = new NoisePatternFolderScanDialog(getOptions);
    return active;
}

export class NoisePatternFolderScanDialog {
    constructor(getOptions) {
        this.getOptions = getOptions;
        this.scan = null;
        this.directory = null;
        this.links = new Map();
        this.previousFocus = document.activeElement;
        this.overlay = element("div", document.body, undefined, {
            position: "fixed", inset: "0", background: "#0009", zIndex: "20000", display: "grid", placeItems: "center",
        });
        this.panel = element("div", this.overlay, undefined, {
            width: "92vw", maxWidth: "1400px", height: "85vh", maxHeight: "94vh", minWidth: "320px", minHeight: "240px",
            resize: "both", overflow: "hidden", boxSizing: "border-box", display: "flex", flexDirection: "column",
            padding: "14px", gap: "10px", border: "1px solid #777", borderRadius: "8px", background: "#202124",
            color: "#eee", font: "13px system-ui, sans-serif", boxShadow: "0 8px 40px #0009",
        });
        this.panel.tabIndex = -1;
        this.panel.setAttribute("role", "dialog");
        this.panel.setAttribute("aria-modal", "true");
        this.panel.setAttribute("aria-label", tr("title"));
        const header = element("div", this.panel, undefined, {display: "flex", alignItems: "center", gap: "12px"});
        element("strong", header, tr("title"), {fontSize: "18px", flex: "1"});
        this.button(header, "close", () => this.close());
        element("div", this.panel, tr("description"), {color: "#bbb"});
        const toolbar = element("div", this.panel, undefined, {display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center"});
        this.chooseButton = this.button(toolbar, "choose", () => this.chooseFolder());
        this.rescanButton = this.button(toolbar, "rescan", () => this.start(this.directory));
        this.stopButton = this.button(toolbar, "stop", () => this.scan?.stop());
        this.exportButton = this.button(toolbar, "export", () => {
            saveAs(new Blob([noisePatternFolderCSV(this.scan.state.rows)], {type: "text/csv;charset=utf-8"}), "NPD-Folder-Scan.csv");
        });
        const limitLabel = element("label", toolbar, tr("limit"), {display: "flex", alignItems: "center", gap: "6px"});
        this.limit = element("input", limitLabel, undefined, {width: "64px", padding: "5px", color: "#eee", background: "#333", border: "1px solid #777"});
        this.limit.type = "number";
        this.limit.min = "0.1";
        this.limit.max = "120";
        this.limit.step = "0.1";
        this.limit.value = "2";
        this.limit.title = tr("limitHelp");
        const label = element("label", toolbar, undefined, {display: "flex", alignItems: "center", gap: "4px"});
        this.onlyRepeats = element("input", label);
        this.onlyRepeats.type = "checkbox";
        element("span", label, tr("onlyRepeats"));
        this.onlyRepeats.onchange = () => this.render();
        this.filter = element("input", toolbar, undefined, {flex: "1", minWidth: "140px", color: "#eee", background: "#333", padding: "5px", border: "1px solid #777"});
        this.filter.type = "search";
        this.filter.placeholder = tr("filter");
        this.filter.setAttribute("aria-label", tr("filter"));
        this.filter.oninput = () => this.render();
        this.status = element("div", this.panel, tr("ready"), {overflowWrap: "anywhere"});
        this.status.setAttribute("role", "status");
        this.settings = element("div", this.panel, "", {color: "#aaa"});
        const folders = element("details", this.panel);
        this.folderSummary = element("summary", folders, tr("folders"));
        this.folderList = element("div", folders, undefined, {maxHeight: "150px", overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere"});
        this.scroll = element("div", this.panel, undefined, {flex: "1", minHeight: "60px", overflow: "auto", border: "1px solid #555"});
        const table = element("table", this.scroll, undefined, {width: "100%", minWidth: "1080px", borderCollapse: "collapse", fontSize: "12px"});
        const head = element("tr", element("thead", table));
        for (const key of ["file", "result", "period", "strength", "curve", "coverage", "matched", "frames", "usable", "details"]) {
            const th = element("th", head, tr(key), {textAlign: "left", padding: "8px", position: "sticky", top: "0", background: "#333", zIndex: "1"});
            if (["strength", "coverage", "matched", "usable"].includes(key)) th.title = tr(`${key}Help`);
        }
        this.body = element("tbody", table);
        this.detail = element("pre", this.panel, "", {display: "none", margin: "0", maxHeight: "25vh", overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere", flexShrink: "0", padding: "8px", background: "#161719"});
        this.onKey = event => {
            event.stopPropagation();
            if (event.key === "Escape") { event.preventDefault(); this.close(); }
            if (event.key === "Tab") {
                const items = [...this.panel.querySelectorAll("button,input,summary,a[href]")].filter(n => !n.disabled && n.getClientRects().length);
                const first = items[0], last = items.at(-1);
                if (event.shiftKey && (document.activeElement === first || document.activeElement === this.panel)) { event.preventDefault(); last?.focus(); }
                else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
            }
        };
        this.panel.addEventListener("keydown", this.onKey);
        this.panel.addEventListener("keyup", event => event.stopPropagation());
        this.render();
        this.chooseButton.focus();
    }

    button(parent, key, action) {
        const button = element("button", parent, tr(key), {cursor: "pointer", color: "#eee", background: "#3a3b3e", border: "1px solid #777", borderRadius: "4px", padding: "5px 9px"});
        button.type = "button";
        button.onclick = action;
        return button;
    }

    async chooseFolder() {
        let directory;
        try {
            const desktop = getDesktopFileSystemBridge();
            if (desktop) {
                const selected = await desktop.chooseFolder({});
                if (!selected?.path) return;
                directory = createDesktopDirectoryHandle(selected.path);
            } else {
                if (!supportsDirectoryPicker()) { showLocalFolderAccessUnsupportedMessage(); return; }
                directory = await window.showDirectoryPicker({mode: "read", id: "sitrec-npd-folder-scan"});
            }
            if (!this.closed) await this.start(directory);
        } catch (error) {
            if (!isAbortLikeError(error)) this.status.textContent = error?.message ?? String(error);
        }
    }

    async start(directory) {
        if (!directory || this.running || this.closed) return;
        this.directory = directory;
        this.links.clear();
        this.running = true;
        this.detail.style.display = "none";
        this.scan = createNoisePatternFolderScan({onUpdate: () => this.scheduleRender()});
        this.render();
        this.limit.value = String(normalizeNoisePatternFolderLimit(this.limit.value));
        await this.scan.run(directory, {...this.getOptions(), frames: "all", limitMinutes: Number(this.limit.value)});
        this.running = false;
        if (!this.closed) this.render();
    }

    scheduleRender() {
        if (this.timer || this.closed) return;
        this.timer = setTimeout(() => { this.timer = null; if (!this.closed) this.render(); }, 200);
    }

    resultLabel(row) {
        if (row.status === "error") return `${tr("error")}: ${row.error || tr("unknownError")}`;
        if (row.status !== "done") return tr(row.status === "stopped" ? "stopped" : row.status === "queued" ? "queued" : "working");
        if (repeat(row)) return tr(row.pictureRepeat ? "pictureRepeat" : "noiseRepeat");
        if (row.kind === "cannot" && row.usable != null) return tr("cannotReason", {usable: row.usable, required: row.minUsableFrames, held: row.held});
        return tr(row.kind === "isolated" ? "isolated" : row.kind === "cannot" ? "cannot" : "none");
    }

    render() {
        const state = this.scan?.state;
        this.chooseButton.disabled = this.rescanButton.disabled = !!this.running;
        this.limit.disabled = !!this.running;
        if (!this.directory) this.rescanButton.disabled = true;
        this.stopButton.disabled = !this.running;
        this.exportButton.disabled = !state?.rows.length;
        if (!state) return;
        const repeats = state.rows.filter(repeat).length;
        const errors = state.rows.filter(r => r.status === "error").length;
        const current = state.rows.find(r => !["queued", "done", "error", "stopped"].includes(r.status));
        this.status.textContent = tr("progress", {folder: state.folder, status: tr(state.status), done: state.completed,
            total: state.rows.length, repeats, errors: errors + state.errors.length})
            + (current ? ` — ${current.path}: ${current.status}${current.progress?.total ? ` ${current.progress.done}/${current.progress.total}` : ""}` : "");
        const o = state.options;
        this.settings.textContent = o ? tr("options", {lag: o.longestLag, detail: o.detail, vertical: o.vertical, held: o.held, limit: o.limitMinutes}) : "";
        this.folderSummary.textContent = tr("folderCount", {count: state.folders.length});
        const groups = new Map(state.folders.map(folder => [folder, {total: 0, repeats: 0, errors: 0}]));
        for (const row of state.rows) {
            const group = groups.get(row.folder);
            if (group) { group.total++; group.repeats += repeat(row) ? 1 : 0; group.errors += row.status === "error" ? 1 : 0; }
        }
        this.folderList.textContent = [...groups].map(([folder, c]) => tr("folderRow", {folder, ...c})).join("\n")
            + state.errors.map(e => `\n${e.path}: ${e.error}`).join("");
        const query = this.filter.value.toLocaleLowerCase();
        const rows = state.rows.filter(row => (!this.onlyRepeats.checked || repeat(row)) && row.path.toLocaleLowerCase().includes(query))
            .sort((a, b) => Number(repeat(b)) - Number(repeat(a)) || (b.strength ?? 0) - (a.strength ?? 0) || a.path.localeCompare(b.path));
        this.body.replaceChildren();
        for (const row of rows) {
            const line = element("tr", this.body, undefined, {background: repeat(row) ? (row.pictureRepeat ? "#504224" : "#204a37") : "transparent"});
            line.dataset.path = row.path;
            line.dataset.repeat = String(repeat(row));
            const values = [row.path, this.resultLabel(row), row.period ?? "—", num(row.strength), row.curve || "—",
                row.references && row.coverage != null ? `${row.coverage}/${row.references} (${pct(row.coverage / row.references)})` : "—",
                row.tested ? `${row.matched}/${row.tested} (${pct(row.matched / row.tested)})` : "—",
                row.frames ? `${row.decoded}/${row.frames}${row.autoReduced ? ` (${tr("autoReduced")})` : row.capped ? ` (${tr("capped")})` : ""}` : "—", row.usable ?? "—"];
            for (const [i, value] of values.entries()) {
                const cell = element("td", line, i === 0 ? undefined : value, {padding: "7px 8px", borderBottom: "1px solid #444", overflowWrap: "anywhere", maxWidth: i === 0 ? "400px" : "160px"});
                if (i === 0 && this.directory) {
                    let transfer = this.links.get(row.path);
                    if (!transfer) {
                        transfer = createNoisePatternFileLink(this.directory, row, state.options);
                        this.links.set(row.path, transfer);
                    }
                    const link = element("a", cell, value, {color: "#9bcaff", textDecoration: "underline"});
                    link.href = transfer.url;
                    link.target = "_blank";
                    link.rel = "noopener";
                    link.title = tr("openVideo");
                    const prepare = () => transfer.prepare().catch(error => {
                        if (!this.closed) this.status.textContent = error?.message ?? String(error);
                    });
                    link.addEventListener("click", prepare);
                    link.addEventListener("auxclick", event => { if (event.button === 1) prepare(); });
                    link.addEventListener("contextmenu", prepare);
                } else if (i === 0) cell.textContent = value;
            }
            this.button(element("td", line), "details", () => {
                this.detail.textContent = `${row.path}\n${this.resultLabel(row)}\n${JSON.stringify(row, null, 2)}`;
                this.detail.style.display = "block";
            });
            if (row.error) line.title = row.error;
        }
    }

    close() {
        this.closed = true;
        this.scan?.stop();
        clearTimeout(this.timer);
        this.overlay.remove();
        this.previousFocus?.focus();
        if (active === this) active = null;
    }
}
