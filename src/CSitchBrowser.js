/**
 * S3 Sitch Browser - full-screen dialog for browsing saved sitches.
 * Supports list+preview and thumbnail grid modes.
 * Labels system with permanent Featured/Private/Deleted labels.
 * Multi-selection: click, shift-click, cmd-click, rubber-band drag.
 * Right-click context menu with label checkboxes.
 */
import {isAdmin, SITREC_APP, SITREC_SERVER} from "./configUtils";
import {getEffectiveUserID, Globals, NodeMan, setNewSitchObject, SitchMan, withTestUser} from "./Globals";
import {DragDropHandler} from "./DragDropHandler";
import {extractWarGovPRCode} from "./WarGovUFOUtils";

const LABEL_COLORS = [
    "#4285f4", "#34a853", "#fbbc04", "#24c1e0",
    "#e8710a", "#f538a0", "#9334e6", "#1a73e8",
];

const PERMANENT_LABELS = [
    {name: "Featured", color: "#f9ab00", permanent: true, global: true},
    {name: "Private", color: "#a142f4", permanent: true},
    {name: "Deleted", color: "#ea4335", permanent: true},
];

// Sentinel "selectedKey" for the synthetic war.gov PR action tile. Real sitch
// keys are "<ownerUserID>:<name>", so this colon-less control string can never
// collide. It is used for focus/highlight only — never added to this.selection.
const WARGOV_PR_KEY = "__wargov_pr_tile__";

export class CSitchBrowser {
    constructor(fileManager) {
        this.fileManager = fileManager;
        this.sitches = [];      // [{key, name, date, screenshotUrl, ownerUserID?, featuredOnly?}]
        this.sitchesByKey = new Map();
        this.filtered = [];
        this.sortColumn = "date";
        this.sortAsc = false;
        this.searchText = "";
        this.selectedKey = null; // focused item (for preview, keyboard nav)
        this.overlay = null;
        this.viewMode = "thumbnails";
        this.thumbColumns = 4;
        this._thumbObserver = null;
        this._thumbCardOffset = 0; // leading synthetic cards (e.g. war.gov PR tile) in the grid
        this._warGovPRCode = null; // current PR code shown by the synthetic tile, or null

        // Labels
        this.userLabels = [];    // [{name, color, permanent?}, ...]
        this.sitchLabels = {};   // {sitchName: [labelName, ...]}
        this.featuredSitches = new Map(); // key -> {name, userID, screenshotUrl} (global, shared)
        this.activeLabel = null; // sidebar filter, or null = All

        // Multi-selection
        this.selection = new Set();
        this._lastClickedIndex = -1;

        // Context menu
        this._contextMenu = null;
        this._contextMenuCloser = null;

        // When true, open() will be called soon — other code should skip redundant fetches.
        this.pendingOpen = false;
        this._featuredFetchPromise = null;
        this.hideCancelButton = false;
    }

    open(options = {}) {
        if (this.overlay) return;
        this.pendingOpen = false;
        this.hideCancelButton = !!options.hideCancelButton;
        this.fetchFromServer();
    }

    // ==================== DATA ====================

    _isLoggedIn() {
        return getEffectiveUserID() > 0;
    }

    _canManageFeatured() {
        return this._isLoggedIn() && isAdmin();
    }

    _makeSitchKey(name, ownerUserID) {
        return `${ownerUserID || 0}:${name}`;
    }

    _reindexSitches() {
        this.sitchesByKey = new Map(this.sitches.map(s => [s.key, s]));
    }

    _getSitch(sitchOrKey) {
        if (!sitchOrKey) return null;
        if (typeof sitchOrKey === "string") {
            return this.sitchesByKey.get(sitchOrKey) || null;
        }
        return sitchOrKey;
    }

    _isOwnSitch(sitchOrKey) {
        const sitch = this._getSitch(sitchOrKey);
        return !!sitch && sitch.ownerUserID === getEffectiveUserID();
    }

    _cloneFeaturedSitches(map = this.featuredSitches) {
        return new Map([...map.entries()].map(([key, info]) => [key, {...info}]));
    }

    _setFeaturedSitchesFromArray(featuredArr) {
        this.featuredSitches = new Map();
        const entries = Array.isArray(featuredArr) ? featuredArr : [];
        for (const entry of entries) {
            if (entry && entry.name && entry.userID) {
                const key = this._makeSitchKey(entry.name, entry.userID);
                this.featuredSitches.set(key, {
                    name: entry.name,
                    userID: entry.userID,
                    screenshotUrl: entry.screenshotUrl || null,
                });
            }
        }
    }

    _syncFeaturedSitchesIntoList() {
        const byKey = new Map(this.sitches.map(s => [s.key, s]));

        for (const [sitchKey, info] of this.featuredSitches) {
            if (!byKey.has(sitchKey)) {
                const featuredOnlySitch = {
                    key: sitchKey,
                    name: info.name,
                    date: "",
                    screenshotUrl: info.screenshotUrl || null,
                    ownerUserID: info.userID,
                    featuredOnly: true,
                };
                this.sitches.push(featuredOnlySitch);
                byKey.set(sitchKey, featuredOnlySitch);
                continue;
            }

            const existing = byKey.get(sitchKey);
            existing.ownerUserID = info.userID;
            if (!existing.screenshotUrl && info.screenshotUrl) {
                existing.screenshotUrl = info.screenshotUrl;
            }
        }

        this.sitches = this.sitches.filter(s => !s.featuredOnly || this.featuredSitches.has(s.key));
        this._reindexSitches();
    }

    _refreshFeaturedState() {
        this._syncFeaturedSitchesIntoList();
        this.applyFilterAndSort();
        this._rebuildSidebar();
        if (this.overlay) {
            this.rebuildContent();
        }
    }

    _fetchFeaturedData() {
        if (this._featuredFetchPromise) {
            return this._featuredFetchPromise;
        }

        const request = fetch(SITREC_SERVER + "metadata.php?featured=1", {mode: "cors"})
            .then(r => r.ok ? r.json() : Promise.reject(new Error(`featured reload returned ${r.status}`)))
            .finally(() => {
                if (this._featuredFetchPromise === request) {
                    this._featuredFetchPromise = null;
                }
            });

        this._featuredFetchPromise = request;
        return request;
    }

    _reloadFeaturedFromServer(fallbackFeatured = null) {
        // Skip if open() is about to fetch everything
        if (this.pendingOpen) return Promise.resolve();
        return this._fetchFeaturedData()
            .then(featuredData => {
                this._setFeaturedSitchesFromArray(featuredData.sitches);
                this._refreshFeaturedState();
            })
            .catch(err => {
                console.error("Failed to reload featured:", err);
                if (fallbackFeatured) {
                    this.featuredSitches = this._cloneFeaturedSitches(fallbackFeatured);
                    this._refreshFeaturedState();
                }
            });
    }

    fetchFromServer() {
        const loggedIn = this._isLoggedIn();

        // Always fetch featured (no auth required)
        const featuredP = this._fetchFeaturedData()
            .catch(() => ({sitches: []}));

        // Only fetch user sitches and metadata if logged in
        const sitchesP = loggedIn
            ? fetch(withTestUser(SITREC_SERVER + "getsitches.php?get=myfiles"), {mode: 'cors'})
                .then(r => { if (r.status !== 200) throw new Error(`Server ${r.status}`); return r.json(); })
            : Promise.resolve([]);
        const metaP = loggedIn
            ? fetch(withTestUser(SITREC_SERVER + "metadata.php"), {mode: 'cors'})
                .then(r => r.ok ? r.json() : {labels: [], sitchLabels: {}})
                .catch(() => ({labels: [], sitchLabels: {}}))
            : Promise.resolve({labels: [], sitchLabels: {}});

        Promise.all([sitchesP, metaP, featuredP])
            .then(([sitchData, metaData, featuredData]) => {
                const ssVersions = metaData.screenshotVersions || {};
                this.sitches = sitchData.map(e => {
                    let screenshotUrl = e[2] || null;
                    const name = String(e[0]);
                    const ownerUserID = getEffectiveUserID();
                    const ver = ssVersions[name];
                    if (screenshotUrl && ver) {
                        screenshotUrl += (screenshotUrl.includes("?") ? "&" : "?") + "v=" + ver;
                    }
                    return {
                        key: this._makeSitchKey(name, ownerUserID),
                        name,
                        date: String(e[1]),
                        screenshotUrl,
                        ownerUserID,
                        featuredOnly: false,
                    };
                });
                this.userLabels = metaData.labels || [];
                const sl = metaData.sitchLabels || {};
                this.sitchLabels = Array.isArray(sl) ? {} : sl;

                this._setFeaturedSitchesFromArray(featuredData.sitches);

                this._syncFeaturedSitchesIntoList();

                // Non-logged-in users only see featured sitches
                if (!loggedIn) {
                    this.activeLabel = "Featured";
                }

                this._ensurePermanentLabels();
                this.applyFilterAndSort();

                // Share sitch list with FileManager so it doesn't need a separate fetch
                if (this.fileManager && loggedIn) {
                    const ownNames = [...new Set(this.sitches
                        .filter(s => this._isOwnSitch(s) && !s.featuredOnly)
                        .map(s => s.name))];
                    this.fileManager.userSaves = ["-", ...ownNames];
                    this.fileManager.refreshVersions();
                }

                this.show();
            })
            .catch(err => {
                console.error("CSitchBrowser fetch error:", err);
                this.sitches = [];
                this._ensurePermanentLabels();
                this.applyFilterAndSort();
                this.show();
            });
    }

    _ensurePermanentLabels() {
        for (const pl of PERMANENT_LABELS) {
            if (!this.userLabels.some(l => l.name === pl.name)) {
                this.userLabels.unshift({...pl});
            } else {
                // Mark existing as permanent
                const existing = this.userLabels.find(l => l.name === pl.name);
                existing.permanent = true;
                existing.color = pl.color;
            }
        }
    }

    _isPermanentLabel(name) {
        return PERMANENT_LABELS.some(l => l.name === name);
    }

    _sitchHasLabel(sitchOrKey, labelName) {
        const sitch = this._getSitch(sitchOrKey);
        if (!sitch) return false;
        if (labelName === "Featured") return this.featuredSitches.has(sitch.key);
        if (!this._isOwnSitch(sitch)) return false;
        return this.sitchLabels[sitch.name]?.includes(labelName) ?? false;
    }

    _isFeatured(sitchOrKey) {
        const sitch = this._getSitch(sitchOrKey);
        return !!sitch && this.featuredSitches.has(sitch.key);
    }

    _loadSitch(sitchKey) {
        const sitchInfo = this._getSitch(sitchKey);
        if (!sitchInfo) return;
        // If sitch is featured and belongs to another user, pass sourceUserID so
        // getVersions fetches from the owner's directory.
        const ownerID = sitchInfo.ownerUserID;
        const sourceUserID = (ownerID && ownerID !== getEffectiveUserID()) ? ownerID : null;
        this.fileManager.loadSavedFile(sitchInfo.name, sourceUserID);
    }

