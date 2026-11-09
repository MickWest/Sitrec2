// Shared shell and form presentation for composed and standalone widgets.
export const widgetPanelStyle = `
.widget-panel { background: var(--panel-bg); color: var(--panel-text); font: 12px/1.3 system-ui, sans-serif; position: relative; box-sizing: border-box; min-width: 0; max-width: 100%; }
.widget-panel[hidden], .widget-window[hidden], .widget-return[hidden] { display: none !important; }
.widget-panel > .widget-title { width: 100% !important; min-width: 0 !important; padding: 0 34px 0 9px !important; box-sizing: border-box; min-height: 24px; line-height: 24px; cursor: grab; text-align: left; color: var(--panel-text); background: var(--panel-bg); border: 0; font: 600 11px/24px system-ui, sans-serif; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.widget-panel > .widget-content { padding: 0 !important; margin: 0 !important; border: 0 !important; }
.widget-panel > .widget-content[hidden] { display: none !important; }
.widget-panel > .widget-title::before { content: '▾'; display: inline-block; width: 11px; color: var(--panel-muted); }
.widget-panel.closed > .widget-title::before { content: '▸'; }
.widget-panel .widget-panel { border-top: 1px solid var(--panel-divider); border-radius: 0; }
.widget-panel > .widget-placement-button { position: absolute; top: 0; right: 0; width: 30px; height: 24px; min-height: 24px; padding: 0; z-index: 2; font-size: 20px; line-height: 24px; }
.widget-panel button.widget-placement-button, .widget-return { color: var(--panel-muted); background: transparent; border: 0; border-radius: 3px; cursor: pointer; }
.widget-panel > .widget-title:focus-visible, .widget-placement-button:focus-visible, .widget-return:focus-visible { outline: 2px solid var(--panel-accent); outline-offset: -2px; }
.widget-placement-button:hover, .widget-return:hover { background: var(--panel-hover) !important; color: var(--panel-text) !important; }
.widget-composition > .widget-title { font-size: 13px; font-weight: 650; }
.widget-body { padding: 3px 7px 5px; font: 12px/1.35 system-ui, -apple-system, sans-serif; color: var(--panel-text); background: var(--panel-bg); touch-action: pan-y; }
.widget-body:empty { display: none; }
.widget-body button:not(.native-controls *) { width: auto; }
.widget-body *, .widget-body *::before { box-sizing: border-box; }
.widget-dock-preview { position: fixed; top: 25px; bottom: 0; width: min(250px, 90vw); background: #80bcea22; border: 2px solid #80bcea; pointer-events: none; z-index: 14999; }
.widget-floating { display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 4px 20px #0005; }
.widget-floating > .widget-title { flex: none; }
.widget-floating > .widget-content { overflow-y: auto !important; min-height: 0; scrollbar-width: thin; }
.widget-floating.closed > .widget-content { display: none; }
.widget-window { max-width: 100vw; }
.widget-return { display: block; width: 100%; text-align: left; padding: 6px 10px; font: 11px system-ui, sans-serif; pointer-events: auto; }
.widget-placement-menu { position: fixed; z-index: 15000; width: min(230px, calc(100vw - 8px)); border: 1px solid var(--panel-border); border-radius: 6px; padding: 4px; background: var(--panel-bg); box-shadow: 0 4px 16px #0006; }
.widget-placement-menu button { display: block; width: 100%; border: 0; border-radius: 3px; background: transparent; color: var(--panel-text); font: 12px system-ui, sans-serif; text-align: left; padding: 7px 9px; cursor: pointer; }
.widget-placement-menu button:hover, .widget-placement-menu button:focus-visible { outline: 0; background: var(--panel-hover); }
.widget-info { width: 100%; pointer-events: auto; border: 1px solid var(--panel-border) !important; border-radius: 6px !important; overflow: hidden; }
.widget-info > .widget-title { position: absolute; inset: 0; height: 100%; font-size: 0; background: transparent; z-index: 1; }
.widget-info > .widget-title::before { display: none; }
.widget-info.closed > .widget-title { position: relative; font-size: 10px; }
.widget-info > .widget-placement-button { height: 24px; min-height: 24px; }
.widget-info .widget-body { padding: 7px 30px 7px 9px; }
.widget-info strong { font-size: 12px; font-weight: 550; }
.widget-info small { display: block; font-size: 11px; color: var(--panel-muted); }
@media (max-width: 760px) {
    #LeftSidebar, #RightSidebar { width: min(250px, calc(100vw - 32px)) !important; box-shadow: 0 4px 20px #0008; }
}
.widget-body [data-id=altitudeControls][inert] { opacity: .45; }
.widget-body button:not(.native-controls *, .sitrec-time-editor *), .widget-body input:not(.native-controls *, .sitrec-time-editor *), .widget-body select:not(.native-controls *, .sitrec-time-editor *), .starlink-launcher {
    font: inherit; color: inherit; border: 1px solid var(--panel-border); border-radius: 5px;
    background: var(--panel-field); min-height: 28px; padding: 4px 7px; max-width: 100%;
}
.widget-body button:not(.native-controls *), .starlink-launcher { cursor: pointer; }
.widget-body button:not(.native-controls *):hover, .starlink-launcher:hover { background: var(--panel-hover); border-color: var(--panel-accent); }
.widget-body :focus-visible, .starlink-launcher:focus-visible { outline: 2px solid var(--panel-accent); outline-offset: 2px; }
.widget-body button:not(.native-controls *)[aria-pressed=true], .widget-body .sl-primary { background: var(--panel-selected); border-color: var(--panel-accent); color: var(--panel-text); }
.widget-body button:not(.native-controls *):disabled, .widget-body input:not(.native-controls *):disabled { opacity: .45; cursor: default; }
.widget-body .sl-row { display: flex; align-items: center; gap: 4px; margin: 4px 0; }
.widget-body .sl-row > * { min-width: 0; }
.widget-body .sl-row > input { flex: 1; width: 0; }
.widget-body .sl-segments > button { flex: 1; padding: 5px 2px; }
.widget-body .sl-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
.widget-body .sl-grid > * { min-width: 0; }
.widget-body label:not(.native-controls *, .sitrec-time-editor *) { color: var(--panel-muted); font-size: 11px; display: block; }
.widget-body .sitrec-time-editor { padding: 0; }
.widget-body .sitrec-time-editor [data-id=speed] { width: 50px; flex: none; }
.widget-body .sitrec-time-editor button[data-action] { padding: 4px 5px; font-size: 11px; white-space: nowrap; }
.widget-body [data-id=altitudeControls] .native-control { flex-wrap: wrap; gap: 2px; }
.widget-body [data-id=altitudeControls] .native-control-label { flex-basis: 100%; font-size: 11px; }
.widget-body [data-id=altitudeControls] .native-control-fields { flex-basis: 100%; }
.widget-body .sl-grid label > input, .widget-body label:not(.native-controls *) > select { display: block; width: 100%; margin-top: 2px; color: var(--panel-text); font-size: 12px; }
.widget-body input:not(.native-controls *)[type=number] { font-variant-numeric: tabular-nums; }
.widget-body .sl-muted { color: var(--panel-muted); font-size: 11px; margin: 3px 0 0; }
.widget-body .sl-status { color: var(--panel-good); font-size: 11px; font-weight: 600; letter-spacing: .04em; }
.widget-body .sl-warning { color: var(--panel-warning); }
.widget-body .sl-error { color: #ffb3a7; }
.widget-body .sl-message:empty { display: none; }
.widget-body .sl-muted:empty { display: none; }
.widget-body .sl-date { width: 100%; font-size: 12px; }
.widget-body details { margin-top: 5px; border-top: 1px solid var(--panel-divider); padding-top: 4px; }
.widget-body .sitrec-time-editor details { margin-top: 4px; border: 0; padding: 0; }
.widget-body summary { cursor: pointer; color: var(--panel-muted); font-size: 12px; }
.widget-body .sl-data { font-variant-numeric: tabular-nums; }
`;
