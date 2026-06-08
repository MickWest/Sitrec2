// M1 — the CUSTOM-SITCH CREATION process: load the blank `custom` sitch, pin the date,
// then create a 3D object via the same API the UI drives (addObjectAtLLA). Asserts the
// object actually appears as a track and that creation marks the sitch dirty. This is the
// core "make and use a custom sitch" workflow, exercised end-to-end and deterministically.
//
// isolated:true — the steps mutate (setDateTime, addObjectAtLLA) but the scenario runs in
// its own fresh page that is closed (never saved) afterward, so there are ZERO side effects
// on shared state. (The mutation lint requires isolated:true for these drives.)
export default {
    id: 'custom-create-object',
    sitch: 'custom',
    builtin: true,
    frame: 10,
    tier: 'value',
    network: 'none',
    isolated: true,
    steps: [
        {
            type: 'assert', name: 'managers-present',
            fn: "()=>({api: typeof window.sitrecAPI==='object', custom: typeof window.CustomManager==='object', tracks: typeof window.TrackManager==='object'})",
            equals: {api: true, custom: true, tracks: true},
        },
        // Pin simulation time so anything time-derived is reproducible.
        {type: 'apiCall', fn: 'setDateTime', args: {dateTime: '2024-01-01T12:00:00Z'}},
        // Track manifest BEFORE creation (baseline of the empty/initial custom sitch).
        {type: 'capture', name: 'tracksBefore', read: {api: 'listTracks'}, pick: ['count']},
        // CREATE: place a 3D object at a fixed LLA. Result {success,name,lat,lon,alt} is deterministic.
        {type: 'apiCall', fn: 'addObjectAtLLA', args: {lat: 40, lon: -100, alt: 10000, name: 'TestOb'}, capture: 'created'},
        // The new object now shows up as a track — manifest should grow and contain it.
        // Project to STABLE fields only: the raw track id is `syntheticTrack_<epochMs>`
        // (a wall-clock timestamp) — nondeterministic, so we keep count + menuText, not id.
        {
            type: 'capture', name: 'tracksAfter',
            read: {eval: "()=>window.sitrecAPI.call('listTracks').then(e=>{const d=e.result||e; return {count:d.count, names:(d.tracks||[]).map(t=>({menuText:t.menuText, isSynthetic:t.isSynthetic}))};})"},
        },
        // Creation should dirty the sitch (unsaved-changes flag).
        {type: 'capture', name: 'dirtyAfter', read: {api: 'getSitchState'}, pick: ['dirty']},
    ],
};
