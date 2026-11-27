import {AdditiveBlending, Color, DataTexture, LinearFilter, Mesh, MeshStandardMaterial, PointLight,
    Raycaster, SphereGeometry, Sprite, SpriteMaterial, Vector3} from "three";
import {kiteLEDIntensity, sampleKiteLED} from "./kiteLEDPattern.js";

export function addKiteLights(model, p) {
    if (p.ledEnabled) addSailLights(model, p);
    if (p.ledTailEnabled) addTailLights(model, p);
}

function addBulb(model, p, parent, position, site, name, geometry, bulbRadius) {
    const color = site.tail ? p.ledTailColor : p.ledColor1;
    const intensity = kiteLEDIntensity(site, p);
    const light = new PointLight(color, intensity, 0, 2);
    light.name = name; light.position.copy(position);
    light.userData = {vehicleLight: true, role: name, kiteLED: {site, settings: {...p}}};
    const lens = new Mesh(geometry, new MeshStandardMaterial({color: "#202020", emissive: color,
        emissiveIntensity: 1.8, roughness: 0.3}));
    lens.name = `${name} lens`; lens.position.copy(position);
    lens.userData.vehicleLightLens = name; lens.material.userData.vehicleLightLens = name;
    parent.add(light, lens);
    model.lamps.push({light, lens, intensity, phase: 0, bulbRadius, previewRoot: model.root});
}

function addSailLights(model, p) {
    if (!p.ledEnabled) return;
    const root = model.root, sail = root.getObjectByName("Kite sail");
    const skins = sail.children.filter(part => ["Kite sail panels", "Kite lower skin", "Kite head"].includes(part.name));
    root.updateMatrixWorld(true);
    const size = Math.min(p.width, p.height), ray = new Raycaster();
    const direction = new Vector3(0, 1, 0).transformDirection(sail.matrixWorld);
    const center = p.height * (p.kiteShape === "box"
        ? Math.max(0.22, Math.min(0.46, 0.34 + p.ledCenter / 100)) : p.ledCenter / 100);
    // Mount the bulbs just beyond the spars, so the fabric/frame cannot cut
    // through their glow when viewed from the windward side.
    const offset = Math.max(0.002, Math.min(0.03, Math.max(p.width, p.height) * 0.004)) + size * 0.004;
    function project(angle, radius) {
        const origin = new Vector3(Math.sin(angle) * radius, -Math.max(p.width, p.height, p.depth) * 4,
            center + Math.cos(angle) * radius).applyMatrix4(sail.matrixWorld);
        ray.set(origin, direction);
        const hit = ray.intersectObjects(skins, false)[0];
        return hit ? root.worldToLocal(hit.point.clone().addScaledVector(direction, -offset)) : null;
    }
    const angles = Array.from({length: p.ledSpokes}, (_, i) => 2 * Math.PI * (i / p.ledSpokes + p.ledRotation / 360));
    // Keep the circular array inside the actual fabric, including a delta's notch.
    // The same projection conforms the bulbs to bowed and inflated kites.
    let radius = size * p.ledCoverage / 200;
    for (let tries = 0; tries < 80 && !angles.every(angle => project(angle, radius)); tries++) radius *= 0.94;
    const bulbRadius = Math.max(0.0001, size * 0.004);
    const geometry = new SphereGeometry(bulbRadius, 8, 6);
    function bulb(angle, fraction, ring, name) {
        const position = project(angle, radius * fraction);
        if (!position) return;
        const site = {angle: ((angle / (2 * Math.PI)) % 1 + 1) % 1, radius: fraction,
            ring, spokes: p.ledSpokes, index: model.lamps.length};
        addBulb(model, p, root, position, site, name, geometry, bulbRadius);
    }
    for (let strip = 0; strip < angles.length; strip++)
        for (let led = 0; led < p.ledPerSpoke; led++)
            bulb(angles[strip], 0.26 + 0.74 * led / (p.ledPerSpoke - 1), false, `LED strip ${strip + 1} bulb ${led + 1}`);
    for (let ring = 0; ring < p.ledRings; ring++)
        for (let led = 0; led < angles.length; led++)
            bulb(angles[led], 0.22 * (ring + 1) / (p.ledRings + 1), true, `LED ring ${ring + 1} bulb ${led + 1}`);
}

