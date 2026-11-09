import {docUrl} from '../docsRegistry';
import {t} from '../i18n';
import {createDocumentationSearch} from './DocumentationSearch';
import {searchTerms, searchTermRanges} from './SearchTerms.cjs';

let dialog, lastQuery = '';
const indexes = new Map();

function highlightedText(text, terms) {
    const fragment = document.createDocumentFragment();
    let previous = 0;
    for (const [start, end] of searchTermRanges(text, terms)) {
        fragment.append(document.createTextNode(text.slice(previous, start)));
        const mark = document.createElement('mark');
        mark.textContent = text.slice(start, end);
        fragment.append(mark);
        previous = end;
    }
    fragment.append(document.createTextNode(text.slice(previous)));
    return fragment;
}

async function loadSearch(url) {
    if (!indexes.has(url)) {
        const request = (async () => {
            const response = await fetch(url, {cache: 'no-cache'});
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return createDocumentationSearch(await response.json());
        })();
        indexes.set(url, request);
        request.catch(() => indexes.delete(url));
    }
    return indexes.get(url);
}

export function showDocumentationSearch(indexURL) {
    if (dialog?.isConnected) { dialog.querySelector('input').focus(); return dialog; }
    const previousFocus = document.activeElement;
    const root = document.createElement('dialog');
    dialog = root;
    root.className = 'documentation-search';
    root.setAttribute('aria-labelledby', 'documentation-search-title');
    root.dataset.interactionNative = 'true';

    const style = document.createElement('style');
    style.textContent = `
        .documentation-search {position:fixed;inset:32px 0 auto;margin:0 auto;
            box-sizing:border-box;width:min(760px,94vw);max-height:calc(100dvh - 48px);
            padding:22px;border:1px solid #888;border-radius:8px;overflow:hidden;
            background:var(--sitrec-bg-app,#202020);color:var(--sitrec-text,#eee);font:14px/1.5 system-ui;}
        .documentation-search[open] {display:flex;flex-direction:column;}
        .documentation-search > * {flex-shrink:0;}
        .documentation-search::backdrop {background:#0008;}
        .documentation-search .search-heading {display:flex;gap:16px;align-items:center;justify-content:space-between;}
        .documentation-search h2 {margin:0;font-size:20px;}
        .documentation-search button {padding:8px 12px;cursor:pointer;}
        .documentation-search label {display:block;margin:16px 0 6px;}
        .documentation-search input {box-sizing:border-box;width:100%;padding:10px;font:inherit;
            background:var(--sitrec-bg-input,#303030);color:inherit;border:1px solid #888;border-radius:4px;}
        .documentation-search .search-status {margin:12px 0;}
        .documentation-search ol {list-style:none;margin:0;padding:0;min-height:0;flex-shrink:1;
            overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;}
        .documentation-search li {padding:12px 0;border-top:1px solid #8885;overflow-wrap:anywhere;}
        .documentation-search a {color:var(--sitrec-accent,#75baff);font-weight:600;text-decoration:underline;}
        .documentation-search .search-section {display:block;font-weight:400;font-size:13px;}
        .documentation-search mark {background:#ffe08a;color:#171717;border-radius:2px;}
        .documentation-search p {margin:6px 0 0;}
        @media(max-width:480px) {.documentation-search {padding:14px;}}
    `;
    root.append(style);
    const header = document.createElement('div');
    header.className = 'search-heading';
    const title = document.createElement('h2');
    title.id = 'documentation-search-title';
    title.textContent = t('documentationSearch.title');
    const close = document.createElement('button');
    close.type = 'button'; close.textContent = t('documentationSearch.close');
    close.onclick = () => root.close();
    header.append(title, close);
    const label = document.createElement('label');
    label.htmlFor = 'documentation-search-query';
    label.textContent = t('documentationSearch.label');
    const input = document.createElement('input');
    input.id = label.htmlFor;
    input.type = 'search'; input.maxLength = 200;
    input.placeholder = t('documentationSearch.placeholder');
    input.value = lastQuery;
    const status = document.createElement('p');
    status.className = 'search-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const retry = document.createElement('button');
    retry.type = 'button'; retry.hidden = true;
    retry.textContent = t('documentationSearch.retry');
    const results = document.createElement('ol');
    results.setAttribute('aria-label', t('documentationSearch.results'));
    root.append(header, label, input, status, retry, results);

    let search, timer;
    const renderResults = () => {
        lastQuery = input.value;
        if (!search) return;
        results.replaceChildren();
        const terms = searchTerms(input.value);
        if (!terms.length) {
            status.textContent = t('documentationSearch.prompt');
            return;
        }
        const found = search(input.value);
        status.textContent = found.total ? t('documentationSearch.count', {
            shown: found.results.length, total: found.total,
        }) : t('documentationSearch.noResults');
        for (const result of found.results) {
            const item = document.createElement('li');
            const link = document.createElement('a');
            link.href = docUrl(result.file, {anchor: result.anchor});
            link.target = '_blank'; link.rel = 'noopener noreferrer';
            link.append(highlightedText(result.title, terms));
            if (result.heading) {
                const heading = document.createElement('span');
                heading.className = 'search-section';
                heading.append(highlightedText(result.heading, terms));
                link.append(heading);
            }
            const snippet = document.createElement('p');
            snippet.append(highlightedText(result.snippet, terms));
            item.append(link, snippet); results.append(item);
        }
    };
    const load = async () => {
        retry.hidden = true;
        status.textContent = t('documentationSearch.loading');
        try {
            search = await loadSearch(indexURL);
            if (root.isConnected) renderResults();
        } catch {
            if (!root.isConnected) return;
            status.textContent = t('documentationSearch.failed');
            retry.hidden = false;
        }
    };
    retry.onclick = load;
    input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(renderResults, 100);
    });
    // Keep typing, Tab, arrows and Escape inside the native modal instead of
    // forwarding them to playback, tracking and other application shortcuts.
    for (const name of ['keydown', 'keyup', 'pointerdown', 'pointerup', 'wheel']) {
        root.addEventListener(name, event => event.stopPropagation());
    }
    root.addEventListener('close', () => {
        clearTimeout(timer); lastQuery = input.value;
        root.remove(); dialog = null;
        if (previousFocus?.isConnected) previousFocus.focus();
    }, {once: true});
    document.body.append(root);
    root.showModal(); input.focus();
    load();
    return root;
}
