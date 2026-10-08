import {BoxGeometry, Color, DataTexture, Float32BufferAttribute, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, Vector3, Vector4} from "three";
import {ThermalPipeline} from "../tools/thermal/ThermalPipeline.js";
import {normalizeSettings} from "../tools/thermal/thermalSchema.js";
import {inBandRadiance, PHOTON_SCALE} from "../tools/thermal/radiometry.js";

function fixture(settings = {}) {
    const pipeline = new ThermalPipeline({}, {analysis:false, synchronous:false});
    pipeline.resources = {targets:new Map(), materials:new Map(), surfaces:new Map(), textures:new Set()};
    pipeline.rangeLUT = {size:2, maxRangeM:10000, transmission:new Float32Array(24).fill(1), pathRadiance:new Float32Array(24)};
    return {pipeline, settings:normalizeSettings(settings), attributes:{temperatureK:settings.groundTemperatureK ?? 288.15, emissivity:1, terrainColor:true}};
}

test.each([[150,3,3.1],[288.15,3,5],[350,4.9,5]])("terrain temperature interpolation agrees with direct photon integration (%i K, %f–%f um)", (temperatureK,bandMinUm,bandMaxUm) => {
    const f = fixture({groundTemperatureK:temperatureK, groundTemperatureSpanK:30, bandMinUm,bandMaxUm});
    try {
        const table=f.pipeline._terrainTable(f.attributes,f.settings), rows=table.spectra.length, data=table.texture.image.data;
        let worst=0;
        // Independent Planck integration at off-grid temperatures across the full
        // permitted span, including the coldest short-band case.
        for(let i=0;i<83;i++) {
            const coordinate=(i+.37)/83*(rows-1), lower=Math.floor(coordinate), fraction=coordinate-lower;
            const actual=data[lower*8]*(1-fraction)+data[(lower+1)*8]*fraction;
            const t=temperatureK-15+30*coordinate/(rows-1);
            const reference=inBandRadiance(t,{minUm:bandMinUm,maxUm:bandMaxUm}).photon/PHOTON_SCALE;
            worst=Math.max(worst,Math.abs(actual/reference-1));
        }
        expect(worst).toBeLessThan(.001);
    } finally {f.pipeline.dispose();}
});

test("terrain tiles share their temperature/range table while retaining map channel, transform, material and vertex colors",()=>{
    const f=fixture(), mesh=new Mesh(new BoxGeometry(),new MeshBasicMaterial({color:.5}));
    const firstMap=new DataTexture(new Uint8Array([80,90,100,255]),1,1);
    firstMap.channel=1; firstMap.offset.set(.2,.3); mesh.geometry.setAttribute("uv1",mesh.geometry.attributes.uv.clone());
    mesh.material.map=firstMap; mesh.material.vertexColors=true;
    mesh.geometry.setAttribute("color",new Float32BufferAttribute(new Float32Array(mesh.geometry.attributes.position.count*3).fill(.5),3));
    const original=mesh.material, other=original.clone(); other.map=firstMap.clone();
    try {
        const a=f.pipeline._surface(f.attributes,original,f.settings,new Vector3(),mesh);
        const b=f.pipeline._surface(f.attributes,other,f.settings,new Vector3(),mesh);
        expect(a).not.toBe(b);expect(a.uniforms.rangeTexture.value).toBe(b.uniforms.rangeTexture.value);
        expect(f.pipeline.resources.terrainTables.size).toBe(1);
        expect(a.map).toBe(firstMap);expect(a.map.channel).toBe(1);expect(a.vertexColors).toBe(true);
        expect(a.uniforms.mapTransform.value.elements).toEqual(firstMap.matrix.elements);
        expect(a.uniforms.terrainColor.value).toBe(original.color);expect(mesh.material).toBe(original);
        // Atmospheric extinction suppresses every temperature row. No RGB
        // contrast can bypass an opaque path; only the same path emission remains.
        f.pipeline.rangeLUT.transmission.fill(0);f.pipeline.rangeLUT.pathRadiance.fill(2);
        f.pipeline._updateTerrainTable([...f.pipeline.resources.terrainTables.values()][0]);
        const data=a.uniforms.rangeTexture.value.image.data;
        for(let row=0;row<a.uniforms.temperatureSamples.value;row++)expect(data[row*8]).toBe(data[0]);
    } finally {f.pipeline.dispose();mesh.geometry.dispose();original.dispose();other.dispose();firstMap.dispose();other.map.dispose();}
});

test("uncolored ground keeps its uniform temperature and never borrows an object or sea color",()=>{
    const f=fixture(), mesh=new Mesh(new BoxGeometry(),new MeshBasicMaterial());
    try {
        const pass=f.pipeline._surface(f.attributes,mesh.material,f.settings,new Vector3(),mesh);
        expect(pass.uniforms.temperatureSamples).toBeUndefined();expect(f.pipeline.resources.terrainTables).toBeUndefined();
        mesh.material.color=new Color(.2,.3,.4);
        const object=f.pipeline._surface({temperatureK:310,emissivity:1},mesh.material,f.settings,new Vector3(),mesh);
        expect(object.uniforms.temperatureSamples).toBeUndefined();
    } finally {f.pipeline.dispose();mesh.geometry.dispose();mesh.material.dispose();}
});

test("terrain draw restores visible materials and expires the shared table when its last tile leaves",()=>{
    const f=fixture(), scene=new Scene(), camera=new PerspectiveCamera(60,1,1,20000), group=new Group();
    const mesh=new Mesh(new BoxGeometry(100,100,100),new MeshBasicMaterial({color:0x555555}));
    mesh.position.z=-1000;group.add(mesh);scene.add(group);camera.updateMatrixWorld(true);
    f.pipeline.radianceAdapter={attributes:()=>f.attributes,isSurface:()=>true};
    f.pipeline._drawRadiance=()=>{};
    const original=mesh.material,target={width:640,height:512,viewport:new Vector4()};
    try {
        f.pipeline._radiance(scene,camera,f.settings,target,0);expect(mesh.material).toBe(original);
        const table=[...f.pipeline.resources.terrainTables.values()][0],dispose=jest.spyOn(table.texture,"dispose");
        group.clear();f.pipeline._radiance(scene,camera,f.settings,target,0);
        expect(dispose).toHaveBeenCalledTimes(1);expect(f.pipeline.resources.terrainTables.size).toBe(0);
    } finally {f.pipeline.dispose();mesh.geometry.dispose();original.dispose();}
});
