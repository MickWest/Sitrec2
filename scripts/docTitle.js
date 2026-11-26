"use strict";

// The text of the <title> element of a generated doc page.
//
// webpack.common.js renders docs/*.md and README.md to HTML pages. The page title is the
// first level-1 heading of the Markdown source, or a fallback (the file name) when there
// is none. That heading is source text, not rendered Markdown: it does not go through
// markdown-it, which is what escapes the body of the page. So it is escaped here.
//
// Without the escape, a heading that holds markup goes into the page head as markup:
// "# Notes on </title><script>..." closes the title and leaves a live script element in
// the published page.

const HTML_ESCAPES = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};

function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

// Returns the title, already escaped for use as HTML text.
function docPageTitle(markdown, fallback) {
    const match = markdown.match(/^#\s+(.+)$/m);
    return escapeHtml(match ? match[1] : fallback);
}

module.exports = {docPageTitle, escapeHtml};
