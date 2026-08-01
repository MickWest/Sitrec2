/**
 * Tab-targeting argument handling for the MCP tools.
 *
 * Kept in its own module so it can be unit-tested without importing mcp-server.js
 * (which binds a port on load).
 */

/**
 * Resolve the tab-targeting argument before it reaches the extension.
 *
 * `tabId` is the name everything else uses — chrome.tabs, and the `id` field
 * that sitrec_list_tabs reports — so callers reach for it naturally. It used to
 * be an unrecognised key: silently dropped, after which the command ran against
 * the DEFAULT tab. The results looked completely normal but described a
 * different page (in one session, a production tab rather than the local build),
 * and every conclusion drawn from them was wrong. So accept it as an alias, and
 * refuse anything else that looks like a tab target rather than ignoring it.
 *
 * Returns a new args object with any alias folded into `tab`.
 * Throws when the targeting is ambiguous or unrecognised.
 */
export function normalizeTabArgs(args) {
    if (!args || typeof args !== "object" || Array.isArray(args)) return args;
    const out = { ...args };

    if (out.tabId !== undefined) {
        if (out.tab !== undefined && String(out.tab) !== String(out.tabId)) {
            throw new Error(
                `Conflicting tab targets: tab=${out.tab} and tabId=${out.tabId}. Pass only one.`);
        }
        out.tab = out.tabId;
        delete out.tabId;
    }

    const stray = Object.keys(out).filter(k => k !== "tab" && /^tab/i.test(k));
    if (stray.length > 0) {
        throw new Error(
            `Unknown tab parameter(s): ${stray.join(", ")}. Use "tab" (or "tabId") with a URL ` +
            `substring or a numeric id from sitrec_list_tabs. Refusing rather than silently ` +
            `running against the default tab.`);
    }

    return out;
}