    // ==================== FILTER / SORT ====================

    applyFilterAndSort() {
        let list = this.sitches;

        if (this.activeLabel === "Deleted") {
            list = list.filter(s => this._sitchHasLabel(s, "Deleted"));
        } else if (this.activeLabel === "Private") {
            list = list.filter(s =>
                this._sitchHasLabel(s, "Private") && !this._sitchHasLabel(s, "Deleted"));
        } else if (this.activeLabel === "Featured") {
            // Featured view: has Featured, not Deleted, not Private
            list = list.filter(s => {
                if (this._sitchHasLabel(s, "Deleted")) return false;
                if (this._sitchHasLabel(s, "Private")) return false;
                return this._isFeatured(s);
            });
        } else if (this.activeLabel === "Unlabeled") {
            // Unlabeled view: no labels at all (not Featured, Private, Deleted, or any custom label)
            list = list.filter(s => {
                if (this._sitchHasLabel(s, "Deleted")) return false;
                if (this._sitchHasLabel(s, "Private")) return false;
                if (this._isFeatured(s)) return false;
                if (!this._isOwnSitch(s)) return true;
                const labels = this.sitchLabels[s.name];
                return !labels || labels.length === 0;
            });
        } else if (this.activeLabel) {
            // Custom label view: has label, not Deleted, not Private
            list = list.filter(s => {
                if (this._sitchHasLabel(s, "Deleted")) return false;
                if (this._sitchHasLabel(s, "Private")) return false;
                return this._sitchHasLabel(s, this.activeLabel);
            });
        } else {
            // All: exclude Deleted + Private
            list = list.filter(s =>
                !this._sitchHasLabel(s, "Deleted") && !this._sitchHasLabel(s, "Private"));
        }

        if (this.searchText) {
            list = list.filter(s => this._matchesSearch(s.name, this.searchText));
        }

        list = [...list];
        list.sort((a, b) => {
            const cmp = this.sortColumn === "name"
                ? a.name.localeCompare(b.name)
                : a.date.localeCompare(b.date);
            return this.sortAsc ? cmp : -cmp;
        });
        this.filtered = list;
    }

    // ==================== SHOW (builds overlay) ====================

    show() {
        if (this.overlay) this.close();
        this.selectedKey = null;
        this.selection.clear();

        // Hide floating/sidebar menus so they don't overlap the browser
        Globals.menuBar?.hideNonBarMenus();

        const overlay = document.createElement("div");
        this.overlay = overlay;
        // Position below the menu bar so it stays accessible
        const menuBarEl = document.getElementById("menuBarBlackBar");
        const topPx = menuBarEl ? (menuBarEl.offsetTop + menuBarEl.offsetHeight) : 0;
        Object.assign(overlay.style, {
            position: "fixed", left: "0", top: topPx + "px",
            width: "100%", height: `calc(100% - ${topPx}px)`,
            backgroundColor: "rgba(0,0,0,0.85)", zIndex: "4999", display: "flex",
            fontFamily: "system-ui, -apple-system, sans-serif", color: "#e0e0e0",
        });

        // --- Sidebar ---
        const sidebar = document.createElement("div");
        this._sidebar = sidebar;
        Object.assign(sidebar.style, {
            width: "180px", minWidth: "180px", backgroundColor: "#1e1e2e",
            display: "flex", flexDirection: "column", padding: "16px",
            gap: "4px", borderRight: "1px solid #333", overflowY: "auto",
        });

        // --- New Sitch button ---
        const newSitchBtn = document.createElement("button");
        newSitchBtn.textContent = "New Sitch";
        Object.assign(newSitchBtn.style, {
            padding: "10px 16px", backgroundColor: "#2ea043", color: "#ffffff",
            border: "1px solid #3fb950", borderRadius: "6px", cursor: "pointer",
            fontSize: "14px", fontWeight: "700", marginBottom: "12px",
            letterSpacing: "0.3px",
        });
        newSitchBtn.addEventListener("mouseenter", () => { newSitchBtn.style.backgroundColor = "#3fb950"; });
        newSitchBtn.addEventListener("mouseleave", () => { newSitchBtn.style.backgroundColor = "#2ea043"; });
        newSitchBtn.addEventListener("click", () => {
            window.location = SITREC_APP + "?action=new";
        });
        sidebar.appendChild(newSitchBtn);

        const loggedIn = this._isLoggedIn();

        // All link (logged-in only)
        this._allLink = null;
        if (loggedIn) {
            this._allLink = this._makeSidebarLink("All", () => {
                this.activeLabel = null;
                this._onFilterChanged();
            }, !this.activeLabel);
            sidebar.appendChild(this._allLink);
        }

        // Featured link (always visible)
        const featuredCount = this.sitches.filter(s =>
            this._isFeatured(s) && !this._sitchHasLabel(s, "Deleted") && !this._sitchHasLabel(s, "Private")).length;
        this._featuredLink = this._makeSidebarLink(
            "Featured" + (featuredCount ? ` (${featuredCount})` : ""),
            () => { this.activeLabel = "Featured"; this._onFilterChanged(); },
            this.activeLabel === "Featured"
        );
        if (this._canManageFeatured()) this._makePermanentLinkDropTarget(this._featuredLink, "Featured");
        sidebar.appendChild(this._featuredLink);

        // Private link (logged-in only)
        this._privateLink = null;
        this._deletedLink = null;
        this._unlabeledLink = null;
        if (loggedIn) {
            const privateCount = this.sitches.filter(s =>
                this._sitchHasLabel(s, "Private") && !this._sitchHasLabel(s, "Deleted")).length;
            this._privateLink = this._makeSidebarLink(
                "Private" + (privateCount ? ` (${privateCount})` : ""),
                () => { this.activeLabel = "Private"; this._onFilterChanged(); },
                this.activeLabel === "Private"
            );
            this._makePermanentLinkDropTarget(this._privateLink, "Private");
            sidebar.appendChild(this._privateLink);

            // Deleted link (logged-in only)
            const deletedCount = this.sitches.filter(s => this._sitchHasLabel(s, "Deleted")).length;
            this._deletedLink = this._makeSidebarLink(
                "Deleted" + (deletedCount ? ` (${deletedCount})` : ""),
                () => { this.activeLabel = "Deleted"; this._onFilterChanged(); },
                this.activeLabel === "Deleted"
            );
            this._makePermanentLinkDropTarget(this._deletedLink, "Deleted");
            sidebar.appendChild(this._deletedLink);

            // Unlabeled link (logged-in only)
            const unlabeledCount = this.sitches.filter(s => {
                if (this._sitchHasLabel(s, "Deleted")) return false;
                if (this._sitchHasLabel(s, "Private")) return false;
                if (this._isFeatured(s)) return false;
                if (!this._isOwnSitch(s)) return true;
                const labels = this.sitchLabels[s.name];
                return !labels || labels.length === 0;
            }).length;
            this._unlabeledLink = this._makeSidebarLink(
                "Unlabeled" + (unlabeledCount ? ` (${unlabeledCount})` : ""),
                () => { this.activeLabel = "Unlabeled"; this._onFilterChanged(); },
                this.activeLabel === "Unlabeled"
            );
            sidebar.appendChild(this._unlabeledLink);
        }

        // View section
        const viewSection = document.createElement("div");
        viewSection.style.marginTop = "12px";
        viewSection.style.borderTop = "1px solid #333";
        viewSection.style.paddingTop = "8px";
        const viewLabel = document.createElement("div");
        Object.assign(viewLabel.style, { fontSize: "11px", color: "#666", textTransform: "uppercase", letterSpacing: "0.5px", padding: "0 12px 4px" });
        viewLabel.textContent = "View";
        viewSection.appendChild(viewLabel);
        sidebar.appendChild(viewSection);

        this._listLink = this._makeSidebarLink("List", () => { this.viewMode = "list"; this.rebuildContent(); }, this.viewMode === "list");
        this._thumbLink = this._makeSidebarLink("Thumbnails", () => { this.viewMode = "thumbnails"; this.rebuildContent(); }, this.viewMode === "thumbnails");
        sidebar.appendChild(this._listLink);
        sidebar.appendChild(this._thumbLink);

        // Labels section (logged-in only)
        this._labelsContainer = null;
        if (loggedIn) {
            this._labelsContainer = document.createElement("div");
            sidebar.appendChild(this._labelsContainer);
            this._rebuildSidebarLabels();
        }

        const spacer = document.createElement("div");
        spacer.style.flex = "1";
        sidebar.appendChild(spacer);

        if (!loggedIn && typeof this.fileManager?.loginServer === "function") {
            const loginBtn = document.createElement("button");
            loginBtn.textContent = "Login";
            Object.assign(loginBtn.style, {
                padding: "10px 16px", backgroundColor: "#8ab4f8", color: "#0b1320",
                border: "1px solid #8ab4f8", borderRadius: "6px", cursor: "pointer",
                fontSize: "14px", fontWeight: "600", marginBottom: "8px",
            });
            loginBtn.addEventListener("click", () => {
                this.close();
                this.fileManager.loginServer();
            });
            sidebar.appendChild(loginBtn);
        }

        if (!this.hideCancelButton) {
            const cancelBtn = document.createElement("button");
            cancelBtn.textContent = "Cancel";
            Object.assign(cancelBtn.style, {
                padding: "10px 16px", backgroundColor: "#333", color: "#e0e0e0",
                border: "1px solid #555", borderRadius: "6px", cursor: "pointer", fontSize: "14px",
            });
            cancelBtn.addEventListener("click", () => this.close());
            sidebar.appendChild(cancelBtn);
        }

        overlay.appendChild(sidebar);

        // --- Content area ---
        this._contentArea = document.createElement("div");
        Object.assign(this._contentArea.style, {
            flex: "1", display: "flex", overflow: "hidden", minWidth: "0",
        });
        overlay.appendChild(this._contentArea);

        document.body.appendChild(overlay);

        // Keyboard handler
        this._keyHandler = (e) => this._handleKeyDown(e);
        document.addEventListener("keydown", this._keyHandler);

        // File drag-and-drop: allow dropping files onto the sitch browser
        // to create a new custom sitch with those files
        this._setupFileDragDrop(overlay);

        this.rebuildContent();
    }

    _onFilterChanged() {
        this.selection.clear();
        this.selectedKey = null;
        this.applyFilterAndSort();
        this._rebuildSidebar();
        this.rebuildContent();
    }

    _rebuildSidebar() {
        this._rebuildSidebarLinks();
        this._rebuildSidebarLabels();
    }

