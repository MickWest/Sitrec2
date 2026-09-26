import * as THREE from "three";
export const BRAND_GROUP={name:"SITREC livery",note:"Globe and lettering fit the current vehicle and stay selected while cycling presets. Reset preset restores its original paint.",fields:[
    {key:"brandLivery",label:"Identity",type:"select",value:"none",options:{none:"Original preset paint",sitrec:"SITREC · globe & lettering"}},
    {key:"brandColor",label:"SITREC blue",type:"color",value:"#0879b1"},
    {key:"brandScale",label:"Marking scale",type:"number",min:0.5,max:1.25,step:0.01,value:1},
]};
const letters={
    S:[[[0.7,0.92],[0.5,1],[0.16,1],[0,0.8],[0.1,0.57],[0.58,0.45],[0.72,0.25],[0.58,0],[0.16,0],[0,0.10]]],
    I:[[[0,0],[0.7,0]],[[0.35,0],[0.35,1]],[[0,1],[0.7,1]]],
    T:[[[0,1],[0.75,1]],[[0.375,1],[0.375,0]]],
    R:[[[0,0],[0,1],[0.5,1],[0.72,0.82],[0.67,0.6],[0.45,0.5],[0,0.5]],[[0.4,0.5],[0.76,0]]],
    E:[[[0.72,1],[0,1],[0,0],[0.72,0]],[[0,0.5],[0.57,0.5]]],
    C:[[[0.72,0.88],[0.5,1],[0.18,1],[0,0.78],[0,0.22],[0.18,0],[0.5,0],[0.72,0.12]]],
};
// Triangle interpolation keeps markings on the rendered surface (including
// taper and cant), rather than on a flat decal that can float through it.
function onMesh(mesh,rows,columns,u,v) {
    u=THREE.MathUtils.clamp(u,0,0.999999);v=THREE.MathUtils.clamp(v,0,0.999999);
    const i=Math.floor(u*rows),j=Math.floor(v*columns),a=u*rows-i,b=v*columns-j;
    const p=i*(columns+1)+j,q=p+columns+1,r=p+1,s=q+1;
    const ids=a+b<=1?[p,q,r]:[s,q,r],weights=a+b<=1?[1-a-b,a,b]:[a+b-1,1-b,1-a];
    const result=new THREE.Vector3(),normal=new THREE.Vector3();
    ids.forEach((id,k)=>{result.addScaledVector(new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.position,id),weights[k]);normal.addScaledVector(new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.normal,id),weights[k]);});
    return result.addScaledVector(normal.normalize(),0.012).toArray();
}
export function addVehicleLivery(model,p) {
    if(p.brandLivery!=="sitrec")return;
    const group=new THREE.Group();group.name="SITREC livery";model.root.add(group);
    const blue=new THREE.MeshStandardMaterial({name:"SITREC blue markings",color:p.brandColor,roughness:0.5});
    const white=new THREE.MeshStandardMaterial({name:"SITREC white globe",color:"#ffffff",roughness:0.5});
    function stroke(path,project,width,mat=blue) {
        const positions=[],indices=[];
        // Build strips in surface coordinates; every edge follows the skin.
        for(let i=1;i<path.length;i++) {
            const a=path[i-1],b=path[i],len=Math.hypot(b[0]-a[0],b[1]-a[1]);if(len<1e-8)continue;
            const nx=-(b[1]-a[1])/len*width/2,ny=(b[0]-a[0])/len*width/2,steps=4;
            for(let j=0;j<steps;j++) {
                const t=j/steps,t1=(j+1)/steps,x=THREE.MathUtils.lerp(a[0],b[0],t),y=THREE.MathUtils.lerp(a[1],b[1],t);
                const x1=THREE.MathUtils.lerp(a[0],b[0],t1),y1=THREE.MathUtils.lerp(a[1],b[1],t1),n=positions.length/3;
                positions.push(...project(x+nx,y+ny),...project(x-nx,y-ny),...project(x1-nx,y1-ny),...project(x1+nx,y1+ny));indices.push(n,n+1,n+2,n,n+2,n+3);
            }
        }
        const g=new THREE.BufferGeometry();g.setAttribute("position",new THREE.Float32BufferAttribute(positions,3));g.setIndex(indices);g.computeVertexNormals();
        const mesh=new THREE.Mesh(g,mat);mat.side=THREE.DoubleSide;mesh.name="SITREC marking";group.add(mesh);
    }
    function word(project,mat=blue) {for(const [i,char]of[..."SITREC"].entries())for(const path of letters[char])stroke(path.map(([x,y])=>[x+i*0.94,y]),project,0.065,mat);}
    function globe(project,mat=blue) {
        stroke(Array.from({length:49},(_,i)=>[Math.cos(i*Math.PI/24),Math.sin(i*Math.PI/24)]),project,0.055,mat);
        for(const width of [0,0.48])stroke(Array.from({length:49},(_,i)=>[width*Math.sin(i*Math.PI/24),Math.cos(i*Math.PI/24)]),project,0.04,mat);
        for(const y of [-0.5,0,0.5])stroke(Array.from({length:25},(_,i)=>{const x=-Math.sqrt(1-y*y)+i/12*Math.sqrt(1-y*y);return[x,y+0.12*(1-x*x-y*y)];}),project,0.04,mat);
    }
    const road=p.vehicleType==="car"||p.vehicleType==="truck", scale=p.brandScale;
    if(model.branding) {
        for(const side of model.branding.sides) {
            word((u,v)=>model.branding.word(u,v,scale,side));
            globe((u,v)=>model.branding.globe(u,v,scale,side));
        }
    } else if(road) {
        const cargo=model.root.getObjectByName("Cargo box"),bounds=cargo?new THREE.Box3().setFromObject(cargo):null;
        const area=model.brandArea;
        const height=Math.min((bounds?bounds.max.y-bounds.min.y:area.height)*0.32,(bounds?bounds.max.z-bounds.min.z:area.length)/7.8)*scale;
        const cy=bounds?(bounds.min.y+bounds.max.y)/2:area.y,cz=bounds?(bounds.min.z+bounds.max.z)/2:area.z;
        const x=bounds?bounds.max.x+0.012:p.width/2+0.012;
        for(const side of [-1,1]) {
            word((u,v)=>[side*x,cy+(v-0.5)*height,cz-side*(u-2.7)*height]);
            globe((u,v)=>[side*x,cy+v*height*0.72,cz+side*(4.4-u*0.72)*height]);
        }
    } else {
        const wingBrand=p.wings&&(p.bodyStyle==="jet"||p.bodyStyle==="glider"||p.bodyStyle==="flyingwing")&&!(p.windows&&p.windowCount>0);
        if(wingBrand)for(const side of [-1,1]) {
            const wing=model.root.getObjectByName(`Wing ${side}`),rows=p.wingPlanform==="flying"?40:10,cols=40;
            const inner=Math.min(0.55,Math.max(0.30,p.diameter/p.span+0.10)),start=inner+0.12;
            // Upper half of the foil loop. Fit lettering into the outer panel.
            // Both words advance in +X when viewed from above, avoiding reflection.
            word((u,v)=>onMesh(wing,rows,cols,start+(side<0?5.5-u:u)/5.5*(0.95-start)*Math.min(scale,1),0.12+v*0.12*scale));
            globe((u,v)=>onMesh(wing,rows,cols,inner+u*0.04*scale,0.25+v*0.055*scale));
        } else {
            const helicopter=p.rotorLayout!=="none",H=p.diameter*p.bodyHeight/2,h=Math.min(H*(helicopter?0.28:0.42),p.length/24)*scale;
            const center=helicopter?0.38:0.30,level=helicopter?-0.50:-0.04;
            for(const side of [-1,1]) {
                word((u,v)=>model.brandSurface(center+side*(u-2.7)*h/p.length,level+(v-0.5)*h/H,side));
                globe((u,v)=>model.brandSurface(center-side*(4.4-u*0.72)*h/p.length,level+v*h*0.72/H,side));
            }
        }
        for(const fin of model.root.children.filter(m=>/^Vertical fin [-\d.]+$/.test(m.name)))for(const face of [1,-1]) {
            const center=onMesh(fin,10,40,0.53,0.25),radius=Math.min(p.finHeight*0.20,p.finChord*0.19)*scale;
            globe((u,v)=>{
                const s=0.53+v*radius/p.finHeight,front=onMesh(fin,10,40,s,0),rear=onMesh(fin,10,40,s,0.5);
                const fraction=THREE.MathUtils.clamp((front[2]-center[2]-u*radius)/(front[2]-rear[2]),0.02,0.98);
                const t=Math.acos(1-2*fraction)/(Math.PI*2);return onMesh(fin,10,40,s,face>0?t:1-t);
            },white);
        }
    }
}
