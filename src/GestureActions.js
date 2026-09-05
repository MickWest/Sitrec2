// Profiles are shared by the input adapters, their tooltips and interaction help.
// Ctrl and Command are aliases only for commands, not for unrelated native keys.
export const commandModifier = event => !!(event.ctrlKey || event.metaKey);

export const WHEEL_PIXELS_PER_STEP = 100;
export function wheelPixels(event, {shiftHorizontal = false, dominant = false} = {}) {
    const finite = n => Number.isFinite(n) ? n : 0;
    const x = finite(event.deltaX), y = finite(event.deltaY);
    const delta = dominant ? (Math.abs(x) > Math.abs(y) ? x : y)
        : shiftHorizontal && event.shiftKey && y === 0 ? x : y;
    // Line/page units have no browser-independent CSS size. Use stable logical
    // units so the same action does not depend on the focused pane's dimensions.
    return delta * (event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 800 : 1);
}

export const GESTURE_PROFILES = Object.freeze({
    camera: {label: "3D camera", wheelScale: .95, gestures: [
        ["Drag", "Move the world"], ["Shift-drag / middle drag", "Orbit the pivot"],
        ["Ctrl/Command-drag / right drag", "Aim the camera"],
        ["Wheel", "Move toward or away from the pointer"], ["Shift-wheel", "Change field of view"],
        ["PTZ mode", "Drags aim; wheel changes field of view"],
        ["Synced camera fit", "Primary drag and wheel move and zoom the video"],
        ["Two fingers", "Pan, pinch to zoom, or twist to rotate"],
    ]},
    video: {label: "Video and images", wheelScale: .9, gestures: [
        ["Drag / one finger", "Pan the image"], ["Wheel / pinch", "Zoom about the pointer"],
        ["Right drag", "Scrub frames"], ["Middle drag", "Zoom"], ["Double-click", "Reset framing"],
    ]},
    handles: {label: "3D handles", gestures: [
        ["Object disc", "Move horizontally, including where the shaft overlaps the disc"],
        ["Arrowheads / exposed shaft", "Change altitude; arrowheads take priority over the disc"],
        ["Building yellow / gray / cyan grips", "Resize footprint / change height / change roofline"],
        ["Outside a building corner grip", "Rotate the building"],
        ["Cloud orange / yellow / cyan grips", "Move / change altitude / change radius"],
        ["Ground-overlay yellow / cyan / magenta grips", "Resize / rotate / move lock points"],
        ["Flood yellow grips", "Resize the simulation boundary"],
        ["Drag / one finger", "Move the selected grip; larger touch targets keep the grab offset"],
    ]},
    tracking: {label: "Manual video tracking", gestures: [
        ["Ctrl/Command-click", "Add or reposition a point"], ["Alt/Option-click", "Delete an A point"],
        ["Drag a point", "Seek to its frame and move it"], ["Shift", "Choose overlapping B handles"],
    ]},
    mask: {label: "Video mask", gestures: [
        ["Primary drag", "Paint the mask"], ["Alt/Option-drag", "Erase"],
        ["Shift-drag", "Paint a rectangle"], ["Alt/Option + Shift-drag", "Erase a rectangle"],
        ["Middle / right drag", "Navigate the video"],
    ]},
    annotation: {label: "Annotations", gestures: [
        ["Choose a toolbar tool, then drag", "Draw, erase, select, move or resize"],
        ["Shift while resizing", "Apply the selection's resize constraint"],
        ["Middle / right drag", "Navigate the video"],
    ]},
    fit: {label: "Camera-fit points", gestures: [
        ["Click empty video", "Add a point"], ["Drag empty video", "Pan without adding a point"],
        ["Drag a point", "Move its observation"], ["Right-click video point", "Delete it"],
        ["Off-frame 3D point", "Select its frame before editing"],
    ]},
    groundTrack: {label: "Ground-track points", gestures: [
        ["Ctrl/Command-click", "Add a keyframe"], ["Alt/Option-click", "Delete a keyframe"],
        ["Click off-frame point", "Seek to its frame"], ["Drag current-frame point", "Move it on the ground"],
    ]},
    curve: {label: "Curve editor", gestures: [
        ["Drag point or segment", "Edit the curve"], ["Ctrl/Command-click", "Add a point"],
        ["Alt/Option-click", "Delete a point"], ["Shift-drag", "Toggle snapping"],
        ["Drag playhead / A / B", "Scrub time / edit frame limits"],
    ]},
    legacyCurve: {label: "Bezier curves", gestures: [
        ["Drag point or tangent", "Edit the curve"], ["Right-click", "Add or delete a point pair"],
        ["Shift-drag", "Carry subsequent points"],
    ]},
    adjustments: {label: "Video adjustments and regions", gestures: [
        ["Drag a grip", "Adjust the value or selection boundary"],
        ["Tone curve click", "Select or insert a point"], ["Delete / Backspace in tone curve", "Remove the selected interior point"],
        ["Region interior / corner / outside", "Move / resize or skew / rotate the region"],
    ]},
    labels: {label: "Video labels", gestures: [["Drag label", "Move the label"], ["Right-click data-series label", "Open its menu"]]},
    limits: {label: "Frame limits", gestures: [["Drag A or B", "Change the in/out frame without moving the playhead"], ["Drag slider", "Scrub frames"]]},
    timeline: {label: "Script timeline", wheelScale: 1.5, gestures: [
        ["Drag top strip or playhead", "Scrub time"], ["Ctrl/Command while scrubbing", "Bypass snapping"],
        ["Drag bar end / bar body", "Edit duration / offset where the command supports it"],
        ["Wheel over a duration", "Adjust duration; Shift makes a larger change"],
        ["Wheel elsewhere", "Pan time"], ["Ctrl/Command-wheel", "Zoom about the pointer"],
        ["Ctrl/Command +, −, 0", "Zoom in, zoom out, reset"],
    ]},
    graph: {label: "Node graph", wheelScale: .9, gestures: [
        ["Drag", "Pan"], ["Wheel", "Zoom about the pointer"],
        ["Right-click node / background", "Isolate connected nodes / restore hidden nodes"],
    ]},
    chart: {label: "3D chart", gestures: [["Drag", "Rotate the chart"]]},
    layout: {label: "Views and panels", gestures: [
        ["Drag header / Q-drag", "Move the view"], ["Drag edge, corner or seam", "Resize views"],
        ["Double-click header", "Maximize or restore"],
    ]},
    brush: {label: "Ground and tree brushes", gestures: [
        ["Primary drag", "Paint or remove trees"], ["Alt/Option", "Erase paint or restore trees"],
        ["Shift-click ground paint", "Connect to the previous dab"], ["Middle / right drag", "Navigate"],
    ]},
    buttons: {label: "Instrument buttons", gestures: [["Click / tap", "Activate the button or cycle the displayed value"]]},
    compass: {label: "Compass", gestures: [
        ["Main compass click / tap", "Face north"], ["Look compass click / tap", "Toggle elevation"],
        ["Look compass touch and hold", "Toggle AR mode on mobile"],
    ]},
    stars: {label: "Star selection", gestures: [["Click / tap a circle", "Toggle that star group"], ["Drag / pinch", "Navigate the video without toggling stars"]]},
    wind: {label: "Wind inspection", gestures: [["Shift-click", "Add a sample"], ["Alt/Option-click", "Remove the nearest sample"], ["Drag", "Navigate without changing samples"]]},
    markers: {label: "Map markers", gestures: [["Click / tap", "Select the marker"], ["Drag", "Navigate the map"]]},
    instrumentScale: {label: "Instrument scale", gestures: [["Wheel", "Step the display scale"]]},
});

