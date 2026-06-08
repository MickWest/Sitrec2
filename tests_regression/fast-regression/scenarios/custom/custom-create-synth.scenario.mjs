// M1 — the CUSTOM-SITCH SYNTHETIC-CONTENT process: on the blank `custom` sitch, create a
// synthetic building and a synthetic cloud layer via the same API the UI drives, then assert
// they register in the synth-element inventory. Catches creation/serialization regressions in
// the synth authoring path (e.g. the 2.78.1 cloud puff-shedding determinism guard).
//
// isolated:true — createSynth* are mutating drives; the scenario runs in a fresh page that is
// never saved, so there are zero side effects.
export default {
    id: 'custom-create-synth',
    sitch: 'custom',
    builtin: true,
    frame: 10,
    tier: 'value',
    network: 'none',
    isolated: true,
    steps: [
        // Create a synthetic building at a fixed footprint (deterministic geometry inputs).
        {
            type: 'apiCall', fn: 'createSynthBuilding',
            args: {id: 'synthBuilding_1', lat: 40, lon: -100, width: 20, depth: 12, height: 5, headingDeg: 30},
            capture: 'building',
        },
        // Create a synthetic cloud layer with a fixed seed (deterministic puff placement).
        {
            type: 'apiCall', fn: 'createSynthClouds',
            args: {id: 'synthClouds_1', lat: 40, lon: -100, altitude: 3000, radius: 500, density: 0.5, cloudSize: 200, seed: 42},
            capture: 'clouds',
            // density/opacity have no name-based tolerance tier; pin them explicitly so they
            // don't fall through to the default-with-warning (the tolerance override path).
            tol: {density: 1e-4, opacity: 1e-4},
        },
        // Synth-element inventory — counts per type. Project to stable fields (drop any ids that
        // might be timestamp-derived); first run reveals the real shape for tightening.
        {
            type: 'capture', name: 'synthInventory',
            read: {eval: "()=>window.sitrecAPI.call('listSynthElements',{type:'all',includeSerialized:false}).then(e=>{const d=e.result||e; return JSON.parse(JSON.stringify(d));})"},
        },
    ],
};
