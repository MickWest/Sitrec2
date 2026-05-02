
export const extraCSS = `
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

    color: #0080ff;
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
    background: #1f1f1f;    // same as --background-color
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
    background: #1f1f1f;
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
    border: 1px solid #FFFFFF;
    background: #202030;
}

.lil-gui .lil-gui .lil-gui > .children {

    border-left: none;
    border: 1px solid #FFFFFF;
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
    background: var(--title-background-color) !important;
    border: 1px solid #666 !important;
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
    background: var(--background-color) !important;
    border: 1px solid #666 !important;
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


`;