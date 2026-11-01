// DropdownWatch.js
//
// Writes one console line for each use of a lil-gui dropdown, so that Help > Export Debug Log
// shows what happened to the menu. Added for forum thread #15159 "Dropdowns unresponsive".
//
// While a native macOS menu is up, the page gets no pointer or focus events and cannot see the
// click. A lost pick therefore looks the same as a cancelled menu. So the watcher records what the
// page CAN see: a change event, the select leaving the page, the focus or the pointer going away,
// the option list changing, and the main thread stalling. Several closes in a row on one control
// with no pick are logged as a warning.
//
// It sends nothing over the network, and it polls only while a dropdown is in use. It logs the
// control's name and whether its value changed, never the value or the panel title, because
// those can be a user's own file or track name, and the log can be exported and posted.
//
// runWhenDropdownsClosed() is here too, because destroying an open dropdown closes its menu and
// loses the pick. It logs each wait, so the debug log still shows work that finished during a menu.

const POLL_MS = 50;
const HOLD_RETRY_MS = 200;
const OPEN_WAIT_MS = 2000;       // a slow machine can take a moment to show the menu
const SETTLE_MS = 3000;          // a pick or a focus loss can reach the page after the close
const REPEAT_WINDOW_MS = 30000;  // closes further apart than this are not one problem
const SUSPECT_REPEATS = 2;       // one close with no pick is a normal cancel

let watch = null;
let lastNoPick = null;

/**
 * Names what the page saw close the menu. "none seen" means that no pick arrived and the page
 * did nothing to the menu: either the user cancelled it, or the browser lost the pick.
 */
export function dropdownCloseCause(record) {
    if (record.changeEvents > 0) {
        return record.inPageAtEnd && record.valueAfter === record.valueBefore ? "pick undone" : "pick";
    }
    if (!record.inPageAtClose) return "panel rebuilt";

    const beforeClose = (time) => time !== null && time <= record.closedAt;
    if (beforeClose(record.focusLostAt)) {
        if (beforeClose(record.mouseLeftAt)) return "mouse left panel";
        if (beforeClose(record.windowBlurAt)) return "window lost focus";
        return "focus lost";
    }
    return "none seen";
}

function offsetFromClose(time, closedAt) {
    if (time === null) return "no";
    const offset = Math.round(time - closedAt);
    return `${offset >= 0 ? "+" : ""}${offset} ms`;
}

export function formatDropdownClose(record, cause, noPickCount) {
    const fromClose = (time) => offsetFromClose(time, record.closedAt);
    return `Dropdown "${record.label}": cause=${cause}`
        + `, valueChanged=${record.valueAfter !== record.valueBefore}`
        + `, open ${Math.round(record.closedAt - record.openedAt)} ms`
        + `, changeEvents=${record.changeEvents}`
        + `, inPageAtClose=${record.inPageAtClose}`
        + `, focusedAtClose=${record.focusedAtClose}`
        + `, focusLost=${fromClose(record.focusLostAt)}`
        + `, mouseLeft=${fromClose(record.mouseLeftAt)}`
        + `, windowBlur=${fromClose(record.windowBlurAt)}`
        + `, optionChanges=${record.optionChanges}`
        + `, longestStall=${Math.round(record.longestStall)} ms at ${fromClose(record.longestStallAt)}`
        + `, noPickCount=${noPickCount}`;
}

function controlLabel(select) {
    return select.closest(".controller")?.querySelector(".name")?.textContent ?? "";
}

function countNoPicks(record, cause) {
    if (cause === "pick") {
        lastNoPick = null;
        return 0;
    }
    const isRepeat = lastNoPick?.label === record.label
        && record.closedAt - lastNoPick.closedAt < REPEAT_WINDOW_MS;
    lastNoPick = {label: record.label, closedAt: record.closedAt, count: isRepeat ? lastNoPick.count + 1 : 1};
    return lastNoPick.count;
}

function noteClose(record, now) {
    record.closedAt = now;
    record.inPageAtClose = record.select.isConnected;
    record.focusedAtClose = document.activeElement === record.select;
}

function finishWatch() {
    const record = watch;
    watch = null;
    record.stop();

    if (record.openedAt === null) {
        console.warn(`Dropdown "${record.label}": menu did not open`);
        return;
    }
    if (record.closedAt === null) noteClose(record, performance.now());

    record.inPageAtEnd = record.select.isConnected;
    record.valueAfter = record.select.value;

    const cause = dropdownCloseCause(record);
    const noPickCount = countNoPicks(record, cause);
    const line = formatDropdownClose(record, cause, noPickCount);
    const isExpected = cause === "pick" || (cause === "none seen" && noPickCount < SUSPECT_REPEATS);
    if (isExpected) {
        console.log(line);
    } else {
        console.warn(line);
    }
}

