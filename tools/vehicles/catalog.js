export const VEHICLE_TYPES = Object.freeze({aircraft:"Fixed-wing aircraft",helicopter:"Helicopters & tiltrotors",
    car:"Cars",truck:"Trucks, vans & buses",drone:"Drones",balloon:"Balloons & sky lanterns"});
export const VEHICLE_REGIONS = Object.freeze({civil:"Civil & general",US:"US",Europe:"Europe",China:"China",Iran:"Iran",Russia:"Russia"});

export function populateVehicleFilters(typeSelect, regionSelect) {
    for (const [select,prompt,options] of [[typeSelect,"All vehicle types",VEHICLE_TYPES],[regionSelect,"All regions",VEHICLE_REGIONS]]) {
        select.replaceChildren(new Option(prompt,""));
        for (const [value,label] of Object.entries(options)) select.add(new Option(label,value));
    }
}

export function createVehicleFilter({query="",kind="",region=""} = {}) {
    const normalize = value => value.toLowerCase().replace(/[^a-z0-9]/g,"");
    const words = query.trim().split(/\s+/).map(normalize).filter(Boolean);
    return preset => (!kind || preset.vehicleType === kind) &&
        (!region || (region === "civil" ? !preset.military : preset.region === region)) &&
        words.every(word => normalize(`${preset.name} ${preset.category ?? ""} ${preset.region ?? ""}`).includes(word));
}
