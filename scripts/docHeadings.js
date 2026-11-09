// Shared by rendered documentation and search, so results use the page's real anchors.
function stripTags(s) {
    let previous;
    do {
        previous = s;
        s = s.replace(/<[^>]*>/g, '');
    } while (s !== previous);
    return s;
}

function addHeadingIds(html) {
    const used = new Map();
    return html.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (match, level, inner) => {
        const text = stripTags(inner)
            .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
        let slug = text.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/\s/g, '-');
        if (!slug) return match;
        const n = used.get(slug) || 0;
        used.set(slug, n + 1);
        if (n > 0) slug = `${slug}-${n}`;
        return `<h${level} id="${slug}">${inner}</h${level}>`;
    });
}

module.exports = {addHeadingIds, stripTags};
