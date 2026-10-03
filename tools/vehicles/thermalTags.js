import {BackSide, Box3, BufferGeometry, CircleGeometry, CylinderGeometry, DoubleSide, Mesh, MeshStandardMaterial, PlaneGeometry, RingGeometry, Vector3} from "three";

// Cheap generator metadata only. The radiometric implementation is loaded by the preview.
export const VEHICLE_THERMAL_GROUP = {name: "Thermal", note: "Estimated equilibrium surface temperatures. Power is a family load coordinate, not a calibrated throttle. Camera settings belong to IR preview.", fields: [
    {key: "thermalProfile", label: "Propulsion / material profile", type: "select", value: "auto", options: {auto: "Automatic family estimate", high_bypass_turbofan: "Turbofan", fighter: "Dry jet", piston: "Piston", turboprop: "Turboprop", turboshaft: "Turboshaft", electric: "Electric", unpowered: "Unpowered", latex: "Latex envelope", foil: "Metallized envelope", lantern: "Lantern", hotair: "Hot-air envelope", road_combustion: "Road combustion"}},
    {key: "thermalPower", label: "Engine power · fraction", type: "number", min: 0, max: 1, step: .01, value: .65},
    {key: "thermalMach", label: "Flight Mach number", type: "number", min: 0, max: 5, step: .01, value: .82},
    {key: "thermalAmbientK", label: "Local ambient · K", type: "number", min: 150, max: 350, step: .1, value: 220},
    {key: "thermalEmissivity", label: "Skin emissivity · fraction", type: "number", min: 0, max: 1, step: .01, value: .85},
]};

export function visibleVehicleBounds(root) {
    root.updateMatrixWorld(true);
    const bounds = new Box3();
    root.traverseVisible(object => {
        if (object.isMesh) bounds.union(new Box3().setFromBufferAttribute(object.geometry.attributes.position).applyMatrix4(object.matrixWorld));
    });
    return bounds;
}

export function vehicleThermalDefaults(p) {
    const rotor = p.rotorLayout && p.rotorLayout !== "none";
    const prop = p.engineType === "prop", turbine = p.engineType === "turboprop";
    const road = ["car", "truck"].includes(p.vehicleType), balloon = p.vehicleType === "balloon";
    const electric = p.vehicleType === "drone" && p.droneStyle !== "fixedwing";
    const lantern = balloon && ["lantern", "boxlantern", "pagoda"].includes(p.balloonShape);
    const heatedEnvelope = balloon && ["hotair", "solar"].includes(p.balloonShape);
    const unpowered = balloon && !lantern && !heatedEnvelope || p.engineType === "none" && !rotor && !electric;
    const ground = road || balloon || electric;
    return {thermalPower: unpowered ? 0 : lantern ? 1 : road || heatedEnvelope ? .3 : electric ? .5 : rotor || turbine ? .7 : .65,
        thermalMach: ground || unpowered ? 0 : rotor ? .12 : prop ? .16 : turbine ? .35 : .82,
        thermalAmbientK: ground || rotor || unpowered ? 293 : prop ? 288 : turbine ? 265 : 220, thermalEmissivity: electric ? .9 : .85};
}

export function tagThermalMesh(mesh, p) {
    if (mesh.userData.thermal) return mesh;
    const name = mesh.name;
    let zone = "painted_skin";
    if (/glazing|window|windscreen|windshield|canopy|camera lens|sensor glazing/i.test(name) && !/surround|frame|mask/i.test(name)) zone = "glass";
    if (/^(Nacelle|Engine fairing|Rotor nacelle)/.test(name)) zone = p.engineType === "prop" ? "piston_cowl" : "nacelle_skin";
    if (/^(Integrated exhaust|Exhaust rim|Vectoring exhaust$|Nozzle shoulder)/.test(name)) zone = "jet_nozzle";
    if (/^(Exhaust$|Exhaust opening|Vectoring exhaust opening)/.test(name)) zone = p.engineType === "jet" ? "jet_cavity" : "painted_skin";
    if (/Transmission housing|Rotor mast|Upper rotor mast/.test(name)) zone = "helicopter_gearbox";
    if (name === "Rotor hub" && p.vehicleType !== "drone") zone = "rotor_hub";
    if (/^Motor /.test(name)) zone = "electric_motor";
    if (/^(Rotor arm|Cooling vent|Cinema boom)/.test(name)) zone = "speed_controller";
    if (/^(Battery cover|Battery strap)/.test(name)) zone = "battery";
    if (/envelope|Balloon neck|Airship tail fin/i.test(name)) zone =
        ["foil", "star", "heart"].includes(p.balloonShape) ? "metallized_envelope" :
        ["lantern", "boxlantern", "pagoda"].includes(p.balloonShape) ? "lantern_envelope" :
        ["hotair", "solar"].includes(p.balloonShape) ? "hotair_envelope" : "latex_envelope";
    if (name === "Lantern flame / burner") zone = "lantern_flame";
    if (name === "Tire" && ["car", "truck"].includes(p.vehicleType)) zone = "road_tire";
    mesh.userData.thermal = {zone};
    return mesh;
}

