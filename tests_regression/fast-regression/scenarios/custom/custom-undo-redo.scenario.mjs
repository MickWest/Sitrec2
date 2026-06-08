// M1 — custom-sitch UNDO/REDO: create an object, undo, redo, watching the track count.
// Regression guard for the object-creation undo support added to CustomManager.createObjectFromInput
// (CustomManagerMenus.js): count goes 0 → 1 (create) → 0 (undo removes object+track) → 1 (redo
// recreates). Originally addObjectAtLLA was NOT undoable (undo left the count at 1); this scenario
// locks in the fixed behavior so a regression in undo coverage is caught.
//
// isolated:true — add/undo/redo are mutating drives on a fresh, never-saved page.
export default {
    id: 'custom-undo-redo',
    sitch: 'custom',
    builtin: true,
    frame: 10,
    tier: 'value',
    network: 'none',
    isolated: true,
    steps: [
        {type: 'capture', name: 'countBefore', read: {api: 'listTracks'}, pick: ['count']},
        {type: 'apiCall', fn: 'addObjectAtLLA', args: {lat: 40, lon: -100, alt: 10000, name: 'UndoOb'}},
        {type: 'capture', name: 'countAfterCreate', read: {api: 'listTracks'}, pick: ['count']},
        {type: 'apiCall', fn: 'undo', args: {}},
        {type: 'capture', name: 'countAfterUndo', read: {api: 'listTracks'}, pick: ['count']},
        {type: 'apiCall', fn: 'redo', args: {}},
        {type: 'capture', name: 'countAfterRedo', read: {api: 'listTracks'}, pick: ['count']},
    ],
};
