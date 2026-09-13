// WindowedTableBody.js — a <tbody> that keeps only the rows in view in the page.
//
// WHY. A table lays out every row it holds, and lays them all out again when any
// cell changes. Measured 2026-09-12 on a BOTBench run over 5,400 files: at 4,191
// rows (108,000 elements) one status-cell edit cost 380-480 ms of layout, and the
// page spent 6.6 s of every 12 s in style and layout against 17 ms in script. The
// run was down to 0.6 files a second. Nothing about the analysis had changed. The
// table had grown.
//
// HOW. The data stays where it is, all of it. This body draws a window onto it —
// the rows in view and a buffer on each side — with an empty row above and below
// whose heights stand in for everything else, so the scroll bar is still the size
// of the whole table. A row that scrolls out of the window is reused for a row that
// scrolls in, so the page holds the same number of elements for a hundred items or
// for ten thousand.
//
// Changes to the data are drawn in batches, at most once per batch interval, and
// only for rows in the window: an item that changes out of view costs nothing.
// Scrolling is drawn on the next frame, since a batch delay there would show blank
// spacer where rows should be.
//
// THE ONE RULE FOR CALLERS: every row is exactly `rowHeight` pixels tall. An index
// becomes a pixel offset by multiplication, so one row that grows by a pixel moves
// every row below it. Style rows so that no content can make one taller.

export const DEFAULT_OVERSCAN = 20;
export const DEFAULT_BATCH_MS = 250;

// Rows kept for reuse after the window shrinks. Beyond this they are let go.
const MAX_POOLED_ROWS = 64;

const requestFrame = (callback) => (typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(callback) : setTimeout(callback, 16));
const cancelFrame = (handle) => (typeof cancelAnimationFrame === "function"
    ? cancelAnimationFrame(handle) : clearTimeout(handle));

/**
 * Which rows to draw, as item indices [start, end).
 *
 * Positions are in the body's own coordinates. The body starts below a sticky
 * header, and that header covers the top of the viewport while the table scrolls,
 * so its height comes off the viewport rather than off the scroll position.
 */
export function windowRange({scrollTop = 0, viewportHeight = 0, headerHeight = 0, rowHeight, count,
    overscan = 0}) {
    if (!(count > 0) || !(rowHeight > 0)) return {start: 0, end: 0};
    const top = Math.max(0, scrollTop);
    const bottom = Math.max(top, scrollTop + viewportHeight - headerHeight);
    const end = Math.min(count, Math.ceil(bottom / rowHeight) + overscan);
    const start = Math.min(end, Math.max(0, Math.floor(top / rowHeight) - overscan));
    return {start, end};
}

export class WindowedTableBody {
    /**
     * @param {object} o
     * @param {HTMLTableSectionElement} o.tbody  the body to own; its children are replaced
     * @param {HTMLElement} o.scroller           the element that scrolls the table
     * @param {HTMLElement} [o.header]           a sticky header inside the scroller, if any
     * @param {number} o.columnCount             how many columns the spacer cells span
     * @param {number} o.rowHeight               the exact height of every row, in pixels
     * @param {() => number} o.getCount          how many items there are now
     * @param {(index: number) => *} o.getItem   the item at an index
     * @param {() => {tr: HTMLTableRowElement}} o.createRow  a new row, to be reused
     * @param {(row: object, item: *, index: number) => void} o.paintRow  write an item into a row
     * @param {number} [o.overscan]              rows drawn beyond the viewport on each side
     * @param {number} [o.batchMs]               the interval for drawing changes to the data
     */
    constructor({tbody, scroller, header = null, columnCount, rowHeight, getCount, getItem,
        createRow, paintRow, overscan = DEFAULT_OVERSCAN, batchMs = DEFAULT_BATCH_MS}) {
        this.tbody = tbody;
        this.scroller = scroller;
        this.header = header;
        this.rowHeight = rowHeight;
        this.getCount = getCount;
        this.getItem = getItem;
        this.createRow = createRow;
        this.paintRow = paintRow;
        this.overscan = overscan;
        this.batchMs = batchMs;

        this.bound = new Map();   // item index -> the row showing it, for the rows in the page
        this.pool = [];           // rows out of the page, ready for reuse
        this.dirty = new Set();   // indices in the window whose item changed since it was painted
        this.start = 0;
        this.end = 0;
        this.rowsCreated = 0;
        this.batchTimer = null;
        this.frame = 0;
        this.disposed = false;
        this.spacerHeights = [-1, -1];

        this.topSpacer = makeSpacer(columnCount);
        this.bottomSpacer = makeSpacer(columnCount);
        tbody.replaceChildren(this.topSpacer, this.bottomSpacer);

        // Scroll anchoring tries to hold a visible row still when content above it
        // changes size, and swapping rows for spacer height is exactly that change.
        // The window already keeps every row at its own offset.
        scroller.style.overflowAnchor = "none";
        this.onScroll = () => this.scheduleFrame();
        scroller.addEventListener("scroll", this.onScroll, {passive: true});
        if (typeof ResizeObserver === "function") {
            this.resizeObserver = new ResizeObserver(() => this.scheduleFrame());
            this.resizeObserver.observe(scroller);
        }
    }

    /** How many rows are in the page now. */
    get renderedCount() { return this.bound.size; }

    /** The row showing an index, or null when that index is out of the window. */
    rowFor(index) { return this.bound.get(index) ?? null; }

