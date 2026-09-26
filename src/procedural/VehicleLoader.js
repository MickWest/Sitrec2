// No generator, preset catalog, editor, renderer or exporter is eagerly imported.
export async function loadProceduralVehicle(recipe) {
    const {generateVehicle} = await import(/* webpackChunkName: "vehicle-generator" */ "./VehicleGenerator");
    return generateVehicle(recipe);
}
export async function openVehicleBrowser(options) {
    const {openVehicleBrowserDialog} = await import(/* webpackChunkName: "vehicle-browser" */ "./VehicleBrowser");
    return openVehicleBrowserDialog(options);
}
export async function exportProceduralVehicle(recipe) {
    const {bakeVehicle} = await import(/* webpackChunkName: "vehicle-exporter" */ "../../tools/vehicles/exportGLB.js");
    return bakeVehicle(recipe);
}