export function thermalOnly(mesh, zone) {
    mesh.userData.thermal = {zone}; mesh.userData.thermalOnly = true; mesh.visible = false;
    return mesh;
}

// Partition existing triangles, with no displaced duplicate emitting layer.
// Visible geometry and exports retain the original mesh and its exact topology.
export function thermalPartition(mesh, select, zone) {
    const position = mesh.geometry.attributes.position, index = mesh.geometry.index;
    const selected = [], rest = [];
    for (let triangle = 0; triangle < (index?.count ?? position.count); triangle += 3) {
        const vertices = [0, 1, 2].map(offset => index ? index.getX(triangle + offset) : triangle + offset);
        const center = vertices.reduce((sum, vertex) => sum.add(new Vector3().fromBufferAttribute(position, vertex)), new Vector3()).divideScalar(3);
        (select(center) ? selected : rest).push(...vertices);
    }
    if (!selected.length || !rest.length) return [];
    mesh.userData.thermalHidden = true;
    const parts = [];
    for (const [indices, id, suffix] of [[selected, zone, "heated section"], [rest, mesh.userData.thermal.zone, "remaining skin"]]) {
        const geometry = new BufferGeometry();
        for (const [key, attribute] of Object.entries(mesh.geometry.attributes)) geometry.setAttribute(key, attribute.clone());
        geometry.setIndex(indices);
        const part = thermalOnly(new Mesh(geometry, Array.isArray(mesh.material) ? mesh.material[0] : mesh.material), id);
        part.name = `${mesh.name} ${suffix}`; part.position.copy(mesh.position); part.quaternion.copy(mesh.quaternion); part.scale.copy(mesh.scale);
        mesh.parent.add(part);
        parts.push(part);
    }
    return parts;
}

// Published in the A340-600 aircraft planning document: separate fan/core
// nozzles, projecting plug, 3.14 m cowl width.
// Estimated: assigning the external section labels to flow surfaces, plug radii
// and setback. These are an axisymmetric surrogate, not surveyed internal sizes.
const separateFlowGeometry = Object.freeze({
    fanOuterRadiusM: 1.345, coreUpstreamRadiusM: .755, coreExitRadiusM: .675,
    nozzleLengthM: 1.41, plugUpstreamRadiusM: .40, plugExitRadiusM: .36, plugLengthM: 1.15,
    pylonEndAreaM2: .01, pylonUndersideAreaM2: .50,
    status: "estimated", source: "Axisymmetric separate-flow surrogate; the published A340-600 aircraft planning document constrains external scale only",
});

