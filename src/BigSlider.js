/**
 * The big slider.
 *
 * Rest the pointer on any lil-gui slider for three seconds and a full-width bar
 * pops up near the bottom of the window. Dragging that bar drives the very same
 * controller - it calls the controller's own _dragStart/_dragMove, so elastic
 * ranges, wrapping sliders and wrapReceiver carries all behave exactly as they do
 * on the little slider in the menu, only with a screen's worth of travel instead
 * of a hundred pixels. A read-out box (the frame slider's, shared via CValueBox)
 * follows the knob.
 *
 * Clicking anywhere off the bar dismisses it, and that click does nothing else:
 * while the popup is up, every pointer event in the page is intercepted in the
 * CAPTURE phase at the window - above every document-level listener in Sitrec -
 * and only re-emitted as a drag on the bar itself.
 */

import {CValueBox} from "./CValueBox";

// How long the pointer must rest on a normal slider before the big one appears.
const HOVER_DELAY_MS = 3000;

// Above the menu bar (9000/9001) and the frame slider (1001-1004), below the modal
// dialogs in showError.js (10000).
const Z_INDEX = 9500;

// Gap between the top of the bar and the read-out box that floats above it.
const BOX_GAP = 10;

// Every pointer event that could make something happen if it reached the page.
// Movement is deliberately absent: it drives the drag, and it has no side effects.
const SWALLOWED_EVENTS = ['pointerdown', 'pointerup', 'pointercancel', 'mousedown',
    'mouseup', 'click', 'dblclick', 'contextmenu', 'wheel'];

// The one big slider that can be up at a time. Null when nothing is showing.
let open = null;

export function bigSliderIsOpen() {
    return open !== null;
}

/**
 * Arm the hover-to-open behavior on one lil-gui number controller. Called once per
 * slider, from the _initSlider patch in lil-gui-slider-settings.js.
 * @param {object} controller - a lil-gui NumberController that has a $slider
 */
export function armBigSlider(controller) {
    const slider = controller.$slider;
    if (!slider) return;

    let timer = null;

    const cancel = () => {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
    };

    slider.addEventListener('mouseenter', () => {
        cancel();
        if (open !== null) return;
        timer = setTimeout(() => {
            timer = null;
            openBigSlider(controller);
        }, HOVER_DELAY_MS);
    });

    slider.addEventListener('mouseleave', cancel);

    // A press means the user is already driving the small slider, and a wheel means
    // they are already changing the value. Neither wants a popup landing on top.
    slider.addEventListener('pointerdown', cancel);
    slider.addEventListener('wheel', cancel);
}

/**
 * Show the big slider for a controller.
 * @param {object} controller - a lil-gui NumberController
 */
export function openBigSlider(controller) {
    if (open !== null) return;
    // The menu can be rebuilt or destroyed during the three-second wait.
    if (!controller.$slider || !controller.domElement.isConnected) return;

    const backdrop = document.createElement('div');
    backdrop.className = 'sitrec-bigslider-backdrop';

    const panel = document.createElement('div');
    panel.className = 'sitrec-bigslider-panel';

    const title = document.createElement('div');
    title.className = 'sitrec-bigslider-title';
    title.textContent = controller._name;

    const track = document.createElement('div');
    track.className = 'sitrec-bigslider-track';

    const fill = document.createElement('div');
    fill.className = 'sitrec-bigslider-fill';
    track.appendChild(fill);

    const ends = document.createElement('div');
    ends.className = 'sitrec-bigslider-ends';
    const minLabel = document.createElement('div');
    const maxLabel = document.createElement('div');
    ends.appendChild(minLabel);
    ends.appendChild(maxLabel);

    panel.appendChild(title);
    panel.appendChild(track);
    panel.appendChild(ends);
    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);

    // Sit the read-out just above the bar. Measured rather than assumed, because the
    // panel's height depends on the title and the end labels.
    const trackTop = track.getBoundingClientRect().top;
    const box = new CValueBox({
        bottom: (window.innerHeight - trackTop + BOX_GAP) + 'px',
        zIndex: Z_INDEX + 1,
        fontSize: '16px',
    });

    open = {controller, backdrop, panel, track, fill, minLabel, maxLabel, box,
        rafID: null, dragPointerID: null, lastPercent: null};

    syncBigSlider();
    open.rafID = requestAnimationFrame(tick);

    for (const type of SWALLOWED_EVENTS) {
        window.addEventListener(type, onWindowPointerEvent, true);
    }
    window.addEventListener('pointermove', onWindowPointerMove, true);
    window.addEventListener('keydown', onWindowKeyDown, true);
}

