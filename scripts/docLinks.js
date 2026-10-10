"use strict";

// A link target that names another site: a URL scheme ("https:", "mailto:") or a
// protocol-relative "//host/...".
const ABSOLUTE_URL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

// Rewrite inter-document links from .md to .html for the generated doc pages.
// A trailing anchor is kept: [x](Foo.md#bar) -> [x](Foo.html#bar).
//
// Only links to our own pages are rewritten. An absolute link points at another site,
// which has no .html twin (https://github.com/.../egress-review-prompt.md stays .md).
//
// The link text may wrap onto the next line: "[^\]]*" matches across the line break,
// as in "[File Rehosting and\nObject References]".
function rewriteMdLinks(text) {
    return text.replace(
        /(\[[^\]]*\]\((?:\.\/)?(?:docs\/)?)([^)#]*?)\.md(#[^)]*)?\)/g,
        (match, prefix, name, anchor) =>
            ABSOLUTE_URL.test(name) ? match : `${prefix}${name}.html${anchor || ''})`
    );
}

module.exports = { rewriteMdLinks };
