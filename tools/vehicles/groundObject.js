import {
    Box3, BoxGeometry, BufferGeometry, Color, CylinderGeometry, DoubleSide, Float32BufferAttribute,
    Group, IcosahedronGeometry, LatheGeometry, Mesh, MeshStandardMaterial, Quaternion, Vector2, Vector3,
} from "three";
import {mergeGeometries} from "three/addons/utils/BufferGeometryUtils.js";

const tau = Math.PI * 2;
const point = (x, y, z) => new Vector3(x, y, z);
const up = point(0, 1, 0);

// All choices for a tree or stone come from its recipe, including color variation.
function randomSequence(seed) {
    let state = seed;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 4294967296;
    };
}

// A tower has hundreds of steel members. Bake their transforms into a mesh per
// material so that placing several towers or trees costs only a few draws each.
function groundParts(simple) {
    const batches = new Map();
    function add(name, color, shape) {
        if (!batches.has(name)) batches.set(name, {color, shapes: []});
        const geometry = shape.index ? shape.toNonIndexed() : shape;
        geometry.deleteAttribute("uv");
        batches.get(name).shapes.push(geometry);
    }
    function beam(name, color, a, b, baseRadius, tipRadius = baseRadius, sides = 6) {
        const axis = b.clone().sub(a);
        const shape = new CylinderGeometry(tipRadius, baseRadius, axis.length(), sides);
        const midpoint = a.clone().lerp(b, .5);
        shape.applyQuaternion(new Quaternion().setFromUnitVectors(up, axis.normalize()));
        shape.translate(midpoint.x, midpoint.y, midpoint.z);
        add(name, color, shape);
    }
    function box(name, color, x, y, z, width, height, depth) {
        add(name, color, new BoxGeometry(width, height, depth).translate(x, y, z));
    }
    function lathe(name, color, profile) {
        add(name, color, new LatheGeometry(profile.map(([r, y]) => new Vector2(r, y)), 64));
    }
    function finish() {
        const root = new Group();
        for (const [name, {color, shapes}] of batches) {
            const material = new MeshStandardMaterial({color, side: DoubleSide, roughness: .9});
            const mesh = new Mesh(mergeGeometries(shapes), material);
            mesh.name = name;
            root.add(mesh);
        }
        return root;
    }
    return {add, beam, box, lathe, finish, simple};
}

function towerArm(p, tier) {
    if (p.towerStyle === "british") return {y: .80-.19*tier, reach:p.armSpan*.5*[.72,1,.90][tier]};
    return {y: .86-tier*.15, reach:p.armSpan*.5*(1-(p.armLevels-1-tier)*.065)};
}

// Used both by the editable model and the wire renderer. X is the crossarm
// offset in metres, and Y is a fraction of the selected support height.
// The incoming and outgoing conductors terminate on the same insulator clamp.
export function powerWireAttachment(p, cable, count, port = "out") {
    if (port !== "in" && port !== "out") throw new RangeError("Unknown wire attachment point " + port);
    if (p.towerStyle === "horizontal") return [[-.37,0,.37][cable%3]*p.armSpan,.80];
    if (p.groundKind === "pylon") {
        const arm = towerArm(p, Math.floor(cable/2) % p.armLevels);
        return [(cable%2 ? 1 : -1)*arm.reach, arm.y-.071];
    }
    if (p.poleStyle === "vaulted") return [[-.5,0,.5][cable%3]*p.armSpan, cable%3 === 1 ? .934 : .80];
    if (p.poleStyle === "british") return [[-.45,0,.45][cable%3]*p.armSpan, cable%3 === 1 ? .993 : .931];
    const row = Math.floor(cable/(2*p.pins)), pins = Math.min(2*p.pins, count-row*2*p.pins);
    const pin = pins === 1 ? 0 : Math.round((cable%(2*p.pins))*(2*p.pins-1)/(pins-1));
    const side = pin < p.pins ? -1 : 1, index = pin < p.pins ? p.pins-1-pin : pin-p.pins;
    return [side*p.armSpan/2*(index+.75)/(p.pins-.1), .94-.082*row+p.poleDiameter*.56/p.height];
}

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
        const [x,level] = powerWireAttachment(p,i,3);
        for (const side of [-1,1]) parts.beam("Suspension insulators","#6d9690",point(x+w*.045*side,h*.85,0),
            point(x,h*level,0),r*1.3,r*1.3,parts.simple ? 4:8);
    }
    for (const side of [-1,1]) parts.beam("Shield wire peaks",p.steelColor,
        point(side*w*.25,h-r,0),point(side*w*.25,h,0),r*.6);
}

