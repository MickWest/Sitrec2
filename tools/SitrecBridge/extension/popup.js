/**
 * SitrecBridge -- Popup UI
 */

const wsDot = document.getElementById("ws-dot");
const wsStatus = document.getElementById("ws-status");
const wsListEl = document.getElementById("ws-list");
const tabDot = document.getElementById("tab-dot");
const tabStatus = document.getElementById("tab-status");
const tabListEl = document.getElementById("tab-list");
const info = document.getElementById("info");
const versionEl = document.getElementById("version");
const updateBanner = document.getElementById("update-banner");
const currentCmdEl = document.getElementById("current-cmd");
const historyListEl = document.getElementById("history-list");

let elapsedTimer = null;

function formatDuration(ms) {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}

function stripPrefix(action) {
    return action.replace(/^sitrec_/, "");
}

function escHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Returns >0 if a > b, <0 if a < b, 0 if equal. Numeric segments only;
// non-numeric tails fall back to string compare.
function compareVersions(a, b) {
    const pa = String(a).split(".");
    const pb = String(b).split(".");
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const na = parseInt(pa[i] || "0", 10);
        const nb = parseInt(pb[i] || "0", 10);
        if (Number.isNaN(na) || Number.isNaN(nb)) {
            return (pa[i] || "").localeCompare(pb[i] || "");
        }
        if (na !== nb) return na - nb;
    }
    return 0;
}

function renderCurrentCommand(cmd) {
    if (!cmd) {
        currentCmdEl.style.display = "none";
        if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
        return;
    }
    currentCmdEl.style.display = "block";
    const updateElapsed = () => {
        const elapsed = Date.now() - cmd.startTime;
        let html = `<span class="action">${stripPrefix(cmd.action)}</span> <span class="elapsed">${formatDuration(elapsed)}</span>`;
        if (cmd.port) html += ` <span class="elapsed">:${cmd.port}</span>`;
        if (cmd.detail) html += `<span class="detail">${escHtml(cmd.detail)}</span>`;
        currentCmdEl.innerHTML = html;
    };
    updateElapsed();
    if (elapsedTimer) clearInterval(elapsedTimer);
    elapsedTimer = setInterval(updateElapsed, 200);
}

function renderHistory(history) {
    if (!history || history.length === 0) {
        historyListEl.innerHTML = '<li style="color:#9ca3af;">No commands yet</li>';
        return;
    }
    historyListEl.innerHTML = history.map(cmd => {
        const icon = cmd.ok ? "✓" : "✗";
        const iconColor = cmd.ok ? "#22c55e" : "#ef4444";
        const dur = formatDuration(cmd.endTime - cmd.startTime);
        const detail = cmd.detail ? cmd.detail : "";
        const portLabel = cmd.port ? `:${cmd.port}` : "";
        const tabLabel = cmd.tabId ? `→#${cmd.tabId}` : "";
        const routing = (cmd.port || cmd.tabId) ? `<span class="routing">${portLabel}${tabLabel}</span>` : "";
        return `<li><span class="icon" style="color:${iconColor}">${icon}</span><span class="action">${stripPrefix(cmd.action)}</span><span class="detail">${escHtml(detail)}</span>${routing}<span class="dur">${dur}</span></li>`;
    }).join("");
}

function renderConnections(conns) {
    const live = (conns || []).filter(c => c.connected);
    if (live.length === 0) {
        wsDot.className = "dot red";
        wsStatus.textContent = "No MCP servers";
        wsListEl.innerHTML = "";
        return;
    }
    wsDot.className = "dot green";
    wsStatus.textContent = `${live.length} server${live.length > 1 ? "s" : ""}`;
    wsListEl.innerHTML = live.map(c => {
        const origin = c.pairedOrigin
            ? escHtml(c.pairedOrigin)
            : "<span style='color:#999'>(host fallback)</span>";
        const pid = c.serverPid ? ` PID ${c.serverPid}` : "";
        return `<div>:${c.port} → ${origin}<span style="color:#aaa">${pid}</span></div>`;
    }).join("");
}

function renderTabs(tabs, conns) {
    const knownTabs = tabs || [];
    if (knownTabs.length === 0) {
        tabDot.className = "dot yellow";
        tabStatus.textContent = "None found";
        tabListEl.innerHTML = "";
        return;
    }
    tabDot.className = "dot green";
    tabStatus.textContent = `${knownTabs.length} tab${knownTabs.length > 1 ? "s" : ""}`;

    // Map origin → port for visible pairing
    const originToPort = new Map();
    for (const c of (conns || [])) {
        if (c.connected && c.pairedOrigin) originToPort.set(c.pairedOrigin, c.port);
    }

    tabListEl.innerHTML = knownTabs.map(t => {
        let path = "";
        try { path = new URL(t.url).pathname.split("/").filter(Boolean)[0] || ""; } catch {}
        const port = originToPort.get(t.origin);
        const pairLabel = port
            ? `<span style="color:#6366f1">→ :${port}</span>`
            : `<span style="color:#888">→ fallback</span>`;
        const origin = t.origin ? escHtml(t.origin) : "?";
        return `<div>${origin}/${escHtml(path)} #${t.id} ${pairLabel}</div>`;
    }).join("");
}

function update(state) {
    renderConnections(state.connections);
    renderTabs(state.knownTabs, state.connections);

    if (state.installedVersion) {
        versionEl.textContent = `v${state.installedVersion}`;
    }

    // Update banner: only show when at least one connected server reports a
    // *newer* sourceVersion than the installed extension. A sandboxed worktree
    // may report an older bridge source (predating recent changes) — that's
    // not an update, so we ignore it.
    const newer = (state.connections || []).find(
        c => c.connected && c.sourceVersion && compareVersions(c.sourceVersion, state.installedVersion) > 0
    );
    if (newer) {
        updateBanner.innerHTML =
            `Update available: v${escHtml(newer.sourceVersion)} ` +
            `<a href="#" id="reload-link" style="color: #92400e; font-weight: 500;">(reload extension)</a>`;
        updateBanner.style.display = "block";
        const reloadLink = document.getElementById("reload-link");
        if (reloadLink) {
            reloadLink.addEventListener("click", (e) => {
                e.preventDefault();
                chrome.runtime.sendMessage({ type: "reload" });
            });
        }
    } else {
        updateBanner.style.display = "none";
    }

    renderCurrentCommand(state.currentCommand);
    renderHistory(state.commandHistory);

    info.textContent = `Scanning ports 9780-9799`;
}

chrome.runtime.sendMessage({ type: "getState" }, (response) => {
    if (response) update(response);
});

chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "stateUpdate") update(msg);
});

document.getElementById("reconnect-btn").addEventListener("click", () => {
    wsStatus.textContent = "Reconnecting...";
    wsDot.className = "dot yellow";
    chrome.runtime.sendMessage({ type: "reconnect" });
});

document.getElementById("close-tabs-btn").addEventListener("click", async () => {
    // The active tab of the window the toolbar icon was clicked in is the one
    // we keep. Determine it here (the popup has window context) and let the
    // background worker do the actual closing — it owns the tabs permission and
    // the knownSitrecTabs registry.
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabStatus.textContent = "Closing...";
    chrome.runtime.sendMessage(
        { type: "closeOtherTabs", keepTabId: activeTab?.id },
        (resp) => {
            if (resp && typeof resp.closed === "number") {
                tabStatus.textContent = resp.closed === 0
                    ? "No others to close"
                    : `Closed ${resp.closed}`;
            }
            // The onRemoved listener triggers a stateUpdate that re-renders the
            // tab list, so no manual refresh is needed here.
        }
    );
});
