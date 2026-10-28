// The filter box on a long list in the Measurement dialog (MeasurementDialog.js).
//
// Kept apart from the dialog so it can be tested without a DOM. A kind can list thousands of
// items (Satellite holds every loaded catalog satellite), and drawing all of them on every
// redraw makes the dialog slow, so the list shows at most `limit` matches.

// A list longer than this gets a filter box.
export const FILTER_MIN_ITEMS = 12;

// The most rows a list draws.
export const MAX_LIST_ROWS = 300;

// The items whose name or id contains `text` (any case), and how many more matched than are
// returned. An empty filter matches everything.
export function filterSourceItems(items, text, limit = MAX_LIST_ROWS) {
    const needle = (text ?? "").trim().toLowerCase();
    const matches = needle === ""
        ? items
        : items.filter(item => String(item.name).toLowerCase().includes(needle)
            || String(item.id).toLowerCase().includes(needle));
    return {
        shown: matches.slice(0, limit),
        hidden: Math.max(0, matches.length - limit),
    };
}