    _rebuildSidebarLinks() {
        // Update All/Featured/Private/Deleted/Unlabeled link styles
        const links = [
            [this._allLink, !this.activeLabel],
            [this._featuredLink, this.activeLabel === "Featured"],
            [this._privateLink, this.activeLabel === "Private"],
            [this._deletedLink, this.activeLabel === "Deleted"],
            [this._unlabeledLink, this.activeLabel === "Unlabeled"],
            [this._listLink, this.viewMode === "list"],
            [this._thumbLink, this.viewMode === "thumbnails"],
        ];
        for (const [el, active] of links) {
            if (!el) continue;
            el.style.color = active ? "#e0e0e0" : "#8ab4f8";
            el.style.backgroundColor = active ? "#2a2a3e" : "transparent";
        }

        // Update counts
        if (this._featuredLink) {
            const c = this.sitches.filter(s =>
                this._isFeatured(s) && !this._sitchHasLabel(s, "Deleted") && !this._sitchHasLabel(s, "Private")).length;
            this._featuredLink.textContent = "Featured" + (c ? ` (${c})` : "");
        }
        if (this._privateLink) {
            const c = this.sitches.filter(s =>
                this._sitchHasLabel(s, "Private") && !this._sitchHasLabel(s, "Deleted")).length;
            this._privateLink.textContent = "Private" + (c ? ` (${c})` : "");
        }
        if (this._deletedLink) {
            const c = this.sitches.filter(s => this._sitchHasLabel(s, "Deleted")).length;
            this._deletedLink.textContent = "Deleted" + (c ? ` (${c})` : "");
        }
        if (this._unlabeledLink) {
            const c = this.sitches.filter(s => {
                if (this._sitchHasLabel(s, "Deleted")) return false;
                if (this._sitchHasLabel(s, "Private")) return false;
                if (this._isFeatured(s)) return false;
                if (!this._isOwnSitch(s)) return true;
                const labels = this.sitchLabels[s.name];
                return !labels || labels.length === 0;
            }).length;
            this._unlabeledLink.textContent = "Unlabeled" + (c ? ` (${c})` : "");
        }
    }

    // ==================== SIDEBAR LABELS ====================

    _rebuildSidebarLabels() {
        const container = this._labelsContainer;
        if (!container) return;
        container.innerHTML = "";

        const section = document.createElement("div");
        section.style.marginTop = "12px";
        section.style.borderTop = "1px solid #333";
        section.style.paddingTop = "8px";
        const header = document.createElement("div");
        Object.assign(header.style, { fontSize: "11px", color: "#666", textTransform: "uppercase", letterSpacing: "0.5px", padding: "0 12px 4px" });
        header.textContent = "Labels";
        section.appendChild(header);
        container.appendChild(section);

        // Only show non-permanent labels in the labels section
        const userOnlyLabels = this.userLabels.filter(l => !l.permanent);

        for (const label of userOnlyLabels) {
            const row = document.createElement("div");
            Object.assign(row.style, {
                display: "flex", alignItems: "center", gap: "6px",
                padding: "5px 12px", borderRadius: "6px", cursor: "pointer",
                backgroundColor: (this.activeLabel === label.name) ? "#2a2a3e" : "transparent",
            });

            const dot = document.createElement("div");
            Object.assign(dot.style, {
                width: "10px", height: "10px", borderRadius: "50%",
                backgroundColor: label.color, flexShrink: "0",
            });
            row.appendChild(dot);

            const nameSpan = document.createElement("span");
            Object.assign(nameSpan.style, {
                fontSize: "13px", flex: "1", overflow: "hidden",
                textOverflow: "ellipsis", whiteSpace: "nowrap",
                color: (this.activeLabel === label.name) ? "#e0e0e0" : "#8ab4f8",
            });
            nameSpan.textContent = label.name;
            nameSpan.title = label.name;
            row.appendChild(nameSpan);

            const count = Object.values(this.sitchLabels).filter(arr => arr.includes(label.name)).length;
            if (count > 0) {
                const badge = document.createElement("span");
                Object.assign(badge.style, { fontSize: "10px", color: "#666", flexShrink: "0" });
                badge.textContent = String(count);
                row.appendChild(badge);
            }

            const delBtn = document.createElement("span");
            Object.assign(delBtn.style, {
                fontSize: "12px", color: "#666", cursor: "pointer", flexShrink: "0", padding: "0 2px",
            });
            delBtn.textContent = "\u00d7";
            delBtn.title = "Delete label";
            delBtn.addEventListener("mouseenter", () => delBtn.style.color = "#ea4335");
            delBtn.addEventListener("mouseleave", () => delBtn.style.color = "#666");
            delBtn.addEventListener("click", (e) => { e.stopPropagation(); this._deleteLabel(label.name); });
            row.appendChild(delBtn);

            row.addEventListener("click", () => {
                this.activeLabel = (this.activeLabel === label.name) ? null : label.name;
                this._onFilterChanged();
            });
            row.addEventListener("mouseenter", () => row.style.backgroundColor = "#2a2a3e");
            row.addEventListener("mouseleave", () => {
                row.style.backgroundColor = (this.activeLabel === label.name) ? "#2a2a3e" : "transparent";
            });

            // Drop target
            this._makeLabelDropTarget(row, label);
            container.appendChild(row);
        }

        // "Add Label" button
        const addBtn = document.createElement("button");
        addBtn.textContent = "+ Add Label";
        Object.assign(addBtn.style, {
            marginTop: "6px", padding: "5px 12px", backgroundColor: "transparent",
            color: "#8ab4f8", border: "1px dashed #444", borderRadius: "6px",
            cursor: "pointer", fontSize: "12px", width: "100%", textAlign: "left",
        });
        addBtn.addEventListener("mouseenter", () => addBtn.style.backgroundColor = "#2a2a3e");
        addBtn.addEventListener("mouseleave", () => addBtn.style.backgroundColor = "transparent");
        addBtn.addEventListener("click", () => this._promptAddLabel());

        // Register as custom-drag drop target
        this._registerDropTarget(addBtn, {
            onEnter: () => addBtn.style.backgroundColor = "#3a3a5e",
            onLeave: () => addBtn.style.backgroundColor = "transparent",
            onDrop: (names) => { addBtn.style.backgroundColor = "transparent"; if (names.length > 0) this._promptAddLabel(names); },
        });

        container.appendChild(addBtn);
    }

    _makeLabelDropTarget(element, label) {
        this._registerDropTarget(element, {
            onEnter: () => { element.style.backgroundColor = "#3a3a5e"; element.style.outline = "2px solid " + label.color; },
            onLeave: () => { element.style.backgroundColor = (this.activeLabel === label.name) ? "#2a2a3e" : "transparent"; element.style.outline = "none"; },
            onDrop: (names) => { element.style.backgroundColor = (this.activeLabel === label.name) ? "#2a2a3e" : "transparent"; element.style.outline = "none"; if (names.length > 0) this._addLabelToSitches(names, label.name); },
        });
    }

    // Also make the permanent sidebar links (Featured, Private, Deleted) drop targets
    _makePermanentLinkDropTarget(element, labelName) {
        const label = PERMANENT_LABELS.find(l => l.name === labelName);
        if (!label) return;
        this._registerDropTarget(element, {
            onEnter: () => { element.style.outline = "2px solid " + label.color; },
            onLeave: () => { element.style.outline = "none"; },
            onDrop: (names) => { element.style.outline = "none"; if (names.length > 0) this._addLabelToSitches(names, labelName); },
        });
    }

    // ==================== SELECTION ====================

    _handleItemClick(e, idx) {
        const sitch = this.filtered[idx];
        if (!sitch) return;

        if (e.metaKey || e.ctrlKey) {
            // Toggle individual
            if (this.selection.has(sitch.key)) {
                this.selection.delete(sitch.key);
            } else {
                this.selection.add(sitch.key);
            }
            this._lastClickedIndex = idx;
        } else if (e.shiftKey && this._lastClickedIndex >= 0) {
            // Range select
            const start = Math.min(this._lastClickedIndex, idx);
            const end = Math.max(this._lastClickedIndex, idx);
            // Don't clear existing selection when extending with shift
            for (let i = start; i <= end; i++) {
                if (this.filtered[i]) this.selection.add(this.filtered[i].key);
            }
        } else {
            // Single select
            this.selection.clear();
            this.selection.add(sitch.key);
            this._lastClickedIndex = idx;
        }

        this.selectedKey = sitch.key;
        this._updateHighlights();
        if (this.viewMode === "list") this.updatePreview(sitch);
    }

    _handleItemMouseDown(e, idx) {
        // Right-click (button 2) triggers context menu.
        // We use mousedown instead of contextmenu because index.js has a global
        // capture-phase contextmenu blocker that prevents our handlers from firing.
        if (e.button !== 2) return;
        e.preventDefault();
        e.stopPropagation();

        const sitch = this.filtered[idx];
        if (!sitch) return;

        // If right-clicking an unselected item, select just it
        if (!this.selection.has(sitch.key)) {
            this.selection.clear();
            this.selection.add(sitch.key);
            this.selectedKey = sitch.key;
            this._lastClickedIndex = idx;
            this._updateHighlights();
            if (this.viewMode === "list") this.updatePreview(sitch);
        }

        this._showContextMenu(e.clientX, e.clientY);
    }

    _updateHighlights() {
        const container = this.viewMode === "list" ? this._tbody : this._thumbGrid;
        if (!container) return;
        for (const child of container.children) {
            if (child._setHighlight) child._setHighlight();
        }
    }

    // ==================== KEYBOARD ====================

