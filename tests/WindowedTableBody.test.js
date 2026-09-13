/**
 * @jest-environment jsdom
 */
// WindowedTableBody.test.js — the table body that draws only the rows in view.
//
// What this replaced: a BOTBench run kept one <tr> per file, so at 4,191 rows one
// status-cell edit cost 380-480 ms of layout, and the page spent more than half its
// time on layout. These tests pin the properties the fix rests on: the page holds
// only the window, the spacers keep the scroll height of the whole table, and a
// change to the data out of view costs nothing.

import {windowRange, WindowedTableBody} from "../src/analysis/WindowedTableBody";

const ROW = 28;

describe("windowRange", () => {
    const range = (o) => windowRange({rowHeight: ROW, overscan: 5, headerHeight: 0, viewportHeight: 280, ...o});

    test("the rows in view and a buffer below them, at the top of the table", () => {
        expect(range({scrollTop: 0, count: 1000})).toEqual({start: 0, end: 15});
    });
    test("the rows in view and a buffer on each side, part way down", () => {
        // 14,000 px is row 500, and 280 px shows ten rows.
        expect(range({scrollTop: 14000, count: 1000})).toEqual({start: 495, end: 515});
    });
    test("a sticky header hides the top of the viewport, not the top of the table", () => {
        expect(range({scrollTop: 0, count: 1000, viewportHeight: 310, headerHeight: 30}))
            .toEqual({start: 0, end: 15});
    });
    test("never past either end", () => {
        expect(range({scrollTop: 560, count: 20})).toEqual({start: 15, end: 20});
        expect(range({scrollTop: 0, count: 3})).toEqual({start: 0, end: 3});
    });
    test("an empty range when there is nothing to draw, or no row height to draw it with", () => {
        expect(range({scrollTop: 0, count: 0})).toEqual({start: 0, end: 0});
        expect(range({scrollTop: 0, count: 10, rowHeight: 0})).toEqual({start: 0, end: 0});
        expect(range({scrollTop: 10000, count: 10})).toEqual({start: 10, end: 10});
    });
});

function makeTable({count = 1000, viewport = 280, header = 0, overscan = 5, paint = null} = {}) {
    document.body.innerHTML = "";
    const scroller = document.createElement("div");
    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const tbody = document.createElement("tbody");
    table.append(thead, tbody);
    scroller.appendChild(table);
    document.body.appendChild(scroller);
    // jsdom does no layout, so the three measurements the body reads are supplied.
    let scrollTop = 0;
    Object.defineProperty(scroller, "scrollTop", {
        configurable: true, get: () => scrollTop, set: (value) => { scrollTop = Math.max(0, Number(value)); },
    });
    Object.defineProperty(scroller, "clientHeight", {configurable: true, get: () => viewport});
    Object.defineProperty(thead, "offsetHeight", {configurable: true, get: () => header});

    const items = Array.from({length: count}, (_, i) => ({name: `item ${i}`}));
    const painted = [];
    const body = new WindowedTableBody({
        tbody, scroller, header: thead, columnCount: 2, rowHeight: ROW, overscan,
        getCount: () => items.length,
        getItem: (index) => items[index],
        createRow: () => {
            const tr = document.createElement("tr");
            const td = document.createElement("td");
            tr.appendChild(td);
            return {tr, td};
        },
        paintRow: paint ?? ((row, item, index) => { row.td.textContent = item.name; painted.push(index); }),
    });
    return {body, tbody, scroller, items, painted};
}

// The drawn rows, which sit between the two spacers.
const drawn = (tbody) => [...tbody.children].slice(1, -1).map((tr) => tr.textContent);
const names = (from, to) => Array.from({length: to - from}, (_, i) => `item ${from + i}`);
const spacers = (tbody) => [tbody.firstElementChild, tbody.lastElementChild]
    .map((tr) => (tr.style.display === "none" ? 0 : parseFloat(tr.firstElementChild.style.height)));