function tick() {
    const record = watch;
    const now = performance.now();
    const gap = now - record.lastTick;
    if (gap > record.longestStall) {
        record.longestStall = gap;
        record.longestStallAt = now;
    }
    record.lastTick = now;

    const isOpen = record.select.matches(":open");
    if (record.openedAt === null) {
        if (isOpen) {
            record.openedAt = now;
        } else if (now - record.startedAt >= OPEN_WAIT_MS) {
            finishWatch();
        }
    } else if (record.closedAt === null) {
        if (!isOpen) noteClose(record, now);
    } else if (now - record.closedAt >= SETTLE_MS) {
        finishWatch();
    }
}

function startWatch(select) {
    const now = performance.now();
    const record = {
        select,
        label: controlLabel(select),
        valueBefore: select.value,
        valueAfter: select.value,
        startedAt: now,
        lastTick: now,
        openedAt: null,
        closedAt: null,
        inPageAtClose: true,
        inPageAtEnd: true,
        focusedAtClose: true,
        changeEvents: 0,
        optionChanges: 0,
        focusLostAt: null,
        mouseLeftAt: null,
        windowBlurAt: null,
        longestStall: 0,
        longestStallAt: null,
    };

    const listeners = new AbortController();
    const {signal} = listeners;
    select.addEventListener("change", () => record.changeEvents++, {signal});
    select.addEventListener("focusout", () => {
        record.focusLostAt ??= performance.now();
    }, {signal});
    window.addEventListener("blur", () => {
        record.windowBlurAt ??= performance.now();
    }, {signal});
    select.closest(".lil-gui.root")?.addEventListener("mouseleave", () => {
        record.mouseLeftAt ??= performance.now();
    }, {signal});

    const optionObserver = new MutationObserver((mutations) => {
        record.optionChanges += mutations.length;
    });
    optionObserver.observe(select, {childList: true});

    const timer = setInterval(tick, POLL_MS);
    record.stop = () => {
        clearInterval(timer);
        listeners.abort();
        optionObserver.disconnect();
    };
    watch = record;
}

function onMouseDown(event) {
    const select = event.target;
    if (select?.tagName !== "SELECT" || !select.closest(".lil-gui")) return;
    if (watch) finishWatch();
    startWatch(select);
}

// A selector that the browser does not know makes matches() and querySelector() throw.
function canReportOpenMenu() {
    return globalThis.CSS?.supports?.("selector(select:open)") ?? false;
}

function hasOpenDropdown(menu) {
    return canReportOpenMenu() && menu.domElement.querySelector("select:open") !== null;
}

function endHold(menu) {
    clearTimeout(menu._dropdownHold.timer);
    const waited = Math.round(performance.now() - menu._dropdownHold.since);
    menu._dropdownHold = null;
    return waited;
}

function runHeldAction(menu) {
    const {action} = menu._dropdownHold;
    const waited = endHold(menu);
    console.log(`Dropdown: panel update waited ${waited} ms for an open menu`);
    action();
}

/**
 * Runs `action` now, or, if a dropdown in `menu` is open, once it has closed. While it waits, a
 * newer action replaces the older one.
 *
 * @param {GUI} menu - The lil-gui menu that `action` changes
 * @param {Function} action - The work to run
 */
export function runWhenDropdownsClosed(menu, action) {
    if (menu._dropdownHold) {
        menu._dropdownHold.action = action;
        if (!hasOpenDropdown(menu)) runHeldAction(menu);
        return;
    }
    if (!hasOpenDropdown(menu)) {
        action();
        return;
    }

    const hold = {action, since: performance.now(), timer: null};
    const retry = () => {
        if (hasOpenDropdown(menu)) {
            hold.timer = setTimeout(retry, HOLD_RETRY_MS);
        } else {
            runHeldAction(menu);
        }
    };
    hold.timer = setTimeout(retry, HOLD_RETRY_MS);
    menu._dropdownHold = hold;
}

/**
 * Drops a waiting action. Call this when `menu` is destroyed.
 */
export function cancelDropdownHold(menu) {
    if (menu._dropdownHold) endHold(menu);
}

/**
 * Starts the watcher. It does nothing on a browser that cannot report an open menu.
 */
export function initDropdownWatch() {
    if (!canReportOpenMenu()) return;
    document.addEventListener("mousedown", onMouseDown, true);
    console.log("Dropdown watch on:", navigator.userAgent);
}