    _handleKeyDown(e) {
        if (e.key === "Escape") {
            this._hideContextMenu();
            this.close();
            return;
        }

        // From the search box: Down arrow moves focus into the grid and selects the
        // first tile; Enter (with nothing selected) activates the first tile directly.
        if (e.target.tagName === "INPUT") {
            if (e.key === "ArrowDown") {
                e.preventDefault();
                e.target.blur(); // so subsequent arrow keys navigate the grid
                this._selectFirstTile();
            } else if (e.key === "Enter") {
                e.preventDefault();
                this._activateKey(this.selectedKey || this._firstTileKey());
            }
            return;
        }

        if (e.key === "a" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            // Select all
            this.selection.clear();
            for (const s of this.filtered) this.selection.add(s.key);
            this._updateHighlights();
            return;
        }

        if ((e.key === "Delete" || e.key === "Backspace") && this._isLoggedIn()) {
            if (this.selection.size > 0) {
                const keys = [...this.selection];
                const allDeleted = keys.every(k => this._sitchHasLabel(k, "Deleted"));
                if (allDeleted) {
                    this._removeLabelFromSitches(keys, "Deleted");
                } else {
                    this._addLabelToSitches(keys, "Deleted");
                }
            }
            return;
        }

        const arrows = ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"];
        if (arrows.includes(e.key)) {
            e.preventDefault();

            // Navigate over raw grid positions so the synthetic war.gov tile (always
            // at position 0) folds in naturally. offset = number of leading synthetic
            // tiles; filtered[i] lives at grid position i + offset.
            const offset = this._hasSyntheticTile() ? 1 : 0;
            const total = offset + this.filtered.length;
            if (total === 0) return;

            // Current grid position from the focused key (-1 = nothing focused).
            let pos;
            if (offset && this.selectedKey === WARGOV_PR_KEY) {
                pos = 0;
            } else {
                const fi = this.filtered.findIndex(s => s.key === this.selectedKey);
                pos = fi === -1 ? -1 : fi + offset;
            }

            if (pos === -1) {
                const forward = (e.key === "ArrowDown" || e.key === "ArrowRight");
                pos = forward ? 0 : total - 1;
            } else {
                let delta;
                if (this.viewMode === "thumbnails") {
                    if (e.key === "ArrowRight") delta = 1;
                    else if (e.key === "ArrowLeft") delta = -1;
                    else if (e.key === "ArrowDown") delta = this.thumbColumns;
                    else delta = -this.thumbColumns;
                } else {
                    delta = (e.key === "ArrowDown" || e.key === "ArrowRight") ? 1 : -1;
                }
                pos = Math.max(0, Math.min(total - 1, pos + delta));
            }

            if (offset && pos === 0) {
                // Landed on the synthetic tile (single-select only; no shift ranges).
                this._selectWarGovPRCard();
            } else {
                const idx = pos - offset;
                const sitch = this.filtered[idx];
                if (!sitch) return;

                if (e.shiftKey && this.selectedKey !== WARGOV_PR_KEY) {
                    // Extend selection across real sitches only.
                    if (this._lastClickedIndex < 0) this._lastClickedIndex = idx;
                    const start = Math.min(this._lastClickedIndex, idx);
                    const end = Math.max(this._lastClickedIndex, idx);
                    this.selection.clear();
                    for (let i = start; i <= end; i++) {
                        if (this.filtered[i]) this.selection.add(this.filtered[i].key);
                    }
                } else {
                    this.selection.clear();
                    this.selection.add(sitch.key);
                    this._lastClickedIndex = idx;
                }

                this.selectedKey = sitch.key;
                if (this.viewMode === "list") this.updatePreview(sitch);
            }

            this._updateHighlights();

            // Scroll the focused grid position into view.
            const container = this.viewMode === "list" ? this._tbody : this._thumbGrid;
            if (container && container.children[pos]) {
                container.children[pos].scrollIntoView({block: "nearest"});
            }
        }

        if (e.key === "Enter") {
            this._activateKey(this.selectedKey);
        }
    }

    // ==================== CONTEXT MENU ====================

    _showContextMenu(x, y) {
        this._hideContextMenu();

        if (!this._isLoggedIn()) return;

        const menu = document.createElement("div");
        this._contextMenu = menu;
        Object.assign(menu.style, {
            position: "fixed", left: x + "px", top: y + "px",
            backgroundColor: "#2a2a3e", border: "1px solid #555",
            borderRadius: "6px", padding: "4px 0", minWidth: "200px",
            zIndex: "10010", boxShadow: "0 4px 16px rgba(0,0,0,0.6)",
            fontSize: "13px", color: "#e0e0e0",
        });

        const selectedKeys = [...this.selection];
        if (selectedKeys.length === 0) return;

        // Header showing count
        if (selectedKeys.length > 1) {
            const countDiv = document.createElement("div");
            Object.assign(countDiv.style, { padding: "4px 16px 4px", fontSize: "11px", color: "#888" });
            countDiv.textContent = `${selectedKeys.length} sitches selected`;
            menu.appendChild(countDiv);
            menu.appendChild(this._makeMenuSep());
        }

        const allDeleted = selectedKeys.every(k => this._sitchHasLabel(k, "Deleted"));
        menu.appendChild(this._makeMenuItem(allDeleted ? "Undelete" : "Delete", () => {
            if (allDeleted) this._removeLabelFromSitches(selectedKeys, "Deleted");
            else this._addLabelToSitches(selectedKeys, "Deleted");
            this._hideContextMenu();
        }));

        menu.appendChild(this._makeMenuItem("Refresh Thumbnails", () => {
            this._hideContextMenu();
            this.close();
            const ownSitchNames = selectedKeys
                .map(k => this._getSitch(k))
                .filter(s => s && this._isOwnSitch(s) && !this._sitchHasLabel(s, "Deleted"))
                .map(s => s.name);
            if (ownSitchNames.length > 0) {
                this.fileManager.refreshScreenshots(ownSitchNames);
            }
        }));

        menu.appendChild(this._makeMenuSep());

        // Label checkboxes (all labels except "Deleted" — handled by delete button)
        for (const label of this.userLabels) {
            if (label.name === "Deleted") continue;
            if (label.name === "Featured" && !this._canManageFeatured()) continue;
            const hasCount = selectedKeys.filter(k => this._sitchHasLabel(k, label.name)).length;
            const all = hasCount === selectedKeys.length;
            const none = hasCount === 0;
            const indeterminate = !all && !none;

            menu.appendChild(this._makeMenuCheckbox(label, all, indeterminate, () => {
                if (all) this._removeLabelFromSitches(selectedKeys, label.name);
                else this._addLabelToSitches(selectedKeys, label.name);
                this._hideContextMenu();
            }));
        }

        document.body.appendChild(menu);

        // Reposition if off-screen
        const mr = menu.getBoundingClientRect();
        if (mr.right > window.innerWidth) menu.style.left = Math.max(0, window.innerWidth - mr.width - 4) + "px";
        if (mr.bottom > window.innerHeight) menu.style.top = Math.max(0, window.innerHeight - mr.height - 4) + "px";

        // Close on click/scroll outside
        setTimeout(() => {
            this._contextMenuCloser = (e) => {
                if (!menu.contains(e.target)) this._hideContextMenu();
            };
            document.addEventListener("mousedown", this._contextMenuCloser);
        });
    }

    _hideContextMenu() {
        if (this._contextMenu && this._contextMenu.parentNode) {
            this._contextMenu.parentNode.removeChild(this._contextMenu);
        }
        this._contextMenu = null;
        if (this._contextMenuCloser) {
            document.removeEventListener("mousedown", this._contextMenuCloser);
            this._contextMenuCloser = null;
        }
    }

    _makeMenuItem(text, onClick) {
        const item = document.createElement("div");
        Object.assign(item.style, { padding: "6px 16px", cursor: "pointer" });
        item.textContent = text;
        item.addEventListener("mouseenter", () => item.style.backgroundColor = "#3a3a5e");
        item.addEventListener("mouseleave", () => item.style.backgroundColor = "transparent");
        item.addEventListener("click", onClick);
        return item;
    }

    _makeMenuSep() {
        const sep = document.createElement("div");
        Object.assign(sep.style, { height: "1px", backgroundColor: "#444", margin: "4px 0" });
        return sep;
    }

    _makeMenuCheckbox(label, checked, indeterminate, onClick) {
        const item = document.createElement("div");
        Object.assign(item.style, {
            padding: "5px 16px", cursor: "pointer",
            display: "flex", alignItems: "center", gap: "8px",
        });

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = checked;
        cb.indeterminate = indeterminate;
        Object.assign(cb.style, { accentColor: label.color, cursor: "pointer", margin: "0" });

        const dot = document.createElement("div");
        Object.assign(dot.style, {
            width: "8px", height: "8px", borderRadius: "50%", backgroundColor: label.color, flexShrink: "0",
        });

        const nameSpan = document.createElement("span");
        nameSpan.textContent = label.name;

        item.appendChild(cb);
        item.appendChild(dot);
        item.appendChild(nameSpan);
        item.addEventListener("mouseenter", () => item.style.backgroundColor = "#3a3a5e");
        item.addEventListener("mouseleave", () => item.style.backgroundColor = "transparent");
        item.addEventListener("click", (e) => { e.preventDefault(); onClick(); });
        return item;
    }

    // ==================== RUBBER-BAND SELECTION ====================

    _initRubberBand(scrollContainer) {
        if (this.viewMode !== "thumbnails") return;

        scrollContainer.style.position = "relative";

        scrollContainer.addEventListener("mousedown", (e) => {
            // Only left button, and only on empty space (not on a card)
            if (e.button !== 0) return;
            if (e.target.closest("[data-sitch-card]")) return;

            e.preventDefault();

            const contRect = scrollContainer.getBoundingClientRect();
            const scrollTop0 = scrollContainer.scrollTop;
            const startX = e.clientX - contRect.left + scrollContainer.scrollLeft;
            const startY = e.clientY - contRect.top + scrollTop0;

            // Snapshot selection before band if holding shift/cmd
            const priorSelection = (e.shiftKey || e.metaKey || e.ctrlKey) ? new Set(this.selection) : new Set();
            if (!e.shiftKey && !e.metaKey && !e.ctrlKey) {
                this.selection.clear();
                this._updateHighlights();
            }

            const bandEl = document.createElement("div");
            Object.assign(bandEl.style, {
                position: "absolute", backgroundColor: "rgba(66,133,244,0.15)",
                border: "1px solid #4285f4", pointerEvents: "none", zIndex: "1",
            });
            scrollContainer.appendChild(bandEl);

            let moved = false;

            const onMouseMove = (me) => {
                moved = true;
                const cx = me.clientX - contRect.left + scrollContainer.scrollLeft;
                const cy = me.clientY - contRect.top + scrollContainer.scrollTop;

                const bx = Math.min(startX, cx);
                const by = Math.min(startY, cy);
                const bw = Math.abs(cx - startX);
                const bh = Math.abs(cy - startY);
                Object.assign(bandEl.style, {
                    left: bx + "px", top: by + "px", width: bw + "px", height: bh + "px",
                });

                // Auto-scroll near edges
                const edgeThresh = 40;
                if (me.clientY < contRect.top + edgeThresh) scrollContainer.scrollTop -= 12;
                else if (me.clientY > contRect.bottom - edgeThresh) scrollContainer.scrollTop += 12;

                // Determine overlap with cards
                const grid = this._thumbGrid;
                if (!grid) return;
                this.selection = new Set(priorSelection);

                for (let i = 0; i < grid.children.length; i++) {
                    const card = grid.children[i];
                    if (!card.dataset.sitchCard) continue;
                    const cr = card.getBoundingClientRect();
                    const cardX = cr.left - contRect.left + scrollContainer.scrollLeft;
                    const cardY = cr.top - contRect.top + scrollContainer.scrollTop;
                    const overlaps = !(cardX + cr.width < bx || cardX > bx + bw ||
                        cardY + cr.height < by || cardY > by + bh);
                    const key = this.filtered[i - (this._thumbCardOffset || 0)]?.key;
                    if (key && overlaps) this.selection.add(key);
                }
                this._updateHighlights();
            };

            const onMouseUp = () => {
                document.removeEventListener("mousemove", onMouseMove);
                document.removeEventListener("mouseup", onMouseUp);
                if (bandEl.parentNode) bandEl.parentNode.removeChild(bandEl);

                // If didn't move, treat as click on empty space = deselect
                if (!moved) {
                    this.selection.clear();
                    this._updateHighlights();
                }
            };

            document.addEventListener("mousemove", onMouseMove);
            document.addEventListener("mouseup", onMouseUp);
        });
    }

    // ==================== CONTENT REBUILD ====================

