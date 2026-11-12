// Shared by embedded control groups, custom edit windows and the viewing panel.
// Scoped so adopting this presentation does not change ordinary menu density.
export const modernControlStyle = `
.sitrec-modern {
    --panel-bg: #111821; --panel-field: #192433; --panel-hover: #263b52;
    --panel-border: #35465d; --panel-divider: #293445;
    --panel-text: #e4eaf3; --panel-muted: #a9bad0; --panel-accent: #80bcea;
    --panel-selected: #234c6c; --panel-good: #82d9b4; --panel-warning: #efbf7b;
    color-scheme: dark;
}
html[data-theme="light"] .sitrec-modern {
    --panel-bg: #f3f6fa; --panel-field: #ffffff; --panel-hover: #e0eaf4;
    --panel-border: #8799ac; --panel-divider: #ccd7e2;
    --panel-text: #1e2e40; --panel-muted: #485e75; --panel-accent: #21669b;
    --panel-selected: #c6e0f4; --panel-good: #236642; --panel-warning: #855000;
    color-scheme: light;
}
:root .lil-gui.sitrec-modern, :root .sitrec-modern .lil-gui {
    --background-color: var(--panel-bg); --text-color: var(--panel-text);
    --title-background-color: var(--panel-field); --title-text-color: var(--panel-text);
    --widget-color: var(--panel-field); --hover-color: var(--panel-hover);
    --focus-color: var(--panel-hover); --number-color: var(--panel-accent);
    --string-color: var(--panel-text);
    border-radius: 6px;
}
.sitrec-modern .controller { border-radius: 4px; }
.sitrec-modern .controller .name { background: transparent; }
/* Menus keep lil-gui's original row spacing, fonts and slider height. The larger,
   stacked controls belong only to groups embedded in the viewing panel. */
:root .lil-gui.modern-embedded, :root .modern-embedded .lil-gui {
    --font-size: 12px; --widget-height: 26px;
    font-family: system-ui, -apple-system, sans-serif;
}
.modern-embedded .controller { min-height: 28px; margin: 3px 0; }
.modern-embedded .controller .name { white-space: normal; line-height: 1.25; }
.sitrec-modern .controller input[type=checkbox] { border: 1px solid var(--panel-border); }
.sitrec-modern .lil-gui > .children { background: var(--panel-bg); border-color: var(--panel-divider); }
.sitrec-modern .controller input, .sitrec-modern .controller select,
.sitrec-modern .controller button { border-radius: 4px; }
.sitrec-modern .controller input:focus-visible, .sitrec-modern .controller select:focus-visible,
.sitrec-modern .controller button:focus-visible { outline: 2px solid var(--panel-accent); outline-offset: 1px; }
.modern-embedded .lil-checkbox-pair { min-height: 28px; }
.sitrec-modern .lil-checkbox-pair .controller { margin: 0; }
.lil-gui.modern-embedded { width: 100%; max-width: 100%; border: 0; box-shadow: none; }
.lil-gui.root.sitrec-modern > .children { background: var(--panel-bg) !important; border-color: var(--panel-border) !important; }
.lil-gui.root.sitrec-modern > .title { background: var(--panel-field) !important; border-color: var(--panel-border) !important; }
.lil-gui.root.modern-embedded > .title { display: none !important; }
.lil-gui.root.modern-embedded > .children { border: 0 !important; padding: 0; }
.sitrec-modern .controller.function button { background: var(--panel-field); border: 1px solid var(--panel-border); padding: 0 7px; }
.sitrec-modern .controller.function button:hover { background: var(--panel-hover); }
.modern-embedded .controller.number, .modern-embedded .controller.string { flex-wrap: wrap; }
.modern-embedded .controller.number > .name, .modern-embedded .controller.string > .name { flex: 0 0 100%; margin-bottom: 4px; }
.modern-embedded .controller.number > .widget, .modern-embedded .controller.string > .widget { width: 100%; flex: 1 1 100%; }
.modern-embedded.modern-grid > .children { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 8px; }
.modern-embedded.modern-grid .controller > .name { font-size: 11px; }
`;
