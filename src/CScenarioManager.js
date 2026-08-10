// CScenarioManager.js — the Physics → Scenarios menu.
//
// A "scenario" is a self-contained simulation/analysis package (Football,
// Nimitz, Gimbal Analysis, Flood Sim, ...). The contract is strict isolation:
// an un-activated scenario is a 100% no-op — no nodes, no 3D objects, no
// entries in the Objects/Contents menus, no camera-switch options, no event
// listeners, no per-frame cost, and (via dynamic import) not even its code
// loaded. All that exists up front is a permanent, empty menu folder shell
// (created at app init in index.js).
//
// Lifecycle:
//   register(desc)      module-scope registration (cheap descriptors only —
//                       never import the scenario module here).
//   setup()             per sitch load, from CCustomManager.setup(): arms the
//                       lazy population hook. Folder contents (the Enable /
//                       Load buttons built by desc.populate) only appear when
//                       the Scenarios menu is first opened.
//   desc.populate()     dynamic-imports the scenario module and builds its
//                       folder buttons. Activation — the node-creating step —
//                       happens when the user clicks Enable or a Load preset
//                       (handled inside the module), or via activateForMods.
//   activateForMods(mods)  called from deserializeMods() BEFORE the save's
//                       mods are applied: a save that was using a scenario
//                       carries mods for that scenario's nodes, and mods for
//                       missing node ids are silently dropped — so the nodes
//                       must exist first. desc.activeInMods decides "was
//                       using": saves from the pre-scenario era carry ALL the
//                       (then eagerly created) scenario nodes at default
//                       values, so mere presence of a node id is NOT enough —
//                       each scenario keys on real usage signals (its Show
//                       flags, camera-switch choices, etc).
//
// Toward plugins: a scenario is fully described by its descriptor plus a
// module exporting {setupX, activateX} — nothing else in the codebase knows
// it exists.

import {CustomManager, guiMenus} from "./Globals";

class CScenarioManagerClass {
    constructor() {
        this.scenarios = [];
    }

    // desc: {
    //   id           — guiMenus key of the scenario's permanent folder shell
    //   populate()   — build the folder's buttons (async; the dynamic-import
    //                  point). Must be idempotent and create NO nodes.
    //   activate()   — optional: full activation (used by activateForMods;
    //                  interactive activation goes through the module's own
    //                  Enable/Load buttons).
    //   activeInMods(mods) — optional: true when a loading save was actually
    //                  using this scenario (see header).
    // }
    register(desc) {
        this.scenarios.push(desc);
    }

    // Per-sitch (from CCustomManager.setup()). The per-scenario folders are
    // permanent shells; menuBar.destroy(false) emptied their contents on the
    // sitch switch, so re-arm lazy population.
    setup() {
        const parent = guiMenus.scenarios;
        if (!parent) return;
        for (const desc of this.scenarios) desc._populated = false;
        // One handler slot per GUI — this is the only onOpenClose user on the
        // Scenarios folder. The callback bubbles up from descendants too; we
        // only care about the Scenarios folder itself opening.
        parent.onOpenClose((changed) => {
            if (changed === parent && !changed._closed) this._populateAll();
        });
        // A same-session sitch switch can leave the (permanent) folder open,
        // in which case it will get no open event — populate immediately.
        if (!parent._closed) this._populateAll();
    }

    _populateAll() {
        for (const desc of this.scenarios) this._populate(desc);
    }

    // Build one scenario's folder buttons (once per sitch; the dynamic import
    // is the code-splitting point). Returns the populate promise.
    _populate(desc) {
        if (desc._populated) return desc._populating ?? Promise.resolve();
        desc._populated = true;
        desc._populating = Promise.resolve()
            .then(() => desc.populate(guiMenus[desc.id]))
            .catch((e) => {
                console.error(`Scenario "${desc.id}" populate failed:`, e);
                desc._populated = false;
            })
            .finally(() => {
                desc._populating = null;
            });
        return desc._populating;
    }

    // Called from deserializeMods() with the save's mods, BEFORE they apply.
    async activateForMods(mods) {
        if (!mods) return;
        for (const desc of this.scenarios) {
            if (!desc.activate || !desc.activeInMods) continue;
            try {
                if (!desc.activeInMods(mods)) continue;
                await this._populate(desc);   // buttons first, so Enable exists (and gets disabled)
                await desc.activate();
            } catch (e) {
                console.error(`Scenario "${desc.id}" activation for a loading save failed:`, e);
            }
        }
    }
}

export const ScenarioManager = new CScenarioManagerClass();

// ── Registered scenarios ────────────────────────────────────────────
// populate/activate use dynamic import() so a scenario's code is only
// fetched when its menu is opened / it is activated (webpack code-splits
// each into its own chunk).

ScenarioManager.register({
    id: "football",
    populate: async () => (await import("./Football")).setupFootball(),
    activate: async () => (await import("./Football")).activateFootball(),
    // Real-usage signals only (see header): a Show flag on, a camera aspect
    // switched to a football source, or the broadcast camera riding a track.
    activeInMods(mods) {
        return !!(mods.footballShowBall?.value
            || mods.footballShowCableCam?.value
            || mods.footballShowPitch?.value
            || mods.footballShowView?.value
            || mods.cameraTrackSwitch?.choice === "Cable Cam"
            || mods.CameraLOSController?.choice === "Cable Cam Aim"
            || mods.fovSwitch?.choice === "Cable Cam"
            || (mods.footballBroadcastCamSwitch
                && mods.footballBroadcastCamSwitch.choice !== "Manual Position"));
    },
});

ScenarioManager.register({
    id: "nimitz",
    populate: async () => (await import("./Nimitz")).setupNimitz(),
    activate: async () => (await import("./Nimitz")).activateNimitz(),
    activeInMods(mods) {
        return !!(mods.nimitzShow?.value
            || mods.cameraTrackSwitch?.choice === "Fravor's Jet"
            || mods.cameraTrackSwitch?.choice === "Dietrich's Jet"
            || mods.CameraLOSController?.choice === "Look At Tic-Tac"
            || mods.fovSwitch?.choice === "Nimitz Pilot");
    },
});

ScenarioManager.register({
    id: "gimbalAnalysis",
    // Menu-only: the Gimbal pipeline runs from handleGimbalSetup() (index.js)
    // when Sit.gimbalSetup is present — its own activation mechanism, via the
    // generated sitch. This menu creates no nodes, so no activate/activeInMods.
    populate: () => CustomManager.populateGimbalAnalysisMenu(),
});

ScenarioManager.register({
    id: "flatEarth",
    populate: async () => (await import("./scenarios/FlatEarthScenario")).setupFlatEarth(),
    activate: async () => (await import("./scenarios/FlatEarthScenario")).activateFlatEarth(),
    // Only saves with the mode actually ON re-activate it; a save made
    // after enabling-then-disabling carries flatEnabled:false and is left
    // alone (its mods for the missing node are silently dropped).
    activeInMods: (mods) => mods.FlatEarth?.flatEnabled === true,
});

ScenarioManager.register({
    id: "floodSim",
    populate: async () => (await import("./scenarios/FloodSimScenario")).setupFloodSim(),
    activate: async () => (await import("./scenarios/FloodSimScenario")).activateFloodSim(),
    // FloodSim serialized its params (addSimpleSerials) even in the
    // always-created era, so every legacy save carries a FloodSim entry —
    // only one with flooding actually enabled needs the node back.
    activeInMods: (mods) => mods.FloodSim?.floodEnabled === true,
});
