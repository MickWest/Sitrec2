const STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from',
    'how', 'i', 'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'what',
    'with']);

function normalizeSearchText(text) {
    return String(text).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

function searchTerms(text) {
    return [...new Set((normalizeSearchText(text).match(/[\p{L}\p{N}]+/gu) || [])
        .filter(word => !STOP_WORDS.has(word)))];
}

// Match the same whole words and prefixes as the index, preserving offsets in
// the original text so accented letters and literal markup display unchanged.
function searchTermRanges(text, terms) {
    const ranges = [];
    for (const match of text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu)) {
        const word = match[0], normalized = normalizeSearchText(word);
        const length = terms.reduce((longest, term) =>
            normalized === term || (term.length >= 3 && normalized.startsWith(term))
                ? Math.max(longest, term.length) : longest, 0);
        if (!length) continue;
        let end = 0, normalizedLength = 0;
        for (const character of word) {
            end += character.length;
            normalizedLength += normalizeSearchText(character).length;
            if (normalizedLength >= length) break;
        }
        end += word.slice(end).match(/^\p{M}*/u)[0].length;
        ranges.push([match.index, match.index + end]);
    }
    return ranges;
}

module.exports = {normalizeSearchText, searchTerms, searchTermRanges};
