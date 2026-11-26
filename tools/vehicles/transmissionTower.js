import {Vector3} from "three";
import {tubularTower} from "./groundParameters.js";

const point = (x, y, z = 0) => new Vector3(x, y, z);

function horizontalPylon(p, parts, steel, r) {
    const h = p.height, w = p.armSpan, foot = p.baseWidth/2;
    // A waist splits into two sloping lattice heads. The centre phase hangs
    // in the window below the truss, with a shield-wire peak on either side.
    const sections = [[0, foot, foot], [.45, foot*.36, foot*.40], [.85, w*.23, foot*.36]];
    for (let band=0; band<2; band++) {
        const [y0,x0,z0] = sections[band], [y1,x1,z1] = sections[band+1];
        const n = parts.simple ? 1 : Math.max(2,Math.round(p.bays/2));
        for (const side of [-1,1]) for (const face of [-1,1]) {
            const corner = (t,s,f) => point(s*(x0+(x1-x0)*t), Math.max(r*2,h*(y0+(y1-y0)*t)), f*(z0+(z1-z0)*t));
            const base = corner(0,side,face);
            if (!band) parts.box("Concrete footings","#a5a399",base.x,r*1.5,base.z,r*8,r*3,r*8);
            steel(base,corner(1,side,face),r*1.45);
            for (let i=0; i<n; i++) {
                const a=corner(i/n,side,face), b=corner((i+1)/n,side,face);
                steel(a,corner((i+1)/n,side,-face),r*.68);
                if (!band) steel(a,corner((i+1)/n,-side,face),r*.68);
                steel(b,corner((i+1)/n,side,-face),r*.66);
            }
        }
    }
    for (const face of [-1,1]) {
        const z = foot*.36*face;
        for (const level of [.85,.925]) steel(point(-w*.5,h*level,z),point(w*.5,h*level,z));
        const bays = parts.simple ? 4 : 12;
        for (let i=0;i<bays;i++) {
            const x=w*(i/bays-.5),next=w*((i+1)/bays-.5);
            steel(point(x,h*(i%2 ? .925:.85),z), point(next,h*(i%2 ? .85:.925),z),r*.8);
        }
        for (const side of [-1,1]) {
            for (const dx of [-.04,.04]) steel(point(w*side*(.25+dx),h*.925,z), point(w*side*.25,h-r,0));
            steel(point(w*side*.5,h*.85,z),point(w*side*.5,h*.925,-z));
        }
    }
    for (let i=0;i<3;i++) {
        const [x,level] = towerClamp(p,i);
        for (const side of [-1,1]) {
            const seat = x+w*.045*side;
            steel(point(seat,h*.85,-foot*.36),point(seat,h*.85,foot*.36));
            insulator(parts,point(seat,h*.85),point(x,h*level),r);
        }
    }
    for (const side of [-1,1]) parts.beam("Shield wire peaks",p.steelColor,
        point(side*w*.25,h-r,0),point(side*w*.25,h,0),r*.6);
}

// A lattice tier gives its height and the positive phase offsets on either side,
// as fractions of height and overall span. Multiple phases can share one truss.
const fixedTiers = {
    danube: [[.83,.26], [.60,.24,.50]],
    barrel: [[.84,.29], [.67,.50], [.50,.32]],
    flat: [[.78,.19,.345,.50]],
};
const flatThree = [[-.5,.79], [0,.79], [.5,.79]];
const fixedClamps = {
    horizontal: [[-.37,.80], [0,.80], [.37,.80]],
    guyedV: [[-.46,.79], [0,.79], [.46,.79]],
    woodH: flatThree, threePole: flatThree,
    linePost: [[-.5,.85], [.5,.72], [-.5,.59]],
    davit: [[-.46,.82],[.46,.82],[-.50,.66],[.50,.66],[-.48,.50],[.48,.50]],
    tPylon: [[-.24,.79],[.24,.79],[-.50,.79],[.50,.79],[-.37,.65],[.37,.65]],
};

function latticeTiers(p) {
    if (fixedTiers[p.towerStyle]) return fixedTiers[p.towerStyle];
    return Array.from({length:p.armLevels}, (_,i) => p.towerStyle === "british"
        ? [.80-.19*i, [.36,.50,.45][i]]
        : [.86-.15*i, .5*(1-(p.armLevels-1-i)*.065)]);
}

// Keep the inner clamps clear of a wide footing even at the shortest span setting.
const latticeSpan = p => Math.max(p.armSpan,p.baseWidth*1.3);

export function towerCapacity(p) {
    if (fixedClamps[p.towerStyle]) return fixedClamps[p.towerStyle].length;
    if (p.towerStyle === "wintrack" || fixedTiers[p.towerStyle]) return 6;
    return 2*p.armLevels;
}

