import * as THREE from "three";
import {PRESETS, parameterGroups, isRoad, isMultirotor, isBalloon, normalizeParameters} from "./vehicleParameters.js";
import {usesCanopy, usesAirlinerWindscreen} from "./aircraftSchema.js";
import {disposeVehicle} from "./vehicle.js";
import {animateVehicleLights} from "./vehicleLights.js";

import {createVehicleRecipe, readVehicleRecipe} from "./recipe.js";
import {generateVehicle} from "./generator.js";
import {poseVehicleSpinners} from "./motion.js";
import {createVehicleStudio} from "./studio.js";
import {createVehicleFilter, populateVehicleFilters} from "./catalog.js";
import {vehicleFileStem} from "./recipeFormat.js";
import {downloadVehicleBlob, downloadVehicleRecipe, readVehicleRecipeFile} from "./files.js";

// A scoped, disposable editor shared by the standalone tool and Sitrec dialog.
export function mountVehicleDesigner(root = document, options = {}) {
const $ = id => root.querySelector(`#${id}`);
const lifecycle = new AbortController();
const events = {signal: lifecycle.signal};
const STORAGE_KEY = "sitrec-vehicle-designer-v1";
let params = {...PRESETS[0].parameters}, activePreset = PRESETS[0].id, designName = PRESETS[0].name;
let modified = false, model, modelDirty = true, renderDirty = true, saveTimer, currentView = "perspective";
let lastBuildMs = 0, disposed = false, frameId, propellerTime = 0;
const fieldControls = new Map();
let matchingPresets = [];

function status(message) { $("status").textContent = message; }
function error(message) { $("error").textContent = message; $("error").hidden = !message; }
function saveSession() {
    if (options.persist === false) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify({...createVehicleRecipe(params, designName, activePreset || null), activePreset, modified})); }
        catch { status("Design is live · use Save design to keep a copy"); }
    }, 300);
}

try {
    const stored = options.persist === false ? null : localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem("sitrec-aircraft-designer-v1");
    if (stored) {
        const data = JSON.parse(stored), restored = readVehicleRecipe(data);
        params = restored.parameters; designName = restored.name;
        activePreset = PRESETS.some(p => p.id === data.activePreset) ? data.activePreset : "";
        modified = Boolean(data.modified);
    }
} catch { /* A disabled store or an old record must not prevent the tool from opening. */ }

if (options.initialRecipe) {
    const recipe = readVehicleRecipe(options.initialRecipe);
    params = recipe.parameters; designName = recipe.name; activePreset = recipe.presetId || ""; modified = true;
}

const studio = createVehicleStudio($("canvasMount"),{background:"#e4ebf2",damping:true,onChange:() => {renderDirty = true;}});
const {renderer,scene,camera,controls} = studio;
let grid = new THREE.GridHelper(1, 20, "#a8bbca", "#c2d0da");
grid.material.transparent = true; grid.material.opacity = 0.6; scene.add(grid);

function updateName() {
    $("aircraftName").textContent = designName + (modified ? " · edited" : "");
    const reference = PRESETS.find(p => p.id === activePreset)?.reference;
    $("resetPreset").disabled = !activePreset;
    $("presetReference").hidden = !reference;
    if (reference) {
        $("presetDescription").textContent = reference.description;
        $("presetDimensions").textContent = `${reference.quality ?? "Preset reference"}: ${reference.length.toFixed(2)} m ${reference.lengthLabel ?? "long"} · ${reference.wingspan.toFixed(2)} m ${reference.spanLabel ?? "span"}`;
        $("presetSource").href = reference.source;
    }
}

