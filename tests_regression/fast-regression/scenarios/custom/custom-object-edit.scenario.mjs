// M1 — custom-sitch object EDITING: create an object, then change its geometry and dimensions
// via the API (the same path the objects-menu UI drives). Uses setAllObjects* so it doesn't
// depend on the created object's folder name — which is `syntheticObject_<number>` (NOT the
// passed `name`) and therefore nondeterministic. We baseline a STABLE summary (success + applied
// flags + object count), never the raw object names.
//
// isolated:true — add/setGeometry/setDimensions are mutating drives on a fresh, never-saved page.
export default {
    id: 'custom-object-edit',
    sitch: 'custom',
    builtin: true,
    frame: 10,
    tier: 'value',
    network: 'none',
    isolated: true,
    steps: [
        {type: 'apiCall', fn: 'addObjectAtLLA', args: {lat: 40, lon: -100, alt: 10000, name: 'EditOb'}, capture: 'created'},
        // Drive + project: switch every object to a box; baseline only the stable summary.
        // (The default custom sitch ships traverseObject + cameraObject, so count is 3 with ours.)
        {
            type: 'capture', name: 'geom',
            read: {eval: "()=>window.sitrecAPI.call('setAllObjectsGeometry',{geometry:'box'}).then(e=>{const r=e.result||e;const o=r.objects||[];return {success:r.success===true, geometry:r.geometry, count:o.length, allApplied:o.every(x=>x.success&&x.geometry==='box')};})"},
        },
        {
            type: 'capture', name: 'dims',
            read: {eval: "()=>window.sitrecAPI.call('setAllObjectsDimensions',{width:50,height:30,depth:20}).then(e=>{const r=e.result||e;const o=r.objects||[];return {success:r.success===true, count:o.length, allApplied:o.every(x=>x.success&&x.dimensions&&x.dimensions.width===50&&x.dimensions.height===30&&x.dimensions.depth===20)};})"},
        },
    ],
};
