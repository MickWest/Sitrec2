import {normalizeSearchText, searchTerms, searchTermRanges} from './SearchTerms.cjs';

function lowerBound(words, value) {
    let lo = 0, hi = words.length;
    while (lo < hi) {
        const middle = (lo + hi) >>> 1;
        if (words[middle] < value) lo = middle + 1;
        else hi = middle;
    }
    return lo;
}

export function documentationSnippet(text, terms, length = 230) {
    const firstMatch = searchTermRanges(text, terms)[0];
    let start = Math.max(0, (firstMatch?.[0] ?? 0) - 65);
    if (start) {
        const nextSpace = text.indexOf(' ', start);
        if (nextSpace >= 0) start = nextSpace + 1;
    }
    let end = Math.min(text.length, start + length);
    if (end < text.length) {
        const space = text.lastIndexOf(' ', end);
        if (space > start) end = space;
    }
    return (start ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

export function createDocumentationSearch(index) {
    if (index?.version !== 1 || !Array.isArray(index.documents) || !Array.isArray(index.sections)
        || !index.postings || typeof index.postings !== 'object') throw new Error('Invalid documentation index');
    const vocabulary = Object.keys(index.postings).sort();
    return (query, limit = 30) => {
        const terms = searchTerms(query);
        if (!terms.length) return {results: [], total: 0};
        let candidates;
        for (const term of terms) {
            const matches = new Set();
            // Short terms such as QP match exactly; longer words also match prefixes.
            for (let i = lowerBound(vocabulary, term); i < vocabulary.length; i++) {
                const word = vocabulary[i];
                if (!word.startsWith(term)) break;
                if (term.length < 3 && word !== term) continue;
                for (const id of index.postings[word]) matches.add(id);
            }
            candidates = candidates === undefined ? matches
                : new Set([...candidates].filter(id => matches.has(id)));
            if (!candidates.size) return {results: [], total: 0};
        }
        const phrase = normalizeSearchText(query).trim();
        const bodyPhrase = new RegExp('(?:^|[^\\p{L}\\p{N}])' + terms.join('[\\p{L}\\p{N}]*\\s+')
            + '[\\p{L}\\p{N}]*(?=$|[^\\p{L}\\p{N}])', 'u');
        const ranked = [...candidates].map(id => {
            const section = index.sections[id], document = index.documents[section.document];
            const title = normalizeSearchText(document.title), heading = normalizeSearchText(section.heading);
            const titleTerms = searchTerms(title), headingTerms = searchTerms(heading);
            let score = (title.includes(phrase) ? 100 : 0) + (heading.includes(phrase) ? 50 : 0);
            for (const term of terms) {
                score += titleTerms.includes(term) ? 25 : titleTerms.some(word => word.startsWith(term)) ? 15 : 0;
                score += headingTerms.includes(term) ? 12 : headingTerms.some(word => word.startsWith(term)) ? 6 : 0;
            }
            if (bodyPhrase.test(normalizeSearchText(section.text))) score += 10;
            if (!section.heading && section.text) score += 5;
            // Prefer a focused explanation to the same words in a long index of topics.
            if (section.text) score += 4 / (1 + section.text.length / 500);
            return {...section, ...document, score, id};
        }).sort((a, b) => b.score - a.score || a.id - b.id);
        return {total: ranked.length, results: ranked.slice(0, limit).map(result => ({...result,
            snippet: documentationSnippet(result.text, terms)}))};
    };
}
