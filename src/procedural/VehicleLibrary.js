import {readVehicleRecipe} from "../../tools/vehicles/recipe.js";

const DATABASE = "sitrec-vehicle-library", PREFERENCES = "sitrec-vehicle-picker-v1";
let database;
function open() {
    if (!database) database = new Promise((resolve,reject) => {
        const request = indexedDB.open(DATABASE,1);
        request.onupgradeneeded = () => request.result.createObjectStore("models",{keyPath:"id"});
        request.onsuccess = () => {request.result.onversionchange = () => {request.result.close(); database = undefined;}; resolve(request.result);};
        request.onerror = () => {database = undefined; reject(request.error);};
        request.onblocked = () => {database = undefined; reject(new Error("Close other Vehicle Designer windows to open My models."));};
    });
    return database;
}
async function transaction(mode, operation) {
    const db = await open();
    return new Promise((resolve,reject) => {
        const tx = db.transaction("models",mode), request = operation(tx.objectStore("models"));
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = tx.onabort = () => reject(tx.error || request.error || new Error("Could not update My models."));
    });
}
export async function listMyVehicles() {
    return (await transaction("readonly",store => store.getAll())).sort((a,b) => b.updatedAt - a.updatedAt);
}
export async function saveMyVehicle(recipe, thumbnail, id = crypto.randomUUID()) {
    const record = {id,recipe:readVehicleRecipe(recipe),thumbnail,updatedAt:Date.now()};
    await transaction("readwrite",store => store.put(record)); return record;
}
export function deleteMyVehicle(id) {return transaction("readwrite",store => store.delete(id));}
export function readVehiclePreferences() {
    try {
        const data = JSON.parse(localStorage.getItem(PREFERENCES));
        return {favorites:Array.isArray(data?.favorites) ? data.favorites.filter(v => typeof v === "string") : [],
            recent:Array.isArray(data?.recent) ? data.recent.filter(v => typeof v === "string").slice(0,24) : []};
    } catch {return {favorites:[],recent:[]};}
}
export function saveVehiclePreferences(value) {localStorage.setItem(PREFERENCES,JSON.stringify(value));}
