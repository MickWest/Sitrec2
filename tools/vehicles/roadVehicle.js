import * as THREE from "three";

const rad = Math.PI / 180, mix = THREE.MathUtils.lerp;
export function roadLayout(p) {
    const r = p.wheelRadius, rearCount = p.axles - 1, spacing = r * 2.5;
    const rearSpread = spacing * (rearCount - 1), available = p.length - r * 2.35 - rearSpread;
    const wheelbase = Math.max(r * 2.5, Math.min(p.length * p.wheelbase / 100, available));
    const front = (wheelbase + rearSpread) / 2, rear = front - wheelbase;
    const axles = [front, ...Array.from({length: rearCount}, (_, i) => rear - i * spacing)];
    const belt = Math.max(p.height * p.beltLevel / 100, r * 2.20 + 0.04, p.clearance + 0.2);
    const roof = Math.max(belt + 0.25, p.height * p.cabHeight / 100);
    const cabFront = p.length * (0.5 - p.cabFront / 100), cabRear = p.length * (0.5 - p.cabRear / 100);
    const cabinLength = cabFront - cabRear, rise = roof - belt;
    let frontRake = Math.tan(p.windshieldRake * rad) * rise, rearRake = Math.tan(p.rearRake * rad) * rise;
    const scale = Math.min(1, cabinLength * 0.65 / Math.max(0.001, frontRake + rearRake));
    frontRake *= scale; rearRake *= scale;
    return {r, axles, wheelbase: front - axles.at(-1), belt, roof, cabFront, cabRear, roofFront: cabFront - frontRake, roofRear: cabRear + rearRake};
}

