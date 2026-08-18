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
 *
 * ELASTIC SLIDERS are the one thing that cannot simply be inherited. An elastic
 * range grows when the pointer goes PAST the end of the track, so the real budget
 * for growth is the screen between the slider and the edge of the window: a menu
 * slider is ~80px wide with sixteen track widths of room to its right, while this
 * bar is as wide as the window and has a ~48px gutter - one doubling, then stuck.
 * So the bar turns that distance rule off (allowElasticRange = false) and grows the
 * range from TIME instead: hold a drag in one of the end zones and the range steps
 * every ZONE_STEP_MS, out to _elasticMax or back to _elasticMin.
 */

import {CValueBox} from "./CValueBox";

// How long the pointer must rest on a normal slider before the big one appears.
const HOVER_DELAY_MS = 3000;

// The strip at each end of the bar where holding a drag resizes an elastic range:
// the left one shrinks it, the right one grows it. Only elastic sliders get them;
// on every other slider the whole bar is value travel. The zone reaches outward
// past the end of the bar as well, so the gutter behaves the same as the strip.
const ZONE_PX = 60;

// Crossing a zone on the way to the end of the bar must not resize anything, so the
// first step waits longer than the ones that follow it.
const ZONE_FIRST_STEP_MS = 450;
const ZONE_STEP_MS = 300;

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

    // Added after the fill so they paint over it, and never hit targets themselves -
    // the press belongs to the track underneath, which is what startDrag looks for.
    // Width is set here rather than in the stylesheet so ZONE_PX stays the one place
    // the size is written down.
    let zoneLow = null;
    let zoneHigh = null;
    if (controller._elastic) {
        zoneLow = makeZone('low', '«');
        zoneHigh = makeZone('high', '»');
        track.appendChild(zoneLow);
        track.appendChild(zoneHigh);
    }

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
        zoneLow, zoneHigh, rafID: null, dragPointerID: null, lastPercent: null,
        zoneDir: 0, zoneStepAt: 0, lastX: 0};

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
    stepElasticZone();
    syncBigSlider();
    open.rafID = requestAnimationFrame(tick);
}

// One end zone of the bar. Marked but inert: pointer-events are off, so a press in a
// zone still lands on the track and startDrag still sees it.
function makeZone(side, glyph) {
    const zone = document.createElement('div');
    zone.className = 'sitrec-bigslider-zone ' + side;
    zone.style.width = ZONE_PX + 'px';
    zone.textContent = glyph;
    return zone;
}

// Which end zone the pointer is in: +1 right (grow), -1 left (shrink), 0 neither.
// Deliberately unbounded outward, so the gutter between the bar and the edge of the
// window counts as part of the zone it sits next to.
function zoneAt(clientX) {
    const {controller, track} = open;
    if (!controller._elastic) return 0;
    const rect = track.getBoundingClientRect();
    if (clientX >= rect.right - ZONE_PX) return 1;
    if (clientX <= rect.left + ZONE_PX) return -1;
    return 0;
}

// Follow the pointer into and out of the end zones. Entering one restarts the step
// clock, so the wait before the first resize is spent inside that zone rather than
// carried over from a previous one.
function setZone(clientX) {
    const dir = open.dragPointerID === null ? 0 : zoneAt(clientX);
    if (dir !== open.zoneDir) {
        open.zoneDir = dir;
        open.zoneStepAt = performance.now() + ZONE_FIRST_STEP_MS;
        if (open.zoneLow) open.zoneLow.classList.toggle('active', dir === -1);
        if (open.zoneHigh) open.zoneHigh.classList.toggle('active', dir === 1);
    }
    open.lastX = clientX;
}

// The elastic resize itself, run from the animation frame because it is driven by
// how long the pointer has been held rather than by how far it has moved.
function stepElasticZone() {
    const {controller, track, zoneDir} = open;
    if (zoneDir === 0 || open.dragPointerID === null) return;

    const now = performance.now();
    if (now < open.zoneStepAt) return;
    open.zoneStepAt = now + ZONE_STEP_MS;

    // False means the range is already against _elasticMin/_elasticMax.
    if (!controller._elasticStepRange(zoneDir > 0)) return;

    // Put the value back where the pointer points in the range that just changed
    // size. The pointer is not moving, so nothing else is going to do it.
    controller._setValueFromX(open.lastX, false, track, false);
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
    open.controller._dragMove(e.clientX, open.track, false);
    setZone(e.clientX);
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
    controller._dragStart(e.clientX, track, false);
    setZone(e.clientX);
    syncBigSlider();
}

function endDrag() {
    const {controller, track, dragPointerID} = open;
    if (track.hasPointerCapture(dragPointerID)) track.releasePointerCapture(dragPointerID);
    open.dragPointerID = null;
    setZone(0);                         // no drag, so this clears the zone highlight
    track.classList.remove('active');
    controller._setDraggingStyle(false);
    controller._callOnFinishChange();
}
