import {PRESETS} from "../../tools/vehicles/vehicleParameters.js";
import {VEHICLE_GENERATOR_REVISION} from "../../tools/vehicles/recipeFormat.js";
import {createVehicleRecipe, readVehicleRecipe} from "../../tools/vehicles/recipe.js";
import {createVehiclePreview} from "../../tools/vehicles/preview.js";
import {deleteMyVehicle, listMyVehicles, readVehiclePreferences, saveMyVehicle, saveVehiclePreferences} from "./VehicleLibrary";
import {createVehicleFilter, populateVehicleFilters} from "../../tools/vehicles/catalog.js";
import {downloadVehicleRecipe, readVehicleRecipeFile} from "../../tools/vehicles/files.js";
import css from "./VehicleBrowser.css?raw";

let activeDialog;

export async function openVehicleBrowserDialog({initialRecipe,edit=false,isAlive=()=>true,onApply}) {
    if (!isAlive()) return {dispose() {}};
    activeDialog?.dispose();
    const previousFocus = document.activeElement;
    const dialog = document.createElement("dialog");
    dialog.style.cssText = "position:fixed;inset:0;margin:0;padding:0;width:100vw;height:100dvh;max-width:none;max-height:none;border:0;background:#101923;color:#dbe4ef;z-index:100000;";
    dialog.setAttribute("aria-label","Vehicle Designer");
    const host = document.createElement("div"); dialog.append(host);
    const shadow = host.attachShadow({mode:"open"});
    const style = document.createElement("style"); style.textContent = css;
    const shell = document.createElement("div"); shell.className = "shell";
    shell.innerHTML = `
        <header><div><h1>Vehicle Designer</h1><p>Choose a vehicle, or make it your own.</p></div><button id="close">Cancel ×</button></header>
        <section id="browser">
            <div class="catalog">
                <div class="filters">
                    <input id="search" type="search" aria-label="Search vehicles" placeholder="Search vehicles, manufacturer or role…">
                    <select id="kind" aria-label="Vehicle type"></select>
                    <select id="collection" aria-label="Collection"><option value="all">All presets</option><option value="favorites">Favorites</option><option value="recent">Recently used</option><option value="mine">My models</option></select>
                    <select id="region" aria-label="Region"></select>
                </div>
                <div class="catalog-meta"><span id="count" role="status"></span><button id="import">Import design…</button></div>
                <input type="file" id="importFile" accept=".json,application/json" hidden>
                <div id="tiles" aria-label="Vehicle presets"></div>
            </div>
            <aside>
                <div id="preview"></div>
                <div class="selection">
                    <span id="category" class="eyebrow"></span><h2 id="name"></h2>
                    <p id="description"></p><a id="reference" target="_blank" rel="noopener noreferrer">Model reference ↗</a>
                    <p class="hint">Drag to orbit · scroll to zoom.<br>Editable visual approximation. Dimensions are in metres.</p>
                    <div class="actions"><button id="edit">Customize…</button><button id="apply" class="primary">Use this vehicle</button></div>
                    <div class="actions secondary"><button id="favorite">☆ Favorite</button><button id="save">Save to My models</button><button id="export">Export design</button><button id="delete" hidden>Delete saved copy</button></div>
                    <p class="hint">My models are stored in this browser. Applied designs are saved inside the sitch. Export a design to keep a separate editable copy.</p>
                </div>
            </aside>
        </section>
        <div id="editor" hidden></div><div id="notice" role="status" hidden></div>`;
    shadow.append(style,shell); document.body.append(dialog);
    const $ = id => shadow.getElementById(id);
    populateVehicleFilters($("kind"),$("region"));
    let disposed = false, selected, recipe, preview, editor, editorRequest = 0, myModels = [];
    const preferences = readVehiclePreferences();
    const presets = PRESETS.map(p => ({...p,key:p.id,recipe:createVehicleRecipe(p.parameters,p.name,p.id),
        thumbnail:new URL(`tools/vehicles/thumbnails/${p.id}.jpg?v=${VEHICLE_GENERATOR_REVISION}`,document.baseURI).href}));
    const alive = () => !disposed && isAlive();
    function notice(message) {if (disposed) return; $("notice").textContent = message; $("notice").hidden = !message;}
    function savePreferences() {try {saveVehiclePreferences(preferences);} catch {notice("Browser preferences could not be saved. You can still use and export designs.");}}
    function entries() {return [...presets,...myModels.map(m => ({key:`mine:${m.id}`,savedId:m.id,name:m.recipe.name,recipe:m.recipe,
        vehicleType:m.recipe.parameters.vehicleType || "aircraft",category:"My models",thumbnail:m.thumbnail}))];}
    function renderTiles() {
        const collection = $("collection").value;
        const matchesVehicle = createVehicleFilter({query:$("search").value,kind:$("kind").value,region:$("region").value});
        let matches = entries().filter(p => matchesVehicle(p) &&
            (collection === "mine" ? p.savedId : collection === "favorites" ? preferences.favorites.includes(p.key) :
                collection === "recent" ? preferences.recent.includes(p.key) : !p.savedId));
        if (collection === "recent") matches.sort((a,b) => preferences.recent.indexOf(a.key) - preferences.recent.indexOf(b.key));
        $("tiles").replaceChildren(); $("count").textContent = `${matches.length} vehicles · ${PRESETS.length} presets`;
        if (!matches.length) {
            const empty = document.createElement("p"); empty.className = "empty";
            empty.textContent = collection === "mine" ? "Your saved designs will appear here. Customize a preset, then save it to My models." : "No vehicles match these filters.";
            $("tiles").append(empty);
        }
        for (const item of matches) {
            const tile = document.createElement("button"); tile.className = "tile"; tile.dataset.key = item.key;
            tile.setAttribute("aria-pressed",String(selected?.key === item.key));
            const image = document.createElement("img"); image.src = item.thumbnail; image.alt = "";
            image.width = 300; image.height = 200; image.loading = "lazy"; image.decoding = "async";
            const title = document.createElement("strong"); title.textContent = item.name;
            const category = document.createElement("span"); category.textContent = item.category;
            tile.append(image,title,category); tile.addEventListener("click",() => select(item));
            tile.addEventListener("dblclick",() => apply()); $("tiles").append(tile);
        }
    }
    function select(item) {
        try {
            const next = readVehicleRecipe(item.recipe);
            if (!preview) preview = createVehiclePreview($("preview"));
            preview.set(next); selected = item; recipe = next;
            $("name").textContent = recipe.name; $("category").textContent = item.category || "Custom design";
            $("description").textContent = item.reference?.description || "A full editable design. Changes to catalog presets will not replace your saved parameters.";
            $("reference").hidden = !item.reference?.source;
            if (item.reference?.source) $("reference").href = item.reference.source;
            $("favorite").textContent = preferences.favorites.includes(item.key) ? "★ Favorited" : "☆ Favorite";
            $("favorite").disabled = !item.key; $("delete").hidden = !item.savedId;
            $("tiles").querySelectorAll(".tile").forEach(tile => tile.setAttribute("aria-pressed",String(tile.dataset.key === item.key)));
        } catch (e) {notice(e.message);}
    }
    function apply(value = recipe) {
        if (!alive() || !value) return;
        try {
            onApply(readVehicleRecipe(value),{preserveObjectSettings:selected?.currentObject === true});
            if (selected?.key) {preferences.recent = [selected.key,...preferences.recent.filter(id => id !== selected.key)].slice(0,24); savePreferences();}
            dispose();
        } catch (e) {notice(e.message);}
    }
    async function save(value = recipe, thumbnail) {
        if (!alive() || !value) return;
        // Use the same selected-model renderer to capture custom thumbnails.
        if (!thumbnail) {
            if (!preview) preview = createVehiclePreview($("preview"));
            preview.set(value); thumbnail = preview.thumbnail();
        }
        const record = await saveMyVehicle(value,thumbnail);
        myModels = [record,...myModels];
        if (alive()) {renderTiles(); notice(`Saved “${value.name}” to My models.`);}
        return record;
    }
    async function customize() {
        const request = ++editorRequest;
        $("edit").disabled = true; notice("Loading editor…");
        try {
            const {mountEmbeddedVehicleEditor} = await import(/* webpackChunkName: "vehicle-editor" */ "./VehicleEditor");
            if (!alive() || request !== editorRequest) return;
            preview?.dispose(); preview = undefined;
            $("browser").hidden = true; $("editor").hidden = false;
            editor = mountEmbeddedVehicleEditor($("editor"),{recipe,onApply:apply,onSave:save,onBack:draft => {
                editor.dispose(); editor = undefined; $("editor").hidden = true; $("browser").hidden = false;
                select({...selected,recipe:draft,name:draft.name}); notice("");
            }});
            notice("");
        } catch (e) {
            $("editor").hidden = true; $("browser").hidden = false; notice(e.message);
        } finally {if (!disposed) $("edit").disabled = false;}
    }
    function dispose() {
        if (disposed) return;
        disposed = true; editorRequest++; preview?.dispose(); editor?.dispose();
        dialog.close(); dialog.remove(); if (activeDialog === api) activeDialog = undefined;
        previousFocus?.focus?.();
    }
    const api = {dispose}; activeDialog = api;
    dialog.addEventListener("cancel",event => {event.preventDefault(); dispose();});
    // Do not let Sitrec's scene shortcuts consume typing or slider keys.
    dialog.addEventListener("keydown",event => event.stopPropagation());
    $("close").onclick = dispose;
    for (const id of ["search","kind","collection","region"]) $(id).addEventListener(id === "search" ? "input" : "change",renderTiles);
    $("apply").onclick = () => apply(); $("edit").onclick = customize;
    $("save").onclick = () => save().catch(e => notice(e.message));
    $("favorite").onclick = () => {
        const key = selected?.key; if (!key) return;
        preferences.favorites = preferences.favorites.includes(key) ? preferences.favorites.filter(id => id !== key) : [...preferences.favorites,key];
        savePreferences(); renderTiles(); select(selected);
    };
    $("delete").onclick = async () => {
        const id = selected?.savedId; if (!id) return;
        try {
            await deleteMyVehicle(id); myModels = myModels.filter(item => item.id !== id);
            if (alive()) {
                if (selected?.savedId === id) {selected = {...selected,key:null,savedId:null}; select(selected);}
                renderTiles(); notice("Saved copy deleted. The current sitch model is unchanged.");
            }
        } catch (e) {notice(e.message);}
    };
    $("export").onclick = () => {
        if (!recipe) return;
        downloadVehicleRecipe(recipe);
    };
    $("import").onclick = () => $("importFile").click();
    $("importFile").onchange = async () => {
        const file = $("importFile").files[0]; $("importFile").value = ""; if (!file) return;
        try {
            const imported = await readVehicleRecipeFile(file);
            if (alive()) select({recipe:imported,name:imported.name,category:"Imported design"});
        } catch (e) {notice(e.message);}
    };
    dialog.showModal(); renderTiles();
    select(initialRecipe ? {recipe:initialRecipe,name:initialRecipe.name,category:"Current object",currentObject:true} : presets[0]);
    if (!recipe) select(presets[0]);
    listMyVehicles().then(records => {if (alive()) {myModels = records; renderTiles();}}).catch(e => notice(`My models unavailable: ${e.message}`));
    if (edit && recipe) customize(); else $("search").focus();
    return api;
}