/** Road vehicles use the same metre, +Y up, +Z forward frame as the aircraft. */
export function buildRoadVehicle(p) {
    const root = new THREE.Group(); root.name = "Procedural road vehicle";
    root.userData = {generator: "Sitrec Vehicle Designer", parameters: p, units: "metres", forward: "+Z", up: "+Y"};
    const propellers = [], layout = roadLayout(p), {r, axles, belt, roof, cabFront, cabRear, roofFront, roofRear} = layout;
    const L = p.length, W = p.width, bottom = p.clearance;
    const material = (name, color, roughness = p.roughness, extra = {}) => new THREE.MeshStandardMaterial({name, color, roughness, metalness: 0.12, ...extra});
    const paint = material("Body paint", p.bodyColor), cargoPaint = material("Cargo paint", p.cargoColor), trim = material("Trim", p.trimColor, 0.7);
    const rubber = material("Tire rubber", "#171c21", 0.9), metal = material("Wheel alloy", "#a9b3bd", 0.28, {metalness: 0.8});
    const glass = material("Opaque glazing", p.glassColor, 0.18, {metalness: 0.45, side: THREE.DoubleSide});
    const white = material("Headlamp lens", "#eff4e1", 0.3, {emissive: "#e7eacf", emissiveIntensity: 0.7});
    const red = material("Tail lamp lens", "#a81416", 0.35, {emissive: "#e62b20", emissiveIntensity: 0.6});
    const amber = material("Indicator lens", "#e69a17", 0.35, {emissive: "#ed9616", emissiveIntensity: 0.5});
    function mesh(name, geometry, mat, parent = root) {const m = new THREE.Mesh(geometry, mat); m.name = name; parent.add(m); return m;}
    function box(name, size, position, mat = paint, parent = root) {
        const m = mesh(name, new THREE.BoxGeometry(...size), mat, parent); m.position.set(...position); return m;
    }
    function rod(name, a, b, radius, mat = trim, parent = root) {
        const v = new THREE.Vector3(...a), end = new THREE.Vector3(...b), delta = end.clone().sub(v);
        const m = mesh(name, new THREE.CylinderGeometry(radius, radius, delta.length(), 8), mat, parent);
        m.position.copy(v.add(end).multiplyScalar(0.5)); m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize()); return m;
    }
    function quad(name, vertices, mat, parent = root) {
        const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(vertices.flat(), 3));
        g.setIndex([0, 1, 2, 0, 2, 3]); g.computeVertexNormals(); return mesh(name, g, mat, parent);
    }
    // Extruded side silhouette with actual wheel openings. A solid box through
    // the tires makes wheelbase and ride-height edits look disconnected.
    const shape = new THREE.Shape();
    shape.moveTo(-L / 2, bottom); shape.lineTo(-L / 2, belt * 0.88); shape.lineTo(Math.min(cabRear,-L * 0.44), belt);
    shape.lineTo(Math.max(cabFront,L * 0.42), belt); shape.lineTo(L / 2, belt * 0.87); shape.lineTo(L / 2, bottom);
    const arch = r * 1.16, startAngle = Math.asin(THREE.MathUtils.clamp((bottom - r) / arch, -1, 1));
    for (const z of axles) {
        shape.lineTo(z + Math.cos(startAngle) * arch, bottom);
        for (let j = 1; j <= 24; j++) {
            const a = mix(startAngle, Math.PI - startAngle, j / 24); shape.lineTo(z + Math.cos(a) * arch, r + Math.sin(a) * arch);
        }
    }
    shape.lineTo(-L / 2, bottom); shape.closePath();
    const lower = new THREE.ExtrudeGeometry(shape, {depth: W, bevelEnabled: false, curveSegments: 16});
    lower.translate(0, 0, -W / 2); lower.rotateY(-Math.PI / 2); mesh("Body with wheel arches", lower, paint);
    const bw = W * 0.47, rw = W * p.roofWidth / 200;
    const sides = {};
    for (const side of [-1, 1]) {
        const corners = [[side*bw,belt,cabFront],[side*bw,belt,cabRear],[side*rw,roof,roofRear],[side*rw,roof,roofFront]];
        sides[side] = corners;
        quad(`Cabin side ${side}`, side > 0 ? corners : [...corners].reverse(), paint);
        const at = (u, v, lift = 0) => {
            const lo = corners[0].map((n,k) => mix(n,corners[1][k],u)), hi = corners[3].map((n,k) => mix(n,corners[2][k],u));
            const pos = lo.map((n,k) => mix(n,hi[k],v)); pos[0] += side * lift; return pos;
        };
        if (p.glazing) for (let i = 0; i < p.sideWindows; i++) {
            const gap = Math.min(0.15 / p.sideWindows, p.pillarWidth / 100 / (cabFront - cabRear));
            const a = i / p.sideWindows + gap, b = (i + 1) / p.sideWindows - gap;
            quad(`Side window ${side} ${i}`, [at(a,0.12,0.006),at(b,0.12,0.006),at(b,0.89,0.006),at(a,0.89,0.006)], glass);
        }
        for (let i = 0; i < p.doorsPerSide; i++) {
            const u = (i + 0.82) / p.doorsPerSide, z = mix(cabFront, cabRear, u);
            box(`Door handle ${side} ${i}`, [0.025,0.03,Math.min(0.19,L*0.035)], [side*(W/2+0.012),belt-0.07,z], metal);
        }
        if (p.sideStripe) box(`Side stripe ${side}`, [0.012,Math.min(0.18,belt*0.15),L*0.91], [side*(W/2+0.008),belt*0.82,0], trim);
    }
    quad("Cabin roof", [[-rw,roof,roofFront],[rw,roof,roofFront],[rw,roof,roofRear],[-rw,roof,roofRear]], paint);
    for (const front of [true, false]) {
        const z = front ? cabFront : cabRear, topZ = front ? roofFront : roofRear;
        const corners = [[-bw,belt,z],[bw,belt,z],[rw,roof,topZ],[-rw,roof,topZ]];
        quad(front ? "Windscreen surround" : "Rear window surround", front ? corners : [...corners].reverse(), paint);
        if (p.glazing) {
            const at = (u,v) => {
                const pos = [mix(-mix(bw,rw,v),mix(bw,rw,v),u),mix(belt,roof,v),mix(z,topZ,v)+(front?0.007:-0.007)]; return pos;
            };
            quad(front ? "Front windscreen" : "Rear glazing", [at(0.06,0.12),at(0.94,0.12),at(0.94,0.88),at(0.06,0.88)], glass);
        }
    }
    // Chassis and axles keep the running gear visibly connected to the body.
    for (const side of [-1,1]) box(`Chassis rail ${side}`, [0.10,0.12,L*0.88], [side*W*0.24,Math.max(bottom+0.03,r*0.82),0], trim);
    function wheel(side, z, axle, inner = false) {
        const x = side * (W * p.track / 200 - (inner ? p.tireWidth * 1.03 : 0));
        const mount = new THREE.Group(); mount.name = `Wheel mount ${side} ${axle}${inner ? " inner" : ""}`; mount.position.set(x,r,z); root.add(mount);
        if (axle === 0) mount.rotation.y = p.steering * rad;
        const spin = new THREE.Group(); spin.name = "Wheel"; spin.userData = {spinAxis:"x",spinSpeed:2}; mount.add(spin); propellers.push(spin);
        const tire = mesh("Tire", new THREE.CylinderGeometry(r,r,p.tireWidth,32),rubber,spin); tire.rotation.z = Math.PI / 2;
        const rim = mesh("Alloy rim",new THREE.CylinderGeometry(r*0.60,r*0.60,p.tireWidth+0.009,24),metal,spin);rim.rotation.z = Math.PI/2;
        for (const face of [-1,1]) {
            const faceX = face * (p.tireWidth/2+0.008);
            const disk = mesh("Wheel recess",new THREE.CircleGeometry(r*0.49,24),trim,spin);disk.rotation.y=face*Math.PI/2;disk.position.x=faceX;
            for (let i=0;i<5;i++) {const a=i*Math.PI*2/5;rod("Wheel spoke",[faceX+face*0.003,0,0],[faceX+face*0.003,Math.cos(a)*r*0.50,Math.sin(a)*r*0.50],r*0.045,metal,spin);}
        }
    }
    axles.forEach((z,i) => {
        rod(`Axle ${i}` ,[-W*p.track/200,r,z],[W*p.track/200,r,z],r*0.14,trim);
        for (const side of [-1,1]) {wheel(side,z,i);if(p.dualRear && i>0)wheel(side,z,i,true);}
    });
    // Cargo uses the same cab boundary, so shortening the cab expands the bed.
    const cargoFront = cabRear-0.04, cargoRear = -L/2+0.10, cargoLength = Math.max(0.15,cargoFront-cargoRear), cargoZ=(cargoFront+cargoRear)/2;
    const cargoTop = Math.max(belt+0.3,p.height*p.cargoLevel/100), deck= belt+0.045;
    if (p.cargoStyle === "box") {
        box("Cargo box",[W*0.98,cargoTop-deck,cargoLength],[0,(deck+cargoTop)/2,cargoZ],cargoPaint);
        for(const side of [-1,1]) box("Rear cargo door",[W*0.465,(cargoTop-deck)*0.92,0.018],[side*W*0.24,(deck+cargoTop)/2,cargoRear-0.012],metal);
    } else if (["pickup","flatbed","dump"].includes(p.cargoStyle)) {
        const group=new THREE.Group();group.name="Cargo bed";group.position.set(0,deck,cargoRear);root.add(group);
        if(p.cargoStyle==="dump")group.rotation.x=-p.dumpTilt*rad;
        box("Bed floor",[W*0.97,0.10,cargoLength],[0,0,cargoLength/2],cargoPaint,group);
        if(p.cargoStyle!=="flatbed") {
            const wall=p.cargoStyle==="pickup"?Math.max(0.2,belt-deck+0.12):Math.max(0.3,cargoTop-deck);
            for(const side of [-1,1])box("Bed side",[0.09,wall,cargoLength],[side*W*0.455,wall/2,cargoLength/2],cargoPaint,group);
            for(const z of [0.045,cargoLength-0.045])box("Bed end",[W*0.91,wall,0.09],[0,wall/2,z],cargoPaint,group);
        }
    } else if(p.cargoStyle==="tanker") {
        const radius=Math.min(W*0.45,(cargoTop-deck)/2);
        const tank=mesh("Cargo tank",new THREE.CylinderGeometry(radius,radius,cargoLength,32),cargoPaint);tank.rotation.x=Math.PI/2;tank.position.set(0,deck+radius,cargoZ);
        for(const t of [0.18,0.8]) {const band=mesh("Tank band",new THREE.TorusGeometry(radius+0.015,0.025,6,32),metal);band.position.set(0,deck+radius,mix(cargoRear,cargoFront,t));}
    } else if(p.cargoStyle==="fifthwheel") {
        const fifth=mesh("Fifth wheel",new THREE.CylinderGeometry(W*0.24,W*0.24,0.10,24),trim);fifth.position.set(0,deck,cargoZ);
    }
    for(const side of [-1,1]) {
        box(`Headlamp ${side}`,[W*0.19,Math.min(0.18,belt*0.17),0.025],[side*W*0.32,belt*0.71,L/2-0.003],white);
        box(`Tail lamp ${side}`,[W*0.13,0.18,0.025],[side*W*0.36,belt*0.66,-L/2+0.003],red);
        box(`Front indicator ${side}`,[W*0.08,0.07,0.028],[side*W*0.405,belt*0.53,L/2-0.003],amber);
        if(p.mirrors) {rod("Mirror arm",[side*bw,belt+0.09,cabFront-0.05],[side*(W/2+0.12),belt+0.14,cabFront-0.08],0.022);box("Mirror housing",[0.15,0.13,0.22],[side*(W/2+0.14),belt+0.17,cabFront-0.10],trim);}
    }
    for(const z of [-L/2+0.04,L/2-0.04])box("Bumper",[W*0.95,0.12,0.08],[0,bottom+0.13,z],trim);
    if(p.grille)for(let i=0;i<4;i++)box("Grille slot",[W*0.42,0.025,0.012],[0,belt*0.52+i*0.047,L/2+0.002],trim);
    if(p.roofRack)for(const side of [-1,1]) {
        rod("Roof rail",[side*rw*0.80,roof+0.075,roofFront],[side*rw*0.80,roof+0.075,roofRear],0.028,metal);
        for(const z of [roofFront,roofRear])rod("Rack support",[side*rw*0.80,roof,z],[side*rw*0.80,roof+0.075,z],0.025,trim);
    }
    if(p.spoiler) {for(const side of [-1,1])box("Spoiler support",[0.07,0.18,0.08],[side*W*0.28,belt+0.09,-L*0.43],trim);box("Rear spoiler",[W*0.93,0.06,0.25],[0,belt+0.21,-L*0.43],trim);}
    if(p.lightbar) {
        box("Lightbar base",[W*0.70,0.05,0.20],[0,roof+0.06,(roofFront+roofRear)/2],trim);
        const blue=material("Blue emergency lens","#164aaa",0.25,{emissive:"#206aff",emissiveIntensity:0.7});
        for(const side of [-1,1])box("Emergency lamp",[W*0.32,0.09,0.18],[side*W*0.17,roof+0.12,(roofFront+roofRear)/2],side>0?red:blue);
    }
    if(p.roofSign)box("Taxi roof sign",[W*0.30,0.16,0.24],[0,roof+0.09,(roofFront+roofRear)/2],white);
    root.updateMatrixWorld(true);const bounds=new THREE.Box3().setFromObject(root),size=bounds.getSize(new THREE.Vector3());let triangles=0;
    root.traverse(o=>{if(o.isMesh)triangles+=(o.geometry.index?.count??o.geometry.attributes.position.count)/3;});
    return {root,propellers,bounds,brandArea:{y:belt*0.73,z:(axles[0]+axles[1])/2,length:Math.max(0.4,axles[0]-axles[1]-r*2.2),height:Math.max(0.12,belt-bottom)},stats:{triangles,size,width:W,height:size.y,wheelbase:layout.wheelbase}};
}
