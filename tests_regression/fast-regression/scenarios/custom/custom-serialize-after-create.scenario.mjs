// M1 — custom-sitch SERIALIZATION fidelity: creating an object must land in the serialized
// node-graph (the data a share-link / save would persist). We assert the INVARIANT — the
// serialized mods grow meaningfully — rather than an exact node count: object creation spins up
// ~12 sub-nodes asynchronously, so the precise count is timing-sensitive (±1) and not a safe
// baseline. "grew by at least 10" cleanly distinguishes "object serialized" from a regression
// where it isn't (which would be ~0), while tolerating the async ±1.
//
// isolated:true — setDateTime/addObjectAtLLA (driven inside the eval) are mutating, on a fresh,
// never-saved page. exportSitchState is pure/in-memory (no server write).
const SERIAL_GROWTH = `()=>{
  const snapshot = async () => {
    const e = await window.sitrecAPI.call('exportSitchState', {});
    const s = e.result || e;
    return { ok: s.success === true, isFile: s.state && s.state.isASitchFile === true,
             n: s.state && s.state.mods ? Object.keys(s.state.mods).length : 0 };
  };
  return snapshot().then(async (before) => {
    const c = await window.sitrecAPI.call('addObjectAtLLA', {lat:40, lon:-100, alt:10000, name:'SerOb'});
    const after = await snapshot();
    return {
      beforeOk: before.ok, beforeIsFile: before.isFile,
      created: (c.result || c).success === true,
      grewByAtLeast10: (after.n - before.n) >= 10,
    };
  });
}`;

export default {
    id: 'custom-serialize-after-create',
    sitch: 'custom',
    builtin: true,
    frame: 10,
    tier: 'value',
    network: 'none',
    isolated: true,
    steps: [
        {type: 'apiCall', fn: 'setDateTime', args: {dateTime: '2024-01-01T12:00:00Z'}},
        {type: 'capture', name: 'serialization', read: {eval: SERIAL_GROWTH}},
    ],
};
