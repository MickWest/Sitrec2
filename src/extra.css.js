
export const extraCSS = `
/* ============================================================================
   SITREC DESIGN TOKENS  (single source of truth — see docs/temp/ui-redesign/DESIGN-LANGUAGE.md,
   a local-only working document; git history has it under docs/ui-redesign/ before 2026-08-17)
   D1: the app stays DARK; only per-window headers are light-grey.
   Values for existing surfaces preserve the current appearance (no visual change);
   tokens tagged NEW are Blender-5.1.2-grounded and consumed by later phases.
   NOTE: this string is run through stripComments() before injection — block and
   line comments are fine in source but never use // inside a CSS value.
   lil-gui's OWN theme vars are intentionally NOT re-pointed here yet (it has touch
   font-size and hover-color variants); that aliasing is a careful later step.
   ============================================================================ */
:root {
    /* Surfaces */
    --sitrec-bg-app: #000000;
    --sitrec-bg-menubar: #1f1f1f;
    --sitrec-bg-panel: #1f1f1f;          /* mirrors lil-gui --background-color */
    --sitrec-bg-title: #111111;          /* mirrors lil-gui --title-background-color */
    --sitrec-bg-folder: #202030;         /* nested-folder dark blue */
    --sitrec-bg-widget: #424242;         /* mirrors lil-gui --widget-color */
    --sitrec-hover: #4f4f4f;             /* mirrors lil-gui --hover-color */
    --sitrec-bg-header: #303030;         /* per-view header — Blender 5.1.2 area-header colour (lighter than the menubar) */

    /* Text */
    --sitrec-text: #ebebeb;              /* mirrors lil-gui --text-color */
    --sitrec-text-strong: #ffffff;
    --sitrec-text-dim: #a0a0a0;

    /* Lines & accents */
    --sitrec-border: #666666;            /* menu tab / dropdown borders */
    --sitrec-border-folder: #ffffff;     /* nested-folder border */
    --sitrec-border-area: rgba(255, 255, 255, 0.08);   /* NEW: Blender area seam — Phase 2/3 */
    --sitrec-accent: #2cc9ff;            /* mirrors lil-gui --number-color (sliders/numbers) */
    --sitrec-primary: #1976d2;
    --sitrec-danger: #d32f2f;
    --sitrec-link: #0080ff;
    --sitrec-drag-highlight: rgba(100, 150, 255, 0.6);

    /* Metrics */
    --sitrec-header-h: 26px;             /* NEW: Blender header height — Phase 3 */
    --sitrec-font-size: 11px;            /* mirrors lil-gui --font-size */
    --sitrec-radius: 4px;
    --sitrec-space-1: 4px;
    --sitrec-space-2: 8px;
    --sitrec-space-3: 12px;
}

.uplot {
    font-family: monospace;
}


.u-legend {
    font-size: 14px;
    margin: auto;
    text-align: left;
    line-height: 1.0;
}


body {
    color: #000;
    font-family:Monospace;
    font-size:20px;
    background-color: #fff;
    margin: 0px;
    overflow: hidden;
}


#output {
    color: #000;
    font-family:Monospace;
    font-size:15px;
    position: absolute;
    top: 50%; width: 60%;

//white-space: pre;
}

#myChart {
    color: #000;
    font-family:Monospace;
    font-size:15px;
    position: absolute;
    top: 50%; width: 60%;
    padding: 10px;
//white-space: pre;
}
a {

    color: var(--sitrec-link);
}
.label {
    color: #FFF;
    font-family: sans-serif;
    padding: 2px;
    background: rgba( 0, 0, 0, .6 );
}

/* lugolabs.com/flat-slider */


// .flat-slider.ui-corner-all,
// .flat-slider .ui-corner-all {
//     border-radius: 0;
// }
//
// .flat-slider.ui-slider {
//     border: 0;
//     background: #f7d2cc;
//     border-radius: 7px;
// }
//
// .flat-slider.ui-slider-horizontal {
//     height: 10px;
// }
//
// .flat-slider.ui-slider-vertical {
//     height: 15em;
//     width: 4px;
// }

// .flat-slider .ui-slider-handle {
//     width: 130px;
//     height: 150px;
//     background: #38b11f;
//     border-radius: 50%;
//     border: none;
//     cursor: pointer;
// }

// .flat-slider.ui-slider-horizontal .ui-slider-handle {
//     top: 50%;
//     margin-top: -7.5px;
// }
//
// .flat-slider.ui-slider-vertical .ui-slider-handle {
//     left: 50%;
//     margin-left: -6.5px;
// }
//
// .flat-slider .ui-slider-handle:hover {
//     opacity: .8;
// }
//
// .flat-slider .ui-slider-range {
//     border: 0;
//     border-radius: 7;
//     background: #dfe385;
// }
//
// .flat-slider.ui-slider-horizontal .ui-slider-range {
//     top: 0;
//     height: 4px;
// }
//
// .flat-slider.ui-slider-vertical .ui-slider-range {
//     left: 0;
//     width: 4px;
// }

////////////////////////////////////////////////////////////////////////
// lil-gui

// a button in lil-gui is used as a menu item
// so we style it to be more like a Mac/Windows menu item
// left centered text, inset a few pixels
.lil-gui .name {
    text-align: left;
    padding-left: 5px;
    background: var(--sitrec-bg-panel);
    // Prevent long file/track names from wrapping to a second line.
    // The default lil-gui rule uses white-space:pre on .controller > .name,
    // but that selector misses .name inside FunctionController buttons, so
    // long button labels wrapped. Nowrap + ellipsis truncates instead.
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.lil-gui button {
    text-align: left;
    background: var(--sitrec-bg-panel);
    // Constrain children (the .name div) so text-overflow:ellipsis can engage.
    overflow: hidden;
}

// Folder titles (e.g. track-name folders nested in File/Export/Resources)
// have no nowrap rule in lil-gui's stylesheet. Force single-line display.
// Root titles already use width:auto so they shrink-wrap to content; inner
// folders inherit the menu's fixed width and will truncate with ellipsis.
.lil-gui .title {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.lil-gui.transition > .children {
        transition-duration: 1ms;  // changed from 300ms to 1ms
}

.lil-gui.closed > .title:before {
  content: "";
}
.lil-gui .lil-gui.closed > .title:before {
  content: "▸";
}

.lil-gui .title:before {
  font-family: "lil-gui";
  content: "";
  padding-right: 2px;
  display: inline-block;
}

.lil-gui .lil-gui .title:before {
  font-family: "lil-gui";
  content: "▾";
  padding-right: 2px;
  display: inline-block;
}

// INDENT TOP-LEVEL FOLDERS
// THIS IS LIKE .lil-gui .lil-gui .lil-gui > .children, BUT WITH ONE LESS .lil-gui
// I also use a dark blue background and a thicker white left border
// to ensure the folder is visually distinctive

.lil-gui .lil-gui > .children {
    border: none;
    border: 1px solid var(--sitrec-border-folder);
    background: var(--sitrec-bg-folder);
}

.lil-gui .lil-gui .lil-gui > .children {

    border-left: none;
    border: 1px solid var(--sitrec-border-folder);
}

body.hide-cursor {
    cursor: none;
}

html, body {
    overflow: hidden;
    margin: 0;
    padding: 0;
    height: 100%;
    /* Disable iOS callout menu and text selection on long press */
    -webkit-touch-callout: none;
    -webkit-user-select: none;
    user-select: none;
    /* Prevent pull-to-refresh on mobile browsers (especially Android) */
    overscroll-behavior: none;
    overscroll-behavior-y: none;
}

/* Menu title bar styling - make titles appear as tabs instead of full-width bars */
.lil-gui.root > .title {
    display: inline-block !important;
    width: auto !important;
    min-width: fit-content !important;
    max-width: none !important;
    padding: 4px 12px 4px 8px !important;
    background: var(--sitrec-bg-title) !important;
    border: 1px solid var(--sitrec-border) !important;
    border-bottom: none !important;
    border-radius: 4px 4px 0 0 !important;
    position: relative !important;
    margin-right: auto !important;
}

/* Remove border for docked menus (in the menu bar) */
#menuBar .lil-gui.root > .title {
    border: none !important;
    border-radius: 0 !important;
}

/* Make the root GUI container have transparent background and pass through mouse events */
.lil-gui.root {
    background: transparent !important;
    pointer-events: none !important;
}

/* Re-enable pointer events only on the visible title and children */
.lil-gui.root > .title {
    pointer-events: auto !important;
}

.lil-gui.root > .children {
    pointer-events: auto !important;
}

/* Ensure the dropdown content has proper background and connects to the tab */
.lil-gui.root > .children {
    background: var(--sitrec-bg-panel) !important;
    border: 1px solid var(--sitrec-border) !important;
    border-top: none !important;
    margin-top: 0 !important;
}

/* Limit menu dropdown height so tall menus scroll internally instead of overflowing the viewport */
#menuBar .lil-gui.root > .children {
    max-height: calc(100vh - 35px);
    overflow-y: auto;
}

/* Custom HTML controller styling */
.lil-gui .custom-html-controller {
    display: flex;
    align-items: center;
    padding: 0;
    height: auto;
    min-height: var(--widget-height);
}

.lil-gui .custom-html-controller .widget {
    flex: 1;
    display: flex;
    align-items: center;
    user-select: text;
    -webkit-user-select: text;
    cursor: text;
    color: #ffffff;
    padding: 4px 8px;
}

.lil-gui .custom-html-controller .widget * {
    user-select: text;
    -webkit-user-select: text;
}

/* ============================================================================
   BIG SLIDER  (src/BigSlider.js)
   Pops up when the pointer rests on a lil-gui slider. The backdrop is invisible
   on purpose: it exists to catch the dismissing click, and dimming it would hide
   the very thing the user is dragging the slider to watch.
   ============================================================================ */
.sitrec-bigslider-backdrop {
    position: fixed;
    inset: 0;
    z-index: 9500;
    background: transparent;
}

.sitrec-bigslider-panel {
    position: absolute;
    left: 2vw;
    width: 96vw;
    bottom: 70px;
    box-sizing: border-box;
    padding: 8px 10px 6px 10px;
    background: var(--sitrec-bg-panel);
    border: 1px solid var(--sitrec-border);
    border-radius: var(--sitrec-radius);
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.6);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
    color: var(--sitrec-text);
    user-select: none;
    -webkit-user-select: none;
}

.sitrec-bigslider-title {
    font-size: 13px;
    color: var(--sitrec-text-strong);
    text-align: center;
    margin-bottom: 6px;
}

.sitrec-bigslider-track {
    position: relative;
    height: 54px;
    background: var(--sitrec-bg-widget);
    border-radius: 3px;
    overflow: hidden;
    cursor: ew-resize;
    touch-action: none;
}

.sitrec-bigslider-track.active {
    background: var(--sitrec-hover);
}

.sitrec-bigslider-fill {
    height: 100%;
    box-sizing: content-box;
    background: rgba(44, 201, 255, 0.25);
    border-right: 4px solid var(--sitrec-accent);
}

/* The end zones of an elastic slider's bar: hold a drag in one and the range steps
   outward (right) or inward (left). A bar this wide has no room outside itself for
   the pointer-distance rule the menu sliders use, so time does the job instead.
   Width comes from ZONE_PX in BigSlider.js. Never a hit target - the press has to
   reach the track underneath. */
.sitrec-bigslider-zone {
    position: absolute;
    top: 0;
    bottom: 0;
    pointer-events: none;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 20px;
    line-height: 1;
    color: var(--sitrec-text-dim);
    background: rgba(255, 255, 255, 0.06);
}

.sitrec-bigslider-zone.low {
    left: 0;
    border-right: 1px solid var(--sitrec-border);
}

.sitrec-bigslider-zone.high {
    right: 0;
    border-left: 1px solid var(--sitrec-border);
}

.sitrec-bigslider-zone.active {
    background: var(--sitrec-accent);
    color: var(--sitrec-bg-panel);
}

.sitrec-bigslider-ends {
    display: flex;
    justify-content: space-between;
    margin-top: 4px;
    font-size: 11px;
    color: var(--sitrec-text-dim);
}

`;
