export const timeEditorStyle = `
.sitrec-time-editor {
    font: 12px/1.35 system-ui, -apple-system, sans-serif;
    background: var(--panel-bg); color: var(--panel-text); padding: 8px;
    border-radius: 8px; min-width: 0; box-sizing: border-box;
}
.sitrec-time-editor *, .sitrec-time-editor *::before { box-sizing: border-box; }
.sitrec-time-editor .te-row { display: flex; align-items: center; gap: 4px; margin: 4px 0; }
.sitrec-time-editor .te-row > * { min-width: 0; }
.sitrec-time-editor .te-grow { flex: 1; width: 0; }
.sitrec-time-editor button, .sitrec-time-editor input, .sitrec-time-editor select {
    font: inherit; color: var(--panel-text); background: var(--panel-field);
    border: 1px solid var(--panel-border); border-radius: 5px; min-height: 28px;
    padding: 4px 7px; max-width: 100%; margin: 0;
}
.sitrec-time-editor button { cursor: pointer; }
/* The editor is also used in a menu. The menu styles give each button the full row width
   and left text, with a selector of the same weight as the rules here, so the order of the
   style sheets would decide. The repeated class makes the editor's own layout win in each host. */
.sitrec-time-editor.sitrec-time-editor button { width: auto; text-align: center; }
/* Compact action row. It must fit in a 250px side rail in each host. */
.sitrec-time-editor button[data-action] { padding: 4px 5px; font-size: 11px; white-space: nowrap; }
.sitrec-time-editor [data-id=speed] { width: 50px; flex: none; }
.sitrec-time-editor button:hover { background: var(--panel-hover); border-color: var(--panel-accent); }
.sitrec-time-editor :focus-visible { outline: 2px solid var(--panel-accent); outline-offset: 1px; }
.sitrec-time-editor button[aria-pressed=true] { background: var(--panel-selected); border-color: var(--panel-accent); }
.sitrec-time-editor button:disabled { opacity: .45; cursor: default; }
.sitrec-time-editor > :first-child { margin-top: 0; }
.sitrec-time-editor > :last-child { margin-bottom: 0; }
.sitrec-time-editor .te-target button { flex: 1; padding: 5px 2px; font-size: 11px; }
.sitrec-time-editor .te-date, .sitrec-time-editor .te-clock { display: grid; align-items: center; gap: 4px; margin: 4px 0; }
.sitrec-time-editor .te-date { grid-template-columns: 1.6fr auto 1fr auto 1fr 28px; }
.sitrec-time-editor .te-clock { grid-template-columns: 1fr auto 1fr auto 1fr; }
.sitrec-time-editor .te-digit { width: 100%; min-width: 0; padding: 4px 0; font: 500 18px/1.2 ui-monospace, monospace; text-align: center; cursor: ew-resize; touch-action: pan-y; }
.sitrec-time-editor .te-clock .te-digit { height: 43px; font-size: 32px; }
.sitrec-time-editor .te-digit:focus { background: var(--panel-hover); }
.sitrec-time-editor .te-date > span, .sitrec-time-editor .te-clock > span { color: var(--panel-muted); }
.sitrec-time-editor .te-calendar { position: relative; width: 28px; height: 28px; padding: 0; color: transparent; cursor: pointer; }
.sitrec-time-editor .te-calendar::-webkit-datetime-edit { visibility: hidden; }
.sitrec-time-editor .te-calendar::-webkit-calendar-picker-indicator { position: absolute; inset: 0; margin: auto; cursor: pointer; }
.sitrec-time-editor .te-ms { display: flex; align-items: center; gap: 5px; color: var(--panel-muted); font-size: 11px; }
.sitrec-time-editor .te-ms input { width: 47px; padding: 3px; font-size: 12px; }
.sitrec-time-editor .te-context { font-size: 10px; color: var(--panel-muted); }
.sitrec-time-editor .te-context { flex: 1; text-align: right; }
.sitrec-time-editor .te-status { font-size: 10px; color: var(--panel-good); font-weight: 650; }
.sitrec-time-editor .te-error { font-size: 11px; color: var(--panel-warning); margin: 5px 0; }
.sitrec-time-editor .te-error:empty { display: none; }
.sitrec-time-editor [aria-invalid=true] { outline: 2px solid var(--panel-warning); }
.sitrec-time-editor .te-paste { font-size: 11px; }
.sitrec-time-editor .te-paste::placeholder { color: var(--panel-muted); opacity: 1; }
.sitrec-time-editor .te-scrubbing { background: var(--panel-selected) !important; cursor: ew-resize !important; }
.time-menu-editor { margin: 4px; }
.lil-gui.sitrec-time-menu { --width: 310px; }
.time-menu-details > summary { cursor: pointer; padding: 7px; font: 12px system-ui, sans-serif; }
`;
