import * as THREE from "three";
import {OrbitControls} from "three/addons/controls/OrbitControls.js";
import {GLTFExporter} from "three/addons/exporters/GLTFExporter.js";
import {PARAMETER_GROUPS, PRESETS, normalizeParameters, parameterFile, readParameterFile, usesCanopy, usesAirlinerWindscreen} from "./parameters.js";
import {buildAircraft, disposeAircraft} from "./aircraft.js";

const $ = id => document.getElementById(id);
const STORAGE_KEY = "sitrec-aircraft-designer-v1";
let params = {...PRESETS[0].parameters}, activePreset = PRESETS[0].id, designName = PRESETS[0].name;
let modified = false, model, modelDirty = true, renderDirty = true, saveTimer, currentView = "perspective";
let lastBuildMs = 0, disposed = false, frameId;
const fieldControls = new Map();

function status(message) { $("status").textContent = message; }
function error(message) { $("error").textContent = message; $("error").hidden = !message; }
function saveSession() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify({...parameterFile(params, designName), activePreset, modified})); }
        catch { status("Design is live · use Save design to keep a copy"); }
    }, 300);
}

try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
        const data = JSON.parse(stored), restored = readParameterFile(data);
        params = restored.parameters; designName = restored.name;
        activePreset = PRESETS.some(p => p.id === data.activePreset) ? data.activePreset : PRESETS[0].id;
        modified = Boolean(data.modified);
    }
} catch { /* A disabled store or an old record must not prevent the tool from opening. */ }

