import {BufferAttribute, BufferGeometry, InstancedBufferAttribute, Mesh, PerspectiveCamera, Vector3, Scene, MeshBasicMaterial, ShaderLib} from 'three';
import {CloudSort, installCloudQuadSort, registerTransparentCamera} from '../src/rendering/CloudSort';
import {triangulateTrackCap} from '../src/rendering/TrackCap';
import {installSoftDepthMaterial, SoftDepthPass} from '../src/rendering/SoftDepth';

test('cloud orders follow each camera, use view depth, and never mutate canonical puffs', () => {
    // Euclidean-distance sorting would incorrectly put the far-off-axis puff first.
    const offsets=new Float32Array([1000,0,-10, 0,0,-100, 0,0,-50]);
    const sizes=new Float32Array([1,2,3,4,5,6]), original=offsets.slice();
    const geometry=new BufferGeometry();
    geometry.setAttribute('instanceOffset',new InstancedBufferAttribute(offsets.slice(),3));
    geometry.setAttribute('instanceSize',new InstancedBufferAttribute(sizes.slice(),2));
    const mesh=new Mesh(geometry), camera=new PerspectiveCamera(), reverse=new PerspectiveCamera();
    reverse.rotation.y=Math.PI;reverse.updateMatrixWorld();camera.updateMatrixWorld();
    const sorter=new CloudSort(offsets,sizes,3);
    sorter.prepare(camera,mesh);
    expect(sorter.current.order).toEqual([1,2,0]);
    const version=geometry.getAttribute('instanceOffset').version;
    sorter.prepare(camera,mesh);
    expect(geometry.getAttribute('instanceOffset').version).toBe(version);
    camera.position.x=10;camera.updateMatrixWorld();sorter.prepare(camera,mesh);
    expect(geometry.getAttribute('instanceOffset').version).toBe(version);
    sorter.prepare(reverse,mesh);expect(sorter.current.order).toEqual([0,2,1]);
    sorter.prepare(camera,mesh);expect(sorter.current.order).toEqual([1,2,0]);
    expect(offsets).toEqual(original);
    expect(Array.from(geometry.getAttribute('instanceSize').array)).toEqual([3,4,5,6,1,2]);
});

test('concave caps triangulate to their actual area with repeated closing points', () => {
    const points=[[0,0],[4,0],[4,4],[3,4],[3,1],[1,1],[1,4],[0,4],[0,0]].map(([x,y])=>new Vector3(x+6371000,y,0));
    const triangles=triangulateTrackCap(points,new Vector3(0,0,1));
    let area=0;
    for(const [a,b,c] of triangles)area+=new Vector3().crossVectors(points[b].clone().sub(points[a]),points[c].clone().sub(points[a])).length()/2;
    expect(triangles).toHaveLength(6);expect(area).toBeCloseTo(10,10);
    expect(triangulateTrackCap(points.toReversed(),new Vector3(0,0,1))).toHaveLength(6);
});

test('legacy cloud sorting permutes whole quads without changing vertices', () => {
    const geometry=new BufferGeometry();
    const positions=[];for(const z of [-10,-50])positions.push(-1,1,z,1,1,z,-1,-1,z,1,-1,z);
    geometry.setAttribute('position',new BufferAttribute(new Float32Array(positions),3));
    geometry.setIndex([0,2,1,2,3,1,4,6,5,6,7,5]);
    const mesh=new Mesh(geometry), camera=new PerspectiveCamera();
    mesh.updateMatrixWorld();camera.updateMatrixWorld();installCloudQuadSort(mesh);
    mesh.userData.prepareTransparentCamera(camera);
    expect(Array.from(geometry.index.array)).toEqual([4,6,5,6,7,5,0,2,1,2,3,1]);
    expect(Array.from(geometry.getAttribute('position').array)).toEqual(positions);
});

test('soft depth binds only within its draw and preserves hooks and shader depth branch', () => {
    const material=installSoftDepthMaterial(new MeshBasicMaterial({transparent:true}),25);
    const shader={...ShaderLib.basic,uniforms:{}};material.onBeforeCompile(shader,{});
    expect(shader.fragmentShader).toContain('#ifdef USE_LOGARITHMIC_DEPTH_BUFFER');
    const scene=new Scene(),camera=new PerspectiveCamera(),mesh=new Mesh(undefined,material);
    const order=[];mesh.userData.prepareTransparentCamera=()=>order.push('prepare');scene.add(mesh);
    registerTransparentCamera(mesh);
    const renderer={getRenderTarget:()=>null};const pass=new SoftDepthPass();
    expect(()=>pass.render(renderer,scene,camera,()=>{scene.onBeforeRender(renderer,scene,camera);order.push('draw');throw Error('failed');})).toThrow('failed');
    material.onBeforeRender(renderer,scene,camera);
    expect(material.userData.softDepthUniforms.softDepthEnabled.value).toBe(false);
    expect(order).toEqual(['prepare','draw']);expect(pass.targets.size).toBe(0);pass.dispose();
    mesh.geometry.dispose();scene.onBeforeRender(renderer,scene,camera);
    expect(order).toEqual(['prepare','draw']);
});