function transmissionTower(p, parts) {
    const h = p.height, foot = p.baseWidth / 2, mast = foot * .22, r = Math.min(h * .0026, foot * .045);
    const steel = (a, b, radius = r) => parts.beam("Galvanized steel", p.steelColor, a, b, radius, radius, 4);
    if (p.towerStyle === "horizontal") return horizontalPylon(p,parts,steel,r);
    const halfWidth = level => mast + (foot - mast) * Math.max(0, 1 - level / .56);
    const ring = level => {
        const w = halfWidth(level), y = h * level;
        return [point(-w,y,-w), point(w,y,-w), point(w,y,w), point(-w,y,w)];
    };
    let lower = ring(0);
    for (const a of lower) {
        parts.box("Concrete footings", "#a5a399", a.x, r*1.8, a.z, r*8, r*3.6, r*8);
        a.y = r*2;
    }
    const bays = parts.simple ? 2 : p.bays;
    for (let i = 1; i <= bays; i++) {
        const upper = ring(.91 * i / bays);
        for (let j = 0; j < 4; j++) {
            const next = (j+1)%4;
            steel(lower[j], upper[j], r * 1.35);
            steel(upper[j], upper[next]);
            steel(lower[j], upper[next], r * .63);
            steel(lower[next], upper[j], r * .63);
        }
        lower = upper;
    }
    for (const a of lower) steel(a, point(0,h,0));
    for (let tier = 0; tier < p.armLevels; tier++) {
        const arm = towerArm(p,tier), level = arm.y, y = h*level, w = halfWidth(level);
        const reach = Math.max(w*1.4,arm.reach);
        for (const sign of [-1, 1]) {
            const tip = point(sign*reach,y,0);
            for (const z of [-w, w]) {
                const start = point(sign*w, y, z), end = point(sign*w, y+h*.061, z);
                steel(start, tip); steel(end, tip);
                for (let j = 1; !parts.simple && j < 4; j++) {
                    const joint = start.clone().lerp(tip, j/4);
                    steel(end.clone().lerp(tip, (j-1)/4), joint, r*.55);
                    steel(joint, end.clone().lerp(tip, j/4), r*.55);
                }
            }
            if (parts.simple) continue;
            const drop = h * .071;
            parts.beam("Insulator pins", "#454a48", tip, point(tip.x,y-drop,0), r*.52);
            for (let j=1; j<=9; j++) {
                const disc = y-drop*j/10;
                parts.beam("Glass insulators", "#6d9690", point(tip.x,disc,0), point(tip.x,disc+drop*.045,0), r*2.1, r*1.1, 10);
            }
        }
    }
}