    rebuildContent() {
        // Save scroll position before destroying content
        const scrollContainer = this.viewMode === "list" ? this._listScrollContainer : this._thumbScrollContainer;
        const savedScroll = scrollContainer ? scrollContainer.scrollTop : 0;

        this._destroyThumbObserver();
        this._hideContextMenu();
        this._contentArea.innerHTML = "";
        // Prune drop targets whose DOM elements were removed
        if (this._dropTargets) this._dropTargets = this._dropTargets.filter(t => document.body.contains(t.element));

        this._rebuildSidebarLinks();

        if (this.viewMode === "list") this.buildListView();
        else this.buildThumbnailView();

        // Restore scroll position after rebuilding
        const newScrollContainer = this.viewMode === "list" ? this._listScrollContainer : this._thumbScrollContainer;
        if (newScrollContainer && savedScroll > 0) {
            newScrollContainer.scrollTop = savedScroll;
        }
    }

    // ==================== LIST VIEW ====================

    buildListView() {
        const listArea = document.createElement("div");
        Object.assign(listArea.style, {
            flex: "1", display: "flex", flexDirection: "column",
            backgroundColor: "#181825", overflow: "hidden", minWidth: "0",
        });

        // Title
        const titleBar = document.createElement("div");
        Object.assign(titleBar.style, { padding: "16px 24px", fontSize: "20px", fontWeight: "600", borderBottom: "1px solid #333", display: "flex", justifyContent: "space-between", alignItems: "center" });
        titleBar.textContent = this._titleText();
        const versionLabel = document.createElement("span");
        Object.assign(versionLabel.style, { fontSize: "12px", color: "#666", fontWeight: "400" });
        versionLabel.textContent = process.env.BUILD_VERSION_STRING;
        titleBar.appendChild(versionLabel);
        listArea.appendChild(titleBar);

        // Search
        const searchBar = document.createElement("div");
        Object.assign(searchBar.style, { padding: "12px 24px", borderBottom: "1px solid #333" });
        const searchInput = this._createSearchInput(() => this.renderRows(this._tbody));
        searchBar.appendChild(searchInput);
        listArea.appendChild(searchBar);

        // Header row
        const headerRow = document.createElement("div");
        Object.assign(headerRow.style, {
            display: "flex", padding: "10px 24px", borderBottom: "2px solid #444",
            fontSize: "13px", fontWeight: "600", textTransform: "uppercase",
            letterSpacing: "0.5px", color: "#888", userSelect: "none",
        });
        const makeHdr = (text, column, flex) => {
            const cell = document.createElement("div");
            cell.style.flex = flex; cell.style.cursor = "pointer"; cell.style.padding = "4px 0";
            const update = () => {
                let arrow = "";
                if (this.sortColumn === column) arrow = this.sortAsc ? " \u25B2" : " \u25BC";
                cell.textContent = text + arrow;
            };
            update();
            cell.addEventListener("click", () => {
                if (this.sortColumn === column) this.sortAsc = !this.sortAsc;
                else { this.sortColumn = column; this.sortAsc = column === "name"; }
                this.applyFilterAndSort();
                headerRow._updateLabels();
                this.renderRows(this._tbody);
            });
            cell._updateLabel = update;
            return cell;
        };
        const nameHdr = makeHdr("Name", "name", "3");
        const dateHdr = makeHdr("Date", "date", "2");
        headerRow.appendChild(nameHdr);
        headerRow.appendChild(dateHdr);
        headerRow._updateLabels = () => { nameHdr._updateLabel(); dateHdr._updateLabel(); };
        listArea.appendChild(headerRow);

        // Scrollable list
        const listContainer = document.createElement("div");
        Object.assign(listContainer.style, { flex: "1", overflowY: "auto", padding: "0 24px" });
        this._listScrollContainer = listContainer;
        const tbody = document.createElement("div");
        this._tbody = tbody;
        this.renderRows(tbody);
        listContainer.appendChild(tbody);
        listArea.appendChild(listContainer);
        this._contentArea.appendChild(listArea);

        // Preview panel
        const preview = document.createElement("div");
        Object.assign(preview.style, {
            width: "640px", minWidth: "640px", backgroundColor: "#1e1e2e",
            borderLeft: "1px solid #333", display: "flex", flexDirection: "column",
            alignItems: "center", padding: "24px", gap: "16px",
        });

        const pTitle = document.createElement("div");
        Object.assign(pTitle.style, { fontSize: "14px", fontWeight: "600", color: "#888", textTransform: "uppercase", letterSpacing: "0.5px", alignSelf: "flex-start" });
        pTitle.textContent = "Preview";
        preview.appendChild(pTitle);

        this._previewName = document.createElement("div");
        Object.assign(this._previewName.style, { fontSize: "16px", fontWeight: "600", color: "#e0e0e0", wordBreak: "break-word", textAlign: "center" });
        preview.appendChild(this._previewName);

        this._previewImg = document.createElement("img");
        Object.assign(this._previewImg.style, { maxWidth: "100%", maxHeight: "50%", borderRadius: "6px", border: "1px solid #333", objectFit: "contain", display: "none" });
        preview.appendChild(this._previewImg);

        this._previewNoImage = document.createElement("div");
        Object.assign(this._previewNoImage.style, { width: "100%", aspectRatio: "16/9", backgroundColor: "#2a2a3e", borderRadius: "6px", border: "1px solid #333", display: "none", alignItems: "center", justifyContent: "center", color: "#555", fontSize: "13px" });
        this._previewNoImage.textContent = "No preview available";
        preview.appendChild(this._previewNoImage);

        this._previewDate = document.createElement("div");
        Object.assign(this._previewDate.style, { fontSize: "13px", color: "#888" });
        preview.appendChild(this._previewDate);

        this._previewLabels = document.createElement("div");
        preview.appendChild(this._previewLabels);

        this.updatePreview(null);
        this._contentArea.appendChild(preview);
        searchInput.focus();
    }

    updatePreview(sitch) {
        if (!this._previewName) return;
        if (!sitch) {
            this._previewName.textContent = "";
            this._previewImg.style.display = "none";
            this._previewNoImage.style.display = "none";
            this._previewDate.textContent = "Click a sitch to preview";
            if (this._previewLabels) this._previewLabels.innerHTML = "";
            return;
        }
        this._previewName.textContent = sitch.name;
        this._previewDate.textContent = sitch.date;
        if (sitch.screenshotUrl) {
            this._previewImg.src = sitch.screenshotUrl;
            this._previewImg.style.display = "block";
            this._previewNoImage.style.display = "none";
            this._previewImg.onerror = () => { this._previewImg.style.display = "none"; this._previewNoImage.style.display = "flex"; };
        } else {
            this._previewImg.style.display = "none";
            this._previewNoImage.style.display = "flex";
        }
        if (this._previewLabels) {
            this._previewLabels.innerHTML = "";
            const chips = this._makeLabelChips(sitch);
            if (chips) this._previewLabels.appendChild(chips);
        }
    }

    renderRows(tbody) {
        tbody.innerHTML = "";
        if (this.filtered.length === 0) {
            const empty = document.createElement("div");
            Object.assign(empty.style, { padding: "40px 0", textAlign: "center", color: "#666", fontSize: "14px" });
            empty.textContent = this.searchText ? "No matching sitches found." : "No saved sitches.";
            tbody.appendChild(empty);
            return;
        }
        this.filtered.forEach((sitch, idx) => {
            const row = document.createElement("div");
            Object.assign(row.style, {
                display: "flex", padding: "12px 0", borderBottom: "1px solid #2a2a3e",
                cursor: "pointer", borderRadius: "4px", alignItems: "center",
            });

            const setHighlight = () => {
                const sel = this.selection.has(sitch.key);
                row.style.backgroundColor = sel ? "#2a3a5e" : "transparent";
            };
            setHighlight();
            row.addEventListener("mouseenter", () => {
                if (!this.selection.has(sitch.key)) row.style.backgroundColor = "#2a2a3e";
            });
            row.addEventListener("mouseleave", () => setHighlight());

            this._makeDraggable(row, sitch.key);

            const nameCell = document.createElement("div");
            nameCell.style.flex = "3"; nameCell.style.fontSize = "14px";
            const nameText = document.createElement("div");
            nameText.textContent = sitch.name;
            nameCell.appendChild(nameText);
            const chips = this._makeLabelChips(sitch);
            if (chips) nameCell.appendChild(chips);

            const dateCell = document.createElement("div");
            dateCell.style.flex = "2"; dateCell.style.fontSize = "13px"; dateCell.style.color = "#888";
            dateCell.textContent = sitch.date;
            row.appendChild(nameCell);
            row.appendChild(dateCell);

            row.addEventListener("click", (e) => this._handleItemClick(e, idx));
            row.addEventListener("mousedown", (e) => this._handleItemMouseDown(e, idx));
            row.addEventListener("contextmenu", (e) => e.preventDefault());
            row.addEventListener("dblclick", () => { this.close(); this._loadSitch(sitch.key); });

            row._setHighlight = setHighlight;
            tbody.appendChild(row);
        });

        if (this.selectedKey) {
            const idx = this.filtered.findIndex(s => s.key === this.selectedKey);
            if (idx >= 0 && tbody.children[idx]) tbody.children[idx].scrollIntoView({block: "nearest"});
        }
    }

    // ==================== THUMBNAIL VIEW ====================

