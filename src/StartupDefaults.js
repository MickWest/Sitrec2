// StartupDefaults.js
//
// The user's saved preferences for how a NEW sitch begins: where the camera stands,
// and whether 3D buildings are on. They live in the Settings menu (see
// setupSettingsMenu() in CustomSupport.js), not in any sitch, so they are applied to
// Sit AFTER the CSituation is built but BEFORE setup runs, and are never serialized
// with the sitch. Loading a saved sitch therefore always restores that sitch's own
// camera and terrain, not these.

import {Globals, Sit, Units} from "./Globals";

/**
 * Point a not-yet-set-up sitch at a lat/lon.
 *
 * Shared by the ?latlon= URL parameter and the saved startup-location preference so
 * both land in exactly the same place: the terrain tiles, the main camera's opening
 * shot, and the manual ("fixed") camera the look view starts from.
 *
 * Each sub-object is REPLACED rather than mutated. Sit is a fresh CSituation, but its
 * property values are shallow-copied from the registered sitch data, so mutating them
 * would edit the sitch definition itself and leak into every later sitch change in
 * this session.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {number} alt - metres ABOVE GROUND for the fixed camera. 0 = on the ground.
 */
export function setSitchStartLocation(lat, lon, alt) {
    if (Sit.TerrainModel) {
        // Close in, and enough tiles to cover the area you can see from the ground.
        Sit.TerrainModel = {...Sit.TerrainModel, lat, lon, zoom: 15, nTiles: 8};
    }

    if (Sit.mainCamera) {
        // A high, wide opening shot from the south, aimed at the location.
        Sit.mainCamera = {
            ...Sit.mainCamera,
            startCameraPositionLLA: [lat - 3, lon, 250000],
            startCameraTargetLLA: [lat, lon, 0],
        };
    }

    if (Sit.fixedCameraPosition) {
        // agl so that alt 0 means "standing on the ground", whatever the terrain
        // height turns out to be once it loads.
        Sit.fixedCameraPosition = {...Sit.fixedCameraPosition, LLA: [lat, lon, alt], agl: true};
    }
}

/**
 * Apply the saved new-sitch startup preferences to the current Sit.
 *
 * Only the drag-and-drop "custom" sitch. The named sitches (Gimbal, GoFast, the
 * recreations) are each of a specific place, so moving their camera or terrain would
 * break them - and a sitch loaded from a save has its own camera to restore.
 *
 * Call after the CSituation is built and before setup runs. Anything more explicit -
 * a ?latlon= parameter, a dropped track - is applied after this and so wins.
 */
export function applyStartupDefaults() {
    // A saved sitch is also name:"custom", so the name alone is not enough - anything
    // loaded from a file or a share link has already marked the sitch established.
    if (Sit.name !== "custom" || Globals.sitchEstablished) return;

    const settings = Globals.settings;
    if (!settings) return;

    // Units are deliberately under the same custom-only gate as everything else here,
    // not applied to every sitch that omits a `units` field.
    //
    // A sitch's numbers carry no unit of their own: CNodeGUIValue.getValueFrame()
    // returns Units[unitType].toM * value, so Gimbal's startDistance: 32 means 32 NM
    // only because Units is Nautical. Changing units LIVE is safe - changeUnits()
    // rescales every node, so the physical meaning survives - but changing them at
    // startup is not, because there are no nodes yet to rescale. 32 NM would quietly
    // become 32 km, and a recreation would no longer recreate anything. The custom
    // sitch is a blank slate, so there is nothing to misread.
    //
    // This runs after CSituation's own Units.changeUnits() and before any node is
    // created, which is why it is here rather than in the constructor.
    if (settings.startupUnits && settings.startupUnits !== Sit.units.toLowerCase()) {
        Sit.units = settings.startupUnits;
        Units.changeUnits(settings.startupUnits);
    }

    if (settings.startupLocation) {
        setSitchStartLocation(settings.startupLat, settings.startupLon, settings.startupAlt);
    }

    if (settings.startupBuildings && Sit.TerrainModel) {
        // CNodeTerrainUI re-checks permission and provider keys and quietly leaves
        // buildings off if this user cannot actually reach them.
        Sit.TerrainModel = {...Sit.TerrainModel, showBuildings: true};
    }
}