function telegraphPole(p, parts) {
    const h = p.height, r = p.poleDiameter / 2;
    if (p.poleStyle === "vaulted" || p.poleStyle === "british") {
        const vault = p.poleStyle === "vaulted", top = vault ? .89 : .98;
        if (vault) parts.beam("Concrete shaft",p.concreteColor,point(0,0,0),point(0,h*top,0),r*1.3,r*.78,4);
        else parts.beam("Timber pole",p.woodColor,point(0,0,0),point(0,h*top,0),r,r*.63,12);
        const metal = (a,b,rad) => parts.beam("Steel crossarm","#757d80",a,b,rad,rad,6);
        for (let i=0;i<3;i++) {
            const [x,level] = powerWireAttachment(p,i,3), end = point(x,h*level,0);
            const at = point(x,h*(level + (vault ? .055 : -.045)),0);
            if (vault) {
                const knee = point(x*.52,h*(i===1 ? .982:.946),0);
                metal(point(0,h*.83,0),knee,r*.42); metal(knee,at,r*.39);
            } else if (i !== 1) {
                metal(point(0,at.y,0),at,r*.43); metal(point(0,h*.81,0),point(x*.77,at.y,0),r*.18);
            }
            parts.beam("Porcelain insulators","#716557",at,end,r*.31,r*.31,8);
            if (!parts.simple) for (let d=1;d<=4;d++) {
                const mid=at.clone().lerp(end,d/5);
                parts.beam("Porcelain insulators","#716557",mid,mid.clone().add(point(0,r*.14,0)),r*.54,r*.35,8);
            }
        }
        const peak = vault ? "Vault cap" : "Pole cap";
        parts.beam(peak,vault ? "#757d80" : p.woodColor,point(0,h*top,0),point(0,h,0),r*.33,r*.23);
        return;
    }
    parts.beam("Timber pole", p.woodColor, point(0,0,0), point(0,h,0), r, r*.63, 12);
    for (let row=0; row<p.armLevels; row++) {
        const y = h*(.94-.082*row), z = r*.8;
        parts.box("Timber crossarms", p.woodColor, 0,y,z, p.armSpan,r*.94,r*.75);
        if (parts.simple) continue;
        for (const sign of [-1,1]) {
            parts.beam("Steel braces", "#626761", point(0,y-h*.052,z), point(sign*p.armSpan*.30,y,z), r*.085);
            for (let j=0; j<p.pins; j++) {
                const x = sign * p.armSpan/2 * (j+.75)/(p.pins-.1), bottom = y+r*.47;
                parts.beam("Insulator pins", "#4e4d45", point(x,bottom,z), point(x,bottom+r*.65,z), r*.12);
                for (let k=0; k<2; k++) {
                    const base = bottom + r*(.22+.34*k);
                    parts.beam("Glass insulators", "#698e84", point(x,base,z), point(x,base+r*.35,z), r*.37, r*.22, 10);
                }
            }
        }
    }
}

function chimney(p, parts) {
    const h = p.height, r = p.baseDiameter/2, top = r*p.topRatio;
    const radius = t => r + (top-r)*t;
    parts.lathe("Foundation", "#98948a", [[r*1.12,0], [r*1.12,h*.025], [radius(.025),h*.025]]);
    const count = p.bands * 2 + 1;
    for (let j=0; j<count; j++) {
        const a = .025 + .955*j/count, b = .025 + .955*(j+1)/count;
        const band = j%2 === 1;
        parts.lathe(band ? "Painted bands" : "Stack", band ? p.bandColor : p.shaftColor,
            [[radius(a),a*h], [radius(b),b*h]]);
    }
    parts.lathe("Coping", "#756e64", [[radius(.98),.98*h], [top*1.08,.983*h], [top*1.08,h], [top*.84,h]]);
    parts.lathe("Flue lining", "#494540", [[top*.84,h], [top*.85,h*.84], [0,h*.84]]);
}

function coolingTower(p, parts) {
    const h = p.height, r = p.baseDiameter/2, throat = p.throatRatio*r;
    const inlet = h*.09, waist = h*p.throatLevel/100;
    // Two hyperbolic sections meet with a horizontal tangent at the throat.
    const radius = y => {
        const lower = y < waist, end = lower ? r : throat*1.10;
        const t = (y-waist)/(lower ? waist-inlet : h-waist);
        return Math.sqrt(throat*throat + (end*end-throat*throat)*t*t);
    };
    const profile = Array.from({length: 33}, (_,i) => {
        const y = inlet+(h-inlet)*i/32;
        return [radius(y),y];
    });
    const lip = radius(h);
    profile[profile.length-1] = [lip+r*.009,h];
    profile.push([lip-r*.013,h], [lip-r*.013,h*.982]);
    parts.lathe("Cooling shell", p.shellColor, profile);
    parts.lathe("Basin ring", "#959387", [[r*1.025,0], [r*1.025,h*.013], [r*.94,h*.013], [r*.94,0]]);
    const support = (angle,y,rad) => point(Math.cos(angle)*rad,y,Math.sin(angle)*rad);
    for (let i=0; i<36; i++) {
        for (const side of [-1,1]) parts.beam("Raking columns", p.shellColor,
            support(tau*i/36,h*.012,r), support(tau*(i+.5*side)/36,inlet,r), r*.013);
    }
}

