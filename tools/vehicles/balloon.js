import * as THREE from "three";

/** Editable visual envelopes in metres, +Y up. No flight or thermal simulation. */
export function buildBalloon(p) {
    const root = new THREE.Group(); root.name = "Procedural balloon";
    const W=p.width, H=p.height, L=p.length, shape=p.balloonShape;
    const lantern=["lantern","boxlantern","pagoda"].includes(shape), foil=["foil","star","heart"].includes(shape);
    const airship=["blimp","solar"].includes(shape), internalLamps=[];
    let glowMap=null;
    if(lantern) {
        const pixels=new Uint8Array(128*4);
        for(let i=0;i<128;i++) {const value=Math.round(255*(.06+.94*Math.exp(-Math.pow((i/127-.13)/.31,2))));pixels.set([value,value,value,255],i*4);}
        glowMap=new THREE.DataTexture(pixels,1,128);glowMap.magFilter=glowMap.minFilter=THREE.LinearFilter;glowMap.needsUpdate=true;
    }
    const palette=p.balloonPattern==="rainbow"?["#db3e36","#f18d32","#eed04b","#43a867","#298ccb","#8456b5"]:[p.bodyColor,p.accentColor,p.thirdColor];
    const materials=palette.map((color,i)=>new THREE.MeshStandardMaterial({name:`Envelope panel ${i+1}`,color,
        metalness:p.metalness,roughness:p.roughness,side:THREE.DoubleSide,transparent:p.opacity<1,opacity:p.opacity,
        emissive:lantern?new THREE.Color(color).lerp(new THREE.Color("#ffb84d"),.35):"#000000",emissiveMap:glowMap,
        emissiveIntensity:lantern&&p.flame&&p.lightsEnabled?p.glow:0}));
    const mat=(name,color)=>new THREE.MeshStandardMaterial({name,color,roughness:.78});
    const rope=mat("Suspension cord","#8e8267"), basket=mat("Basket wicker","#ad7743"), frame=mat("Frame","#594d3c");
    function mesh(name,geometry,material=frame) {const m=new THREE.Mesh(geometry,material);m.name=name;root.add(m);return m;}
    function box(name,size,position,material=basket) {const m=mesh(name,new THREE.BoxGeometry(...size),material);m.position.set(...position);return m;}
    function rod(name,a,b,r,material=rope) {
        const start=new THREE.Vector3(...a),end=new THREE.Vector3(...b),delta=end.clone().sub(start);
        const m=mesh(name,new THREE.CylinderGeometry(r,r,delta.length(),8),material);
        m.position.copy(start.add(end).multiplyScalar(.5));m.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),delta.normalize());return m;
    }
    function panel(u,v) {
        const gore=Math.min(p.goreCount-1,Math.floor(v*p.goreCount)),band=Math.floor(u*p.patternBands);
        return p.balloonPattern==="solid"?0:p.balloonPattern==="bands"?band%palette.length:
            p.balloonPattern==="checker"?(gore+band)%2:gore%(p.balloonPattern==="alternating"?2:palette.length);
    }
    // Sampling the rendered triangles also provides a surface for the livery.
    function grid(name,point,rows,cols,reverse=false) {
        const positions=[],uv=[],indices=[],batches=materials.map(()=>[]),g=new THREE.BufferGeometry();
        for(let i=0;i<=rows;i++)for(let j=0;j<=cols;j++){positions.push(...point(i/rows,j/cols));uv.push(j/cols,i/rows);}
        for(let i=0;i<rows;i++)for(let j=0;j<cols;j++) {
            const a=i*(cols+1)+j,b=a+cols+1,c=a+1,d=b+1;
            batches[panel((i+.5)/rows,(j+.5)/cols)].push(...(reverse?[a,c,b,c,d,b]:[a,b,c,c,b,d]));
        }
        // One draw call per color, instead of one per tessellated panel quad.
        batches.forEach((batch,i)=>{if(batch.length){g.addGroup(indices.length,batch.length,i);indices.push(...batch);}});
        g.setAttribute("position",new THREE.Float32BufferAttribute(positions,3));g.setAttribute("uv",new THREE.Float32BufferAttribute(uv,2));g.setIndex(indices);g.computeVertexNormals();
        mesh(name,g,materials);
        return (u,v,side)=>{
            u=THREE.MathUtils.clamp(u,0,.999999);v=((v%1)+1)%1;
            const i=Math.floor(u*rows),j=Math.floor(v*cols),a=u*rows-i,b=v*cols-j;
            const n=i*(cols+1)+j,ids=a+b<=1?[n,n+cols+1,n+1]:[n+cols+2,n+cols+1,n+1];
            const weights=a+b<=1?[1-a-b,a,b]:[a+b-1,1-b,1-a],pos=new THREE.Vector3();
            ids.forEach((id,k)=>pos.addScaledVector(new THREE.Vector3().fromBufferAttribute(g.attributes.position,id),weights[k]));
            if(foil)pos.z+=side*L*.002;
            else pos.x+=side*Math.min(W,H,L)*.003;
            return pos.toArray();
        };
    }
    function profile(u) {
        if(shape==="hotair") {
            const r=u<.64?.065+.935*Math.pow(Math.sin(u/.64*Math.PI/2),1.35):Math.sqrt(Math.max(0,1-Math.pow((u-.64)/.36,2)));
            return Math.pow(r,1/p.fullness);
        }
        if(lantern) {
            const r=shape==="pagoda"?.56+.44*Math.sin(Math.min(u/.78,1)*Math.PI/2):.76+.24*Math.sin(u*Math.PI*.8);
            return r*(u>.86?Math.sqrt(Math.max(0,1-Math.pow((u-.86)/.14,2))):1);
        }
        return Math.pow(Math.sqrt(Math.max(0,1-Math.pow(2*u-1,2))),1/p.fullness)*(shape==="oval"?(.74+.26*Math.sin(u*Math.PI*.7)):1);
    }
    let branding;
    if(foil) {
        function outline(t) {
            const angle=t*Math.PI*2+Math.PI/2;
            if(shape==="star") {const n=t*10,i=Math.floor(n),r0=i%2?.47:1,r1=i%2?1:.47;
                const a=i*Math.PI/5+Math.PI/2,b=a+Math.PI/5,q=n-i;
                return [THREE.MathUtils.lerp(Math.cos(a)*r0,Math.cos(b)*r1,q)/.9510565163,(THREE.MathUtils.lerp(Math.sin(a)*r0,Math.sin(b)*r1,q)-.0954915028)/.9045084972];}
            if(shape==="heart") {const a=-t*Math.PI*2;return [Math.pow(Math.sin(a),3),(13*Math.cos(a)-5*Math.cos(2*a)-2*Math.cos(3*a)-Math.cos(4*a)+2.5)/14.5];}
            return [Math.cos(angle),Math.sin(angle)];
        }
        const surfaces={};
        for(const side of [-1,1])surfaces[side]=grid(`Foil envelope ${side}`,(u,v)=>{
            const [x,y]=outline(v),bulge=u<.62?1:Math.cos((u-.62)/.38*Math.PI/2);
            return[x*u*W/2,H/2+y*u*H/2,side*L/2*bulge];
        },20,120,side<0);
        const h=Math.min(W/(shape==="star"?12:8),H*.12),r=Math.min(W,H)*.07;
        const edge=Array.from({length:121},(_,i)=>outline(i/120));
        function foilSurface(x,y,side) {
            const px=x/(W/2),py=(y-H/2)/(H/2);
            if(Math.hypot(px,py)<1e-8)return[0,y,side*(L/2+L*.002)];
            for(let i=0;i<120;i++) {
                const [ax,ay]=edge[i],dx=edge[i+1][0]-ax,dy=edge[i+1][1]-ay,den=px*dy-py*dx;
                if(Math.abs(den)<1e-10)continue;
                const distance=(ax*dy-ay*dx)/den,fraction=(ax*py-ay*px)/den;
                if(distance>0&&fraction>=-1e-8&&fraction<=1+1e-8)return surfaces[side](Math.min(.96,1/distance),(i+fraction)/120,side);
            }
            return[0,H/2,side*L/2];
        }
        branding={sides:[-1,1],word:(u,v,s,side)=>foilSurface(side*(u-2.7)*h*s,H*.49+(v-.5)*h*s,side),
            globe:(u,v,s,side)=>foilSurface(side*u*r*s,H*.68+v*r*s,side)};
    } else {
        const surface=grid("Balloon envelope",(u,v)=>{
            const theta=v*Math.PI*2,bulge=1-p.lobing/100*(1-Math.cos(theta*p.goreCount))/2;
            if(airship) {
                const radius=Math.pow(Math.sqrt(Math.max(0,1-Math.pow(2*u-1,2))),shape==="solar"?.4:1/p.fullness);
                return[Math.cos(theta)*W/2*radius*bulge,H/2+Math.sin(theta)*H/2*radius*bulge,(u-.5)*L];
            }
            const power=shape==="boxlantern"?.30:1,r=profile(u)*bulge;
            const axis=n=>Math.sign(n)*Math.pow(Math.abs(n),power);
            return[axis(Math.cos(theta))*W/2*r,u*H,axis(Math.sin(theta))*L/2*r];
        },64,Math.max(96,p.goreCount*4),airship);
        const h=Math.min(H*.12,L*.075);
        function project(u,v,side) {
            const row=airship?.50-side*u/L:.56+v/H;
            const axis=airship?1:2,target=airship?H/2+v:-side*u;
            // Invert the tessellated surface, including square lantern corners
            // and panel bulges. An analytic angle can compress letters between
            // widely spaced vertices even when it lies on the ideal envelope.
            let lo=-.249999,hi=.249999,point;
            for(let i=0;i<13;i++) {
                const mid=(lo+hi)/2;point=surface(row,side>0?mid:.5-mid,side);
                if(point[axis]<target)lo=mid;else hi=mid;
            }
            return point;
        }
        branding={sides:[-1,1],word:(u,v,s,side)=>project((u-2.7)*h*s,(v-.5)*h*s,side),
            globe:(u,v,s,side)=>project(u*h*.72*s,(2+v*.72)*h*s,side)};
    }
    const small=Math.min(W,H,L), cord=Math.max(.0006,small*.0012);
    if(p.suspended==="basket") {
        const b=p.basketWidth,y=-p.suspension-b*.45,thick=b*.045;
        box("Basket floor",[b,thick,b*.75],[0,y-b*.30,0]);
        for(const side of [-1,1]) {
            box("Basket wall",[thick,b*.60,b*.75],[side*b/2,y,0]);
            box("Basket wall",[b,b*.60,thick],[0,y,side*b*.375]);
            for(const z of [-b*.34,b*.34])rod("Suspension line",[side*b*.46,y+b*.30,z],[side*W*.026,H*.015,Math.sign(z)*L*.026],cord);
        }
        for(let i=0;i<8;i++) {
            const yy=y-b*.25+i*b*.074;
            for(const side of [-1,1])box("Wicker band",[b+thick,thick*.25,thick*.20],[0,yy,side*(b*.375+thick*.51)],rope);
        }
        for(const side of [-1,1])rod("Burner support",[side*b*.35,y+b*.3,0],[side*b*.35,-p.suspension*.12,0],thick*.30,frame);
        rod("Burner crossbar",[-b*.35,-p.suspension*.12,0],[b*.35,-p.suspension*.12,0],thick*.35,frame);
    } else if(p.suspended==="sonde") {
        rod("Radiosonde suspension",[0,0,0],[0,-p.suspension,0],cord);
        box("Radiosonde",[p.basketWidth,p.basketWidth*1.6,p.basketWidth*.65],[0,-p.suspension-p.basketWidth*.8,0],mat("Radiosonde case","#ebebe2"));
    } else if(p.suspended==="gondola") {
        const b=p.basketWidth;
        for(const z of [-b*.60,b*.60])rod("Gondola mount",[0,H*.04,z],[0,-p.suspension,z],cord*3,frame);
        box("Gondola",[b,b*.60,b*2],[0,-p.suspension-b*.30,0],mat("Gondola paint",p.bodyColor));
        const glass=mat("Gondola windows","#1b3e53");
        for(const side of [-1,1])for(let i=0;i<4;i++)box("Gondola window",[b*.012,b*.23,b*.29],[side*b*.504,-p.suspension-b*.20,b*(.7-i*.45)],glass);
    }
    if(p.tether) {
        const points=[];for(let i=0;i<=24;i++) {const t=i/24;points.push(new THREE.Vector3(Math.sin(t*Math.PI*3)*small*.07*t,-t*p.tetherLength,Math.sin(t*Math.PI*2)*small*.04));}
        mesh("Tether ribbon",new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points),48,cord,5,false),rope);
    }
    if(!lantern&&!airship&&p.suspended==="none") {
        const knot=mesh("Balloon neck",new THREE.ConeGeometry(small*.022,small*.06,12),materials[0]);knot.position.y=-small*.023;
    }
    if(airship&&p.balloonFins)for(let i=0;i<4;i++) {
        const g=new THREE.BufferGeometry(),r=Math.max(W,H)*.66;
        g.setAttribute("position",new THREE.Float32BufferAttribute([0,0,-L*.21,r,0,-L*.41,r*.8,0,-L*.51,0,0,-L*.47],3));g.setIndex([0,1,2,0,2,3]);g.computeVertexNormals();
        const m=mesh("Airship tail fin",g,materials[p.balloonPattern==="solid"?0:i%materials.length]);m.rotation.z=i*Math.PI/2;m.position.y=H/2;
    }
    if(lantern) {
        const r=profile(0),points=[];
        for(let i=0;i<=96;i++) {const a=i*Math.PI/48,power=shape==="boxlantern"?.30:1;
            points.push(new THREE.Vector3(Math.sign(Math.cos(a))*Math.pow(Math.abs(Math.cos(a)),power)*W/2*r,0,Math.sign(Math.sin(a))*Math.pow(Math.abs(Math.sin(a)),power)*L/2*r));}
        mesh("Open lantern rim",new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points),96,cord*2,6,false),basket);
        rod("Lantern cross frame",[-W*r/2,0,0],[W*r/2,0,0],cord,frame);
        rod("Lantern cross frame",[0,0,-L*r/2],[0,0,L*r/2],cord,frame);
    }
    if(p.flame) {
        const radius=lantern?small*.042:Math.min(small*.018,p.basketWidth*.12),y=lantern?radius*2:Math.max(0,-p.suspension*.08)+radius*2;
        const fire=new THREE.MeshStandardMaterial({name:"Warm flame",color:"#ffc562",emissive:"#ff9c26",emissiveIntensity:p.lightsEnabled?2:0,roughness:.8});
        const m=mesh("Lantern flame / burner",new THREE.SphereGeometry(1,12,10),fire);m.scale.set(radius,radius*2.5,radius);m.position.set(0,y,0);
        internalLamps.push({name:"Envelope warm light",color:"#ffb34d",position:[0,y,0],lens:m,intensity:Math.max(.1,small*small*12)});
    }
    root.updateMatrixWorld(true);const bounds=new THREE.Box3().setFromObject(root);
    return {root,propellers:[],bounds,internalLamps,branding,stats:{size:bounds.getSize(new THREE.Vector3())}};
}
