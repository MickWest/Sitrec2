// M1 — custom-sitch synth CRUD round-trip: create a building, UPDATE a property, then DELETE
// it, asserting the element inventory count goes 0 → 1 → 0 (no leak) and the update actually
// applied. This is the full edit lifecycle of synthetic content in a custom sitch.
//
// isolated:true — create/update/delete are mutating drives on a fresh, never-saved page.
export default {
    id: 'custom-synth-crud',
    sitch: 'custom',
    builtin: true,
    frame: 10,
    tier: 'value',
    network: 'none',
    isolated: true,
    steps: [
        {type: 'capture', name: 'countStart', read: {api: 'listSynthElements', args: {type: 'all', includeSerialized: false}}, pick: ['count']},
        {type: 'apiCall', fn: 'createSynthBuilding', args: {id: 'synthBuilding_1', lat: 40, lon: -100, width: 20, depth: 12, height: 5}, capture: 'created'},
        {type: 'capture', name: 'countAfterCreate', read: {api: 'listSynthElements', args: {type: 'all', includeSerialized: false}}, pick: ['count']},
        // Update a property and confirm it took.
        {type: 'apiCall', fn: 'updateSynthElement', args: {type: 'building', id: 'synthBuilding_1', patch: {roofAGL: 9}}, capture: 'updated'},
        {type: 'capture', name: 'roofAfterUpdate', read: {api: 'getSynthElement', args: {type: 'building', id: 'synthBuilding_1'}}, pick: ['element.roofAGL']},
        // Delete and confirm the inventory returns to baseline (no leak).
        {type: 'apiCall', fn: 'deleteSynthElement', args: {type: 'building', id: 'synthBuilding_1'}, capture: 'deleted'},
        {type: 'capture', name: 'countAfterDelete', read: {api: 'listSynthElements', args: {type: 'all', includeSerialized: false}}, pick: ['count']},
    ],
};
