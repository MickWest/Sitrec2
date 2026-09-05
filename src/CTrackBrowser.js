/**
 * Track Browser — a full-screen browser for a LOCAL FOLDER of multi-track files.
 *
 * The sibling of CSitchBrowser, and deliberately shaped like it (same overlay
 * chrome, same grid-plus-preview split, same keyboard model) but pointed at a
 * different thing: CSitchBrowser lists saved sitches on the server and previews
 * them with a stored screenshot, this walks a folder on disk and previews each
 * file by DRAWING it.
 *
 * WHY IT DRAWS RATHER THAN IMPORTS. A results folder is hundreds of files whose
 * names encode the scenario and whose differences are geometric — the same run at
 * three noise levels, a curve against an orbit against a straight line. Nothing
 * short of the shape tells them apart, and importing each one to find out costs a
 * scene rebuild per file. So every candidate is parsed head­lessly (TrackFileProbe),
 * reduced to a few hundred plan-view points, and the parsed file is then thrown
 * away — only the summary is retained. Import happens once, for the one file the
 * user picks, and goes through the ordinary drop path so it behaves exactly as
 * dragging that file onto the window would.
 *
 * MULTI-TRACK ONLY. A file is listed when it yields two or more tracks
 * (getTrackCount, not getImportTrackCount — see TrackFileProbe for why those
 * differ). Single-track files are counted and reported in the status line rather
 * than silently dropped, so a folder that looks empty can be told apart from a
 * folder that is.
 */

import {FileManager, Globals} from "./Globals";
import {t} from "./i18n";
import {DragDropHandler} from "./DragDropHandler";
import {showError} from "./showError";
import {
    isAbortLikeError,
    showLocalFolderAccessUnsupportedMessage,
    supportsDirectoryPicker,
    walkDirectoryForFiles,
} from "./CFileManagerUtils";
import {isProbeableTrackName, probeTrackFile, summarizeTrackFile, trackFileTrackCount} from "./TrackFiles/TrackFileProbe";
import {botBenchExplicitFileRole, botBenchScenarioBase} from "./analysis/BotBenchIngest";
import {VIZ} from "./TraverseHypotheses";
import {openBotBenchWithEntries} from "./analysis/BotBenchUI";

// Track colors by resolved role. Truth is checked before role, so a BOT truth
// sub-track (role "target", ground truth) reads as the answer key rather than as
// one more target.
//
// The three values come from VIZ so this view, the traverse charts, the 3D scene
// and the legacy sitches all agree — a camera track used to be a different colour
// in each of those. Truth and target are the closest pair, and they meet exactly
// here (a BOT file has both), so truth is drawn DASHED below.
const TRACK_COLORS = {
    truth: VIZ.truth,
    camera: VIZ.camera,
    target: VIZ.target,
};

// Colors for tracks whose format states no roles at all — a multi-aircraft KML, a
// multi-TrackID MISB file. Drawing every one of them in a single neutral grey made
// a two-track KML two indistinguishable lines, which defeats the point of plotting
// them together. Deliberately clear of the three role colors above, so a palette
// track is never mistaken for a platform or an answer key.
const ROLELESS_COLORS = ["#b0bec5", "#ce93d8", "#9fa8da", "#80cbc4", "#ffab91", "#c5e1a5"];

// Files probed between yields to the event loop. Low enough that the status line
// and the Stop button stay live on a folder of thousands, high enough that the
// yields do not dominate the scan.
const PROBE_BATCH = 8;

function trackColor(track) {
    if (track.isTruth) return TRACK_COLORS.truth;
    if (track.role === "camera" || track.role === "target") return TRACK_COLORS[track.role];
    return ROLELESS_COLORS[(track.index ?? 0) % ROLELESS_COLORS.length];
}

/** "1.4 km" / "820 m" — a distance a person reads at a glance. */
function formatDistance(m) {
    if (!Number.isFinite(m)) return "—";
    if (m >= 10000) return `${Math.round(m / 1000)} km`;
    if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
    return `${Math.round(m)} m`;
}

function formatDuration(s) {
    if (!Number.isFinite(s) || s <= 0) return "—";
    if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
    const mins = Math.floor(s / 60);
    const secs = Math.round(s % 60);
    return `${mins}m ${secs}s`;
}

/**
 * Draw a summary as a north-up plan view.
 *
 * `overlay` picks between two genuinely different pictures, not a preference:
 *
 *   false  TRUE GEOMETRY. One frame around every track, so the standoff between
 *          the platform and its target is to scale and readable. On a typical
 *          bearings-only scenario — a sensor 13 km out, a target moving 200 m —
 *          that makes the target a dot: correct, and useless for telling one
 *          scenario from another.
 *   true   OVERLAID. Every track's own centre is moved to the centre of the box,
 *          so the paths sit on top of each other and both shapes are legible.
 *          ONLY the position is faked: a single scale is shared by every track,
 *          so their relative SIZES survive — a target covering 200 m still draws
 *          a fifth of the size of a platform covering a kilometre. That is what
 *          separates this from scaling each track to fill the box, which would
 *          make a 200 m wiggle and a 20 km circle look identical.
 *
 * Aspect ratio is preserved either way — a shape drawn to a stretched scale is
 * not the shape.
 */
export function drawPlanView(canvas, summary, {overlay = true, lineWidth = 1.5, padding = 10} = {}) {
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || parseInt(canvas.style.width) || 200;
    const cssH = canvas.clientHeight || parseInt(canvas.style.height) || 150;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    if (!summary || !summary.tracks.length) return;

    const boxW = Math.max(1, cssW - padding * 2);
    const boxH = Math.max(1, cssH - padding * 2);

    // Degenerate extents (a stationary sensor is a single point) would divide by
    // zero, so they fall back to a scale of 1 and simply sit at the centre.
    const fitScale = (w, h) => (w > 0 || h > 0) ? Math.min(boxW / (w || h), boxH / (h || w)) : 1;

    const bounds = summary.tracks.map((track) => {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        const xy = track.xy;
        for (let i = 0; i < xy.length; i += 2) {
            if (xy[i] < minX) minX = xy[i];
            if (xy[i] > maxX) maxX = xy[i];
            if (xy[i + 1] < minY) minY = xy[i + 1];
            if (xy[i + 1] > maxY) maxY = xy[i + 1];
        }
        return {minX, maxX, minY, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2};
    });

    // ONE scale in both modes — see the header. Overlaid, it is set by the
    // largest single track so the biggest one fills the box and the rest keep
    // their true proportion to it; in true geometry it is set by the frame
    // around everything.
    const scale = overlay
        ? fitScale(Math.max(...bounds.map(b => b.maxX - b.minX)),
                   Math.max(...bounds.map(b => b.maxY - b.minY)))
        : fitScale(summary.maxX - summary.minX, summary.maxY - summary.minY);

    const sharedCx = (summary.minX + summary.maxX) / 2;
    const sharedCy = (summary.minY + summary.maxY) / 2;

    for (let t = 0; t < summary.tracks.length; t++) {
        const track = summary.tracks[t];
        const xy = track.xy;
        // Overlaid, each track is centred on ITSELF; otherwise every track shares
        // the one frame, which is what preserves the standoff between them.
        const cx = overlay ? bounds[t].cx : sharedCx;
        const cy = overlay ? bounds[t].cy : sharedCy;
        // Screen y grows downward and north grows up, hence the negated y.
        const sx = (x) => cssW / 2 + (x - cx) * scale;
        const sy = (y) => cssH / 2 - (y - cy) * scale;

        const color = trackColor(track);
        ctx.strokeStyle = color;
        ctx.lineWidth = lineWidth;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        // Truth is dashed, matching the traverse charts. It shares a hue family
        // with the target on purpose — on a BOT file they ARE the same object —
        // so the dash, not the colour, says which one is the answer key.
        if (track.isTruth) ctx.setLineDash([lineWidth * 3, lineWidth * 2.5]);
        ctx.beginPath();
        ctx.moveTo(sx(xy[0]), sy(xy[1]));
        for (let i = 2; i < xy.length; i += 2) ctx.lineTo(sx(xy[i]), sy(xy[i + 1]));
        ctx.stroke();
        ctx.setLineDash([]);

        // A filled dot at the start, so a closed or doubled-back path still shows
        // which way it was flown.
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(sx(xy[0]), sy(xy[1]), Math.max(2, lineWidth * 1.6), 0, Math.PI * 2);
        ctx.fill();
    }
}