// Use the A340-600's existing 2.95 m visual recipe diameter as the unit scale;
// it is a procedural approximation, not the published 3.14 m cowl width.
// Other turbofan recipes scale this same estimated layout with nacelle diameter.
// No visible vertices or transforms are changed. Thin opaque surfaces provide
// real depth occlusion; the two wall faces never emit into the same sightline.
export function addSeparateFlowThermalOutlet(parent, {position, nacelleDiameter, engineIndex}) {
    const scale = nacelleDiameter / 2.95, g = separateFlowGeometry;
    const fanRadius = g.fanOuterRadiusM * scale, upstreamRadius = g.coreUpstreamRadiusM * scale;
    const exitRadius = g.coreExitRadiusM * scale, length = g.nozzleLengthM * scale;
    const plugRadius = g.plugUpstreamRadiusM * scale, plugExit = g.plugExitRadiusM * scale;
    const fanZ = position[2], exitZ = fanZ - length;
    const material = new MeshStandardMaterial({color: "#555555"});
    const parts = [];
    const add = (name, geometry, zone, center, surfaceMaterial = material) => {
        const part = thermalOnly(new Mesh(geometry, surfaceMaterial), zone);
        part.name = `Thermal ${name} ${engineIndex + 1}`;
        part.position.set(position[0] + center[0], position[1] + center[1], center[2]);
        part.userData.thermalEngineIndex = engineIndex;
        part.userData.thermalGeometry = {status: g.status, source: g.source};
        parent.add(part); parts.push(part); return part;
    };
    // 128 facets keep projected areas within 0.1% of the circular surrogate.
    const ring = (name, inner, outer, zone) => {
        const part = add(name, new RingGeometry(inner, outer, 128), zone, [0, 0, fanZ]);
        part.rotation.y = Math.PI; return part;
    };
    const shell = (name, startRadius, endRadius, startZ, endZ, zone) => {
        const part = add(name, new CylinderGeometry(endRadius, startRadius, startZ - endZ, 128, 1, true),
            zone, [0, 0, (startZ + endZ) / 2]);
        part.rotation.x = -Math.PI / 2; return part;
    };
    const cavity = ring("turbofan cavity", plugRadius, upstreamRadius, "turbofan_cavity");
    const fan = ring("fan duct", upstreamRadius, fanRadius, "turbofan_fan_duct");
    const wall = shell("core nozzle exterior", upstreamRadius, exitRadius, fanZ, exitZ, "turbofan_core_nozzle");
    const innerMaterial = material.clone(); innerMaterial.side = BackSide;
    const inner = add("core nozzle inner wall", wall.geometry, "turbofan_core_inner", [0, 0, wall.position.z], innerMaterial);
    inner.quaternion.copy(wall.quaternion);
    const shoulder = shell("plug shoulder", plugRadius, plugExit, fanZ, exitZ, "turbofan_plug");
    const plug = shell("plug", plugExit, 0, exitZ, exitZ - g.plugLengthM * scale, "turbofan_plug");

    // Calculated square underside from the estimated 0.50 m² allowance, with
    // end height = 0.01 m² / width. Estimated placement above the core exit,
    // extending aft under the pylon. Its silhouette replaces
    // any fan/nozzle area it covers through normal depth testing, never addition.
    // Unobstructed area: A = .01*cos(theta) + .50*sin(theta) at 0°/5° below.
    const shieldWidth = Math.sqrt(g.pylonUndersideAreaM2) * scale;
    const shieldHeight = g.pylonEndAreaM2 * scale * scale / shieldWidth;
    const shieldY = upstreamRadius;
    const shieldEnd = add("pylon shield end", new PlaneGeometry(shieldWidth, shieldHeight),
        "turbofan_pylon_shield", [0, shieldY + shieldHeight / 2, exitZ - shieldWidth]);
    shieldEnd.rotation.y = Math.PI;
    const shieldUnder = add("pylon shield underside", new PlaneGeometry(shieldWidth, shieldWidth),
        "turbofan_pylon_shield", [0, shieldY, exitZ - shieldWidth / 2]);
    shieldUnder.rotation.x = Math.PI / 2;
    return {parent, position: [position[0], position[1], exitZ], axis: [0, 0, -1], radius: exitRadius,
        engineIndex, cavity, wall, inner, shoulder, plug, fan, shieldEnd, shieldUnder, parts};
}

// Anchors use the same parent transform and dimensions as the visible engine.
// Radii and the short internal wall are geometric estimates, not engine measurements.
export function addThermalOutlet(parent, {position, radius, engineIndex, cavity = null, axis = [0, 0, -1], zone = "jet_nozzle", cavityZone = "jet_cavity"}) {
    const material = new MeshStandardMaterial({color: "#555555"});
    const direction = new Vector3(...axis).normalize(), center = new Vector3(...position);
    const wall = thermalOnly(new Mesh(new CylinderGeometry(radius, radius, radius * .35, 24, 1, true), material), zone);
    wall.material = material.clone(); wall.material.side = DoubleSide;
    wall.name = `Thermal nozzle ${engineIndex + 1}`;
    wall.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), direction);
    wall.position.copy(center).addScaledVector(direction, radius * .175); parent.add(wall);
    const rim = thermalOnly(new Mesh(new RingGeometry(radius, radius * 1.06, 24), material), zone);
    rim.name = `Thermal nozzle rim ${engineIndex + 1}`;
    rim.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), direction);
    rim.position.copy(center).addScaledVector(direction, radius * .35); parent.add(rim);
    if (!cavity) {
        cavity = thermalOnly(new Mesh(new CircleGeometry(radius, 24), material), cavityZone);
        cavity.name = `Thermal cavity ${engineIndex + 1}`;
        cavity.position.copy(center); cavity.quaternion.copy(rim.quaternion); parent.add(cavity);
    } else cavity.userData.thermal = {zone: cavityZone};
    for (const part of [wall, rim, cavity]) part.userData.thermalEngineIndex = engineIndex;
    return {parent, position: [...position], axis: [...axis], radius, engineIndex, cavity, wall, rim};
}