const renderer = new THREE.WebGLRenderer({antialias: true, preserveDrawingBuffer: true});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setClearColor("#e4ebf2");
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
$("canvasMount").append(renderer.domElement);
renderer.domElement.setAttribute("aria-label", "3D aircraft. Drag to orbit, scroll to zoom, right-drag to pan.");
renderer.domElement.tabIndex = 0;
const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight("#ffffff", "#718da6", 1.6));
const key = new THREE.DirectionalLight("#fff8ed", 2.3); key.position.set(20, 35, 25); scene.add(key);
const fill = new THREE.DirectionalLight("#cde8ff", 0.85); fill.position.set(-25, 10, -15); scene.add(fill);
let grid = new THREE.GridHelper(1, 20, "#a8bbca", "#c2d0da");
grid.material.transparent = true; grid.material.opacity = 0.6; scene.add(grid);
const camera = new THREE.PerspectiveCamera(36, 1, 0.01, 2000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; controls.dampingFactor = 0.1; controls.autoRotateSpeed = 0.65;
controls.addEventListener("change", () => { renderDirty = true; });

function updateName() {
    $("aircraftName").textContent = designName + (modified ? " · edited" : "");
    const reference = PRESETS.find(p => p.id === activePreset)?.reference;
    $("presetReference").hidden = !reference;
    if (reference) {
        $("presetDescription").textContent = reference.description;
        $("presetDimensions").textContent = `Preset reference: ${reference.length.toFixed(2)} m long · ${reference.wingspan.toFixed(2)} m span`;
        $("presetSource").href = reference.source;
    }
}

function updateCockpitControls() {
    const canopy = usesCanopy(params);
    for (const [key, controls] of fieldControls) {
        if (key === "cockpit" || (!key.startsWith("cockpit") && key !== "canopyHeight")) continue;
        const inactive = !params.cockpit || (key === "canopyHeight" ? !canopy :
            ["cockpitSetback", "cockpitPanes", "cockpitPillar", "cockpitHeight"].includes(key) && canopy) ||
            (key === "cockpitPanes" && usesAirlinerWindscreen(params)) ||
            (key === "cockpitMask" && !usesAirlinerWindscreen(params));
        for (const control of controls) control.disabled = inactive;
        if (key === "cockpitPanes") for (const control of controls) control.value = usesAirlinerWindscreen(params) ? (params.cockpitStyle === "airliner4" ? 4 : 6) : params.cockpitPanes;
        controls[0].closest(".field").classList.toggle("inactive", inactive);
    }
}

function updateFields() {
    for (const [key, elements] of fieldControls) for (const element of elements) {
        if (element.type === "checkbox") element.checked = params[key];
        else element.value = params[key];
    }
    $("presetSelect").value = activePreset;
    $("designName").value = designName;
    updateCockpitControls();
    updateName();
}

function changed(field, value, source) {
    const next = normalizeParameters({...params, [field.key]: value});
    if (next[field.key] === params[field.key]) return;
    params = next;
    for (const control of fieldControls.get(field.key)) {
        if (control === source) continue;
        if (control.type === "checkbox") control.checked = params[field.key]; else control.value = params[field.key];
    }
    modified = true; modelDirty = true;
    updateCockpitControls(); updateName(); saveSession();
}

for (const group of PARAMETER_GROUPS) {
    const folder = document.createElement("details"); folder.open = Boolean(group.open);
    const summary = document.createElement("summary"); summary.textContent = group.name;
    const count = document.createElement("span"); count.className = "folder-count"; count.textContent = String(group.fields.length); summary.append(count);
    folder.append(summary);
    const fields = document.createElement("div"); fields.className = "folder-fields"; folder.append(fields);
    if (group.note) {
        const note = document.createElement("p"); note.className = "folder-note"; note.textContent = group.note; fields.append(note);
    }
    for (const field of group.fields) {
        const row = document.createElement("div"); row.className = "field";
        const label = document.createElement("label"); label.textContent = field.label; label.htmlFor = `field-${field.key}`;
        const input = document.createElement(field.type === "select" ? "select" : "input"); input.id = `field-${field.key}`;
        if (field.type === "select") {
            for (const [value, name] of Object.entries(field.options)) input.add(new Option(name, value));
        } else input.type = field.type;
        const elements = [input];
        if (field.type === "number") {
            const header = document.createElement("div"); header.className = "field-header"; header.append(label, input); row.append(header);
            const range = document.createElement("input"); range.type = "range"; range.id = `slider-${field.key}`; range.setAttribute("aria-label", field.label);
            for (const control of [input, range]) {control.min = field.min; control.max = field.max; control.step = field.step;}
            input.addEventListener("input", () => { if (Number.isFinite(input.valueAsNumber)) changed(field, input.valueAsNumber, input); });
            input.addEventListener("change", () => { input.value = params[field.key]; });
            // input fires during the drag; change only fires when the thumb is released.
            range.addEventListener("input", () => changed(field, range.valueAsNumber, range));
            row.append(range); elements.push(range);
        } else {
            row.append(label, input);
            if (field.type === "checkbox" || field.type === "color") row.classList.add(field.type === "checkbox" ? "check-field" : "color-field");
            input.addEventListener("input", () => changed(field, field.type === "checkbox" ? input.checked :
                typeof field.value === "number" ? Number(input.value) : input.value, input));
        }
        fieldControls.set(field.key, elements); fields.append(row);
    }
    $("parameterFolders").append(folder);
}

const categories = new Map();
for (const preset of PRESETS) {
    if (!categories.has(preset.category)) {
        const group = document.createElement("optgroup"); group.label = preset.category;
        categories.set(preset.category, group); $("presetSelect").append(group);
    }
    categories.get(preset.category).append(new Option(preset.name, preset.id));
}
$("presetCount").textContent = String(PRESETS.length);

function applyPreset() {
    const preset = PRESETS.find(item => item.id === $("presetSelect").value);
    params = {...preset.parameters}; activePreset = preset.id; designName = preset.name; modified = false;
    error(""); updateFields(); modelDirty = true; rebuild(); fit(); saveSession();
}
$("presetSelect").addEventListener("change", applyPreset);
$("resetPreset").addEventListener("click", applyPreset);
$("designName").addEventListener("input", () => {designName = $("designName").value; updateName(); saveSession();});

function setWireframe(root, value) {
    root.traverse(object => {
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) if (material) material.wireframe = value;
    });
}

