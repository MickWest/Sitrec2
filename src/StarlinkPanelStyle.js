export const starlinkPanelStyle = `
.starlink-panel, .starlink-launcher, .starlink-hud {
    font: 12px/1.35 system-ui, -apple-system, sans-serif; color: #e4eaf3;
    box-sizing: border-box;
}
.starlink-panel {
    position: absolute; z-index: 4400; width: 300px; bottom: 0;
    background: #111821; border-right: 1px solid #2b3849; overflow-y: auto;
    padding: 12px 14px; scrollbar-width: thin; scrollbar-color: #41516a #111821;
    touch-action: pan-y; color-scheme: dark;
}
.starlink-panel *, .starlink-panel *::before { box-sizing: border-box; }
.starlink-panel header { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.starlink-panel h1 { font-size: 19px; letter-spacing: .03em; margin: 0; font-weight: 650; }
.starlink-panel .sl-subtitle { color: #97a9bf; font-size: 12px; }
.starlink-panel .sl-close { margin-left: auto; min-width: 30px; padding: 3px; font-size: 18px; }
.starlink-panel section { border-top: 1px solid #293445; padding-top: 9px; margin-top: 10px; }
.starlink-panel h2 { color: #a9bad0; font-size: 10px; font-weight: 650; letter-spacing: .12em; text-transform: uppercase; margin: 0 0 7px; }
.starlink-panel button, .starlink-panel input, .starlink-panel select, .starlink-launcher {
    font: inherit; color: inherit; border: 1px solid #35465d; border-radius: 5px;
    background: #192433; min-height: 28px; padding: 4px 7px; max-width: 100%;
}
.starlink-panel button, .starlink-launcher { cursor: pointer; }
.starlink-panel button:hover, .starlink-launcher:hover { background: #263b52; border-color: #7299bf; }
.starlink-panel :focus-visible, .starlink-launcher:focus-visible { outline: 2px solid #8bc8ff; outline-offset: 2px; }
.starlink-panel button[aria-pressed=true], .starlink-panel .sl-primary { background: #234c6c; border-color: #528bb5; color: #f4faff; }
.starlink-panel button:disabled, .starlink-panel input:disabled { opacity: .45; cursor: default; }
.starlink-panel .sl-row { display: flex; align-items: center; gap: 6px; margin: 5px 0; }
.starlink-panel .sl-row > * { min-width: 0; }
.starlink-panel .sl-row > input { flex: 1; width: 0; }
.starlink-panel .sl-segments > button { flex: 1; padding: 5px 2px; }
.starlink-panel .sl-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.starlink-panel label { color: #afbed0; font-size: 11px; display: block; }
.starlink-panel .sl-grid label > input, .starlink-panel label > select { display: block; width: 100%; margin-top: 2px; color: #edf3fa; font-size: 12px; }
.starlink-panel .sl-checks { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 9px; }
.starlink-panel .sl-checks label, .starlink-panel .sl-check { display: flex; align-items: center; gap: 7px; color: #c3cfdf; font-size: 12px; }
.starlink-panel input[type=checkbox] { accent-color: #70b9ef; min-height: 0; width: 14px; height: 14px; margin: 0; }
.starlink-panel input[type=range] { accent-color: #80bcea; width: 100%; min-height: 20px; margin: 3px 0; padding: 0; background: transparent; border: 0; }
.starlink-panel [data-id=angles] input[type=range] { display: block; min-height: 16px; height: 16px; margin: 1px 0; }
.starlink-panel [data-id=angles] .sl-range-label { margin-top: 4px; }
.starlink-panel input[type=number] { font-variant-numeric: tabular-nums; }
.starlink-panel .sl-range-label { display: flex; justify-content: space-between; align-items: center; color: #afbed0; margin-top: 6px; font-size: 12px; }
.starlink-panel .sl-range-label input[type=number] { width: 72px; flex: 0 0 72px; min-height: 24px; padding: 2px 5px; text-align: right; }
.starlink-panel .sl-muted { color: #93a6bd; font-size: 11px; margin: 6px 0 0; }
.starlink-panel .sl-status { color: #82d9b4; font-size: 11px; font-weight: 600; letter-spacing: .04em; }
.starlink-panel .sl-warning { color: #efbf7b; }
.starlink-panel .sl-error { color: #ffb3a7; }
.starlink-panel .sl-message:empty { display: none; }
.starlink-panel .sl-muted:empty { display: none; }
.starlink-panel .sl-date { width: 100%; font-size: 12px; }
.starlink-panel details { margin-top: 10px; border-top: 1px solid #293445; padding-top: 9px; }
.starlink-panel summary { cursor: pointer; color: #afbed0; font-size: 12px; }
.starlink-panel .sl-data { font-variant-numeric: tabular-nums; }
.starlink-launcher { position: absolute; top: 36px; left: 12px; z-index: 4400; background: #162333; padding: 7px 12px; }
.starlink-hud { position: absolute; top: 36px; left: 18px; right: 18px; pointer-events: none; display: flex; justify-content: space-between; gap: 16px; z-index: 20; text-shadow: 0 1px 3px #000; }
.starlink-hud[hidden] { display: none; }
.starlink-hud .sl-hud-block { background: #101925d9; border: 1px solid #53687d66; border-radius: 7px; padding: 9px 12px; }
.starlink-hud strong { font-size: 13px; font-weight: 550; }
.starlink-hud small { display: block; color: #acbbce; font-size: 11px; margin-top: 3px; }
.starlink-hud .sl-hud-time { text-align: right; font-variant-numeric: tabular-nums; }
@media (max-width: 760px) {
    .starlink-panel { width: min(300px, 100vw); box-shadow: 8px 0 28px #0008; }
    .starlink-hud { top: 62px; left: 10px; right: 10px; }
    .starlink-hud .sl-hud-time { display: none; }
}
`;