// The network and the mesh both use these clamp centres. X is in metres,
// Y is a fraction of height to allow a map instance to have its own height.
export function towerClamp(p, index) {
    const layout = fixedClamps[p.towerStyle];
    if (layout) {
        const [offset,level] = layout[index % layout.length];
        return [offset*p.armSpan,level];
    }
    const sign = index%2 ? 1 : -1;
    if (p.towerStyle === "wintrack") {
        const inset = Math.min(p.armSpan, p.baseWidth*.8)/2;
        return [sign*(p.baseWidth/2-inset),.81-.16*(Math.floor(index/2)%3)];
    }
    let pair = Math.floor((index % towerCapacity(p))/2);
    for (const [level,...offsets] of latticeTiers(p)) {
        if (pair < offsets.length) return [sign*offsets[pair]*latticeSpan(p),level-.071];
        pair -= offsets.length;
    }
}

function insulator(parts, start, end, radius) {
    const delta = end.clone().sub(start);
    parts.beam("Insulator strings", "#536b69", start, end, radius*.52, radius*.52, parts.simple ? 4 : 6);
    if (parts.simple) return;
    const discs = Math.max(4,Math.min(12,Math.round(delta.length()/(radius*1.45))));
    for (let i=1; i<=discs; i++) {
        const mid = start.clone().lerp(end,i/(discs+1));
        parts.beam("Insulator sheds", "#70918c", mid, mid.clone().addScaledVector(delta,.38/(discs+1)),
            radius*1.65, radius*.85, 8);
    }
}

function latticeTower(p, parts, steel, r) {
    const h = p.height, foot = p.baseWidth/2;
    const ring = level => {
        const w = foot*(.22+.78*Math.max(0,1-level/.56)), y = h*level;
        return [point(-w,y,-w),point(w,y,-w),point(w,y,w),point(-w,y,w)];
    };
    let lower = ring(0);
    for (const a of lower) {
        parts.box("Concrete footings","#a5a399",a.x,r*1.8,a.z,r*8,r*3.6,r*8);
        a.y = r*2;
    }
    const corners = [lower[2]], bays = parts.simple ? 2 : p.bays;
    for (let i=1; i<=bays; i++) {
        const upper = ring(.91*i/bays);
        for (let j=0; j<4; j++) {
            const next = (j+1)%4;
            steel(lower[j],upper[j],r*1.35);
            steel(upper[j],upper[next]);
            steel(lower[j],upper[next],r*.63);
            steel(lower[next],upper[j],r*.63);
        }
        corners.push(upper[2]);
        lower = upper;
    }
    const apex = point(0,h);
    for (const a of lower) steel(a,apex);
    corners.push(apex);
    // The taper bends at the actual ring elevations, which differ by detail
    // level. Intersect each chord with its leg at its own attachment height.
    function legWidth(y) {
        const i = corners.findIndex(c => c.y >= y);
        const a = corners[i-1], b = corners[i];
        return a.x+(b.x-a.x)*(y-a.y)/(b.y-a.y);
    }
    let cable = 0;
    for (const [level,...offsets] of latticeTiers(p)) {
        const y = h*level, top = h*(level+.061), lowW = legWidth(y), highW = legWidth(top);
        const reach = offsets.at(-1)*latticeSpan(p);
        for (const side of [-1,1]) {
            const tip = point(side*reach,y);
            for (const face of [-1,1]) {
                const low = point(side*lowW,y,face*lowW), high = point(side*highW,top,face*highW);
                steel(low,tip); steel(high,tip);
                for (let i=1; !parts.simple && i<4; i++) {
                    const joint = low.clone().lerp(tip,i/4);
                    steel(high.clone().lerp(tip,(i-1)/4),joint,r*.55);
                    steel(joint,high.clone().lerp(tip,i/4),r*.55);
                }
            }
        }
        for (let phase=0; phase<offsets.length*2; phase++) {
            const [x,clampLevel] = towerClamp(p,cable++);
            if (phase < (offsets.length-1)*2) {
                // Connect the two lower chords where an intermediate string hangs.
                const z = lowW*(reach-Math.abs(x))/(reach-lowW);
                steel(point(x,y,-z),point(x,y,z));
            }
            insulator(parts,point(x,y),point(x,h*clampLevel),r);
        }
    }
}

