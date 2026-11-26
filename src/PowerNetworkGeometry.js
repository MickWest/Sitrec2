import {
    Box3, BufferAttribute, BufferGeometry, DoubleSide, Group, InstancedMesh, LineBasicMaterial,
    LineSegments, Matrix4, MeshStandardMaterial, Sphere, Vector3,
} from "three";
import {mergeGeometries} from "three/addons/utils/BufferGeometryUtils.js";
import {buildGroundObject, powerWireAttachment} from "../tools/vehicles/groundObject";
import {GROUND_PRESETS, groundShapeGroup} from "../tools/vehicles/groundParameters";
import {withSRGBInputs} from "../tools/vehicles/designColors";
import {wirePorts} from "./PowerObjectLinks";
import {localENU} from "./cloudField/CloudFieldFormat";

const profiles = {pylon:"ground-pylon", pole:"ground-telegraph-pole", horizontal:"ground-horizontal-pylon",
    britishTower:"ground-british-pylon", britishPole:"ground-british-pole", vaulted:"ground-french-pole"};
const defaults = Object.fromEntries(Object.entries(profiles).map(([key,id]) => {
    const {parameters} = GROUND_PRESETS.find(p => p.id === id);
    const fields = groundShapeGroup(parameters).fields.map(field => [field.key,field.value]);
    return [key,{...Object.fromEntries(fields),...parameters}];
}));

// One vertex-colored geometry per preset and level of detail. Every cell shares
// those buffers, so even a lattice with hundreds of members takes one draw.
function prototypeGeometry(kind, simple) {
    const {root} = withSRGBInputs(() => buildGroundObject(defaults[kind], {simple}));
    const geometries = root.children.map(({geometry, material}) => {
        const colors = new Float32Array(geometry.attributes.position.count * 3);
        for (let i = 0; i < colors.length; i += 3) material.color.toArray(colors, i);
        geometry.setAttribute("color", new BufferAttribute(colors, 3));
        material.dispose();
        return geometry;
    });
    const merged = mergeGeometries(geometries);
    geometries.forEach(g => g.dispose());
    return merged;
}

function makeLineBuffer(segments, material) {
    const geometry = new BufferGeometry();
    const position = new BufferAttribute(new Float32Array(segments*6), 3);
    geometry.setAttribute("position", position);
    return new LineSegments(geometry, material);
}

const sagSteps = 6;
const cellDegrees = .035;

