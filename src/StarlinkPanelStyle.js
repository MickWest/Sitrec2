export const starlinkPanelStyle = `
.starlink-panel, .starlink-launcher, .starlink-hud {
    font: 12px/1.35 system-ui, -apple-system, sans-serif; color: var(--panel-text);
    box-sizing: border-box;
}
.starlink-panel {
    position: absolute; z-index: 4400; width: 300px; bottom: 0;
    background: var(--panel-bg); border-right: 1px solid var(--panel-divider); overflow-y: auto;
    padding: 8px 10px; scrollbar-width: thin; scrollbar-color: var(--panel-border) var(--panel-bg);
    touch-action: pan-y;
}
.starlink-panel *, .starlink-panel *::before { box-sizing: border-box; }
.starlink-panel header { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; position: sticky; top: -8px; z-index: 2; padding: 2px 0; background: var(--panel-bg); }
.starlink-panel h1 { font-size: 17px; margin: 0; font-weight: 650; }
.starlink-panel .sl-close { margin-left: auto; min-width: 30px; padding: 3px; font-size: 18px; }
.starlink-panel section { border-top: 1px solid var(--panel-divider); padding-top: 5px; margin-top: 6px; }
.starlink-panel > section:first-of-type { border-top: 0; padding-top: 0; margin-top: 0; }
.starlink-panel h2 { color: var(--panel-muted); font-size: 10px; font-weight: 650; letter-spacing: .12em; text-transform: uppercase; margin: 0 0 3px; }
.starlink-panel .controller { margin: 1px 0; }
.starlink-panel .modern-embedded .controller.number > .name, .starlink-panel .modern-embedded .controller.string > .name { margin-bottom: 2px; }
.starlink-panel [data-id=altitudeControls] .controller { margin: 0; }
.starlink-panel [data-id=altitudeControls] .name { color: var(--panel-muted); font-size: 11px; }
.starlink-panel [data-id=altitudeControls][inert] { opacity: .45; }
.starlink-panel button:not(.lil-gui *, .sitrec-time-editor *), .starlink-panel input:not(.lil-gui *, .sitrec-time-editor *), .starlink-panel select:not(.lil-gui *, .sitrec-time-editor *), .starlink-launcher {
    font: inherit; color: inherit; border: 1px solid var(--panel-border); border-radius: 5px;
    background: var(--panel-field); min-height: 28px; padding: 4px 7px; max-width: 100%;
}
.starlink-panel button:not(.lil-gui *), .starlink-launcher { cursor: pointer; }
.starlink-panel button:not(.lil-gui *):hover, .starlink-launcher:hover { background: var(--panel-hover); border-color: var(--panel-accent); }
.starlink-panel :focus-visible, .starlink-launcher:focus-visible { outline: 2px solid var(--panel-accent); outline-offset: 2px; }
.starlink-panel button:not(.lil-gui *)[aria-pressed=true], .starlink-panel .sl-primary { background: var(--panel-selected); border-color: var(--panel-accent); color: var(--panel-text); }
.starlink-panel button:not(.lil-gui *):disabled, .starlink-panel input:not(.lil-gui *):disabled { opacity: .45; cursor: default; }
.starlink-panel .sl-row { display: flex; align-items: center; gap: 4px; margin: 4px 0; }
.starlink-panel .sl-row > * { min-width: 0; }
.starlink-panel .sl-row > input { flex: 1; width: 0; }
.starlink-panel .sl-segments > button { flex: 1; padding: 5px 2px; }
.starlink-panel .sl-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
.starlink-panel .sl-grid > * { min-width: 0; }
.starlink-panel label:not(.lil-gui *, .sitrec-time-editor *) { color: var(--panel-muted); font-size: 11px; display: block; }
.starlink-panel .sitrec-time-editor { padding: 0; }
.starlink-panel .sl-grid label > input, .starlink-panel label:not(.lil-gui *) > select { display: block; width: 100%; margin-top: 2px; color: var(--panel-text); font-size: 12px; }
.starlink-panel input:not(.lil-gui *)[type=number] { font-variant-numeric: tabular-nums; }
.starlink-panel .sl-muted { color: var(--panel-muted); font-size: 11px; margin: 3px 0 0; }
.starlink-panel .sl-status { color: var(--panel-good); font-size: 11px; font-weight: 600; letter-spacing: .04em; }
.starlink-panel .sl-warning { color: var(--panel-warning); }
.starlink-panel .sl-error { color: #ffb3a7; }
.starlink-panel .sl-message:empty { display: none; }
.starlink-panel .sl-muted:empty { display: none; }
.starlink-panel .sl-date { width: 100%; font-size: 12px; }
.starlink-panel details { margin-top: 5px; border-top: 1px solid var(--panel-divider); padding-top: 4px; }
.starlink-panel .sitrec-time-editor details { margin-top: 4px; border: 0; padding: 0; }
.starlink-panel summary { cursor: pointer; color: var(--panel-muted); font-size: 12px; }
.starlink-panel .sl-data { font-variant-numeric: tabular-nums; }
.starlink-launcher { position: absolute; top: 36px; left: 12px; z-index: 4400; background: var(--panel-field); padding: 7px 12px; }
.starlink-hud { position: absolute; top: 36px; left: 18px; right: 18px; pointer-events: none; display: flex; justify-content: space-between; gap: 16px; z-index: 20;  }
.starlink-hud[hidden] { display: none; }
.starlink-hud .sl-hud-block { background: var(--panel-bg); border: 1px solid var(--panel-border); border-radius: 7px; padding: 9px 12px; }
.starlink-hud strong { font-size: 13px; font-weight: 550; }
.starlink-hud small { display: block; color: var(--panel-muted); font-size: 11px; margin-top: 3px; }
.starlink-hud .sl-hud-time { text-align: right; font-variant-numeric: tabular-nums; }
@media (max-width: 760px) {
    .starlink-panel { width: min(300px, 100vw); box-shadow: 8px 0 28px #0008; }
    .starlink-hud { top: 62px; left: 10px; right: 10px; }
    .starlink-hud .sl-hud-time { display: none; }
}
`;