export function closeBigSlider() {
    if (open === null) return;
    const {controller, backdrop, track, box, rafID, dragPointerID} = open;

    // Escape can arrive mid-drag, so end the drag properly rather than leaving the
    // body stuck in lil-gui's ew-resize cursor with a live pointer capture.
    if (dragPointerID !== null) {
        if (track.hasPointerCapture(dragPointerID)) track.releasePointerCapture(dragPointerID);
        controller._setDraggingStyle(false);
        controller._callOnFinishChange();
    }

    cancelAnimationFrame(rafID);
    for (const type of SWALLOWED_EVENTS) {
        window.removeEventListener(type, onWindowPointerEvent, true);
    }
    window.removeEventListener('pointermove', onWindowPointerMove, true);
    window.removeEventListener('keydown', onWindowKeyDown, true);

    box.dispose();
    backdrop.remove();
    open = null;
}

// Redraw the fill and the read-out from the controller's current value. Runs every
// frame while the popup is up, so the bar also tracks changes made from elsewhere
// (an animating value, a linked controller) and not just its own drag.
function syncBigSlider() {
    const {controller, fill, minLabel, maxLabel, box, track} = open;

    const percent = controller._fillPercent();
    if (percent !== open.lastPercent) {
        fill.style.width = (percent * 100) + '%';
        open.lastPercent = percent;
    }

    // The ends move under an elastic slider, so they are re-read, not cached.
    minLabel.textContent = endLabel(controller, controller._min);
    maxLabel.textContent = endLabel(controller, controller._max);

    const rect = track.getBoundingClientRect();
    box.show(controller.displayText(), rect.left + percent * rect.width);
}

function tick() {
    if (open === null) return;
    // A controller's onChange can rebuild the menu it lives in, which destroys this
    // controller. Dragging on after that would be writing to an orphan, so bail out.
    if (!open.controller.domElement.isConnected) {
        closeBigSlider();
        return;
    }
    syncBigSlider();
    open.rafID = requestAnimationFrame(tick);
}

// Format one end of the range the same way the controller formats its value.
function endLabel(controller, raw) {
    const value = controller._isLog ? Math.pow(10, raw) : raw;
    if (!Number.isFinite(value)) return String(value);
    return controller._decimals === undefined ? String(value) : value.toFixed(controller._decimals);
}

// Every press, release and click in the page while the popup is up. Handled at the
// window in the capture phase, which is upstream of every document-level listener
// in Sitrec (the menu bar's close-on-outside-click, the UI logger, the feature
// manager), so a click that dismisses the popup cannot also do something else.
function onWindowPointerEvent(e) {
    e.stopPropagation();

    if (e.type === 'pointerdown' && open.track.contains(e.target)) {
        startDrag(e);
        return;
    }

    if (e.type === 'pointerup' || e.type === 'pointercancel') {
        if (open.dragPointerID !== null && e.pointerId === open.dragPointerID) endDrag();
        return;
    }

    // Dismiss on the click rather than the press, so the whole press-release-click
    // sequence lands on the backdrop and nothing underneath ever sees a stray half
    // of it. A press on the panel's own furniture (title, end labels) is ignored.
    if (e.type === 'click' && !open.panel.contains(e.target)) {
        e.preventDefault();
        closeBigSlider();
    }
}

function onWindowPointerMove(e) {
    if (open.dragPointerID === null || e.pointerId !== open.dragPointerID) return;
    open.controller._dragMove(e.clientX, open.track);
    syncBigSlider();
}

function onWindowKeyDown(e) {
    if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        closeBigSlider();
    }
}

function startDrag(e) {
    if (e.button === 2) return;         // right-click is the settings menu's, not ours
    if (open.dragPointerID !== null) return;
    e.preventDefault();                 // no text selection, no focus change

    const {controller, track} = open;
    // The drag runs off window-level listeners, so capture is a bonus rather than a
    // requirement: it keeps the pointer feeding us after it leaves the browser
    // window. If the browser refuses it, drag anyway.
    try {
        track.setPointerCapture(e.pointerId);
    } catch (err) {
        // no capture available for this pointer
    }
    open.dragPointerID = e.pointerId;
    track.classList.add('active');
    controller._setDraggingStyle(true);
    controller._dragStart(e.clientX, track);
    syncBigSlider();
}

function endDrag() {
    const {controller, track, dragPointerID} = open;
    if (track.hasPointerCapture(dragPointerID)) track.releasePointerCapture(dragPointerID);
    open.dragPointerID = null;
    track.classList.remove('active');
    controller._setDraggingStyle(false);
    controller._callOnFinishChange();
}
