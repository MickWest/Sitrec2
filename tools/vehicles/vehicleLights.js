import * as THREE from "three";

export const LIGHT_GROUP = {name: "Lights", note: "Lights follow the generated body. Locations are family approximations; brightness and flash timing are editable visual defaults.", fields: [
    {key:"lightsEnabled",label:"Procedural lights",type:"checkbox",value:true},
    {key:"positionLights",label:"Position / tail lights",type:"checkbox",value:true},
    {key:"landingLights",label:"Landing lights / headlights",type:"checkbox",value:true},
    {key:"beaconLights",label:"Beacons / emergency lamps",type:"checkbox",value:true},
    {key:"strobeLights",label:"Aircraft strobes",type:"checkbox",value:true},
    {key:"taxiLights",label:"Taxi light",type:"checkbox",value:false},
    {key:"landingLayout",label:"Aircraft landing-light location",type:"select",value:"auto",options:{auto:"Automatic family layout",wingroot:"Wing roots",nose:"Nose / chin",gear:"Nose gear (when extended)"}},
    {key:"landingAim",label:"Beam elevation · °",type:"number",min:-30,max:10,step:1,value:-3},
    {key:"landingCone",label:"Beam half-angle · °",type:"number",min:5,max:45,step:1,value:17},
    {key:"lightGain",label:"Light brightness multiplier",type:"number",min:0.1,max:5,step:0.1,value:1},
    {key:"flashPeriod",label:"Flash interval · s",type:"number",min:0.3,max:3,step:0.01,value:1},
    {key:"flashDuration",label:"Flash duration · s",type:"number",min:0.02,max:0.4,step:0.01,value:0.1},
    {key:"turnSignal",label:"Road indicators",type:"select",value:"none",options:{none:"Off",left:"Left",right:"Right",hazard:"Hazard"}},
]};