    buildThumbnailView() {
        const area = document.createElement("div");
        Object.assign(area.style, {
            flex: "1", display: "flex", flexDirection: "column",
            backgroundColor: "#181825", overflow: "hidden", minWidth: "0",
        });

        // Title
        const titleBar = document.createElement("div");
        Object.assign(titleBar.style, { padding: "16px 24px", fontSize: "20px", fontWeight: "600", borderBottom: "1px solid #333", display: "flex", justifyContent: "space-between", alignItems: "center" });
        titleBar.textContent = this._titleText();
        const versionLabel = document.createElement("span");
        Object.assign(versionLabel.style, { fontSize: "12px", color: "#666", fontWeight: "400" });
        versionLabel.textContent = process.env.BUILD_VERSION_STRING;
        titleBar.appendChild(versionLabel);
        area.appendChild(titleBar);

        // Search + sort + columns
        const searchBar = document.createElement("div");
        Object.assign(searchBar.style, { padding: "12px 24px", borderBottom: "1px solid #333", display: "flex", gap: "16px", alignItems: "center" });

        const searchInput = this._createSearchInput(() => this.renderThumbnails());
        searchInput.style.flex = "1";
        searchBar.appendChild(searchInput);

        // Sort
        const sortLabel = document.createElement("div");
        Object.assign(sortLabel.style, { fontSize: "12px", color: "#888", whiteSpace: "nowrap" });
        sortLabel.textContent = "Sort:";
        searchBar.appendChild(sortLabel);

        const sortSelect = document.createElement("select");
        Object.assign(sortSelect.style, { backgroundColor: "#2a2a3e", color: "#e0e0e0", border: "1px solid #444", borderRadius: "4px", padding: "4px 8px", fontSize: "12px" });
        for (const [val, label] of [["date_desc", "Date (newest)"], ["date_asc", "Date (oldest)"], ["name_asc", "Name (A-Z)"], ["name_desc", "Name (Z-A)"]]) {
            const opt = document.createElement("option");
            opt.value = val; opt.textContent = label;
            if (val === this.sortColumn + "_" + (this.sortAsc ? "asc" : "desc")) opt.selected = true;
            sortSelect.appendChild(opt);
        }
        sortSelect.addEventListener("change", () => {
            const [col, dir] = sortSelect.value.split("_");
            this.sortColumn = col; this.sortAsc = dir === "asc";
            this.applyFilterAndSort();
            this.renderThumbnails();
        });
        searchBar.appendChild(sortSelect);

        // Column slider
        const colLabel = document.createElement("div");
        Object.assign(colLabel.style, { fontSize: "12px", color: "#888", whiteSpace: "nowrap" });
        colLabel.textContent = `Columns: ${this.thumbColumns}`;
        searchBar.appendChild(colLabel);

        const colSlider = document.createElement("input");
        colSlider.type = "range"; colSlider.min = "1"; colSlider.max = "10"; colSlider.value = String(this.thumbColumns);
        Object.assign(colSlider.style, { width: "100px", accentColor: "#8ab4f8" });
        colSlider.addEventListener("input", () => {
            this.thumbColumns = parseInt(colSlider.value);
            colLabel.textContent = `Columns: ${this.thumbColumns}`;

            let selectedCard = null, offsetFromViewport = 0;
            if (this.selectedKey && this._thumbGrid) {
                const i = this.filtered.findIndex(s => s.key === this.selectedKey);
                if (i >= 0) {
                    selectedCard = this._thumbGrid.children[i + (this._thumbCardOffset || 0)];
                    if (selectedCard) {
                        offsetFromViewport = selectedCard.getBoundingClientRect().top - this._thumbScrollContainer.getBoundingClientRect().top;
                    }
                }
            }
            this._thumbGrid.style.gridTemplateColumns = `repeat(${this.thumbColumns}, 1fr)`;
            if (selectedCard) {
                const newOffset = selectedCard.getBoundingClientRect().top - this._thumbScrollContainer.getBoundingClientRect().top;
                this._thumbScrollContainer.scrollTop += (newOffset - offsetFromViewport);
            }
        });
        searchBar.appendChild(colSlider);
        area.appendChild(searchBar);

        // Scrollable grid
        const scrollContainer = document.createElement("div");
        Object.assign(scrollContainer.style, { flex: "1", overflowY: "auto", padding: "16px 24px" });
        this._thumbScrollContainer = scrollContainer;

        const grid = document.createElement("div");
        Object.assign(grid.style, {
            display: "grid",
            gridTemplateColumns: `repeat(${this.thumbColumns}, 1fr)`,
            gap: "16px",
        });
        this._thumbGrid = grid;
        this.renderThumbnails();

        scrollContainer.appendChild(grid);
        area.appendChild(scrollContainer);
        this._contentArea.appendChild(area);

        // Rubber-band selection
        this._initRubberBand(scrollContainer);

        searchInput.focus();
    }

