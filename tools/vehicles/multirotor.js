import * as THREE from "three";
import {droneMotorLayout} from "./aerialParameters.js";

/** Metres, +Y up and camera looking +Z. Motor spacing excludes propeller sweep. */
export function buildMultirotor(p) {
    const root = new THREE.Group(); root.name = "Procedural multirotor";
    const propellers = [], statusLamps = [], L = p.length, W = p.width, H = p.height;
    const baseY = p.gearHeight + H * 0.55;
    const material = (name, color, extra = {}) => new THREE.MeshStandardMaterial({name, color, roughness: p.roughness, metalness: .18, ...extra});
    const paint = material("Drone body", p.bodyColor), accent = material("Drone arms", p.accentColor);
    const dark = material("Camera and motors", "#202932"), propPaint = material("Propellers", p.propColor);
    const glass = material("Camera glass", "#173c55", {metalness: .6, roughness: .12});
    function mesh(name, geometry, mat, parent = root) {
        const object = new THREE.Mesh(geometry, mat); object.name = name; parent.add(object); return object;
    }
    function box(name, size, position, mat, parent = root) {
        const object = mesh(name, new THREE.BoxGeometry(...size), mat, parent); object.position.set(...position); return object;
    }
    function ellipsoid(name, size, position, mat, parent = root) {
        const object = mesh(name, new THREE.SphereGeometry(1, 24, 16), mat, parent);
        object.scale.set(...size); object.position.set(...position); return object;
    }
    function rod(name, a, b, radius, mat = accent) {
        const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b), delta = end.clone().sub(start);
        const object = mesh(name, new THREE.CylinderGeometry(radius, radius, delta.length(), 10), mat);
        object.position.copy(start.add(end).multiplyScalar(.5)); object.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), delta.normalize()); return object;
    }
    const bodyWidth=p.droneBody==="spine"?W*.72:W;
    ellipsoid("Center shell", [bodyWidth/2,H/2,L/2], [0,baseY,0], paint);
    // A rounded deck gives the battery a flat marking surface without sharp,
    // unsupported corners projecting beyond the rounded center shell.
    const deckW=bodyWidth*(p.droneBody==="dome"?.48:.68),deckL=L*(p.droneBody==="spine"?.82:.63),radius=Math.min(deckW,deckL)*.15;
    const outline=new THREE.Shape();outline.moveTo(-deckW/2+radius,-deckL/2);
    outline.lineTo(deckW/2-radius,-deckL/2);outline.quadraticCurveTo(deckW/2,-deckL/2,deckW/2,-deckL/2+radius);
    outline.lineTo(deckW/2,deckL/2-radius);outline.quadraticCurveTo(deckW/2,deckL/2,deckW/2-radius,deckL/2);
    outline.lineTo(-deckW/2+radius,deckL/2);outline.quadraticCurveTo(-deckW/2,deckL/2,-deckW/2,deckL/2-radius);
    outline.lineTo(-deckW/2,-deckL/2+radius);outline.quadraticCurveTo(-deckW/2,-deckL/2,-deckW/2+radius,-deckL/2);
    const coverGeometry=new THREE.ExtrudeGeometry(outline,{depth:H*.18,bevelEnabled:false,curveSegments:5});coverGeometry.rotateX(-Math.PI/2);
    const cover=mesh("Battery cover",coverGeometry,paint);cover.position.set(0,baseY+H*.31,-L*.02);
    if(p.droneBody==="stack") {
        box("Frame deck",[W*1.1,H*.16,L],[0,baseY-H*.22,0],accent);
        for(const z of [-L*.18,L*.18])box("Battery strap",[W*.70,H*.035,L*.07],[0,baseY+H*.505,z],dark);
    }
    if(p.droneBody==="spine")for(const side of [-1,1])rod("Cinema boom",[side*p.armSpan/2,baseY+p.armRise,-p.armLength/2],[side*p.armSpan/2,baseY+p.armRise,p.armLength/2],p.armThickness*.7,dark);
    for(const side of [-1,1])ellipsoid("Forward sensor",[bodyWidth*.065,H*.065,L*.018],[side*bodyWidth*.24,baseY+H*.15,L*.438],glass);
    for (const side of [-1,1]) for (let i=0;i<4;i++)
        box("Cooling vent", [W*.012,H*.10,L*.025], [side*W*.49,baseY,-L*.10-i*L*.065], dark);

    for (const [i,[x,z]] of droneMotorLayout(p).entries()) {
        const y = baseY + p.armRise + (z>0?1:-1)*H*.10;
        rod(`Rotor arm ${i+1}`, [Math.sign(x)*W*.26,baseY,Math.sign(z)*L*.24], [x,y,z], p.armThickness/2);
        const motorR = Math.max(p.armThickness*.65, p.rotorDiameter*.065), motorH = Math.max(H*.34, motorR*.75);
        const motor = mesh(`Motor ${i+1}`, new THREE.CylinderGeometry(motorR,motorR,motorH,20), dark);
        motor.position.set(x,y,z);
        function rotor(level, direction) {
            const spin = new THREE.Group(); spin.name = `Rotor ${i+1}${level<0?" lower":" upper"}`;
            spin.position.set(x,y+level*(motorH/2+p.rotorDiameter*.018),z);
            spin.userData = {spinAxis:"y",spinDirection:direction}; root.add(spin); propellers.push(spin);
            ellipsoid("Rotor hub", [motorR*.65,motorR*.24,motorR*.65], [0,0,0], paint, spin);
            const r = p.rotorDiameter/2;
            for (let blade=0;blade<p.rotorBlades;blade++) {
                const bladeShape = new THREE.Shape();
                bladeShape.moveTo(r*.10,-r*.025); bladeShape.lineTo(r*.78,-r*.09);
                bladeShape.quadraticCurveTo(r*1.06,-r*.075,r,.015*r);
                bladeShape.lineTo(r*.40,r*.11); bladeShape.lineTo(r*.10,r*.03); bladeShape.closePath();
                const geometry = new THREE.ExtrudeGeometry(bladeShape,{depth:r*.018,bevelEnabled:false,curveSegments:6});
                geometry.rotateX(Math.PI/2);
                const b=mesh("Propeller blade",geometry,propPaint,spin); b.rotation.y=blade*Math.PI*2/p.rotorBlades+i*.31;
            }
        }
        rotor(1,i%2?1:-1);
        if(p.coaxial) rotor(-1,i%2?-1:1);
        if(p.rotorGuards) {
            const r=p.rotorDiameter*.54, top=y+motorH/2;
            for(const dy of [-p.guardHeight/2,p.guardHeight/2]) {
                const ring=mesh("Propeller guard rim",new THREE.TorusGeometry(r,Math.max(.0015,r*.035),6,40),accent);
                ring.rotation.x=Math.PI/2; ring.position.set(x,top+dy,z);
            }
            for(let j=0;j<4;j++) {
                const a=j*Math.PI/2;
                rod("Guard upright",[x+Math.cos(a)*r,top-p.guardHeight/2,z+Math.sin(a)*r],[x+Math.cos(a)*r,top+p.guardHeight/2,z+Math.sin(a)*r],Math.max(.001,r*.025));
                rod("Guard spoke",[x,y-motorH/2,z],[x+Math.cos(a)*r,top-p.guardHeight/2,z+Math.sin(a)*r],Math.max(.001,r*.022));
            }
        }
        statusLamps.push({name:`${z>0?"Front red":"Rear green"} status ${i+1}`,color:z>0?"#ff2718":"#15ef57",position:[x,y-motorH*.56,z]});
        if(p.droneGear==="feet") rod("Landing foot",[x,y-motorH/2,z],[x,p.armThickness*.15,z],p.armThickness*.30,dark);
    }
    if(p.droneGear==="skids") for(const side of [-1,1]) {
        const x=side*Math.max(W*.68,p.armSpan*.29), low=p.armThickness*.3;
        rod("Landing skid",[x,low,-L*.62],[x,low,L*.62],p.armThickness*.3,dark);
        for(const z of [-L*.32,L*.32]) rod("Gear leg",[side*W*.30,baseY-H*.2,z],[x,low,z],p.armThickness*.28,dark);
    }
    if(p.camera) {
        const size=p.cameraSize, camera=new THREE.Group(); camera.name="Camera gimbal";
        camera.position.set(0,baseY-H*.40-size*.38,L*.46); root.add(camera);
        rod("Gimbal support",[0,baseY-H*.20,L*.36],camera.position.toArray(),size*.10,dark);
        camera.rotation.set(p.cameraPitch*Math.PI/180,p.cameraYaw*Math.PI/180,0);
        ellipsoid("Camera housing",[size*.57,size*.52,size*.40],[0,0,0],dark,camera);
        for(let j=0;j<p.cameraLenses;j++) {
            const radius=size*(p.cameraLenses===1?.32:.19), x=p.cameraLenses===1?0:Math.cos(j*Math.PI*2/p.cameraLenses)*size*.27;
            const y=p.cameraLenses===1?0:Math.sin(j*Math.PI*2/p.cameraLenses)*size*.27;
            const lens=mesh("Camera lens",new THREE.CylinderGeometry(radius,radius,size*.10,24),glass,camera);
            lens.rotation.x=Math.PI/2; lens.position.set(x,y,size*.37);
        }
    }
    if(p.rtk) for(const side of [-1,1]) {
        const x=side*W*.40,y=baseY+H*1.15;
        rod("RTK mast",[x,baseY,x],[x,y,x],W*.018,dark);
        ellipsoid("RTK antenna",[W*.12,H*.12,W*.12],[x,y,x],paint);
    }
    if(p.lidar) ellipsoid("Top sensor",[W*.17,H*.22,W*.17],[0,baseY+H*.65,-L*.25],dark);
    if(p.cargoTank) {
        box("Payload tank",[W*.85,p.gearHeight*.67,L*.64],[0,baseY-H*.5-p.gearHeight*.32,0],paint);
        rod("Spray boom",[-p.armSpan*.52,p.gearHeight*.22,0],[p.armSpan*.52,p.gearHeight*.22,0],p.armThickness*.4,dark);
        for(const side of [-1,1]) ellipsoid("Spray head",[W*.12,W*.06,W*.12],[side*p.armSpan*.5,p.gearHeight*.20,0],accent);
    }
    root.updateMatrixWorld(true);
    const bounds=new THREE.Box3().setFromObject(root),size=bounds.getSize(new THREE.Vector3());
    const h=Math.min(deckW*.145,L*.065), labelY=baseY+H*.495+.001;
    return {root,propellers,bounds,statusLamps,stats:{size,rotors:propellers.length},branding:{sides:[1],
        word:(u,v,scale)=>[(u-2.7)*h*scale,labelY,-L*.13-(v-.5)*h*scale],
        globe:(u,v,scale)=>[u*h*.72*scale,labelY,L*.15-v*h*.72*scale]}};
}