export function wheelSteps(event, options) {
    return Math.max(-20, Math.min(20, wheelPixels(event, options) / WHEEL_PIXELS_PER_STEP));
}

export function wheelZoomFactor(event, profile = "video", options) {
    return GESTURE_PROFILES[profile].wheelScale ** wheelSteps(event, options);
}

// Discrete values accumulate small trackpad deltas instead of changing once per
// event. A new field, direction or gesture must not inherit another's remainder.
export class WheelStepAccumulator {
    take(event, key, threshold = WHEEL_PIXELS_PER_STEP) {
        const delta = wheelPixels(event), now = event.timeStamp ?? Date.now();
        if (!delta) return 0;
        if (key !== this.key || now - this.time > 300 || Math.sign(delta) !== Math.sign(this.remainder)) this.remainder = 0;
        this.key = key; this.time = now;
        this.remainder += Math.max(-2000, Math.min(2000, delta));
        const steps = Math.trunc(this.remainder / threshold);
        this.remainder -= steps * threshold;
        return steps || 0;
    }
}

export function gestureHelp(profile) {
    const entry = GESTURE_PROFILES[profile];
    return entry ? entry.gestures.map(([gesture, action]) => `${gesture}: ${action}`).join(" • ") : "";
}

// These DOM widgets deliberately retain their native selection, text editing,
// scrolling and GUI-specific lifecycles. App canvas tools use the router.
export const NATIVE_INTERACTION_BOUNDARIES = Object.freeze({
    "CUIBar.js": "Native menu buttons and header click controls",
    "BigSlider.js": "Range slider with pointer capture and cancellation",
    "lil-gui-extras.js": "GUI folders, menus and value controls",
    "lil-gui-slider-settings.js": "Native value-field settings",
    "CTrackBrowser.js": "Scrollable list selection and rubber-band selection",
    "CSitchBrowser.js": "Scrollable list/card selection and column sizing",
    "scriptedVideo/ScriptEditorWindow.js": "Textarea selection and number-token editing",
    "nodes/CNodeFrameSlider.js": "Native range, numeric input and repeat buttons",
});