function updateCockpitControls() {
    if(isMultirotor(params)||isBalloon(params))return;
    for (const key of ["strobeLights","taxiLights","landingLayout","turnSignal"]) for (const control of fieldControls.get(key) ?? []) {
        const inactive = key === "turnSignal" ? !isRoad(params) : isRoad(params);
        control.disabled = inactive; control.closest(".field").classList.toggle("inactive",inactive);
    }
    if (isRoad(params)) {
        for (const key of ["dumpTilt", "cargoLevel"]) for (const control of fieldControls.get(key) ?? [])
            control.disabled = key === "dumpTilt" ? params.cargoStyle !== "dump" : !["box", "dump", "tanker"].includes(params.cargoStyle);
        return;
    }
    const canopy = usesCanopy(params);
    const fixedPaneCount = ["auto", "airliner", "airliner4"].includes(params.cockpitStyle) && usesAirlinerWindscreen(params);
    for (const [key, controls] of fieldControls) {
        if (key === "cockpit" || (!key.startsWith("cockpit") && !["canopyHeight", "canopyFrame", "navigatorWindows"].includes(key))) continue;
        const inactive = !params.cockpit || (["canopyHeight", "canopyFrame"].includes(key) ? !canopy :
            ["cockpitSetback", "cockpitPanes", "cockpitHeight"].includes(key) && canopy) ||
            (key === "cockpitPanes" && fixedPaneCount) ||
            (key === "cockpitEyebrows" && !usesAirlinerWindscreen(params)) ||
            (key === "cockpitMask" && !usesAirlinerWindscreen(params));
        for (const control of controls) control.disabled = inactive;
        if (key === "cockpitPanes") for (const control of controls) control.value = fixedPaneCount ? (params.cockpitStyle === "airliner4" ? 4 : 6) : params.cockpitPanes;
        controls[0].closest(".field").classList.toggle("inactive", inactive);
    }
}

function updateFields() {
    for (const [key, elements] of fieldControls) for (const element of elements) {
        if (element.type === "checkbox") element.checked = params[key];
        else element.value = params[key];
    }
    updatePresetList();
    $("designName").value = designName;
    updateCockpitControls();
    updateName();
}

function changed(field, value, source) {
    const next = normalizeParameters({...params, [field.key]: value});
    if (next[field.key] === params[field.key]) {
        if(source && value!==next[field.key])source.value=next[field.key];
        return;
    }
    params = next;
    for (const [key, controls] of fieldControls) for (const control of controls) {
        if (control === source && value===next[field.key]) continue;
        if (control.type === "checkbox") control.checked = params[key]; else control.value = params[key];
    }
    modified = true; modelDirty = true;
    updateCockpitControls(); updateName(); saveSession();
}

function buildFields() {
fieldControls.clear(); $("parameterFolders").replaceChildren();
for (const group of parameterGroups(params)) {
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
}

function updatePresetList() {
    const matches = PRESETS.filter(createVehicleFilter({query:$("presetSearch").value,region:$("presetRegion").value,kind:$("presetKind").value}));
    matchingPresets = matches;
    const categories = new Map(), select = $("presetSelect"); select.replaceChildren();
    const prompt = new Option(matches.length ? "Choose a preset…" : "No matching vehicles", ""); prompt.disabled = true; select.append(prompt);
    for (const preset of matches) {
        if (!categories.has(preset.category)) {
            const group = document.createElement("optgroup"); group.label = preset.category;
            categories.set(preset.category, group); select.append(group);
        }
        categories.get(preset.category).append(new Option(preset.name, preset.id));
    }
    select.value = matches.some(p => p.id === activePreset) ? activePreset : "";
    $("presetResults").textContent = `${matches.length} matching presets · ${PRESETS.length} total`;
    $("previousPreset").disabled = $("nextPreset").disabled = matches.length === 0;
}
populateVehicleFilters($("presetKind"),$("presetRegion"));
$("presetSearch").addEventListener("input", updatePresetList);
$("presetRegion").addEventListener("change", updatePresetList);
$("presetKind").addEventListener("change", () => {$("presetRegion").value = ""; updatePresetList();});
$("presetCount").textContent = String(PRESETS.length);

function applyPreset(id = $("presetSelect").value, keepIdentity = true) {
    const preset = PRESETS.find(item => item.id === id);
    if (!preset) return;
    const identity = keepIdentity && params.brandLivery === "sitrec" ? {brandLivery:params.brandLivery,brandColor:params.brandColor,brandScale:params.brandScale} : {};
    params = {...preset.parameters,...identity}; activePreset = preset.id; designName = preset.name; modified = Boolean(identity.brandLivery);
    error(""); buildFields(); updateFields(); modelDirty = true; rebuild(); fit(); saveSession();
}
function cyclePreset(direction) {
    if (!matchingPresets.length) return;
    const index = matchingPresets.findIndex(p => p.id === activePreset);
    const next = index < 0 ? (direction > 0 ? 0 : matchingPresets.length - 1) : (index + direction + matchingPresets.length) % matchingPresets.length;
    applyPreset(matchingPresets[next].id);
}
$("previousPreset").addEventListener("click", () => cyclePreset(-1));
$("nextPreset").addEventListener("click", () => cyclePreset(1));
$("presetSelect").addEventListener("change", () => applyPreset());
$("resetPreset").addEventListener("click", () => applyPreset(activePreset, false));
$("designName").addEventListener("input", () => {designName = $("designName").value; updateName(); saveSession();});

function setWireframe(root, value) {
    root.traverse(object => {
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) if (material) material.wireframe = value;
    });
}