export class CTrackBrowser {
    constructor(fileManager) {
        this.fileManager = fileManager;
        this.directoryHandle = null;
        this.folderName = "";
        this.recursive = true;
        // Overlaid by default: browsing is about telling scenarios apart, and the
        // true geometry of a bearings-only scenario is a line and a dot.
        this.overlayTracks = true;
        this.entries = [];          // multi-track files, each with its summary
        this.filtered = [];
        this.skippedCount = 0;      // probed, but fewer than two tracks
        this.errorCount = 0;
        this.searchText = "";
        this.sortKey = "path";
        this.sortAsc = true;
        // selectedKey is the FOCUSED entry — the one the preview shows and the
        // arrow keys move. `selection` is what the buttons act on. They are
        // usually the same one key; they diverge as soon as a shift- or
        // cmd-click puts several files under one action.
        this.selectedKey = null;
        this.selection = new Set();
        this._lastClickedIndex = -1;
        this.overlay = null;
        this.thumbColumns = 3;
        // Split view is OFF by default: the grid is the thing being browsed, and
        // giving it the whole window fits twice as many columns. The preview is a
        // detail view you turn on when you want it, not a permanent half-screen.
        this.splitView = false;
        this.scanning = false;
        this._scanToken = 0;
        this._thumbObserver = null;
        this._keyHandler = null;
        // How many of `entries` already have a card. The scan appends from here
        // rather than rebuilding the grid — see _appendNewEntries.
        this._appendedCount = 0;
        this._placeholder = null;
        this._walked = null;        // last folder walk, kept for sidecar pairing
    }

    open() {
        if (this.overlay) return;
        this.show();
        // A folder chosen earlier in the session is re-walked rather than
        // re-picked: the handle is still live, and making the user find the
        // folder again every time is the whole friction this browser removes.
        if (this.directoryHandle) this.rescan();
    }

    // ==================== FOLDER SCANNING ====================

    async chooseFolder() {
        if (!supportsDirectoryPicker()) {
            showLocalFolderAccessUnsupportedMessage();
            return;
        }
        let handle;
        try {
            // Read-only: the browser never writes to the folder it is browsing.
            handle = await window.showDirectoryPicker({mode: "read", id: "sitrec-track-browser"});
        } catch (error) {
            if (!isAbortLikeError(error)) showError(error);
            return;
        }
        this.directoryHandle = handle;
        this.folderName = handle.name || "";
        await this.rescan();
    }

