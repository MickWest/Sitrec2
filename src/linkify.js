// Shared link rendering used by both the Notes view (CNodeNotes) and the AI chat
// (CNodeViewChat), so clickable links look and behave identically in both.
//
// It escapes HTML first, then turns URLs into styled, new-tab <a> links:
//   - absolute http(s) URLs (as the Notes view always has), and
//   - relative help-doc paths like "docs/Tracks.html" or "README.html", which are
//     resolved against the current page so they work in any deployment (the AI chat
//     emits these when it cites a help doc).
//
// Returns an HTML string; callers assign it to innerHTML. That is safe because the
// input is HTML-escaped before any anchors are inserted.

// One source of truth for "what counts as a link". The relative-doc branch matches
// docs/<Name>.html (Name may contain - and _, e.g. gimbal-recreate) and README.html.
const LINK_PATTERN = /(https?:\/\/[^\s<]+[^\s<.,;:!?\])>"']|(?:\.\/)?(?:docs\/[A-Za-z0-9_-]+|README)\.html)/gi;

export function linkifyToHTML(text) {
    const escaped = String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    return escaped.replace(LINK_PATTERN, (match) => {
        const raw = match.replace(/&amp;/g, '&');
        let href = raw;
        if (!/^https?:\/\//i.test(raw)) {
            // Relative help-doc path — resolve to an absolute URL against the page.
            try { href = new URL(raw, document.baseURI).href; } catch (e) { href = raw; }
        }
        return `<a href="${href}" target="_blank" rel="noopener noreferrer" style="color: #6cf; text-decoration: underline;">${match}</a>`;
    });
}

// True if the text contains anything linkifyToHTML would turn into a link. Uses a
// fresh (non-global) test so there is no shared lastIndex state between calls.
export function hasLinks(text) {
    return new RegExp(LINK_PATTERN.source, "i").test(String(text));
}
