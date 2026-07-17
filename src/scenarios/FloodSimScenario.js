// FloodSimScenario.js — Flood Sim as a Scenario (Physics → Scenarios → Flood Sim).
//
// The heightmap/PBF flood simulator (CNodeFloodSim) allocates real particle
// and grid buffers in its constructor, so the node is only created on
// activation; an untouched Flood Sim folder is a 100% no-op.

import {guiMenus, NodeMan} from "../Globals";
import {CNodeFloodSim} from "../nodes/CNodeFloodSim";

const ENABLE_LABEL = "Enable Flood Sim";

function syncEnableButton() {
    const folder = guiMenus.floodSim;
    const btn = folder?.controllers.find(c => c._name === ENABLE_LABEL);
    if (btn && NodeMan.exists("FloodSim")) btn.disable();
}

export function activateFloodSim() {
    if (!NodeMan.exists("FloodSim")) {
        new CNodeFloodSim({
            id: "FloodSim",
            guiFolder: guiMenus.floodSim,
        });
    }
    syncEnableButton();
}

// Thin per-sitch population: just the Enable button. Called lazily by the
// ScenarioManager when the Scenarios menu is first opened.
export function setupFloodSim() {
    const folder = guiMenus.floodSim;
    if (!folder) return;
    if (!folder.controllers.find(c => c._name === ENABLE_LABEL)) {
        folder.add({enable: () => activateFloodSim()}, "enable")
            .name(ENABLE_LABEL)
            .tooltip("Create the flood simulator (rain / dam-burst water flowing over the terrain). Its controls appear in this folder once enabled.");
    }
    syncEnableButton();
}