function addTailLights(model, p) {
    if (!model.tails.length) return;
    const bulbRadius = Math.max(0.0001, Math.min(p.width, p.height) * 0.004);
    const geometry = new SphereGeometry(bulbRadius, 8, 6);
    const sizeAt = fraction => p.tailWidth * (1 - (1 - p.tailTaper / 100) * fraction ** (p.tailStyle === "tube" ? 1.4 : 1));
    model.tails.forEach((links, tailIndex) => {
        const step = p.tailLength / links.length;
        for (let index = 0; index < p.ledTailCount; index++) {
            const fraction = index / (p.ledTailCount - 1);
            const joint = Math.min(links.length - 1, Math.floor(fraction * links.length));
            const within = fraction * links.length - joint;
            const start = sizeAt(joint / links.length), end = sizeAt((joint + 1) / links.length);
            const radius = p.tailStyle === "tube" ? (start + (end - start) * within) / 2 : 0;
            const position = new Vector3(0, -radius - bulbRadius * 1.5, -within * step);
            const site = {tail: true, tailIndex, fraction, index: tailIndex * p.ledTailCount + index};
            addBulb(model, p, links[joint], position, site, `LED tail ${tailIndex + 1} bulb ${index + 1}`, geometry, bulbRadius);
        }
    });
}

// Studio-only glows. Hundreds of illuminating PointLights would exceed WebGL's
// shader limits. Sitrec replaces these with its normal CNode3DLight billboards;
// clean GLB exports contain only the physical lenses and punctual lights.
function glowTexture() {
    const size = 32, bytes = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const r = Math.hypot((x + 0.5) / size * 2 - 1, (y + 0.5) / size * 2 - 1), i = (y * size + x) * 4;
        bytes[i] = bytes[i + 1] = bytes[i + 2] = 255;
        bytes[i + 3] = 255 * Math.max(0, Math.exp(-r * r * 8) - Math.exp(-8));
    }
    const texture = new DataTexture(bytes, size, size); texture.magFilter = LinearFilter; texture.needsUpdate = true;
    return texture;
}

export function animateKiteLamp(lamp, time, animate) {
    const {light, lens} = lamp, data = light.userData.kiteLED;
    const state = sampleKiteLED(data.site, data.settings, animate ? time : 0,
        lamp.ledState ??= {color: new Color(), level: 0});
    const intensity = kiteLEDIntensity(data.site, data.settings);
    light.color.copy(state.color); light.intensity = lamp.intensity * state.level;
    light.visible = false;
    lens.material.emissive.copy(state.color);
    lens.material.emissiveIntensity = state.level * intensity / 35 * 2.5;
    updatePreviewGlow(lamp.previewRoot, lamp, lens, state.level, lamp.bulbRadius * 18 * Math.sqrt(intensity / 35));
}

export function updatePreviewGlow(root, lamp, anchor, opacity, diameter) {
    if (!lamp.glow) {
        // Share the texture between lamps; disposal follows the model's materials.
        const texture = root.userData.previewGlowTexture ??= glowTexture();
        lamp.glow = new Sprite(new SpriteMaterial({map: texture, color: lamp.light.color,
            transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false}));
        lamp.glow.name = "LED preview glow"; lamp.glow.position.copy(anchor.position);
        anchor.parent.add(lamp.glow);
    }
    lamp.glow.material.color.copy(lamp.light.color);
    lamp.glow.material.opacity = opacity;
    lamp.glow.scale.setScalar(diameter);
}