function rebuild() {
    const start = performance.now();
    const replacement = buildAircraft(params);
    if (model) disposeAircraft(model.root);
    model = replacement; model.root.name = designName || "Aircraft"; scene.add(model.root);
    setWireframe(model.root, $("wireframe").checked);
    const gridSize = Math.max(params.length, params.span) * 2.5;
    grid.scale.setScalar(gridSize); grid.position.y = model.bounds.min.y - Math.max(params.diameter * 0.15, 0.15);
    controls.maxDistance = Math.max(300, gridSize * 12);
    $("lengthMetric").textContent = `${params.length.toFixed(2)} m`;
    $("spanMetric").textContent = `${model.stats.wingspan.toFixed(2)} m`;
    $("spanMetric").title = "Main wings and winglets, including tip thickness";
    $("areaMetric").textContent = `${model.stats.area.toFixed(1)} m²`;
    $("aspectMetric").textContent = model.stats.aspectRatio.toFixed(2);
    $("geometryStats").textContent = `${Math.round(model.stats.triangles).toLocaleString()} triangles · metres`;
    lastBuildMs = performance.now() - start;
    status(`Live preview · ${lastBuildMs.toFixed(0)} ms update`);
    modelDirty = false; renderDirty = true;
}

const directions = {perspective: [-1.6, 0.7, 1], front: [0, 0, 1], side: [-1, 0, 0], top: [0, 1, 0.0001]};
function fit() {
    if (!model) return;
    const sphere = model.bounds.getBoundingSphere(new THREE.Sphere());
    const vFov = THREE.MathUtils.degToRad(camera.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
    const direction = new THREE.Vector3(...directions[currentView]).normalize();
    const right = new THREE.Vector3().crossVectors(camera.up, direction).normalize();
    const up = new THREE.Vector3().crossVectors(direction, right).normalize();
    // Fit the projected box, rather than its circumscribed sphere: long, flat
    // aircraft otherwise occupy very little of a wide preview. Leave room for UI.
    let distance = sphere.radius;
    for (const x of [model.bounds.min.x, model.bounds.max.x])
        for (const y of [model.bounds.min.y, model.bounds.max.y])
            for (const z of [model.bounds.min.z, model.bounds.max.z]) {
                const corner = new THREE.Vector3(x, y, z).sub(sphere.center);
                const depth = corner.dot(direction);
                distance = Math.max(distance, depth + Math.abs(corner.dot(right)) / Math.tan(hFov / 2) * 1.25,
                    depth + Math.abs(corner.dot(up)) / Math.tan(vFov / 2) * 1.55);
            }
    // Flush damping so switching a view during a drag cannot carry a stale orbit delta.
    const damping = controls.enableDamping; controls.enableDamping = false; controls.update(); controls.enableDamping = damping;
    controls.target.copy(sphere.center);
    camera.position.copy(sphere.center).addScaledVector(direction, distance);
    camera.near = Math.max(0.005, sphere.radius / 1000); camera.far = Math.max(3000, distance * 30); camera.updateProjectionMatrix();
    controls.update(); renderDirty = true;
}

document.querySelectorAll("[data-view]").forEach(button => button.addEventListener("click", () => {
    currentView = button.dataset.view;
    document.querySelectorAll("[data-view]").forEach(item => {const active = item === button; item.classList.toggle("active", active); item.setAttribute("aria-pressed", String(active));});
    $("autoRotate").checked = false; controls.autoRotate = false; fit();
}));
$("fitView").addEventListener("click", fit);
window.addEventListener("keydown", event => {
    if (event.key.toLowerCase() === "f" && !event.ctrlKey && !event.metaKey && !["INPUT", "SELECT", "TEXTAREA"].includes(event.target.tagName)) {event.preventDefault(); fit();}
});
$("showGrid").addEventListener("change", () => {grid.visible = $("showGrid").checked; renderDirty = true;});
$("wireframe").addEventListener("change", () => {setWireframe(model.root, $("wireframe").checked); renderDirty = true;});
$("autoRotate").addEventListener("change", () => {controls.autoRotate = $("autoRotate").checked;});
$("fullscreen").addEventListener("click", async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); }
    catch { status("Fullscreen is unavailable in this browser."); }
});

