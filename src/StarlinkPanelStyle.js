export const starlinkPanelStyle = `
.starlink-launcher { position: absolute; top: 36px; left: 12px; z-index: 4400; font: 12px system-ui, sans-serif; color: var(--panel-text); background: var(--panel-field); border: 1px solid var(--panel-border); border-radius: 5px; padding: 7px 12px; cursor: pointer; }
.starlink-launcher[hidden], .starlink-hud[hidden] { display: none; }
.starlink-launcher:hover { background: var(--panel-hover); }
.starlink-launcher:focus-visible { outline: 2px solid var(--panel-accent); }
.starlink-hud { position: absolute; top: 36px; left: 12px; right: 12px; pointer-events: none; display: flex; justify-content: space-between; gap: 12px; z-index: 20; }
.widget-info-stack { display: flex; flex-direction: column; gap: 5px; align-items: flex-start; width: max-content; max-width: 300px; min-width: 0; }
.widget-info-right { align-items: flex-end; }
@media (max-width: 760px) {
    .starlink-hud { top: 68px; left: 8px; right: 8px; }
    .widget-info-right { display: none; }
}
`;