describe("WindowedTableBody", () => {
    afterEach(() => { jest.useRealTimers(); });

    test("the page holds only the window, in order, and the spacers stand in for the rest", () => {
        const {body, tbody} = makeTable();
        body.render();
        expect(drawn(tbody)).toEqual(names(0, 15));
        expect(spacers(tbody)).toEqual([0, 985 * ROW]);
    });

    test("scrolling part way down draws those rows", () => {
        const {body, tbody, scroller} = makeTable();
        scroller.scrollTop = 14000;
        body.render();
        expect(drawn(tbody)).toEqual(names(495, 515));
        expect(spacers(tbody)).toEqual([495 * ROW, 485 * ROW]);
    });

    test("the height of the whole table is kept however far it is scrolled", () => {
        const {body, tbody, scroller} = makeTable();
        for (const px of [0, 3000, 14000, 27720]) {
            scroller.scrollTop = px;
            body.render();
            const [above, below] = spacers(tbody);
            expect(above + drawn(tbody).length * ROW + below).toBe(1000 * ROW);
        }
    });

    test("rows are reused, so scrolling the whole table makes no more rows than one window holds", () => {
        const {body, tbody, scroller} = makeTable();
        for (let px = 0; px <= 1000 * ROW; px += 97) {
            scroller.scrollTop = px;
            body.render();
            expect(tbody.children.length - 2).toBe(body.renderedCount);
        }
        // Ten rows fit in 280 px, but a scroll position between two rows shows part
        // of one more, so eleven are in view, with five on each side.
        expect(body.rowsCreated).toBeLessThanOrEqual(21);
    });

    test("a small scroll paints only the rows that came into the window", () => {
        const {body, scroller, painted} = makeTable();
        body.render();
        painted.length = 0;
        scroller.scrollTop = 3 * ROW;
        body.render();
        expect(painted).toEqual([15, 16, 17]);
    });

    test("a change to a row out of view costs nothing", () => {
        jest.useFakeTimers();
        const {body, items, painted} = makeTable();
        body.render();
        painted.length = 0;
        items[900].name = "changed";
        body.invalidate(900);
        jest.advanceTimersByTime(1000);
        expect(painted).toEqual([]);
    });

    test("changes to a row in view are drawn once, at the end of the batch", () => {
        jest.useFakeTimers();
        const {body, tbody, items, painted} = makeTable();
        body.render();
        painted.length = 0;
        for (const progress of ["10%", "20%", "30%"]) {
            items[3].name = progress;
            body.invalidate(3);
        }
        jest.advanceTimersByTime(249);
        expect(painted).toEqual([]);
        jest.advanceTimersByTime(1);
        expect(painted).toEqual([3]);
        expect(drawn(tbody)[3]).toBe("30%");
    });

    test("new items extend the scroll height at the end of the batch", () => {
        jest.useFakeTimers();
        const {body, tbody, items} = makeTable();
        body.render();
        for (let i = 0; i < 100; i++) items.push({name: `item ${1000 + i}`});
        body.countChanged();
        expect(spacers(tbody)[1]).toBe(985 * ROW);
        jest.advanceTimersByTime(250);
        expect(spacers(tbody)[1]).toBe(1085 * ROW);
    });

    test("scrollToIndex moves the least distance that shows the whole row", () => {
        const {body, tbody, scroller} = makeTable({header: 30, viewport: 310});
        body.scrollToIndex(500);
        // The bottom of row 500 comes to the bottom of the 280 px below the header.
        expect(scroller.scrollTop).toBe(501 * ROW - 280);
        expect(drawn(tbody)).toContain("item 500");
        const settled = scroller.scrollTop;
        body.scrollToIndex(495);     // already in view: no movement
        expect(scroller.scrollTop).toBe(settled);
        body.scrollToIndex(10);      // above the view: its top comes to the top
        expect(scroller.scrollTop).toBe(10 * ROW);
        expect(drawn(tbody)).toContain("item 10");
    });

    test("refreshRow repaints a row in view at once, and ignores one out of view", () => {
        const {body, tbody, items, painted} = makeTable();
        body.render();
        painted.length = 0;
        items[2].name = "opening…";
        body.refreshRow(2);
        body.refreshRow(700);
        expect(painted).toEqual([2]);
        expect(drawn(tbody)[2]).toBe("opening…");
    });

    test("replacing the items at the same indices repaints every row", () => {
        const {body, tbody, items} = makeTable();
        body.render();
        items.splice(0, items.length, ...Array.from({length: 1000}, (_, i) => ({name: `new ${i}`})));
        body.render();
        expect(drawn(tbody)).toHaveLength(15);
        expect(drawn(tbody)[0]).toBe("new 0");
    });

    test("an emptied data set leaves no rows behind", () => {
        const {body, tbody, items} = makeTable();
        body.render();
        items.length = 0;
        body.reset();
        expect(drawn(tbody)).toEqual([]);
        expect(spacers(tbody)).toEqual([0, 0]);
    });

    test("a row that fails to paint does not stop the others", () => {
        const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
        const {body, tbody} = makeTable({
            paint: (row, item, index) => {
                if (index === 4) throw new Error("bad row");
                row.td.textContent = item.name;
            },
        });
        body.render();
        expect(drawn(tbody)).toHaveLength(15);
        expect(drawn(tbody)[5]).toBe("item 5");
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });

    test("after dispose, neither a scroll nor a pending batch draws anything", () => {
        jest.useFakeTimers();
        const {body, scroller, painted} = makeTable();
        body.render();
        body.invalidate(3);
        body.dispose();
        painted.length = 0;
        scroller.dispatchEvent(new Event("scroll"));
        jest.advanceTimersByTime(1000);
        expect(painted).toEqual([]);
    });
});