function rebuild() {
    const start = performance.now();
    const replacement = generateVehicle(createVehicleRecipe(params,designName,activePreset || null));
    propellerTime = 0;
    if (model) disposeVehicle(model.root);
    model = replacement; scene.add(model.root);
    animateVehicleLights(model,0,false);
    setWireframe(model.root, $("wireframe").checked);
    const road = isRoad(params), drone=isMultirotor(params),balloon=isBalloon(params), aerial=drone||balloon;
    const gridSize = Math.max(model.stats.size.x, model.stats.size.z,model.stats.size.y*.6) * 2.5;
    grid.scale.setScalar(gridSize); grid.position.y = model.bounds.min.y - (road ? 0.025 : aerial?Math.min(params.width,params.height)*.1:Math.max(params.diameter * 0.15, 0.15));
    controls.maxDistance = Math.max(300, gridSize * 12);
    $("lengthMetric").textContent = `${(drone?model.stats.size.z:params.length).toFixed(2)} m`;
    $("lengthLabel").textContent = drone?"OVERALL LENGTH":balloon?"ENVELOPE LENGTH":road ? "BODY LENGTH" : "FUSELAGE";
    const rotorOnly = !params.wings && params.rotorLayout !== "none";
    $("spanLabel").textContent = drone?"OVERALL WIDTH":balloon?"ENVELOPE WIDTH":road ? "BODY WIDTH" : rotorOnly ? "ROTOR DIAMETER" : "WINGSPAN";
    $("spanMetric").textContent = `${(drone?model.stats.size.x:road||balloon ? params.width : rotorOnly ? params.rotorDiameter : model.stats.wingspan).toFixed(2)} m`;
    $("spanMetric").title = drone?"Current propeller positions; overall sweep varies while spinning":balloon?"Envelope width, excluding fins":road ? "Body width, excluding mirrors" : rotorOnly ? "Diameter of one main rotor" : "Main wings and winglets, including tip thickness";
    $("areaLabel").textContent = drone?"HEIGHT":balloon?"ENVELOPE HEIGHT":road ? "HEIGHT" : "WING AREA";
    $("aspectLabel").textContent = drone?"ROTORS":balloon?"TOTAL HEIGHT":road ? "WHEELBASE" : "ASPECT RATIO";
    $("areaMetric").textContent = aerial?`${(balloon?params.height:model.stats.size.y).toFixed(2)} m`:road ? `${model.stats.height.toFixed(2)} m` : model.stats.area ? `${model.stats.area.toFixed(1)} m²` : "—";
    $("aspectMetric").textContent = drone?String(model.stats.rotors):balloon?`${model.stats.size.y.toFixed(2)} m`:road ? `${model.stats.wheelbase.toFixed(2)} m` : model.stats.area ? model.stats.aspectRatio.toFixed(2) : "—";
    $("spinLabel").textContent = road ? "Spin wheels" : "Spin rotors / props";
    $("animateProps").disabled=balloon;
    $("geometryStats").textContent = `${Math.round(model.stats.triangles).toLocaleString()} triangles · metres`;
    lastBuildMs = performance.now() - start;
    status(`Live preview · ${lastBuildMs.toFixed(0)} ms update`);
    modelDirty = false; renderDirty = true;
}

function fit() {
    if (!model) return;
    studio.fit(model.bounds,{view:currentView,paddingX:1.25,paddingY:1.55});
    renderDirty = true;
}

root.querySelectorAll("[data-view]").forEach(button => button.addEventListener("click", () => {
    currentView = button.dataset.view;
    root.querySelectorAll("[data-view]").forEach(item => {const active = item === button; item.classList.toggle("active", active); item.setAttribute("aria-pressed", String(active));});
    $("autoRotate").checked = false; controls.autoRotate = false; fit();
}));
$("fitView").addEventListener("click", fit);
root.addEventListener("keydown", event => {
    if (event.key.toLowerCase() === "f" && !event.ctrlKey && !event.metaKey && !["INPUT", "SELECT", "TEXTAREA"].includes(event.target.tagName)) {event.preventDefault(); fit();}
    if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.target.isContentEditable && !["INPUT", "SELECT", "TEXTAREA"].includes(event.target.tagName)) {
        const direction = ["ArrowRight", "]"].includes(event.key) ? 1 : ["ArrowLeft", "["].includes(event.key) ? -1 : 0;
        if (direction) {event.preventDefault(); cyclePreset(direction);}
    }
}, events);
$("showGrid").addEventListener("change", () => {grid.visible = $("showGrid").checked; renderDirty = true;});
$("nightPreview").addEventListener("change", () => {
    const night = $("nightPreview").checked;
    $("preview").classList.toggle("night", night);
    studio.setNight(night); renderDirty = true;
});
$("animateLights").addEventListener("change", () => {animateVehicleLights(model,0,false);renderDirty=true;});
$("wireframe").addEventListener("change", () => {setWireframe(model.root, $("wireframe").checked); renderDirty = true;});
$("autoRotate").addEventListener("change", () => {controls.autoRotate = $("autoRotate").checked;});
$("fullscreen").addEventListener("click", async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); }
    catch { status("Fullscreen is unavailable in this browser."); }
});