    /** The item at an index changed. Drawn at the end of the batch, if it is in the window. */
    invalidate(index) {
        if (!this.bound.has(index)) return;
        this.dirty.add(index);
        this.scheduleBatch();
    }

    /** Items were added or removed. The scroll height follows at the end of the batch. */
    countChanged() { this.scheduleBatch(); }

    /** Repaint one row now, for a change the user has just caused. Nothing if it is out of view. */
    refreshRow(index) {
        const row = this.bound.get(index);
        if (!row) return;
        this.dirty.delete(index);
        this.paint(row, this.getItem(index), index);
    }

    /** Scroll the least distance that shows the whole of a row, and draw it. */
    scrollToIndex(index) {
        if (this.disposed || !(index >= 0 && index < this.getCount())) return;
        // Draw first, so the spacers give the scroller the height of the whole
        // table and the position set below is not clamped to a shorter one.
        this.render();
        const height = this.rowHeight;
        const visible = Math.max(height, this.scroller.clientHeight - (this.header?.offsetHeight ?? 0));
        const rowTop = index * height;
        const top = this.scroller.scrollTop;
        if (rowTop < top) this.scroller.scrollTop = rowTop;
        else if (rowTop + height > top + visible) this.scroller.scrollTop = rowTop + height - visible;
        this.render();
    }

    /** Draw the window for the current scroll position and data. */
    render() {
        if (this.disposed) return;
        if (this.frame) { cancelFrame(this.frame); this.frame = 0; }
        if (this.batchTimer) { clearTimeout(this.batchTimer); this.batchTimer = null; }
        const count = this.getCount();
        // Every measurement before any change, so reading them never forces a
        // layout of changes this call is about to make.
        const {start, end} = windowRange({
            scrollTop: this.scroller.scrollTop,
            viewportHeight: this.scroller.clientHeight,
            headerHeight: this.header?.offsetHeight ?? 0,
            rowHeight: this.rowHeight, count, overscan: this.overscan,
        });
        for (const [index, row] of this.bound) {
            if (index >= start && index < end) continue;
            this.bound.delete(index);
            this.release(row);
        }
        // Rows that stay are already in order, so only the rows coming in move.
        let cursor = this.topSpacer.nextSibling;
        for (let index = start; index < end; index++) {
            const item = this.getItem(index);
            let row = this.bound.get(index);
            if (!row) {
                row = this.pool.pop() ?? this.newRow();
                this.bound.set(index, row);
                this.paint(row, item, index);
            } else if (row.item !== item || this.dirty.has(index)) {
                this.paint(row, item, index);
            }
            if (row.tr === cursor) cursor = cursor.nextSibling;
            else this.tbody.insertBefore(row.tr, cursor);
        }
        this.dirty.clear();
        this.setSpacers(start * this.rowHeight, (count - end) * this.rowHeight);
        this.start = start;
        this.end = end;
    }

    /** Let go of every row, then draw what the data holds now. */
    reset() {
        for (const row of this.bound.values()) this.release(row);
        this.bound.clear();
        this.dirty.clear();
        this.render();
    }

    dispose() {
        this.disposed = true;
        this.scroller.removeEventListener("scroll", this.onScroll);
        this.resizeObserver?.disconnect();
        if (this.frame) cancelFrame(this.frame);
        if (this.batchTimer) clearTimeout(this.batchTimer);
        this.frame = 0;
        this.batchTimer = null;
        for (const row of this.bound.values()) row.item = null;
        this.bound.clear();
        this.pool.length = 0;
        this.dirty.clear();
    }

    // -----------------------------------------------------------------------
    // internals

    scheduleBatch() {
        if (this.batchTimer || this.disposed) return;
        this.batchTimer = setTimeout(() => { this.batchTimer = null; this.render(); }, this.batchMs);
    }

    scheduleFrame() {
        if (this.frame || this.disposed) return;
        this.frame = requestFrame(() => { this.frame = 0; this.render(); });
    }

    newRow() {
        this.rowsCreated++;
        const row = this.createRow();
        row.item = null;
        return row;
    }

    paint(row, item, index) {
        // Recorded before painting, so a row whose paint throws is not retried on
        // every frame. It stays as far as it got, and the warning says which.
        row.item = item;
        try {
            this.paintRow(row, item, index);
        } catch (error) {
            console.warn(`WindowedTableBody: could not draw row ${index}`, error);
        }
    }

    release(row) {
        row.tr.remove();
        // A row waiting to be reused must not keep the last item it showed alive.
        row.item = null;
        if (this.pool.length < MAX_POOLED_ROWS) this.pool.push(row);
    }

    setSpacers(above, below) {
        if (above !== this.spacerHeights[0]) setSpacerHeight(this.topSpacer, above);
        if (below !== this.spacerHeights[1]) setSpacerHeight(this.bottomSpacer, below);
        this.spacerHeights = [above, below];
    }
}

function makeSpacer(columnCount) {
    const tr = document.createElement("tr");
    tr.setAttribute("aria-hidden", "true");
    const td = document.createElement("td");
    td.colSpan = Math.max(1, columnCount);
    td.style.cssText = "padding: 0; border: 0; height: 0;";
    tr.appendChild(td);
    tr.style.display = "none";
    return tr;
}

function setSpacerHeight(tr, height) {
    tr.style.display = height > 0 ? "" : "none";
    tr.firstChild.style.height = `${height}px`;
}
