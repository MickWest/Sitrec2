import {t} from "./i18n";

// The localization path for native panels. All text is in src/i18n/en.js.
//
// A template does not hold text. It names each string with a key:
//   data-i18n="key"               the text of the element
//   data-i18n-title="key"         the tooltip
//   data-i18n-placeholder="key"   the placeholder of an input
//   data-i18n-label="key"         the aria-label
// localizeElements(root) fills them. It writes with textContent and setAttribute,
// so a translation cannot add markup.
//
// Code that makes text at run time calls t(key, values) from "./i18n".

const ATTRIBUTES = [["i18nTitle", "title"], ["i18nPlaceholder", "placeholder"], ["i18nLabel", "aria-label"]];
const SELECTOR = "[data-i18n], [data-i18n-title], [data-i18n-placeholder], [data-i18n-label]";

export function localizeElements(root) {
    const elements = [...root.querySelectorAll(SELECTOR)];
    if (root.matches?.(SELECTOR)) elements.unshift(root);
    for (const element of elements) {
        const data = element.dataset;
        if (data.i18n) element.textContent = t(data.i18n);
        for (const [name, attribute] of ATTRIBUTES) {
            if (data[name]) element.setAttribute(attribute, t(data[name]));
        }
    }
    return root;
}

// The title of a definition: `titleKey` names a string, `title` is fixed text.
export function titleText(item) {
    return item?.titleKey ? t(item.titleKey) : item?.title;
}