export function createPowerNetworkGeometry(network, groundAt) {
    const group = new Group(), cells = new Map(), templates = new Map();
    const material = new MeshStandardMaterial({vertexColors: true, roughness: .9, side: DoubleSide});
    const wireMaterial = new LineBasicMaterial({color: 0x292929, transparent: true, opacity: .72, depthWrite: false});
    const points = network.points.map(source => {
        const axes = localENU(source.lat, source.lon);
        return {...source, cells: new Set(), base: groundAt(source.lat,source.lon), up: new Vector3(...axes.up),
            east: new Vector3(...axes.east), side: new Vector3()};
    });
    const pointById = new Map(points.filter(p => p.objectId).map(p => [p.objectId,p]));
    const linked = new Set(points.filter(p => p.objectId && !p.batched));
    function cellAt(p) {
        const key = Math.floor(p.lat/cellDegrees) + "," + Math.floor(p.lon/cellDegrees);
        if (!cells.has(key)) {
            const root = new Group(), near = new Group(), far = new Group();
            root.position.copy(p.base); root.add(near, far); group.add(root);
            cells.set(key, {root, near, far, supports: new Map(), spans: [], batches: [],
                bounds: new Box3(), sphere: new Sphere(), height: 0});
        }
        return cells.get(key);
    }
    // A North American 765 kV single circuit carries three phases side by side.
    // Leave untagged and other-voltage routes on the ordinary tower preset.
    for (const way of network.ways) if (way.voltage === 765000 && way.cables === 3) {
        for (const i of way.path) {
            const p = points[i];
            if (p.lon < -50 && p.lon > -170 && p.lat > 20 && p.lat < 75 && p.kind !== "pole") p.design ??= "horizontal";
        }
    }
    const profile = (p, fallback) => Object.hasOwn(defaults,p.design) &&
        defaults[p.design].groundKind === (p.kind ?? fallback) ? p.design : p.kind ?? fallback;
    for (const p of points) if (p.kind && !p.external && !p.deleted) {
        const cell = cellAt(p);
        const key = profile(p,p.kind);
        p.presetId = profiles[key];
        p.parameters = defaults[key];
        if (!cell.supports.has(key)) cell.supports.set(key, []);
        cell.supports.get(key).push(p);
        p.cells.add(cell);
    }
    function orient(p, delta) {
        const side = delta.clone().cross(p.up).normalize();
        p.side.addScaledVector(side, side.dot(p.side) < 0 ? -1 : 1);
    }
    for (const way of network.ways) {
        const defaultKind = way.minor ? "pole" : "pylon";
        for (let i = 1; i < way.path.length; i++) {
            const a = points[way.path[i-1]], b = points[way.path[i]];
            const dir = b.base.clone().sub(a.base);
            const kindA = profile(a,b.kind ?? defaultKind), kindB = profile(b,a.kind ?? defaultKind);
            const capacity = key => ["horizontal","britishPole","vaulted"].includes(key) ? 3 : key === "pole" ? 12 : 6;
            const count = Math.min(way.cables ?? (way.minor ? 3 : 6),capacity(kindA),capacity(kindB));
            orient(a, dir); orient(b, dir);
            const cell = cellAt(a);
            cell.spans.push({a,b,kindA,kindB,count,fromPort:wirePorts.from,toPort:wirePorts.to});
            a.cells.add(cell); b.cells.add(cell);
        }
    }
    for (const p of points) {
        if (p.side.lengthSq() < .000001) p.side.copy(p.east);
        else p.side.normalize();
    }
    let pickFocal = 1;
    const pickTop = new Vector3(), alongRay = new Vector3(), alongMast = new Vector3();
    function mastRaycast(cell,supports,mesh) {
        const triangles = mesh.raycast;
        mesh.raycast = function(raycaster,hits) {
            if (group.parent?.visible === false || !cell.root.visible || !mesh.parent.visible) return;
            if (!raycaster.ray.intersectsSphere(cell.sphere)) return;
            const before = hits.length;
            triangles.call(mesh,raycaster,hits);
            if (hits.length > before) return;
            // Lattice openings and sub-pixel wooden poles should also be clickable.
            supports.forEach((p,instanceId) => {
                if (p.link) return;
                pickTop.copy(p.base).addScaledVector(p.up,p.height ?? p.parameters.height);
                const gap = raycaster.ray.distanceSqToSegment(p.base,pickTop,alongRay,alongMast);
                const distance = raycaster.ray.origin.distanceTo(alongRay);
                const tolerance = 3 * (raycaster.camera?.isOrthographicCamera ? 1 : distance) / pickFocal;
                if (gap <= tolerance*tolerance && distance >= raycaster.near && distance <= raycaster.far)
                    hits.push({distance,point:alongMast.clone(),object:mesh,instanceId});
            });
        };
    }

    for (const cell of cells.values()) {
        for (const [kind,supports] of cell.supports) {
            if (!templates.has(kind)) templates.set(kind, [prototypeGeometry(kind, false), prototypeGeometry(kind, true)]);
            const [near,far] = templates.get(kind).map(g => new InstancedMesh(g,material,supports.length));
            const ids = supports.map(p => p.objectId);
            near.userData.supportIds = far.userData.supportIds = ids;
            cell.near.add(near); cell.far.add(far);
            mastRaycast(cell,supports,near); mastRaycast(cell,supports,far);
            cell.batches.push({supports, kind, near, far});
        }
        if (cell.spans.length) {
            cell.wires = makeLineBuffer(cell.spans.reduce((sum,s) => sum + s.count*sagSteps, 0), wireMaterial);
            cell.routes = makeLineBuffer(cell.spans.length, wireMaterial);
            cell.wires.userData.ignoreContextMenu = cell.routes.userData.ignoreContextMenu = true;
            cell.near.add(cell.wires); cell.far.add(cell.routes);
        }
    }

    const local = new Vector3(), z = new Vector3(), matrix = new Matrix4(), scale = new Vector3();
    const start = new Vector3(), end = new Vector3(), next = new Vector3(), previous = new Vector3();
    function placeCable(target, point, kind, port, cable, count, sideSign, origin) {
        const [width,level] = powerWireAttachment(point.link?.parameters ?? defaults[kind], cable, count, port);
        if (point.link) {
            return target.set(width * sideSign, point.link.parameters.height * level, 0)
                .applyMatrix4(point.link.matrix).sub(origin);
        }
        return target.copy(point.base).sub(origin).addScaledVector(point.side, width * sideSign)
            .addScaledVector(point.up, (point.height ?? defaults[kind].height) * level);
    }
    function placeCell(cell) {
        const origin = cell.root.position, box = cell.bounds.makeEmpty();
        for (const {supports,kind,near,far} of cell.batches) {
            supports.forEach((p,i) => {
                const h = p.height ?? defaults[kind].height;
                cell.height = Math.max(cell.height,h);
                local.copy(p.base).sub(origin); box.expandByPoint(local);
                matrix.makeBasis(p.side,p.up,z.crossVectors(p.side,p.up)).setPosition(local)
                    .scale(p.link ? scale.set(0,0,0) : scale.set(1, h/defaults[kind].height, 1));
                near.setMatrixAt(i,matrix); far.setMatrixAt(i,matrix);
                box.expandByPoint(local.addScaledVector(p.up,h));
            });
            for (const mesh of [near,far]) {
                mesh.instanceMatrix.needsUpdate = true;
                mesh.computeBoundingSphere();
            }
        }
        let v = 0, r = 0;
        for (const {a,b,kindA,kindB,count,fromPort,toPort} of cell.spans) {
            const verts = cell.wires.geometry.attributes.position, route = cell.routes.geometry.attributes.position;
            const heightA = a.height ?? defaults[kindA].height, heightB = b.height ?? defaults[kindB].height;
            cell.height = Math.max(cell.height,heightA,heightB);
            const baseA = a.link ? local.setFromMatrixPosition(a.link.matrix) : a.base;
            const baseB = b.link ? z.setFromMatrixPosition(b.link.matrix) : b.base;
            const sag = Math.min(baseA.distanceTo(baseB)*.025, Math.min(heightA,heightB)*.28);
            const hidden = (a.external && !a.link) || (b.external && !b.link);
            const flip = (a.link?.side ?? a.side).dot(b.link?.side ?? b.side) < 0 ? -1 : 1;
            for (let c=0; c<count; c++) {
                placeCable(start,a,kindA,fromPort,c,count,1,origin);
                placeCable(end,b,kindB,toPort,c,count,flip,origin);
                if (hidden) {start.set(0,0,0); end.copy(start);}
                if (c === 0) {
                    route.setXYZ(r++, start.x,start.y,start.z); route.setXYZ(r++, end.x,end.y,end.z);
                    box.expandByPoint(start); box.expandByPoint(end);
                }
                previous.copy(start);
                for (let j=1; j<=sagSteps; j++) {
                    const t = j/sagSteps;
                    next.lerpVectors(start,end,t).addScaledVector(a.up,hidden ? 0 : -4*sag*t*(1-t));
                    verts.setXYZ(v++,previous.x,previous.y,previous.z); verts.setXYZ(v++,next.x,next.y,next.z);
                    previous.copy(next);
                }
            }
        }
        for (const lines of [cell.wires,cell.routes]) if (lines) {
            lines.geometry.attributes.position.needsUpdate = true;
            lines.geometry.computeBoundingSphere();
        }
        box.getBoundingSphere(cell.sphere); cell.sphere.center.add(origin);
    }
    for (const cell of cells.values()) placeCell(cell);
    return {
        group, points,
        watchSupport(id) {
            const p = pointById.get(id);
            if (p) linked.add(p);
        },
        // A sitch can supply an editable object in place of one mapped support.
        // Other sitches that open the same file still get the mapped model.
        syncLinkedSupports(resolve) {
            const changed = new Set();
            for (const p of linked) {
                const next = resolve(p.objectId, p.kind);
                if (next ? p.link?.matrix.equals(next.matrix) && p.link.parameters === next.parameters : !p.link) continue;
                p.link = next ? {matrix: next.matrix.clone(), parameters: next.parameters,
                    side: new Vector3().setFromMatrixColumn(next.matrix,0).normalize()} : null;
                for (const cell of p.cells) changed.add(cell);
            }
            for (const cell of changed) placeCell(cell);
        },
        refreshGround() {
            const changed = new Set();
            for (const p of points) {
                const ground = groundAt(p.lat,p.lon);
                if (ground.distanceToSquared(p.base) < .0001) continue;
                p.base.copy(ground);
                for (const cell of p.cells) changed.add(cell);
            }
            for (const cell of changed) placeCell(cell);
        },
        setView(camera, heightPx) {
            const focal = Math.abs(camera.projectionMatrix.elements[5]) * heightPx/2;
            pickFocal = Math.max(.001,focal);
            for (const cell of cells.values()) {
                const depth = camera.isOrthographicCamera ? 1 : Math.max(1,
                    camera.position.distanceTo(cell.sphere.center) - cell.sphere.radius);
                const pixels = cell.height * focal/depth;
                cell.root.visible = pixels >= .45;
                cell.near.visible = pixels >= 30;
                cell.far.visible = !cell.near.visible;
            }
        },
        dispose() {
            for (const cell of cells.values()) {
                for (const batch of cell.batches) {batch.near.dispose(); batch.far.dispose();}
                cell.wires?.geometry.dispose(); cell.routes?.geometry.dispose();
            }
            for (const pair of templates.values()) pair.forEach(g => g.dispose());
            material.dispose(); wireMaterial.dispose(); group.clear();
        },
    };
}