function poleTower(p, parts) {
    const h = p.height, w = p.armSpan, r = p.shaftDiameter/2, timber = p.towerStyle === "woodH";
    const shaft = x => parts.beam(timber ? "Timber poles" : "Tubular poles", timber ? p.woodColor : p.steelColor,
        point(x,0),point(x,h),r,r*(timber ? .65 : .33),parts.simple ? 6 : 12);
    const steel = (a,b,base,tip=base) => parts.beam("Steel arms",p.steelColor,a,b,base,tip,parts.simple ? 4 : 8);
    const clamp = i => {
        const [x,level] = towerClamp(p,i);
        return point(x,level*h);
    };
    const string = (a,b) => insulator(parts,a,b,h*.0036);
    switch (p.towerStyle) {
    case "woodH": {
        const leg = Math.min(p.baseWidth/2,w*.43), y = .89*h;
        for (const side of [-1,1]) {
            shaft(side*leg);
            parts.beam("Timber braces",p.woodColor,point(-side*leg,h*.33),point(side*leg,h*.75),r*.32,r*.32,4);
        }
        parts.box("Timber crossarm",p.woodColor,0,y,0,w+h*.009,h*.017,r*1.35);
        for (let i=0; i<3; i++) string(point(clamp(i).x,y),clamp(i));
        break;
    }
    case "threePole":
        for (let i=0; i<3; i++) {
            const end = clamp(i), x = end.x+(i===2 ? -1 : 1)*w*.095, y = h*.89;
            shaft(x);
            steel(point(x,y),point(end.x,y),r*.51,r*.27);
            steel(point(x,h*.82),point(end.x,y),r*.22);
            string(point(end.x,y),end);
        }
        break;
    case "linePost":
        shaft(0);
        for (let i=0; i<3; i++) {
            const end = clamp(i);
            string(point(0,end.y-h*.018),end);
            string(point(0,end.y+h*.077),end);
        }
        break;
    case "davit":
        shaft(0);
        for (let i=0; i<6; i++) {
            const end = clamp(i), wrist = point(end.x*.31,end.y+h*.07), tip = point(end.x,end.y+h*.078);
            steel(point(0,end.y+h*.025),wrist,r*.40,r*.27);
            steel(wrist,tip,r*.27,r*.12);
            string(tip,end);
        }
        break;
    case "tPylon":
        shaft(0);
        for (const [i,side] of [-1,1].entries()) {
            const hook = point(side*.37*w,h*.945);
            const shoulder = point(side*.105*w,h*.957);
            steel(point(0,h*.934),shoulder,r*.83,r*.69);
            steel(shoulder,hook,r*.69,r*.28);
            const inner = clamp(i), outer = clamp(2+i), bottom = clamp(4+i);
            for (const middle of [inner,outer]) {
                string(hook,middle);
                string(middle,bottom);
            }
        }
        break;
    case "wintrack":
        for (const [i,side] of [-1,1].entries()) {
            const x = side*p.baseWidth*.5;
            shaft(x);
            for (let row=0; row<3; row++) {
                const end = clamp(row*2+i);
                string(point(x,end.y+h*.081),end);
                string(point(x,end.y-h*.032),end);
            }
        }
        break;
    }
}

function guyedV(p, parts, steel, r) {
    const h = p.height, w = p.armSpan, halfLeg = Math.min(p.baseWidth*.21,w*.07);
    const peak = .93*h, y = .88*h, depth = halfLeg*.7;
    parts.box("Concrete footing","#a5a399",0,r*2,0,halfLeg*1.8,r*4,depth*3);
    for (const side of [-1,1]) {
        // Each leg is a separate box truss rising from the same central shoe.
        const corner = (t,lateral,face) => point(side*w*.245*t + lateral*halfLeg*(.35+.65*t),
            r*3+(y-r*3)*t,face*depth*(.55+.45*t));
        const n = parts.simple ? 2 : p.bays;
        for (const edge of [-1,1]) for (const face of [-1,1]) {
            steel(corner(0,edge,face),corner(1,edge,face),r*1.35);
            for (let j=0; j<n; j++) {
                const a=j/n,b=(j+1)/n;
                steel(corner(a,edge,face),corner(b,-edge,face),r*.65);
                steel(corner(a,edge,face),corner(b,edge,-face),r*.65);
            }
        }
        for (const face of [-1,1]) {
            const anchor = point(side*(w*.58+p.baseWidth),r*.3,face*h*.42);
            parts.beam("Guy wires","#666c6c",corner(1,side,face),anchor,r*.24,r*.24,4);
            steel(point(side*w*.245,y,face*depth),point(side*w*.245,h-r,0));
        }
        steel(point(side*w*.245,h-r,0),point(side*w*.245,h,0),r*.68);
    }
    const n = parts.simple ? 4 : p.bays*2;
    for (const face of [-1,1]) {
        const z = face*depth;
        for (const elevation of [y,peak]) steel(point(-w/2,elevation,z),point(w/2,elevation,z));
        for (let j=0; j<n; j++) steel(point(w*(j/n-.5),j%2 ? peak:y,z),point(w*((j+1)/n-.5),j%2 ? y:peak,z),r*.8);
        for (const side of [-1,1]) steel(point(side*w*.5,y,z),point(side*w*.5,peak,-z));
    }
    for (let i=0; i<3; i++) {
        const [x,level] = towerClamp(p,i);
        steel(point(x,y,-depth),point(x,y,depth));
        insulator(parts,point(x,y),point(x,h*level),r);
    }
}

export function buildTransmissionTower(p, parts) {
    if (tubularTower(p.towerStyle)) return poleTower(p,parts);
    const r = Math.min(p.height*.0026,p.baseWidth*.0225);
    const steel = (a,b,radius=r) => parts.beam("Galvanized steel",p.steelColor,a,b,radius,radius,4);
    if (p.towerStyle === "guyedV") return guyedV(p,parts,steel,r);
    if (p.towerStyle === "horizontal") return horizontalPylon(p,parts,steel,r);
    latticeTower(p,parts,steel,r);
}