function filename() {return vehicleFileStem(designName);}
$("saveFile").addEventListener("click", () => {
    downloadVehicleRecipe(createVehicleRecipe(params,designName,activePreset || null));
    status("Design saved · open this JSON to keep editing");
});
$("openFile").addEventListener("click", () => $("fileInput").click());
$("fileInput").addEventListener("change", async () => {
    const file = $("fileInput").files[0]; $("fileInput").value = ""; if (!file) return;
    try {
        const data = await readVehicleRecipeFile(file);
        params = data.parameters; designName = data.name; modified = true;
        activePreset = data.presetId || "";
        error(""); buildFields(); updateFields(); modelDirty = true; rebuild(); fit(); saveSession(); status("Design opened");
    } catch (e) {error(`Could not open the design: ${e.message}`);}
});
$("exportGLB").addEventListener("click", async () => {
    $("exportGLB").disabled = true; error(""); status("Exporting GLB…");
    // Snapshot before the lazy import: slider edits during export belong to the next design.
    const recipe = createVehicleRecipe(params,designName,activePreset || null);
    try {
        const {exportVehicleGLB} = await import(/* webpackChunkName: "vehicle-exporter" */ "./exportGLB.js");
        const {bytes,size} = await exportVehicleGLB(recipe);
        downloadVehicleBlob(new Blob([bytes], {type:"model/gltf-binary"}), `${vehicleFileStem(recipe.name)}~L${size.z.toFixed(3)}m~.glb`);
        status("GLB exported · +Z forward, +Y up · import into Sitrec or a 3D editor");
    } catch (e) {error(`Export failed: ${e.message}`); status("Export failed");}
    finally {$("exportGLB").disabled = false;}
});

$("screenshot").addEventListener("click", () => {
    if (modelDirty) rebuild(); renderer.render(scene, camera);
    renderer.domElement.toBlob(blob => {if (blob) downloadVehicleBlob(blob, `${filename()}.png`);}, "image/png");
});

function resize() {
    if (studio.resize()) renderDirty = true;
}
const observer = new ResizeObserver(resize); observer.observe($("canvasMount"));
renderer.domElement.addEventListener("webglcontextlost", event => {event.preventDefault(); error("The 3D graphics context was lost. Save your design, then reload this page.");});
renderer.domElement.addEventListener("webglcontextrestored", () => {error(""); renderDirty = true;});
buildFields(); updateFields(); resize(); rebuild(); fit();
let lastTime = performance.now();
function animate(now) {
    if (disposed) return;
    const dt = Math.min((now - lastTime) / 1000, 0.05); lastTime = now;
    if (modelDirty) rebuild();
    controls.update(dt);
    if ($("animateLights").checked && model.lamps?.length) {animateVehicleLights(model,now/1000,true);renderDirty=true;}
    if ($("animateProps").checked && model.propellers.length) {
        propellerTime += dt; poseVehicleSpinners(model.propellers,propellerTime,true);
        renderDirty = true;
    }
    if (renderDirty) {renderer.render(scene, camera); renderDirty = false;}
    frameId = requestAnimationFrame(animate);
}
frameId = requestAnimationFrame(animate);
function dispose() {
    if (disposed) return;
    lifecycle.abort(); clearTimeout(saveTimer);
    disposed = true; cancelAnimationFrame(frameId); observer.disconnect();
    disposeVehicle(model.root); grid.geometry.dispose(); grid.material.dispose(); studio.dispose();
}
window.addEventListener("pagehide", event => {if (!event.persisted) dispose();}, events);
return {dispose, getRecipe: () => createVehicleRecipe(params, designName, activePreset || null), thumbnail() {
    if (modelDirty) rebuild(); return studio.thumbnail();
}};
}