    async rescan() {
        if (!this.directoryHandle) return;
        const token = ++this._scanToken;
        this.scanning = true;
        this.entries = [];
        this.filtered = [];
        this.selectedKey = null;
        this.selection.clear();
        this._lastClickedIndex = -1;
        this.skippedCount = 0;
        this.errorCount = 0;
        this._appendedCount = 0;
        this._refreshControls();
        this.renderCards();
        this.updatePreview();

        let candidates;
        let walked = 0;
        try {
            this._setStatus("Walking folder…");
            // Retained whole: "Open in BOTBench" needs the sidecars that this
            // browser's own multi-track filter discards, and re-walking the
            // folder to find them would ask for the picker again. It is a list of
            // handles, not content — cheap to keep.
            candidates = await walkDirectoryForFiles(this.directoryHandle, {
                accept: isProbeableTrackName,
                recursive: this.recursive,
                onFound: () => {
                    if (token === this._scanToken) this._setStatus(`Walking folder… ${++walked} candidate file(s)`);
                },
            });
        } catch (error) {
            if (token !== this._scanToken) return;
            this.scanning = false;
            this._refreshControls();
            this._setStatus(error?.message || String(error));
            return;
        }
        if (token !== this._scanToken) return;

        candidates.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
        this._walked = candidates;

        let probed = 0;
        for (const candidate of candidates) {
            if (token !== this._scanToken) return;
            try {
                const file = await candidate.getFile();
                const trackFile = await probeTrackFile(candidate.name, file);
                // Two or more tracks is the whole listing rule — see the class
                // header. The parsed file is dropped here: holding hundreds of
                // them is what makes a folder of this size unbrowsable.
                if (trackFileTrackCount(trackFile) >= 2) {
                    const summary = summarizeTrackFile(trackFile, candidate.name);
                    if (summary) {
                        this.entries.push({
                            key: candidate.relativePath,
                            name: candidate.name,
                            relativePath: candidate.relativePath,
                            dirPath: candidate.dirPath,
                            getFile: candidate.getFile,
                            summary,
                        });
                    } else {
                        this.skippedCount++;
                    }
                } else {
                    this.skippedCount++;
                }
            } catch (error) {
                // One unreadable or malformed file must not end a folder scan.
                this.errorCount++;
                console.warn(`Track browser: could not read ${candidate.relativePath}:`, error);
            }
            probed++;
            if (probed % PROBE_BATCH === 0) {
                this._setStatus(`Reading ${probed} / ${candidates.length}… `
                    + `${this.entries.length} multi-track file(s)`);
                this._appendNewEntries();
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }
        if (token !== this._scanToken) return;

        this.scanning = false;
        this._appendNewEntries();
        this._finishScanRender();
        this._refreshControls();
        this._setStatus(this._scanSummaryText(candidates.length));
        if (this.filtered.length && !this.selectedKey) this.select(this.filtered[0].key);
    }

    stopScan() {
        this._scanToken++;
        this.scanning = false;
        this._appendNewEntries();
        this._finishScanRender();
        this._refreshControls();
        this._setStatus(`Stopped. ${this.entries.length} multi-track file(s) found so far.`);
    }

    _scanSummaryText(candidateCount) {
        if (!candidateCount) {
            return this.recursive
                ? "No track-shaped files in this folder or its subfolders."
                : "No track-shaped files in this folder — try Include subfolders.";
        }
        const parts = [`${this.entries.length} multi-track file(s) of ${candidateCount} read`];
        if (this.skippedCount) parts.push(`${this.skippedCount} single-track skipped`);
        if (this.errorCount) parts.push(`${this.errorCount} unreadable`);
        return parts.join(" — ");
    }

    // ==================== FILTER / SORT ====================

    /**
     * The fullest path this browser can honestly show: the chosen folder's name
     * followed by the path within it.
     *
     * The File System Access API never hands out an absolute filesystem path — a
     * handle knows its own name and nothing about what is above it — so this is
     * the whole of what is knowable, not a shortened form of something better.
     */
    _fullPath(entry) {
        return this.folderName ? `${this.folderName}/${entry.relativePath}` : entry.relativePath;
    }

    _matchesSearch(entry) {
        const search = this.searchText.trim().toLowerCase();
        return !search || entry.relativePath.toLowerCase().includes(search);
    }

    applyFilterAndSort() {
        this.filtered = this.entries.filter(e => this._matchesSearch(e));

        const dir = this.sortAsc ? 1 : -1;
        const value = (e) => {
            switch (this.sortKey) {
                case "name": return e.name.toLowerCase();
                case "span": return e.summary.spanM;
                case "duration": return e.summary.durationS ?? 0;
                case "tracks": return e.summary.trackCount;
                default: return e.relativePath.toLowerCase();
            }
        };
        this.filtered.sort((a, b) => {
            const va = value(a), vb = value(b);
            if (va < vb) return -dir;
            if (va > vb) return dir;
            return a.relativePath.localeCompare(b.relativePath);
        });

        // Anything the filter just hid is no longer selectable. Every button
        // resolves its keys against `filtered`, so a survivor of an old filter
        // left a stale preview beside ENABLED buttons that silently did nothing.
        const visible = new Set(this.filtered.map(e => e.key));
        if (this.selectedKey && !visible.has(this.selectedKey)) this.selectedKey = null;
        for (const key of [...this.selection]) if (!visible.has(key)) this.selection.delete(key);
        this._lastClickedIndex = -1;
    }

    /**
     * Re-filter, re-sort, redraw the grid, and resync the preview — in that order.
     *
     * Every control that changes what is LISTED goes through here rather than
     * calling the three separately, because forgetting the last one is exactly
     * how the preview and the Import button drifted out of step with the grid.
     */
    _refreshList() {
        this.applyFilterAndSort();
        this.renderCards();
        this.updatePreview();
    }

    // ==================== IMPORT ====================

    /**
     * Import the focused file exactly as dropping it on the window would.
     *
     * Straight through uploadDroppedFiles, so everything that governs a drop
     * still governs this: the "Reset on Track Import" tweak, the role hints that
     * put a BOT sensor on the camera switch, and a BOT scenario's right to size
     * the sitch to its own length. The overlay closes FIRST — the import builds
     * the scene the user asked to look at, and leaving a full-screen browser over
     * it would hide the result of their own click.
     */
    async importSelected() {
        const files = await this._selectedFiles();
        if (!files.length) return;
        this.close();
        DragDropHandler.uploadDroppedFiles(files);
    }

    /**
     * Import the focused file into a FRESH sitch, discarding the current scene.
     *
     * Single file only. A benchmark scenario re-times the sitch to its own length
     * and claims the camera and target switches, so two of them in one new sitch
     * would each undo the other's setup — which is the same reason CTrackFileBOT
     * refuses to load several scenarios from one file. Importing several INTO AN
     * EXISTING scene is still available: that is what Import does.
     */
    async openAsNewSitch() {
        const entry = this.filtered.find(e => e.key === this.selectedKey);
        if (!entry) return;
        let file;
        try {
            file = await entry.getFile();
        } catch (error) {
            showError(error);
            return;
        }
        this.close();
        DragDropHandler.uploadFilesIntoNewSitch([file]);
    }

    /**
     * Hand the selection to BOTBench.
     *
     * The WALK is passed, not just the selected files: a BOT scenario's frame and
     * epoch live in a `.scenario.json` beside the CSV, and pairSidecars can only
     * attach a sidecar it can see. So the selected files are joined by every
     * walked file sharing their scenario key — which is exactly what BOTBench's
     * own folder scan hands it.
     */
    async openInBotBench() {
        const selected = this.filtered.filter(e => this.selection.has(e.key));
        const analysable = selected.filter(e => botBenchExplicitFileRole(e.name));
        if (!analysable.length) {
            showError("None of the selected files are ones BOTBench can analyse "
                + "(BOT interchange CSV, FMV .ts/.klv, a track CSV or .srt with camera "
                + "pointing, or a STANAG 4676 .xml).");
            return;
        }

        // The scenario key a sidecar is matched on: the containing directory plus
        // the base name, so `a/bot-1.scenario.json` reaches `a/bot-1.input.csv`
        // and never `b/bot-1.input.csv`.
        const scenarioKey = (entry) =>
            (entry.relativePath.replace(/[^/]*$/, "")) + botBenchScenarioBase(entry.name);
        const wanted = new Set(analysable.map(scenarioKey));
        const withSidecars = (this._walked ?? []).filter(w => wanted.has(scenarioKey(w)));

        // The walk is retained across a scan, but a browser opened on a folder it
        // has not re-read has none — fall back to the files themselves, which
        // still analyse, just at the format's default origin and epoch.
        const entries = withSidecars.length ? withSidecars : analysable;

        const skipped = selected.length - analysable.length;
        this.close();
        const queued = await openBotBenchWithEntries(entries);
        if (skipped > 0) {
            console.log(`Open in BOTBench: ${queued} file(s) queued, `
                + `${skipped} selected file(s) skipped as not analysable.`);
        }
    }

    /** The selected entries' File objects, in listed order. */
    async _selectedFiles() {
        const entries = this.filtered.filter(e => this.selection.has(e.key));
        const files = [];
        for (const entry of entries) {
            try {
                files.push(await entry.getFile());
            } catch (error) {
                showError(error);
                return [];
            }
        }
        return files;
    }

    // ==================== UI ====================

    show() {
        if (this.overlay) this.close();

        Globals.menuBar?.hideNonBarMenus();

        const overlay = document.createElement("div");
        overlay.dataset.interactionNative = "true";
        this.overlay = overlay;
        const menuBarEl = document.getElementById("menuBarBlackBar");
        const topPx = menuBarEl ? (menuBarEl.offsetTop + menuBarEl.offsetHeight) : 0;
        Object.assign(overlay.style, {
            position: "fixed", left: "0", top: topPx + "px",
            width: "100%", height: `calc(100% - ${topPx}px)`,
            backgroundColor: "rgba(0,0,0,0.85)", zIndex: "4999", display: "flex",
            fontFamily: "system-ui, -apple-system, sans-serif", color: "#e0e0e0",
        });

        overlay.appendChild(this._buildBrowsePane());
        overlay.appendChild(this._buildPreviewPane());

        document.body.appendChild(overlay);

        this._keyHandler = (e) => this._onKeyDown(e);
        document.addEventListener("keydown", this._keyHandler, true);

        this._applyLayout();
        this._refreshControls();
        this.renderCards();
        this.updatePreview();
    }

    /** Left half: toolbar over a scrolling grid of thumbnails. */
    _buildBrowsePane() {
        const pane = document.createElement("div");
        Object.assign(pane.style, {
            flex: "1", minWidth: "0", display: "flex", flexDirection: "column",
            backgroundColor: "#181825", overflow: "hidden",
        });

        // Title
        const titleBar = document.createElement("div");
        Object.assign(titleBar.style, {
            padding: "16px 24px", fontSize: "20px", fontWeight: "600",
            borderBottom: "1px solid #333", display: "flex",
            justifyContent: "space-between", alignItems: "center", gap: "12px",
        });
        this._title = document.createElement("div");
        this._title.textContent = "Track Browser";
        this._title.style.whiteSpace = "nowrap";
        titleBar.appendChild(this._title);

        // The key goes in the empty run between the title and the version, where
        // it is on screen the whole time — a legend that only appears under the
        // selected file cannot explain the grid, which is where the colors are
        // actually being read.
        titleBar.appendChild(this._makeColorKey());

        const versionLabel = document.createElement("span");
        Object.assign(versionLabel.style, {fontSize: "12px", color: "#666", fontWeight: "400"});
        versionLabel.textContent = process.env.BUILD_VERSION_STRING;
        titleBar.appendChild(versionLabel);
        pane.appendChild(titleBar);

        // Toolbar row 1 — folder controls
        const folderBar = document.createElement("div");
        Object.assign(folderBar.style, {
            padding: "12px 24px", borderBottom: "1px solid #333",
            display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap",
        });

        this._chooseBtn = this._makeButton("Choose Folder…", "#2ea043");
        this._chooseBtn.addEventListener("click", () => this.chooseFolder());
        folderBar.appendChild(this._chooseBtn);

        this._rescanBtn = this._makeButton("Rescan", "#3a3a52");
        this._rescanBtn.addEventListener("click", () => this.rescan());
        folderBar.appendChild(this._rescanBtn);

        this._stopBtn = this._makeButton("Stop", "#8b2d2d");
        this._stopBtn.addEventListener("click", () => this.stopScan());
        folderBar.appendChild(this._stopBtn);

        this._recursiveLabel = this._makeCheckbox("Include subfolders", this.recursive, (on) => {
            this.recursive = on;
            if (this.directoryHandle) this.rescan();
        });
        folderBar.appendChild(this._recursiveLabel);

        this._folderLabel = document.createElement("div");
        Object.assign(this._folderLabel.style, {
            fontSize: "12px", color: "#8ab4f8", whiteSpace: "nowrap",
            overflow: "hidden", textOverflow: "ellipsis", flex: "1", minWidth: "0",
        });
        folderBar.appendChild(this._folderLabel);

        // The actions live in the toolbar rather than under the preview, because
        // the preview is optional now — buttons that disappear with the split
        // would leave the default layout with no way to act on a selection except
        // double-click.
        this._importBtn = this._makeButton("Import", "#2ea043");
        this._importBtn.style.fontWeight = "700";
        this._importBtn.title = "Add the selected track file(s) to the CURRENT sitch, "
            + "exactly as dragging them onto the window would.";
        this._importBtn.addEventListener("click", () => this.importSelected());
        folderBar.appendChild(this._importBtn);

        this._newSitchBtn = this._makeButton("Open as New Sitch", "#1a73e8");
        this._newSitchBtn.title = "Discard the current scene and open this file in a fresh "
            + "custom sitch. One file at a time — a scenario re-times the sitch and claims "
            + "the camera and target tracks, so two would undo each other.";
        this._newSitchBtn.addEventListener("click", () => this.openAsNewSitch());
        folderBar.appendChild(this._newSitchBtn);

        this._botBenchBtn = this._makeButton("Open in BOTBench", "#7b4bc4");
        this._botBenchBtn.title = "Run the traverse analysis over every selected file and "
            + "compare the results in one table. Shift-click and cmd/ctrl-click to select "
            + "several, or drag a box across the grid.";
        this._botBenchBtn.addEventListener("click", () => this.openInBotBench());
        folderBar.appendChild(this._botBenchBtn);

        const closeBtn = this._makeButton("Close", "#3a3a52");
        closeBtn.addEventListener("click", () => this.close());
        folderBar.appendChild(closeBtn);

        pane.appendChild(folderBar);

        // Toolbar row 2 — view controls
        const viewBar = document.createElement("div");
        Object.assign(viewBar.style, {
            padding: "10px 24px", borderBottom: "1px solid #333",
            display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap",
        });

        this._searchInput = document.createElement("input");
        this._searchInput.type = "text";
        this._searchInput.placeholder = "Filter by name or path…";
        Object.assign(this._searchInput.style, {
            flex: "1", minWidth: "140px", padding: "6px 10px", fontSize: "13px",
            backgroundColor: "#2a2a3e", color: "#e0e0e0",
            border: "1px solid #444", borderRadius: "4px",
        });
        this._searchInput.addEventListener("input", () => {
            this.searchText = this._searchInput.value;
            this._refreshList();
        });
        viewBar.appendChild(this._searchInput);

        const overlayToggle = this._makeCheckbox("Overlay tracks", this.overlayTracks, (on) => {
            this.overlayTracks = on;
            this.renderCards();
            this.updatePreview();
        });
        overlayToggle.title = "On: every track is centred in the box so the shapes sit on top of "
            + "each other — still drawn to one shared scale, so their relative sizes are real.\n"
            + "Off: true geometry, one frame around everything, so the distance between the "
            + "tracks is to scale.";
        viewBar.appendChild(overlayToggle);

        viewBar.appendChild(this._makeLabel("Sort:"));
        viewBar.appendChild(this._makeSelect([
            ["path_asc", "Path (A-Z)"],
            ["path_desc", "Path (Z-A)"],
            ["name_asc", "Name (A-Z)"],
            ["tracks_desc", "Tracks (most)"],
            ["span_desc", "Extent (largest)"],
            ["duration_desc", "Duration (longest)"],
        ], `${this.sortKey}_${this.sortAsc ? "asc" : "desc"}`, (v) => {
            const split = v.lastIndexOf("_");
            this.sortKey = v.slice(0, split);
            this.sortAsc = v.slice(split + 1) === "asc";
            this._refreshList();
        }));

        this._colLabel = this._makeLabel(`Columns: ${this._effectiveColumns()}`);
        viewBar.appendChild(this._colLabel);
        const colSlider = document.createElement("input");
        colSlider.type = "range";
        colSlider.min = "1";
        colSlider.max = "8";
        colSlider.value = String(this.thumbColumns);
        Object.assign(colSlider.style, {width: "90px", accentColor: "#8ab4f8"});
        colSlider.addEventListener("input", () => {
            this.thumbColumns = parseInt(colSlider.value);
            this._applyLayout();
        });
        viewBar.appendChild(colSlider);

        viewBar.appendChild(this._makeCheckbox("Split view", this.splitView, (on) => {
            this.splitView = on;
            this._applyLayout();
            // The preview canvas is sized in percentages, so it has no size at all
            // while hidden — it has to be redrawn once it is on screen again.
            if (on) this.updatePreview();
        }));
        pane.appendChild(viewBar);

        // Status line
        this._status = document.createElement("div");
        Object.assign(this._status.style, {
            padding: "8px 24px", fontSize: "12px", color: "#888",
            borderBottom: "1px solid #333", minHeight: "18px",
        });
        pane.appendChild(this._status);

        // Grid
        this._scroll = document.createElement("div");
        Object.assign(this._scroll.style, {flex: "1", overflowY: "auto", padding: "16px 24px"});
        this._grid = document.createElement("div");
        Object.assign(this._grid.style, {
            display: "grid",
            gridTemplateColumns: `repeat(${this._effectiveColumns()}, 1fr)`,
            gap: "16px",
        });
        this._scroll.appendChild(this._grid);
        pane.appendChild(this._scroll);
        this._initRubberBand(this._scroll);

        return pane;
    }

    /** Right HALF: the large preview and the import action. */
    _buildPreviewPane() {
        const pane = document.createElement("div");
        this._previewPane = pane;
        Object.assign(pane.style, {
            // border-box so the 24px padding comes OUT of the half rather than being
            // added to it — "the right half of the screen" is the spec, and
            // content-box would make this pane 998px of a 1900px window.
            width: "50%", minWidth: "0", boxSizing: "border-box",
            backgroundColor: "#1e1e2e",
            borderLeft: "1px solid #333", display: "flex", flexDirection: "column",
            padding: "24px", gap: "12px", overflowY: "auto",
        });

        const heading = document.createElement("div");
        Object.assign(heading.style, {
            fontSize: "14px", fontWeight: "600", color: "#888",
            textTransform: "uppercase", letterSpacing: "0.5px",
        });
        heading.textContent = "Preview";
        pane.appendChild(heading);

        this._previewName = document.createElement("div");
        Object.assign(this._previewName.style, {
            fontSize: "17px", fontWeight: "600", color: "#e0e0e0", wordBreak: "break-word",
        });
        pane.appendChild(this._previewName);

        this._previewPath = document.createElement("div");
        Object.assign(this._previewPath.style, {
            fontSize: "12px", color: "#7a7a94", wordBreak: "break-all",
        });
        pane.appendChild(this._previewPath);

        this._previewCanvas = document.createElement("canvas");
        Object.assign(this._previewCanvas.style, {
            width: "100%", aspectRatio: "4/3", backgroundColor: "#12121c",
            borderRadius: "6px", border: "1px solid #333",
        });
        pane.appendChild(this._previewCanvas);

        this._previewLegend = document.createElement("div");
        Object.assign(this._previewLegend.style, {
            display: "flex", flexDirection: "column", gap: "6px", fontSize: "13px",
        });
        pane.appendChild(this._previewLegend);

        this._previewStats = document.createElement("div");
        Object.assign(this._previewStats.style, {fontSize: "13px", color: "#aaa", lineHeight: "1.7"});
        pane.appendChild(this._previewStats);


        // The preview canvas is sized in CSS percentages, so it has to be redrawn
        // when the pane changes size or the plot is stretched to a stale backing
        // store. Observing the canvas itself catches both a window resize and a
        // layout change from the content above it.
        this._resizeObserver = new ResizeObserver(() => this._drawPreview());
        this._resizeObserver.observe(this._previewCanvas);

        return pane;
    }

    // ==================== CARDS ====================

    /**
     * Rebuild the whole grid from `filtered`.
     *
     * This throws away every canvas and every already-drawn thumbnail, so it is
     * for the things that genuinely reorder the grid — a sort, a filter, a fit
     * change. A SCAN must not use it: see _appendNewEntries.
     */
    renderCards() {
        if (!this._grid) return;
        this._destroyThumbObserver();
        this._grid.innerHTML = "";
        this._placeholder = null;
        // Everything known is now on screen, so an append that follows starts
        // from the end rather than re-adding what this call just drew.
        this._appendedCount = this.entries.length;

        if (!this.filtered.length) {
            this._showPlaceholder();
            return;
        }

        this._ensureThumbObserver();
        for (const entry of this.filtered) {
            const card = this._makeCard(entry);
            this._grid.appendChild(card);
            this._thumbObserver.observe(card);
        }
        this._updateHighlights();
    }

    _showPlaceholder() {
        const empty = document.createElement("div");
        Object.assign(empty.style, {
            padding: "48px 0", textAlign: "center", color: "#666",
            fontSize: "14px", gridColumn: "1 / -1",
        });
        empty.textContent = this.scanning
            ? "Reading files…"
            : this.directoryHandle
                ? (this.searchText ? "No files match the filter." : "No multi-track files found.")
                : "Choose a folder to browse its multi-track files.";
        this._placeholder = empty;
        this._grid.appendChild(empty);
    }

    /**
     * Add cards for entries found since the last call, without touching the ones
     * already there.
     *
     * A scan used to call renderCards() every batch, which emptied the grid and
     * rebuilt it — so every thumbnail already drawn was discarded and redrawn,
     * several times a second, and the grid visibly flickered for the whole scan.
     * Appending leaves drawn canvases alone: a card is built once and never
     * rebuilt, and the IntersectionObserver outlives the batch so a thumbnail
     * that scrolled into view stays drawn.
     *
     * Order is DISCOVERY order here, which is the walk's own path order. The
     * authoritative sort runs once when the scan finishes — and only rebuilds if
     * it actually moved something (see _finishScanRender).
     */
    _appendNewEntries() {
        if (!this._grid) return;
        while (this._appendedCount < this.entries.length) {
            const entry = this.entries[this._appendedCount++];
            if (!this._matchesSearch(entry)) continue;
            this.filtered.push(entry);
            if (this._placeholder) {
                this._placeholder.remove();
                this._placeholder = null;
            }
            this._ensureThumbObserver();
            const card = this._makeCard(entry);
            this._grid.appendChild(card);
            this._thumbObserver.observe(card);
        }
        // Give the preview something as soon as there IS something, rather than
        // leaving the right half empty until the whole folder has been read.
        if (!this.selectedKey && this.filtered.length) this.select(this.filtered[0].key);
    }

    /**
     * Sort what the scan appended, and repaint ONLY if the sort moved something.
     *
     * With the default path ordering the walk already delivered the files in
     * sorted order, so this is a no-op and the finished grid is the one that was
     * built incrementally — no final flash either.
     */
    _finishScanRender() {
        const displayed = Array.from(this._grid?.children ?? []).map(c => c._key).filter(Boolean);
        this.applyFilterAndSort();
        const wanted = this.filtered.map(e => e.key);
        if (displayed.length !== wanted.length || wanted.some((k, i) => k !== displayed[i])) {
            this.renderCards();
        } else if (!this.filtered.length) {
            this.renderCards();   // repaint the placeholder, whose text depends on `scanning`
        }
        // applyFilterAndSort can have dropped the selection (a filter typed while
        // the scan was running), so the preview is resynced here too.
        this.updatePreview();
    }

    // One observer for the life of the grid. Thumbnails are drawn only once a
    // card scrolls into view: the summaries are already in memory, so this is
    // about the canvases, not the parsing — several hundred backing stores
    // allocated up front is what makes a big folder stutter.
    _ensureThumbObserver() {
        if (this._thumbObserver) return;
        this._thumbObserver = new IntersectionObserver((observed) => {
            for (const item of observed) {
                if (!item.isIntersecting) continue;
                const card = item.target;
                if (!card._drawn) {
                    drawPlanView(card._canvas, card._summary, {overlay: this.overlayTracks, lineWidth: 1.5});
                    card._drawn = true;
                }
                this._thumbObserver.unobserve(card);
            }
        }, {root: this._scroll, rootMargin: "200px"});
    }

    _makeCard(entry) {
        const card = document.createElement("div");
        card._key = entry.key;
        // Read by the rubber band to tell a card from the empty space between
        // cards — a mousedown on a card is a click, on the gap it starts a band.
        card.dataset.trackCard = "1";
        card._summary = entry.summary;
        card._drawn = false;
        Object.assign(card.style, {
            backgroundColor: "#22222e", border: "2px solid #2f2f42",
            borderRadius: "8px", padding: "8px", cursor: "pointer",
            display: "flex", flexDirection: "column", gap: "6px", overflow: "hidden",
        });

        const canvas = document.createElement("canvas");
        card._canvas = canvas;
        Object.assign(canvas.style, {
            width: "100%", aspectRatio: "4/3", backgroundColor: "#12121c",
            borderRadius: "4px", display: "block",
        });
        card.appendChild(canvas);

        const label = document.createElement("div");
        Object.assign(label.style, {
            fontSize: "11px", color: "#ccc", lineHeight: "1.35",
            wordBreak: "break-all", maxHeight: "2.7em", overflow: "hidden",
        });
        label.textContent = entry.name;
        const fullPath = this._fullPath(entry);
        label.title = fullPath;
        card.title = fullPath;
        card.appendChild(label);

        const meta = document.createElement("div");
        Object.assign(meta.style, {fontSize: "10px", color: "#7a7a94"});
        meta.textContent = `${entry.summary.trackCount} tracks · `
            + `${formatDistance(entry.summary.spanM)} · ${formatDuration(entry.summary.durationS)}`;
        card.appendChild(meta);

        card.addEventListener("click", (e) => this._handleCardClick(e, entry.key));
        card.addEventListener("dblclick", (e) => {
            this._handleCardClick(e, entry.key);
            this.importSelected();
        });
        return card;
    }

    /**
     * Click, shift-click and cmd/ctrl-click, the same three gestures the sitch
     * browser uses — a folder of scenarios is picked over the same way a folder
     * of sitches is, and a second convention here would be a second thing to
     * learn for no gain.
     */
    _handleCardClick(e, key) {
        const index = this.filtered.findIndex(entry => entry.key === key);
        if (index < 0) return;

        if (e.metaKey || e.ctrlKey) {
            if (this.selection.has(key)) this.selection.delete(key);
            else this.selection.add(key);
            this._lastClickedIndex = index;
        } else if (e.shiftKey && this._lastClickedIndex >= 0) {
            // Extends rather than replaces, so several shift-ranges can be built up.
            const start = Math.min(this._lastClickedIndex, index);
            const end = Math.max(this._lastClickedIndex, index);
            for (let i = start; i <= end; i++) this.selection.add(this.filtered[i].key);
        } else {
            this.selection.clear();
            this.selection.add(key);
            this._lastClickedIndex = index;
        }

        this.selectedKey = key;
        this._updateHighlights();
        this.updatePreview();
    }

    /** Focus and select exactly one entry — keyboard nav and the post-scan default. */
    select(key) {
        this.selectedKey = key;
        this.selection.clear();
        if (key) this.selection.add(key);
        this._lastClickedIndex = this.filtered.findIndex(entry => entry.key === key);
        this._updateHighlights();
        this.updatePreview();
    }

    /**
     * Enable each action for exactly the selections it can act on.
     *
     * "Open as New Sitch" is deliberately single-file (see openAsNewSitch), so it
     * goes dead on a multi-selection rather than silently acting on one of them.
     */
    _refreshActionButtons() {
        if (!this._importBtn) return;
        const count = this.selection.size;
        this._setButtonDisabled(this._importBtn, count === 0);
        this._importBtn.textContent = count > 1 ? `Import ${count}` : "Import";
        this._setButtonDisabled(this._newSitchBtn, count !== 1);
        const analysable = this.filtered
            .filter(e => this.selection.has(e.key) && botBenchExplicitFileRole(e.name)).length;
        this._setButtonDisabled(this._botBenchBtn, analysable === 0);
        this._botBenchBtn.textContent = analysable > 1
            ? `Open ${analysable} in BOTBench`
            : "Open in BOTBench";
    }

    _updateHighlights() {
        for (const card of this._grid?.children ?? []) {
            if (!card._key) continue;
            const selected = this.selection.has(card._key);
            const focused = card._key === this.selectedKey;
            // Selected members share the fill; the focused one additionally gets
            // the bright border, so "which of these is the preview showing" stays
            // answerable inside a large selection.
            card.style.borderColor = focused ? "#8ab4f8" : (selected ? "#4d6fa8" : "#2f2f42");
            card.style.backgroundColor = selected ? "#2b2b40" : "#22222e";
        }
        this._refreshActionButtons();
    }

    // ==================== PREVIEW ====================

    updatePreview() {
        if (!this._previewName) return;
        const entry = this.filtered.find(e => e.key === this.selectedKey);
        if (!entry) {
            this._previewName.textContent = "";
            this._previewPath.textContent = "Select a file to preview it.";
            this._previewLegend.innerHTML = "";
            this._previewStats.innerHTML = "";
            this._refreshActionButtons();
            this._drawPreview();
            return;
        }

        const summary = entry.summary;
        this._previewName.textContent = entry.name;
        this._previewPath.textContent = entry.relativePath;
        this._previewPath.title = this._fullPath(entry);
        this._refreshActionButtons();

        this._previewLegend.innerHTML = "";
        for (const track of summary.tracks) {
            const row = document.createElement("div");
            Object.assign(row.style, {display: "flex", alignItems: "center", gap: "8px"});

            const swatch = document.createElement("span");
            Object.assign(swatch.style, {
                width: "14px", height: "3px", borderRadius: "2px",
                backgroundColor: trackColor(track), flex: "0 0 auto",
            });
            row.appendChild(swatch);

            const name = document.createElement("span");
            name.style.color = "#ddd";
            name.textContent = track.name;
            row.appendChild(name);

            const tag = document.createElement("span");
            Object.assign(tag.style, {color: "#7a7a94", fontSize: "12px"});
            const bits = [];
            if (track.isTruth) bits.push("ground truth");
            else if (track.role) bits.push(track.role);
            bits.push(`${track.samples} pts`);
            if (track.altMinM !== null) {
                bits.push(track.altMaxM - track.altMinM < 1
                    ? `${Math.round(track.altMinM)} m alt`
                    : `${Math.round(track.altMinM)}–${Math.round(track.altMaxM)} m alt`);
            }
            tag.textContent = bits.join(" · ");
            row.appendChild(tag);

            this._previewLegend.appendChild(row);
        }

        const stat = (label, value) => `<div><span style="color:#7a7a94">${label}:</span> ${value}</div>`;
        this._previewStats.innerHTML =
            stat("Extent", formatDistance(summary.spanM))
            + stat("Duration", formatDuration(summary.durationS))
            + stat("Origin", `${summary.originLat.toFixed(5)}, ${summary.originLon.toFixed(5)}`)
            + (this.overlayTracks
                ? `<div style="color:#7a7a94;font-size:12px;margin-top:6px">`
                    + `Tracks are overlaid — sizes are to scale, the distance between them is `
                    + `not. Turn off "Overlay tracks" to see the true geometry.</div>`
                : "");

        this._drawPreview();
    }

    _drawPreview() {
        if (!this._previewCanvas) return;
        const entry = this.filtered.find(e => e.key === this.selectedKey);
        drawPlanView(this._previewCanvas, entry?.summary ?? null,
            {overlay: this.overlayTracks, lineWidth: 2.5, padding: 24});
    }

    // ==================== CONTROL STATE ====================

    /**
     * Columns actually rendered. The slider states a count for the SPLIT layout;
     * with the preview hidden the grid has the whole window, so it takes double —
     * which is the point of turning the split off.
     */
    _effectiveColumns() {
        return this.splitView ? this.thumbColumns : this.thumbColumns * 2;
    }

    /** Show or hide the preview half and re-flow the grid to match. */
    _applyLayout() {
        if (this._previewPane) this._previewPane.style.display = this.splitView ? "flex" : "none";
        if (this._grid) this._grid.style.gridTemplateColumns = `repeat(${this._effectiveColumns()}, 1fr)`;
        if (this._colLabel) this._colLabel.textContent = `Columns: ${this._effectiveColumns()}`;
    }

    _refreshControls() {
        if (!this._chooseBtn) return;
        this._setButtonDisabled(this._chooseBtn, this.scanning);
        this._setButtonDisabled(this._rescanBtn, this.scanning || !this.directoryHandle);
        this._stopBtn.style.display = this.scanning ? "" : "none";
        this._folderLabel.textContent = this.directoryHandle
            ? `Folder: ${this.folderName}`
            : "No folder chosen";
    }

    _setStatus(text) {
        if (this._status) this._status.textContent = text;
    }

    _onKeyDown(e) {
        if (!this.overlay) return;
        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            this.close();
            return;
        }
        // Select-all, the same binding the sitch browser uses. Skipped while the
        // filter box has focus, where it means "select the text".
        if (e.key === "a" && (e.metaKey || e.ctrlKey) && document.activeElement !== this._searchInput) {
            e.preventDefault();
            e.stopPropagation();
            this.selection = new Set(this.filtered.map(entry => entry.key));
            if (!this.selectedKey && this.filtered.length) this.selectedKey = this.filtered[0].key;
            this._updateHighlights();
            this.updatePreview();
            return;
        }

        // Arrow keys move the focus through the grid, but only when the user is
        // not typing in the filter box — where they mean "move the caret".
        if (document.activeElement === this._searchInput && e.key !== "Enter") return;
        if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            this.importSelected();
            return;
        }
        const columns = this._effectiveColumns();
        const step = {ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns}[e.key];
        if (step === undefined || !this.filtered.length) return;
        e.preventDefault();
        e.stopPropagation();
        const current = this.filtered.findIndex(entry => entry.key === this.selectedKey);
        const next = Math.max(0, Math.min(this.filtered.length - 1, (current < 0 ? 0 : current + step)));
        this.select(this.filtered[next].key);
        this._grid.children[next]?.scrollIntoView({block: "nearest"});
    }

    close() {
        // Abandons any scan in flight: the loop checks the token every file.
        this._scanToken++;
        this.scanning = false;
        this._destroyThumbObserver();
        this._resizeObserver?.disconnect();
        this._resizeObserver = null;
        if (this._keyHandler) {
            document.removeEventListener("keydown", this._keyHandler, true);
            this._keyHandler = null;
        }
        this.overlay?.remove();
        this.overlay = null;
        this._grid = null;
        this._previewPane = null;
        this._previewName = null;
        this._chooseBtn = null;
    }

    _destroyThumbObserver() {
        this._thumbObserver?.disconnect();
        this._thumbObserver = null;
    }

    /**
     * Drag a box across empty grid space to select every card it touches.
     *
     * Ported from CSitchBrowser's band, including the two behaviours that are not
     * obvious: holding shift/cmd ADDS to the existing selection instead of
     * replacing it, and a press that never moves is treated as a click on empty
     * space, which clears the selection.
     *
     * Coordinates are kept in the scroll container's own space (client rect plus
     * scrollTop) so a band stays anchored to the cards while the list auto-scrolls
     * under it.
     */
    _initRubberBand(scrollContainer) {
        scrollContainer.style.position = "relative";

        scrollContainer.addEventListener("mousedown", (e) => {
            if (e.button !== 0) return;
            if (e.target.closest("[data-track-card]")) return;
            e.preventDefault();

            const contRect = scrollContainer.getBoundingClientRect();
            const startX = e.clientX - contRect.left + scrollContainer.scrollLeft;
            const startY = e.clientY - contRect.top + scrollContainer.scrollTop;

            const additive = e.shiftKey || e.metaKey || e.ctrlKey;
            const priorSelection = additive ? new Set(this.selection) : new Set();
            if (!additive) {
                this.selection.clear();
                this._updateHighlights();
            }

            const bandEl = document.createElement("div");
            Object.assign(bandEl.style, {
                position: "absolute", backgroundColor: "rgba(138,180,248,0.15)",
                border: "1px solid #8ab4f8", pointerEvents: "none", zIndex: "1",
            });
            scrollContainer.appendChild(bandEl);

            let moved = false;

            const onMouseMove = (me) => {
                moved = true;
                const cx = me.clientX - contRect.left + scrollContainer.scrollLeft;
                const cy = me.clientY - contRect.top + scrollContainer.scrollTop;
                const bx = Math.min(startX, cx), by = Math.min(startY, cy);
                const bw = Math.abs(cx - startX), bh = Math.abs(cy - startY);
                Object.assign(bandEl.style,
                    {left: bx + "px", top: by + "px", width: bw + "px", height: bh + "px"});

                const edge = 40;
                if (me.clientY < contRect.top + edge) scrollContainer.scrollTop -= 12;
                else if (me.clientY > contRect.bottom - edge) scrollContainer.scrollTop += 12;

                this.selection = new Set(priorSelection);
                for (const card of this._grid?.children ?? []) {
                    if (!card.dataset.trackCard) continue;
                    const cr = card.getBoundingClientRect();
                    const cardX = cr.left - contRect.left + scrollContainer.scrollLeft;
                    const cardY = cr.top - contRect.top + scrollContainer.scrollTop;
                    const hit = !(cardX + cr.width < bx || cardX > bx + bw
                        || cardY + cr.height < by || cardY > by + bh);
                    if (hit) this.selection.add(card._key);
                }
                this._updateHighlights();
            };

            const onMouseUp = () => {
                document.removeEventListener("mousemove", onMouseMove);
                document.removeEventListener("mouseup", onMouseUp);
                bandEl.remove();
                if (!moved && !additive) {
                    this.selection.clear();
                    this.selectedKey = null;
                    this._updateHighlights();
                    this.updatePreview();
                }
            };

            document.addEventListener("mousemove", onMouseMove);
            document.addEventListener("mouseup", onMouseUp);
        });
    }

    // ==================== SMALL WIDGETS ====================

    _makeButton(text, color) {
        const button = document.createElement("button");
        button.textContent = text;
        Object.assign(button.style, {
            padding: "7px 14px", backgroundColor: color, color: "#fff",
            border: "none", borderRadius: "5px", cursor: "pointer",
            fontSize: "13px", whiteSpace: "nowrap",
        });
        return button;
    }

    _setButtonDisabled(button, disabled) {
        if (!button) return;
        button.disabled = disabled;
        button.style.opacity = disabled ? "0.45" : "1";
        button.style.cursor = disabled ? "default" : "pointer";
    }

    /**
     * Legend for the track colors, sized to sit inline in the title bar.
     *
     * Only the three ROLE colors are named. The roleless palette is deliberately
     * left out: its entries mean "a track this format does not label", so naming
     * each one would imply a meaning none of them has — the swatch there says
     * "different track", which the grid shows better than a label could.
     */
    _makeColorKey() {
        const key = document.createElement("div");
        Object.assign(key.style, {
            display: "flex", gap: "14px", alignItems: "center", flexWrap: "wrap",
            flex: "1", minWidth: "0", justifyContent: "center",
            fontSize: "12px", fontWeight: "400", color: "#9a9ab0",
        });
        const entries = [
            [TRACK_COLORS.camera, "Platform / camera"],
            [TRACK_COLORS.truth, "Ground truth"],
            [TRACK_COLORS.target, "Target"],
            [ROLELESS_COLORS[0], "Unlabelled"],
        ];
        for (const [color, text] of entries) {
            const item = document.createElement("div");
            Object.assign(item.style, {display: "flex", gap: "6px", alignItems: "center", whiteSpace: "nowrap"});
            const swatch = document.createElement("span");
            Object.assign(swatch.style, {
                width: "16px", height: "3px", borderRadius: "2px",
                backgroundColor: color, flex: "0 0 auto",
            });
            item.appendChild(swatch);
            item.appendChild(document.createTextNode(text));
            key.appendChild(item);
        }
        return key;
    }

    _makeLabel(text) {
        const label = document.createElement("div");
        Object.assign(label.style, {fontSize: "12px", color: "#888", whiteSpace: "nowrap"});
        label.textContent = text;
        return label;
    }

    _makeCheckbox(text, checked, onChange) {
        const label = document.createElement("label");
        Object.assign(label.style, {
            display: "flex", alignItems: "center", gap: "6px",
            fontSize: "12px", color: "#ccc", cursor: "pointer", whiteSpace: "nowrap",
        });
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = checked;
        box.style.accentColor = "#8ab4f8";
        box.addEventListener("change", () => onChange(box.checked));
        label.appendChild(box);
        label.appendChild(document.createTextNode(text));
        return label;
    }

    _makeSelect(options, value, onChange) {
        const select = document.createElement("select");
        Object.assign(select.style, {
            backgroundColor: "#2a2a3e", color: "#e0e0e0", border: "1px solid #444",
            borderRadius: "4px", padding: "4px 8px", fontSize: "12px",
        });
        for (const [optionValue, label] of options) {
            const option = document.createElement("option");
            option.value = optionValue;
            option.textContent = label;
            if (optionValue === value) option.selected = true;
            select.appendChild(option);
        }
        select.addEventListener("change", () => onChange(select.value));
        return select;
    }
}

let trackBrowserController = null;

/**
 * Add "Browse Track Folder..." to the File Analysis folder, alongside the FMV
 * timing analyser and BOTBench. Idempotent; the folder is created by
 * addFileAnalysisMenu.
 *
 * It belongs with those two rather than beside File > Import because it answers
 * the same question they do — "what is in this folder?" — over the same kind of
 * bulk local scan. Import assumes the user already knows which file they want.
 *
 * Hidden entirely without a directory picker: the whole tool is a folder walk,
 * so on a browser that cannot pick a folder there is nothing for it to do.
 */
export function addTrackBrowserMenu(fileAnalysisFolder) {
    if (!fileAnalysisFolder || trackBrowserController) return trackBrowserController;
    if (!supportsDirectoryPicker()) return null;
    trackBrowserController = fileAnalysisFolder
        .add({browseTracks: () => FileManager.browseTrackFolder()}, "browseTracks")
        .name(t("file.browseTracks.label"))
        .tooltip(t("file.browseTracks.tooltip"))
        .perm();
    return trackBrowserController;
}
