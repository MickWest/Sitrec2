// M1 — custom-sitch TIME: pin the start date and read the simulation clock back. This is a
// setDateTime fidelity check. NOTE: getCurrentSimTime reflects the displayed time at the loaded
// frame (start + frame/fps offset) and does NOT re-derive from a forced setFrame in regression
// mode — so this is a single-point determinism baseline, not a multi-frame temporal test. A real
// per-frame temporal assertion needs a frame-indexed node read (deferred to a later milestone).
//
// isolated:true — setDateTime is a mutating drive on a fresh, never-saved page.
export default {
    id: 'custom-time-frames',
    sitch: 'custom',
    builtin: true,
    frame: 10,
    tier: 'value',
    network: 'none',
    isolated: true,
    steps: [
        {type: 'apiCall', fn: 'setDateTime', args: {dateTime: '2024-01-01T12:00:00Z'}},
        // isoString is UTC (deterministic); localString is machine-timezone-dependent and dropped.
        // Value reflects 12:00:00 + (loaded frame 10)/fps.
        {type: 'capture', name: 'simTime', read: {api: 'getCurrentSimTime'}, pick: ['isoString']},
    ],
};