    renderThumbnails() {
        this._destroyThumbObserver();
        this._thumbGrid.innerHTML = "";

        // If the search text looks like a war.gov UAP case code (e.g. "PR050"),
        // show a synthetic action tile as the first card. It is not a saved sitch,
        // so it carries no data-sitch-card attribute and is excluded from
        // selection/rubber-band. _thumbCardOffset keeps the positional
        // DOM-child <-> this.filtered mapping correct everywhere else.
        const prCode = extractWarGovPRCode(this.searchText);
        this._thumbCardOffset = prCode ? 1 : 0;
        this._warGovPRCode = prCode || null;
        // If the synthetic tile was focused but no longer exists, drop the focus.
        if (!prCode && this.selectedKey === WARGOV_PR_KEY) this.selectedKey = null;

        if (this.filtered.length === 0 && !prCode) {
            const empty = document.createElement("div");
            Object.assign(empty.style, { padding: "40px 0", textAlign: "center", color: "#666", fontSize: "14px", gridColumn: "1 / -1" });
            empty.textContent = this.searchText ? "No matching sitches found." : "No saved sitches.";
            this._thumbGrid.appendChild(empty);
            return;
        }

        if (prCode) {
            this._thumbGrid.appendChild(this._makeWarGovPRCard(prCode));
        }

        this._thumbObserver = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (entry.isIntersecting) {
                    const img = entry.target;
                    if (img.dataset.src) {
                        img.src = img.dataset.src;
                        delete img.dataset.src;
                        this._thumbObserver.unobserve(img);
                    }
                }
            }
        }, { root: this._thumbScrollContainer, rootMargin: "200px" });

        this.filtered.forEach((sitch, idx) => {
            const card = document.createElement("div");
            card.dataset.sitchCard = "1";
            Object.assign(card.style, {
                backgroundColor: "#1e1e2e", borderRadius: "8px",
                border: "2px solid #333", overflow: "hidden",
                cursor: "pointer", transition: "border-color 0.15s",
            });

            const setHighlight = () => {
                const sel = this.selection.has(sitch.key);
                card.style.borderColor = sel ? "#8ab4f8" : "#333";
                card.style.backgroundColor = sel ? "#252540" : "#1e1e2e";
            };
            setHighlight();

            card.addEventListener("mouseenter", () => {
                if (!this.selection.has(sitch.key)) card.style.borderColor = "#555";
            });
            card.addEventListener("mouseleave", () => setHighlight());

            this._makeDraggable(card, sitch.key);

            // Thumbnail
            const imgWrap = document.createElement("div");
            Object.assign(imgWrap.style, { width: "100%", aspectRatio: "16/9", backgroundColor: "#2a2a3e", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" });

            if (sitch.screenshotUrl) {
                const img = document.createElement("img");
                Object.assign(img.style, { width: "100%", height: "100%", objectFit: "contain", display: "block" });
                img.dataset.src = sitch.screenshotUrl;
                img.alt = sitch.name;
                img.draggable = false;
                img.onerror = () => {
                    img.style.display = "none";
                    const ph = document.createElement("div");
                    Object.assign(ph.style, { color: "#555", fontSize: "12px" });
                    ph.textContent = "No preview";
                    imgWrap.appendChild(ph);
                };
                imgWrap.appendChild(img);
                this._thumbObserver.observe(img);
            } else {
                const ph = document.createElement("div");
                Object.assign(ph.style, { color: "#555", fontSize: "12px" });
                ph.textContent = "No preview";
                imgWrap.appendChild(ph);
            }
            card.appendChild(imgWrap);

            // Info
            const info = document.createElement("div");
            Object.assign(info.style, { padding: "8px 10px" });
            const nameDiv = document.createElement("div");
            Object.assign(nameDiv.style, { fontSize: "13px", fontWeight: "600", color: "#e0e0e0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
            nameDiv.textContent = sitch.name;
            nameDiv.title = sitch.name;
            info.appendChild(nameDiv);
            const dateDiv = document.createElement("div");
            Object.assign(dateDiv.style, { fontSize: "11px", color: "#888", marginTop: "2px" });
            dateDiv.textContent = sitch.date;
            info.appendChild(dateDiv);
            const chips = this._makeLabelChips(sitch);
            if (chips) info.appendChild(chips);
            card.appendChild(info);

            card.addEventListener("click", (e) => this._handleItemClick(e, idx));
            card.addEventListener("mousedown", (e) => this._handleItemMouseDown(e, idx));
            card.addEventListener("contextmenu", (e) => e.preventDefault());
            card.addEventListener("dblclick", () => { this.close(); this._loadSitch(sitch.key); });

            card._setHighlight = setHighlight;
            this._thumbGrid.appendChild(card);
        });

        if (this.selectedKey) {
            const idx = this.filtered.findIndex(s => s.key === this.selectedKey);
            const childIdx = idx + this._thumbCardOffset;
            if (idx >= 0 && this._thumbGrid.children[childIdx]) {
                this._thumbGrid.children[childIdx].scrollIntoView({block: "nearest"});
            }
        }
    }

    // Build the synthetic "war.gov UAP record" action tile shown when the
    // search text matches a case code (e.g. "PR050"). Double-clicking it
    // behaves exactly as if the corresponding war.gov page URL was dropped.
    _makeWarGovPRCard(prCode) {
        const card = document.createElement("div");
        // Deliberately NO data-sitch-card: this is an action, not a saved sitch, so
        // it stays out of rubber-band selection, multi-select, delete and context menu.
        Object.assign(card.style, {
            backgroundColor: "#1e2e1e", borderRadius: "8px",
            border: "2px solid #3fb950", overflow: "hidden",
            cursor: "pointer", transition: "border-color 0.15s",
        });

        // Selected => blue border (matching real cards); otherwise its green theme.
        const setHighlight = () => {
            const sel = this.selectedKey === WARGOV_PR_KEY;
            card.style.borderColor = sel ? "#8ab4f8" : "#3fb950";
            card.style.backgroundColor = sel ? "#252540" : "#1e2e1e";
        };
        card._setHighlight = setHighlight;
        setHighlight();

        card.addEventListener("mouseenter", () => {
            if (this.selectedKey !== WARGOV_PR_KEY) card.style.borderColor = "#56d364";
        });
        card.addEventListener("mouseleave", () => setHighlight());
        // Single click focuses/selects the tile (blue border), like a real card.
        card.addEventListener("click", () => this._selectWarGovPRCard());

        // Thumbnail area — a themed placeholder rather than a screenshot.
        const imgWrap = document.createElement("div");
        Object.assign(imgWrap.style, { width: "100%", aspectRatio: "16/9", backgroundColor: "#11240f", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", overflow: "hidden", gap: "4px" });
        const icon = document.createElement("div");
        Object.assign(icon.style, { fontSize: "40px", lineHeight: "1" });
        icon.textContent = "🛸";
        const codeBig = document.createElement("div");
        Object.assign(codeBig.style, { fontSize: "22px", fontWeight: "700", color: "#56d364", letterSpacing: "1px" });
        codeBig.textContent = prCode;
        imgWrap.appendChild(icon);
        imgWrap.appendChild(codeBig);
        card.appendChild(imgWrap);

        // Info
        const info = document.createElement("div");
        Object.assign(info.style, { padding: "8px 10px" });
        const nameDiv = document.createElement("div");
        Object.assign(nameDiv.style, { fontSize: "13px", fontWeight: "600", color: "#e0e0e0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
        nameDiv.textContent = prCode;
        nameDiv.title = `Open war.gov UAP record ${prCode}`;
        info.appendChild(nameDiv);
        const subDiv = document.createElement("div");
        Object.assign(subDiv.style, { fontSize: "11px", color: "#7ee787", marginTop: "2px" });
        subDiv.textContent = "Open war.gov UAP record";
        info.appendChild(subDiv);
        card.appendChild(info);

        card.addEventListener("dblclick", () => this._triggerWarGovPRRecord(prCode));
        return card;
    }

    // Resolve a war.gov case code by routing the URL to the SAME handler Sitrec
    // uses for a dropped URL — keyed on the same condition the drop pipeline uses
    // (does a "video" node exist to receive the video?).
    //
    //  - A video/custom sitch is already loaded (video node exists): hand the URL
    //    straight to handleDroppedText() -> uploadURL(), exactly like dragging the
    //    URL onto the running app. No sitch reload, so no disposeEverything() and
    //    no WebGL context-loss churn. This is the path that already worked for
    //    sitch-to-sitch swaps.
    //  - No video node yet (e.g. the empty startup sitch): a dropped video has
    //    nowhere to go (CFileManagerParse bails with "No video node found"), so we
    //    must establish the custom sitch first. Queue the URL and load custom; the
    //    custom sitch's setup drains the queue — identical to dropping a URL onto
    //    the sitch browser, which is the canonical "start from scratch" flow.
    _triggerWarGovPRRecord(prCode) {
        const url = `https://www.war.gov/ufo/#${prCode}`;
        if (NodeMan.exists("video")) {
            this.close();
            DragDropHandler.handleDroppedText(url);
        } else {
            DragDropHandler.pendingDropTexts.push(url);
            this._loadCustomSitchForQueuedDrops(1);
        }
    }

    // Activate a tile by key, i.e. do what Enter / a double-click does:
    // the green tile resolves its war.gov record; a real sitch loads.
    _activateKey(key) {
        if (key === WARGOV_PR_KEY) {
            if (this._warGovPRCode) this._triggerWarGovPRRecord(this._warGovPRCode);
        } else if (key) {
            this.close();
            this._loadSitch(key);
        }
    }

    // Key of the first visible tile (green war.gov tile if present, else first sitch).
    _firstTileKey() {
        if (this._hasSyntheticTile()) return WARGOV_PR_KEY;
        return this.filtered.length ? this.filtered[0].key : null;
    }

    // Focus the synthetic war.gov tile (blue border). It is never added to
    // this.selection — only this.selectedKey tracks it.
    _selectWarGovPRCard() {
        this.selection.clear();
        this.selectedKey = WARGOV_PR_KEY;
        this._lastClickedIndex = -1;
        this._updateHighlights();
    }

    // True when the thumbnail grid currently leads with the synthetic war.gov tile.
    _hasSyntheticTile() {
        return this.viewMode === "thumbnails" && !!this._warGovPRCode;
    }

    // Down-arrow from the search box selects the first visible tile (green or otherwise).
    _selectFirstTile() {
        if (this._hasSyntheticTile()) {
            this._selectWarGovPRCard();
        } else if (this.filtered.length > 0) {
            this.selection.clear();
            this.selectedKey = this.filtered[0].key;
            this.selection.add(this.selectedKey);
            this._lastClickedIndex = 0;
            this._updateHighlights();
        } else {
            return;
        }
        const container = this.viewMode === "list" ? this._tbody : this._thumbGrid;
        if (container && container.children[0]) container.children[0].scrollIntoView({block: "nearest"});
    }

    // ==================== SHARED HELPERS ====================

    _titleText() {
        if (this.activeLabel === "Deleted") return "Deleted Sitches";
        if (this.activeLabel === "Private") return "Private Sitches";
        if (this.activeLabel === "Featured") return "Featured Sitches";
        if (this.activeLabel === "Unlabeled") return "Unlabeled Sitches";
        if (this.activeLabel) return `Label: ${this.activeLabel}`;
        return "Browse Sitches";
    }

    _makeSidebarLink(text, onClick, active) {
        const a = document.createElement("a");
        a.textContent = text;
        a.href = "#";
        Object.assign(a.style, {
            color: active ? "#e0e0e0" : "#8ab4f8", textDecoration: "none",
            fontSize: "14px", padding: "6px 12px", borderRadius: "6px",
            backgroundColor: active ? "#2a2a3e" : "transparent",
        });
        a.addEventListener("mouseenter", () => a.style.backgroundColor = "#2a2a3e");
        a.addEventListener("mouseleave", () => a.style.backgroundColor = active ? "#2a2a3e" : "transparent");
        a.addEventListener("click", e => { e.preventDefault(); onClick(); });
        return a;
    }

    _createSearchInput(onUpdate) {
        const si = document.createElement("input");
        si.type = "text"; si.placeholder = "Search by name..."; si.value = this.searchText;
        Object.assign(si.style, {
            width: "100%", boxSizing: "border-box", padding: "10px 14px", fontSize: "14px",
            backgroundColor: "#2a2a3e", color: "#e0e0e0", border: "1px solid #444",
            borderRadius: "6px", outline: "none",
        });
        si.addEventListener("input", () => {
            this.searchText = si.value;
            this.applyFilterAndSort();
            onUpdate();
        });
        si.addEventListener("paste", (e) => {
            const text = e.clipboardData?.getData("text/plain")?.trim();
            if (!text?.startsWith("http://") && !text?.startsWith("https://")) {
                return;
            }

            e.preventDefault();
            e.stopPropagation();
            DragDropHandler.pendingDropTexts.push(text);
            this._loadCustomSitchForQueuedDrops(1);
        });
        return si;
    }

    _matchesSearch(name, searchText) {
        const nameLower = name.toLowerCase();
        const orParts = searchText.split(' OR ');
        if (orParts.length > 1) return orParts.some(part => this._matchesSearch(name, part.trim()));
        const andParts = searchText.split(' AND ');
        if (andParts.length > 1) return andParts.every(part => nameLower.includes(part.trim().toLowerCase()));
        return nameLower.includes(searchText.toLowerCase());
    }

    _makeLabelChips(sitchOrKey) {
        const sitch = this._getSitch(sitchOrKey);
        if (!sitch) return null;
        const labels = this._isOwnSitch(sitch) ? (this.sitchLabels[sitch.name] || []) : [];
        const isFeatured = this._isFeatured(sitch);

        // Always create a container so we can update it in-place later
        const container = document.createElement("div");
        container.dataset.labelChips = sitch.key;
        Object.assign(container.style, { display: "flex", flexWrap: "wrap", gap: "3px", marginTop: "2px" });
        if (labels.length === 0 && !isFeatured) return container;

        // Show Featured chip first if applicable
        if (isFeatured) {
            const featuredDef = PERMANENT_LABELS.find(l => l.name === "Featured");
            const chip = document.createElement("span");
            Object.assign(chip.style, {
                display: "inline-flex", alignItems: "center", gap: "3px",
                padding: "1px 6px", borderRadius: "3px", fontSize: "10px",
                backgroundColor: featuredDef.color + "33", color: featuredDef.color,
                border: "1px solid " + featuredDef.color + "55",
                maxWidth: "100px", overflow: "hidden", textOverflow: "ellipsis",
                whiteSpace: "nowrap", lineHeight: "16px",
            });
            chip.textContent = "Featured";
            chip.title = "Featured";
            container.appendChild(chip);
        }

        for (const labelName of labels) {
            const labelDef = this.userLabels.find(l => l.name === labelName);
            if (!labelDef) continue;

            const chip = document.createElement("span");
            Object.assign(chip.style, {
                display: "inline-flex", alignItems: "center", gap: "3px",
                padding: "1px 6px", borderRadius: "3px", fontSize: "10px",
                backgroundColor: labelDef.color + "33", color: labelDef.color,
                border: "1px solid " + labelDef.color + "55",
                maxWidth: "100px", overflow: "hidden", textOverflow: "ellipsis",
                whiteSpace: "nowrap", lineHeight: "16px",
            });
            chip.textContent = labelName;
            chip.title = labelName;
            container.appendChild(chip);
        }
        return container;
    }

    // Update label chips in-place without rebuilding cards/rows (avoids thumbnail flicker)
    _refreshLabelChips() {
        const containers = this._contentArea.querySelectorAll("[data-label-chips]");
        for (const container of containers) {
            const sitchKey = container.dataset.labelChips;
            container.innerHTML = "";
            const fresh = this._makeLabelChips(sitchKey);
            // Move children from the new container into the existing one
            while (fresh && fresh.firstChild) container.appendChild(fresh.firstChild);
        }
    }

    // ==================== CUSTOM DRAG (no native DnD) ====================

    _registerDropTarget(element, handlers) {
        if (!this._dropTargets) this._dropTargets = [];
        this._dropTargets.push({ element, ...handlers });
    }

    _makeDraggable(element, sitchKey) {
        // Prevent native browser drag (images, links) which triggers Chrome split-view
        element.addEventListener("dragstart", (e) => e.preventDefault());

        let startX, startY, dragging = false;

        element.addEventListener("pointerdown", (e) => {
            if (e.button !== 0) return; // left button only
            startX = e.clientX;
            startY = e.clientY;
            dragging = false;

            const onMove = (me) => {
                if (!dragging) {
                    // Require a small movement threshold before starting drag
                    if (Math.abs(me.clientX - startX) < 5 && Math.abs(me.clientY - startY) < 5) return;
                    dragging = true;
                    this._startCustomDrag(me, sitchKey);
                }
                if (dragging) this._updateCustomDrag(me);
            };
            const onUp = (ue) => {
                document.removeEventListener("pointermove", onMove);
                document.removeEventListener("pointerup", onUp);
                if (dragging) this._endCustomDrag(ue);
            };
            document.addEventListener("pointermove", onMove);
            document.addEventListener("pointerup", onUp);
        });
    }

    _startCustomDrag(e, sitchKey) {
        // Clean up any previous drag state (e.g. if pointerup was lost)
        if (this._dragGhost) { document.body.removeChild(this._dragGhost); this._dragGhost = null; }

        // If dragging an unselected item, select just it
        if (!this.selection.has(sitchKey)) {
            this.selection.clear();
            this.selection.add(sitchKey);
            this.selectedKey = sitchKey;
            this._updateHighlights();
        }
        this._dragNames = [...this.selection];
        this._dragHoverTarget = null;

        // Create floating ghost badge
        const ghost = document.createElement("div");
        const sitch = this._getSitch(sitchKey);
        const label = this._dragNames.length > 1 ? `${this._dragNames.length} sitches` : (sitch?.name || sitchKey);
        ghost.textContent = label;
        Object.assign(ghost.style, {
            position: "fixed", pointerEvents: "none", zIndex: "100000",
            padding: "4px 12px", backgroundColor: "#4285f4",
            color: "#fff", borderRadius: "4px", fontSize: "13px",
            whiteSpace: "nowrap",
        });
        document.body.appendChild(ghost);
        this._dragGhost = ghost;
        this._positionGhost(e);
        document.body.style.userSelect = "none";
    }

    _positionGhost(e) {
        if (!this._dragGhost) return;
        this._dragGhost.style.left = (e.clientX + 12) + "px";
        this._dragGhost.style.top = (e.clientY + 12) + "px";
    }

    _updateCustomDrag(e) {
        this._positionGhost(e);

        // Hit-test drop targets
        let hit = null;
        for (const t of (this._dropTargets || [])) {
            const r = t.element.getBoundingClientRect();
            if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
                hit = t;
                break;
            }
        }
        if (hit !== this._dragHoverTarget) {
            if (this._dragHoverTarget && this._dragHoverTarget.onLeave) this._dragHoverTarget.onLeave();
            this._dragHoverTarget = hit;
            if (hit && hit.onEnter) hit.onEnter();
        }
    }

    _endCustomDrag(e) {
        document.body.style.userSelect = "";
        if (this._dragGhost) { document.body.removeChild(this._dragGhost); this._dragGhost = null; }
        if (this._dragHoverTarget) {
            if (this._dragHoverTarget.onDrop) this._dragHoverTarget.onDrop(this._dragNames || []);
            this._dragHoverTarget = null;
        }
        this._dragNames = null;
    }

    _destroyThumbObserver() {
        if (this._thumbObserver) { this._thumbObserver.disconnect(); this._thumbObserver = null; }
    }

    // ==================== LABEL MUTATIONS ====================

    _promptAddLabel(assignToSitches) {
        const name = prompt("Enter label name:");
        if (!name || !name.trim()) return;
        const trimmed = name.trim().substring(0, 50);

        if (this._isPermanentLabel(trimmed)) {
            alert(`"${trimmed}" is a reserved label name.`);
            return;
        }

        if (!this.userLabels.some(l => l.name === trimmed)) {
            // Pick a color that hasn't been used yet, or cycle
            const usedColors = new Set(this.userLabels.map(l => l.color));
            let color = LABEL_COLORS.find(c => !usedColors.has(c)) || LABEL_COLORS[this.userLabels.length % LABEL_COLORS.length];
            this.userLabels.push({name: trimmed, color});
        }

        const changed = [];
        if (assignToSitches && assignToSitches.length > 0) {
            for (const sitchKey of assignToSitches) {
                const sitch = this._getSitch(sitchKey);
                if (!sitch || !this._isOwnSitch(sitch)) continue;
                if (!this.sitchLabels[sitch.name]) this.sitchLabels[sitch.name] = [];
                if (!this.sitchLabels[sitch.name].includes(trimmed)) {
                    this.sitchLabels[sitch.name].push(trimmed);
                    changed.push(sitch.name);
                }
            }
        }

        this._saveMetadata(changed);
        this._rebuildSidebarLabels();
        this.rebuildContent();
    }

    _deleteLabel(labelName) {
        if (this._isPermanentLabel(labelName)) return;
        if (!confirm(`Delete label "${labelName}"? This will remove it from all sitches.`)) return;

        this.userLabels = this.userLabels.filter(l => l.name !== labelName);
        const changed = [];
        for (const sn of Object.keys(this.sitchLabels)) {
            if (this.sitchLabels[sn].includes(labelName)) {
                this.sitchLabels[sn] = this.sitchLabels[sn].filter(l => l !== labelName);
                changed.push(sn);
                if (this.sitchLabels[sn].length === 0) delete this.sitchLabels[sn];
            }
        }
        if (this.activeLabel === labelName) this.activeLabel = null;

        this._saveMetadata(changed);
        this.applyFilterAndSort();
        this._rebuildSidebarLabels();
        this.rebuildContent();
    }

    // Check if a label change affects the current filter and requires a full content rebuild
    _labelAffectsFilter(labelName) {
        // When viewing Unlabeled, any label change affects the filter
        if (this.activeLabel === "Unlabeled") return true;
        return labelName === "Deleted" || labelName === "Private" || labelName === "Featured" || labelName === this.activeLabel;
    }

    _addLabelToSitches(sitchKeys, labelName) {
        if (labelName === "Featured") {
            if (!this._canManageFeatured()) return;
            const previousFeatured = this._cloneFeaturedSitches();
            const added = [];
            for (const sitchKey of sitchKeys) {
                const sitch = this._getSitch(sitchKey);
                if (!sitch) continue;
                if (!this.featuredSitches.has(sitch.key)) {
                    this.featuredSitches.set(sitch.key, {
                        name: sitch.name,
                        userID: sitch.ownerUserID,
                        screenshotUrl: sitch.screenshotUrl || null,
                    });
                    added.push(sitch.key);
                }
            }
            if (added.length > 0) {
                this._refreshFeaturedState();
                this._saveFeatured(previousFeatured);
            }
            return;
        }
        const changed = [];
        for (const sitchKey of sitchKeys) {
            const sitch = this._getSitch(sitchKey);
            if (!sitch || !this._isOwnSitch(sitch)) continue;
            if (!this.sitchLabels[sitch.name]) this.sitchLabels[sitch.name] = [];
            if (!this.sitchLabels[sitch.name].includes(labelName)) {
                this.sitchLabels[sitch.name].push(labelName);
                changed.push(sitch.name);
            }
        }
        if (changed.length > 0) {
            this._saveMetadata(changed);
            this._rebuildSidebar();
            if (this._labelAffectsFilter(labelName)) {
                this.applyFilterAndSort();
                this.rebuildContent();
            } else {
                this._refreshLabelChips();
            }
        }
    }

    _removeLabelFromSitches(sitchKeys, labelName) {
        if (labelName === "Featured") {
            if (!this._canManageFeatured()) return;
            const previousFeatured = this._cloneFeaturedSitches();
            const removed = [];
            for (const sitchKey of sitchKeys) {
                const sitch = this._getSitch(sitchKey);
                if (!sitch) continue;
                if (this.featuredSitches.has(sitch.key)) {
                    this.featuredSitches.delete(sitch.key);
                    removed.push(sitch.key);
                }
            }
            if (removed.length > 0) {
                this._refreshFeaturedState();
                this._saveFeatured(previousFeatured);
            }
            return;
        }
        const changed = [];
        for (const sitchKey of sitchKeys) {
            const sitch = this._getSitch(sitchKey);
            if (!sitch || !this._isOwnSitch(sitch)) continue;
            if (this.sitchLabels[sitch.name] && this.sitchLabels[sitch.name].includes(labelName)) {
                this.sitchLabels[sitch.name] = this.sitchLabels[sitch.name].filter(l => l !== labelName);
                changed.push(sitch.name);
                if (this.sitchLabels[sitch.name].length === 0) delete this.sitchLabels[sitch.name];
            }
        }
        if (changed.length > 0) {
            this._saveMetadata(changed);
            this._rebuildSidebar();
            if (this._labelAffectsFilter(labelName)) {
                this.applyFilterAndSort();
                this.rebuildContent();
            } else {
                this._refreshLabelChips();
            }
        }
    }

    _saveMetadata(changedSitches) {
        const body = {
            labels: this.userLabels,
            sitchLabels: this.sitchLabels,
        };
        if (changedSitches && changedSitches.length > 0) {
            body.updateSitches = changedSitches;
        }
        fetch(withTestUser(SITREC_SERVER + "metadata.php"), {
            method: "POST", mode: "cors",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(body),
        }).then(r => {
            if (!r.ok) console.error("metadata.php returned", r.status);
            return r.json();
        }).then(data => {
            if (data.error) console.error("metadata save error:", data.error);
        }).catch(err => console.error("Failed to save metadata:", err));
    }

    _saveFeatured(previousFeatured = null) {
        const sitches = [];
        for (const [, info] of this.featuredSitches) {
            sitches.push({name: info.name, userID: info.userID});
        }
        const body = {
            updateFeatured: true,
            sitches,
        };
        fetch(withTestUser(SITREC_SERVER + "metadata.php"), {
            method: "POST", mode: "cors",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(body),
        }).then(r => {
            return r.json().catch(() => ({})).then(data => {
                if (!r.ok) {
                    throw new Error(data.error || `metadata.php featured save returned ${r.status}`);
                }
                return data;
            });
        }).then(data => {
            if (data.error) {
                throw new Error(data.error);
            }
        }).catch(err => {
            console.error("Failed to save featured:", err);
            return this._reloadFeaturedFromServer(previousFeatured);
        });
    }

    // ==================== FILE DRAG & DROP ====================

    _loadCustomSitchForQueuedDrops(queuedCount) {
        console.log("Sitch browser: queued " + queuedCount + " dropped item(s), loading custom sitch");
        this.close();
        const customSitchData = SitchMan.findFirstData(s => s.data.name === "custom");
        setNewSitchObject(customSitchData);
    }

    _setupFileDragDrop(overlay) {
        // Visual feedback element for file drags
        const dropHint = document.createElement("div");
        Object.assign(dropHint.style, {
            position: "absolute", top: "0", left: "0", width: "100%", height: "100%",
            display: "none", alignItems: "center", justifyContent: "center",
            backgroundColor: "rgba(46, 160, 67, 0.3)", border: "3px dashed #3fb950",
            zIndex: "1", pointerEvents: "none", fontSize: "32px", color: "#3fb950",
            fontWeight: "700",
        });
        dropHint.textContent = "Drop files or URLs to create a new sitch";
        overlay.appendChild(dropHint);

        let dragCounter = 0; // track nested dragenter/dragleave pairs
        const hasExternalDropData = (dataTransfer) => {
            if (!dataTransfer) return false;
            return dataTransfer.types.includes("Files")
                || dataTransfer.types.includes("text/uri-list")
                || dataTransfer.types.includes("text/plain");
        };

        overlay.addEventListener("dragenter", (e) => {
            // Only show hint for external drops, not internal sitch-card drags.
            if (!hasExternalDropData(e.dataTransfer)) return;
            e.preventDefault();
            dragCounter++;
            dropHint.style.display = "flex";
        });

        overlay.addEventListener("dragover", (e) => {
            if (!hasExternalDropData(e.dataTransfer)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
        });

        overlay.addEventListener("dragleave", (e) => {
            dragCounter--;
            if (dragCounter <= 0) {
                dragCounter = 0;
                dropHint.style.display = "none";
            }
        });

        overlay.addEventListener("drop", (e) => {
            e.preventDefault();
            e.stopPropagation(); // prevent body-level drop handlers
            dragCounter = 0;
            dropHint.style.display = "none";

            const files = e.dataTransfer?.files;
            let queuedCount = 0;

            if (files && files.length > 0) {
                // Stash files for DragDropHandler to process after SitCustom loads.
                for (const file of files) {
                    DragDropHandler.pendingDropFiles.push(file);
                    queuedCount++;
                }
            } else {
                const text = DragDropHandler.getDroppedText(e.dataTransfer);
                if (text) {
                    DragDropHandler.pendingDropTexts.push(text);
                    queuedCount++;
                }
            }

            if (queuedCount === 0) return;
            this._loadCustomSitchForQueuedDrops(queuedCount);
        });
    }

    // ==================== CLOSE ====================

    close() {
        this._destroyThumbObserver();
        this._hideContextMenu();
        if (this.overlay) { document.body.removeChild(this.overlay); this.overlay = null; }
        if (this._keyHandler) { document.removeEventListener("keydown", this._keyHandler); this._keyHandler = null; }
        Globals.menuBar?.restoreNonBarMenus();
    }
}
