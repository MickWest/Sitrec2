"use strict";

// A link target that names another site: a URL scheme ("https:", "mailto:") or a
// protocol-relative "//host/...".
const ABSOLUTE_URL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

// Rewrite inter-document links from .md to .html for the generated doc pages.
// Handles a trailing anchor: [x](Foo.md#bar) -> [x](Foo.html#bar). The previous pattern
// required a literal ".md)" and so silently left every anchored link pointing at the raw
// markdown file, which the browser shows as plain text instead of opening the page.
//
// Only links to our own pages are rewritten. An absolute link points at another site,
// which has no .html twin: rewriting https://github.com/.../egress-review-prompt.md to
// .html made the published UserDataEgressCheck page link to a GitHub 404.
//
// The link text may wrap onto the next line. "[^\]]*" crosses the line break where
// ".*?" did not, so ObjectReferences' wrapped "[File Rehosting and\nObject References]"
// link stayed .md and opened as raw markdown.
function rewriteMdLinks(text) {
    return text.replace(
        /(\[[^\]]*\]\((?:\.\/)?(?:docs\/)?)([^)#]*?)\.md(#[^)]*)?\)/g,
        (match, prefix, name, anchor) =>
            ABSOLUTE_URL.test(name) ? match : `${prefix}${name}.html${anchor || ''})`
    );
}

module.exports = { rewriteMdLinks };