// Distort coincident vertices identically so shared edges in the icosphere stay closed.
function roughEllipsoid(random, roughness, detail) {
    const shape = new IcosahedronGeometry(1, detail), positions = shape.attributes.position;
    const phase = Array.from({length: 4}, () => random()*tau);
    for (let i=0; i<positions.count; i++) {
        const x=positions.getX(i), y=positions.getY(i), z=positions.getZ(i);
        const noise = .14*Math.sin(3*x+2*y+phase[0])*Math.cos(4*z+phase[1])
            + .10*Math.cos(5*y-3*z+phase[2]) + .07*Math.sin(8*x+6*z+phase[3]);
        const scale = 1+roughness*noise;
        positions.setXYZ(i, x*scale,y*scale,z*scale);
    }
    shape.computeVertexNormals();
    return shape;
}

function boulder(p, parts, random) {
    const shape = roughEllipsoid(random,p.irregularity,2), pos = shape.attributes.position;
    for (let i=0; i<pos.count; i++) {
        const y = pos.getY(i);
        pos.setXYZ(i, pos.getX(i)+.17*y*p.irregularity, Math.max(-.58,y), pos.getZ(i));
    }
    shape.computeVertexNormals();
    parts.add("Stone", p.stoneColor, shape);
}

function tree(p, parts, random) {
    const wood = (a,b,r,t) => parts.beam("Bark",p.woodColor,a,b,r,t,8);
    const foliage = shape => {
        const index = Math.floor(random()*4);
        const tone = new Color(p.leafColor).multiplyScalar(.75+index*.13);
        parts.add("Foliage "+(index+1), tone, shape);
    };
    const polar = (a,r,y) => point(r*Math.cos(a),y,r*Math.sin(a));
    // Construct at unit height, then fit the requested crown and height. Keeping
    // the trunk at the origin makes it the pivot when the user rotates the tree.
    if (p.treeForm === "oak") {
        const fork = point(.025,.30,-.01);
        wood(point(0,0,0),fork,.044,.029);
        function branch(base, angle, run, rise, radius, depth) {
            const elbow = base.clone().add(polar(angle,run*.52,rise*.37));
            const tip = elbow.clone().add(polar(angle+random()*.45-.225,run*.48,rise*.63));
            wood(base,elbow,radius,radius*.77); wood(elbow,tip,radius*.77,radius*.53);
            if (depth > 0) {
                for (const side of [-1,1]) branch(tip,angle+side*(.48+random()*.77),
                    run*(.54+random()*.26),rise*(.48+random()*.30),radius*.56,depth-1);
            } else {
                for (let i=0; i<2+p.density; i++) {
                    const center = tip.clone().add(polar(random()*tau, random()*.087, random()*.078));
                    const size = .064 + random()*.052;
                    foliage(roughEllipsoid(random,1,1).scale(size,size*.85,size).translate(center.x,center.y,center.z));
                }
            }
        }
        for (let i=0; i<7; i++) {
            const inner = i%3 === 0;
            branch(fork, i*tau/7+random()*.4, inner ? .095 : .21, (inner ? .255 : .13)+random()*.045, .023, 2);
        }
    } else if (p.treeForm === "pine") {
        wood(point(0,0,0),point(0,1,0),.025,.002);
        for (let tier=0; tier<11; tier++) {
            const y = .22+tier*.07, reach = .36*(1-y)+.015;
            const count = 6+p.density, phase = random()*tau;
            for (let j=0; j<count; j++) {
                const a = phase + tau*(j+random()*.35)/count, length = reach*(.82+random()*.33);
                // A whorl of individually drooping sprays with a raised central ridge.
                const start = point(0,y+.09,0), tip = polar(a,length,y-.045);
                const ridge = polar(a,length*.55,y+.035);
                const left = polar(a-.33,length*.75,y-.055-random()*.025);
                const right = polar(a+.33,length*.75,y-.055-random()*.025);
                foliage(triangles([start,left,ridge, left,tip,ridge, ridge,tip,right, start,ridge,right]));
            }
        }
    } else {
        let top = point(0,0,0);
        for (let i=1; i<=14; i++) {
            const t = i/14, next = point(.13*t*t,t*.84,.03*Math.sin(t*Math.PI));
            const radius = .025*(1-.35*t);
            wood(top,next,radius*1.12,radius); top = next;
        }
        for (let j=0; j<8+p.density*2; j++) {
            const a = j*2.39996+random()*.3, reach=.34+random()*.18, arch=.14+random()*.12, droop=.10+random()*.22;
            const along = t => top.clone().add(polar(a,reach*t, arch*Math.sin(t*Math.PI)-droop*t*t));
            let last = top;
            const blades = [];
            for (let k=1; k<=16; k++) {
                const t=k/16, base=along(t);
                parts.beam("Frond stems", p.leafColor,last,base,.006*(1-t)+.001,.004*(1-t)+.0007,5);
                for (const side of [-1,1]) {
                    const length = .103*Math.sin(Math.PI*(.04+.93*t));
                    const end = base.clone().add(polar(a+side*1.08,length,-length*.45));
                    const mid = base.clone().lerp(end,.47);
                    const l = mid.clone().add(polar(a,.009,.003)), r = mid.clone().add(polar(a,-.009,.003));
                    blades.push(base,l,end, base,end,r);
                }
                last=base;
            }
            foliage(triangles(blades));
        }
    }
}