// This matches the existing PA28/B737Max8 assets and CNode3DLight: glTF punctual
// lights plus strobeEvery/strobeLength in extras. Intensities are editable visual
// defaults, not certified photometry; placement follows the generated geometry.
export function addVehicleLights(model, p) {
    const road = p.vehicleType === "car" || p.vehicleType === "truck", root = model.root, lamps = [];
    const drone=p.vehicleType==="drone"&&p.droneStyle!=="fixedwing",balloon=p.vehicleType==="balloon";
    model.lamps = lamps;
    // Existing lenses are physical parts of the model even when switched off.
    root.traverse(object => {
        if (/^(Navigation lens|Headlamp |Tail lamp |Front indicator |Emergency lamp)/.test(object.name) && object.isMesh)
            object.material.emissiveIntensity = 0;
    });
    if (!p.lightsEnabled) return;
    const center = object => new THREE.Box3().setFromObject(object).getCenter(new THREE.Vector3()).toArray();
    const L=p.length, R=road||drone||balloon?p.width/2:p.diameter/2, H=road||drone||balloon?p.height:R*p.bodyHeight;
    function lamp(name,color,position,kind="point",flash=false,existing=null,phase=0,strength=null) {
        const intensity=(strength??(drone?Math.max(.02,R*R*25):kind==="spot"?2500:flash?1000:500))*p.lightGain;
        const light=kind==="spot"?new THREE.SpotLight(color,intensity,0,p.landingCone*Math.PI/180,0.3,2):new THREE.PointLight(color,intensity,0,2);
        light.name=name;light.position.set(...position);root.add(light);
        light.userData={vehicleLight:true,role:name,placement:"Procedural family layout",...(flash?{strobeEvery:p.flashPeriod,strobeLength:Math.min(p.flashDuration,p.flashPeriod*0.8),strobeOffset:phase*p.flashPeriod}:{})};
        if(kind==="spot") {
            light.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,-1),new THREE.Vector3(0,Math.sin(p.landingAim*Math.PI/180),Math.cos(p.landingAim*Math.PI/180)));
            const target=new THREE.Object3D();target.name=`${name} target`;target.position.set(0,0,-1);light.add(target);light.target=target;
        }
        let lens=existing;
        if (!lens) {
            const radius=THREE.MathUtils.clamp(R*(kind==="spot"?0.065:0.028),drone?.0015:.022,drone?.018:.13);
            lens=new THREE.Mesh(new THREE.SphereGeometry(radius,10,8),new THREE.MeshStandardMaterial({color,emissive:color,emissiveIntensity:1.8,roughness:0.25}));
            lens.name=`${name} lens`;lens.position.set(...position);root.add(lens);
        } else {lens.material=lens.material.clone();lens.material.emissive.set(color);}
        lens.userData.vehicleLightLens = name;
        lens.material.userData.vehicleLightLens = name;
        lens.material.emissiveIntensity = 1.8;
        lamps.push({light,lens,intensity,phase});
        return light;
    }
    if(balloon) {
        for(const a of model.internalLamps)lamp(a.name,a.color,a.position,"point",false,a.lens,0,a.intensity*p.glow);
    } else if(drone) {
        if(p.positionLights)for(const a of model.statusLamps)lamp(a.name,a.color,a.position);
        const top=[0,p.gearHeight+H*1.12,0];
        if(p.beaconLights)lamp("Drone red beacon","#ff2810",top,"point",true);
        if(p.strobeLights)lamp("Drone white strobe","#ffffff",[0,top[1],-L*.24],"point",true);
        if(p.landingLights) {
            const light=lamp("Downward auxiliary light","#fff0d4",[0,p.gearHeight+H*.04,-L*.2],"spot",false,null,0,Math.max(.1,R*R*500));
            light.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,-1),new THREE.Vector3(0,-1,0));
        }
    } else if(road) {
        for(const side of [1,-1]) {
            const head=root.getObjectByName(`Headlamp ${side}`), tail=root.getObjectByName(`Tail lamp ${side}`), indicator=root.getObjectByName(`Front indicator ${side}`);
            if(p.landingLights)lamp(`${side>0?"Left":"Right"} headlight`,"#fff5da",center(head),"spot",false,head);
            if(p.positionLights)lamp(`${side>0?"Left":"Right"} tail light`,"#ff1b0a",center(tail),"point",false,tail);
            if(p.turnSignal==="hazard" || p.turnSignal===(side>0?"left":"right")) {
                lamp(`${side>0?"Left":"Right"} indicator`,"#ff9900",center(indicator),"point",true,indicator);
                lamp(`${side>0?"Left":"Right"} rear indicator`,"#ff9900",[side*p.width*0.42,center(tail)[1]+0.12,-L/2],"point",true);
            }
        }
        if(p.lightbar && p.beaconLights)for(const [i,lens] of root.children.filter(m=>m.name==="Emergency lamp").entries())lamp(`Emergency beacon ${i+1}`,i===0?"#176aff":"#ff1a14",center(lens),"point",true,lens,i*0.5);
    } else {
        const a=model.lightAnchors, helicopter=p.rotorLayout!=="none";
        const wingTips=helicopter && !p.wings?[a.cabinLeft,a.cabinRight]:[a.leftWing,a.rightWing];
        if(p.positionLights && p.navLights) {
            for(const [i,pos] of wingTips.entries())if(pos)lamp(i===0?"Left Position Red":"Right Position Green",i===0?"#ff0000":"#00ff16",pos,"point",false,root.getObjectByName(`Navigation lens ${i===0?1:-1}`));
            lamp("Rear Position White","#ffffff",a.tail);
        }
        if(p.beaconLights) {
            lamp("Upper Red Beacon","#ff0800",a.upper,"point",true);
            if(!helicopter && p.bodyStyle==="transport")lamp("Lower Red Beacon","#ff0800",a.lower,"point",true,null,0.5);
        }
        if(p.strobeLights) {
            for(const [i,pos] of wingTips.entries())if(pos)lamp(i===0?"Left Strobe":"Right Strobe","#ffffff",[pos[0],pos[1]+0.02,pos[2]-0.04],"point",true);
            if(p.bodyStyle==="transport")lamp("Rear Strobe","#ffffff",[a.tail[0],a.tail[1]+0.06,a.tail[2]],"point",true);
        }
        const layout=p.landingLayout==="auto"?(helicopter||p.bodyStyle==="light"||p.bodyStyle==="glider"?"nose":p.bodyStyle==="jet"&&!p.windows?"gear":"wingroot"):p.landingLayout;
        if(p.landingLights && (layout!=="gear" || p.gear)) {
            if(layout==="wingroot"&&p.wings)for(const [i,pos] of [a.leftLanding,a.rightLanding].entries())lamp(i===0?"Left Landing":"Right Landing","#fff5df",pos,"spot");
            else lamp("Landing Spotlight","#fff5df",layout==="gear"?a.gear:a.nose,"spot");
        }
        if(p.taxiLights && p.gear)lamp("Taxi Spotlight","#fff5df",a.gear,"spot");
    }
    root.updateMatrixWorld(true);
}

export function animateVehicleLights(model,time,animate=true) {
    for(const lamp of model.lamps??[]) {
        const data=lamp.light.userData;
        const on=!animate||!data.strobeEvery||((time+lamp.phase*data.strobeEvery)%data.strobeEvery)<data.strobeLength;
        // Keep the light count stable during flashing to avoid shader recompiles.
        lamp.light.intensity=on?lamp.intensity*0.025:0;
        lamp.lens.material.emissiveIntensity=on?2.5:0.025;
    }
}