function filename() { return (designName || "aircraft").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-|-$/g, "").slice(0, 80) || "aircraft"; }
function download(blob, name) {
    const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = name;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}
$("saveFile").addEventListener("click", () => {
    download(new Blob([JSON.stringify(parameterFile(params, designName), null, 2)], {type: "application/json"}), `${filename()}.aircraft.json`);
    status("Design saved · open this JSON to keep editing");
});
$("openFile").addEventListener("click", () => $("fileInput").click());
$("fileInput").addEventListener("change", async () => {
    const file = $("fileInput").files[0]; $("fileInput").value = ""; if (!file) return;
    try {
        if (file.size > 1000000) throw new Error("The parameter file is too large (maximum 1 MB).");
        const data = readParameterFile(JSON.parse(await file.text()));
        params = data.parameters; designName = data.name; modified = true;
        error(""); updateFields(); modelDirty = true; rebuild(); fit(); saveSession(); status("Design opened");
    } catch (e) {error(`Could not open the design: ${e.message}`);}
});
$("exportGLB").addEventListener("click", async () => {
    $("exportGLB").disabled = true; error(""); status("Exporting GLB…");
    let exported;
    try {
        // A separate model excludes the grid, studio lights, wireframe and animated prop pose.
        exported = buildAircraft(params); exported.root.name = designName || "Aircraft";
        const exportName = filename();
        const glb = await new GLTFExporter().parseAsync(exported.root, {binary: true});
        download(new Blob([glb], {type: "model/gltf-binary"}), `${exportName}~L${exported.stats.size.z.toFixed(3)}m~.glb`);
        status("GLB exported · +Z forward, +Y up · import into Sitrec or a 3D editor");
    } catch (e) {error(`Export failed: ${e.message}`); status("Export failed");}
    finally {if (exported) disposeAircraft(exported.root); $("exportGLB").disabled = false;}
});
$("screenshot").addEventListener("click", () => {
    if (modelDirty) rebuild(); renderer.render(scene, camera);
    renderer.domElement.toBlob(blob => {if (blob) download(blob, `${filename()}.png`);}, "image/png");
});

function resize() {
    const width = $("canvasMount").clientWidth, height = $("canvasMount").clientHeight;
    if (!width || !height) return;
    renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix(); renderDirty = true;
}
const observer = new ResizeObserver(resize); observer.observe($("canvasMount"));
renderer.domElement.addEventListener("webglcontextlost", event => {event.preventDefault(); error("The 3D graphics context was lost. Save your design, then reload this page.");});
renderer.domElement.addEventListener("webglcontextrestored", () => {error(""); renderDirty = true;});
updateFields(); resize(); rebuild(); fit();
let lastTime = performance.now();
function animate(now) {
    if (disposed) return;
    const dt = Math.min((now - lastTime) / 1000, 0.05); lastTime = now;
    if (modelDirty) rebuild();
    controls.update(dt);
    if ($("animateProps").checked && model.propellers.length) {
        for (const propeller of model.propellers) propeller.rotation.z += dt * 18;
        renderDirty = true;
    }
    if (renderDirty) {renderer.render(scene, camera); renderDirty = false;}
    frameId = requestAnimationFrame(animate);
}
frameId = requestAnimationFrame(animate);
window.addEventListener("pagehide", event => {
    if (event.persisted) return;
    disposed = true; cancelAnimationFrame(frameId); observer.disconnect(); controls.dispose();
    disposeAircraft(model.root); grid.geometry.dispose(); grid.material.dispose(); renderer.dispose();
});