function triangles(vertices) {
    const shape = new BufferGeometry();
    shape.setAttribute("position", new Float32BufferAttribute(vertices.flatMap(v => v.toArray()), 3));
    shape.computeVertexNormals();
    return shape;
}

export function buildGroundObject(p, {simple = false} = {}) {
    const parts = groundParts(simple), random = randomSequence(p.seed);
    const builders = {pylon: transmissionTower, pole: telegraphPole, chimney, cooling: coolingTower, tree, boulder};
    builders[p.groundKind](p, parts, random);
    const root = parts.finish();
    if (p.groundKind === "pole" || p.groundKind === "pylon") {
        const count = p.towerStyle === "horizontal" || ["vaulted","british"].includes(p.poleStyle)
            ? 3 : 2 * p.armLevels * (p.groundKind === "pole" ? p.pins : 1);
        root.userData.connectionPoints = ["in","out"].flatMap(tag => Array.from({length:count}, (_,index) => {
            const [x,level] = powerWireAttachment(p,index,count,tag);
            return {tag,index,position:[x,p.height*level,0]};
        }));
    }
    if (p.groundKind === "tree" || p.groundKind === "boulder") {
        const bounds = new Box3().setFromObject(root), size = bounds.getSize(new Vector3());
        const stone = p.groundKind === "boulder", lateral = p.crownWidth / Math.max(size.x,size.z);
        const center = bounds.getCenter(new Vector3());
        for (const mesh of root.children) {
            mesh.geometry.translate(stone ? -center.x : 0, -bounds.min.y, stone ? -center.z : 0);
            mesh.geometry.scale(stone ? p.width/size.x : lateral, p.height/size.y, stone ? p.depth/size.z : lateral);
        }
    }
    return {root, propellers: [], lamps: [], stats: {}};
}
