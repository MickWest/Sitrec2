// CMeasurementManager
//
// Owns the user's measurements in Show > Measurements: the "Add Measurement" button, one menu
// entry per measurement (a click opens its dialog), the CNodeMeasurement nodes, and their
// serialization as the sitch's `measurements` block.
//
// A measurement is the altitude of one point, or the distance between two. A point is a
// {kind, id} reference to something in the sitch — the camera, the traverse, a track, a 3D
// object, a pin or a building — resolved to a position every frame by resolvePosition().
//
// Custom sitches only. A fresh custom sitch gets the three defaults that SitCustom.js used to
// define as nodes (camera altitude, traverse altitude, camera-to-traverse distance). An old save
// that still carries those nodes has them converted to a `measurements` block before it is
// built (migrateLegacyMeasurements in SitchMigrations.js).
//
// Lifecycle: setup() runs once per custom sitch load (from CustomManager). disposeAll() runs on
// each reload, after NodeMan.disposeAll() has already disposed the nodes.

import {Globals, guiMenus, NodeMan, setRenderOne, Sit, Synth3DManager, TrackManager} from "./Globals";
import {FeatureManager} from "./CFeatureManager";
import {CNodeMeasurement, setupMeasurementUI} from "./nodes/CNodeLabels3D";
import {CNode3DObject, shortObjectName} from "./nodes/CNode3DObject";
import {closeMeasurementDialog, openMeasurementDialog} from "./MeasurementDialog";
import {V3} from "./threeUtils";
import {t} from "./i18n";
import {EventManager} from "./CEventManager";

// The kinds of thing a measurement can point at, in the order the dialog shows them.
// "node" is only for an old save whose measurement used some other node id; the dialog shows
// it only while a measurement still points at one.
export const MEASUREMENT_SOURCE_KINDS = ["camera", "traverse", "track", "object", "pin", "building", "node"];

const DEFAULT_COLOR = "#00ff00";

const CAMERA = {kind: "camera", id: "lookCamera"};
const TRAVERSE = {kind: "traverse", id: "traverseSmoothedTrack"};

// Made for a fresh custom sitch. The ids are the ones the old SitCustom.js nodes had, so an
// old save converts to exactly these, and code that finds them by id (fromApp.js hides the
// traverse ones) keeps working.
const DEFAULT_MEASUREMENTS = [
    {id: "altitudeLabel", type: "altitude", from: CAMERA, to: null},
    {id: "altitudeLabel2", type: "altitude", from: TRAVERSE, to: null},
    {id: "distanceLabel", type: "distance", from: CAMERA, to: TRAVERSE},
];

// Fill in every field, so a hand-edited or old entry cannot leave one undefined.
export function normalizeMeasurementConfig(config = {}) {
    const type = config.type === "altitude" ? "altitude" : "distance";
    return {
        type,
        from: config.from ?? null,
        to: type === "altitude" ? null : (config.to ?? null),
        show: config.show !== false,
        color: typeof config.color === "string" ? config.color : DEFAULT_COLOR,
        lineWidth: Number.isFinite(config.lineWidth) ? config.lineWidth : 1,
        units: config.units ?? "default",
        label: config.label ?? "",
    };
}

class CMeasurementManager {
    constructor() {
        this.list = {};          // id -> CNodeMeasurement, in menu order
        this.active = false;     // true while a custom sitch owns measurements
        this.addButton = null;
        this.menuButtons = [];      // [{id, button}], in menu order
        this.nextId = 1;
        this.tracksChangedListener = null;
        // Measurements with a dialog open, and what a save writes for each meanwhile: the config
        // it had when the dialog opened, or null for one that is still being added. The live
        // preview must not reach a save made before OK.
        this.drafts = new Map();
        this.sourceKinds = MEASUREMENT_SOURCE_KINDS;
    }

    // --- setup / teardown ---------------------------------------------------

    setup() {
        if (!Sit.isCustom) return;
        const folder = guiMenus.showhidemeasurements;
        if (!folder) return;
        this.active = true;

        // Makes MeasurementsGroupNode, which every measurement hangs from. Normally done
        // already at startup; it does nothing when it has been.
        setupMeasurementUI();

        this.addButton = folder.add({add: () => this.addMeasurement()}, "add")
            .name(t("measurements.add.label"))
            .tooltip(t("measurements.add.tooltip"));

        // undefined: a fresh sitch, so it gets the defaults. An array (empty included): a saved
        // sitch, or an old one converted by migrateLegacyMeasurements.
        const saved = Sit.measurements;
        const configs = Array.isArray(saved) ? saved : DEFAULT_MEASUREMENTS;
        for (const config of configs) {
            try {
                this.createMeasurement(config.id, config);
            } catch (e) {
                console.error("Measurement could not be made", config, e);
            }
        }
        this.rebuildMenu();

        // The menu names use the names of what is measured, and a saved sitch rebuilds its
        // tracks, pins and buildings AFTER this runs, so the first names can be raw ids.
        // Rename when tracks change, and whenever the folder is opened (pins, buildings and
        // objects have no change event).
        this.tracksChangedListener = () => this.refreshMenuNames();
        EventManager.addEventListener("tracksChanged", this.tracksChangedListener);
        folder.onOpenClose(() => this.refreshMenuNames());
    }

    disposeAll() {
        // Its measurement is about to go. The cancel it resolves with is ignored, as the
        // load generation has moved on by the time it arrives.
        closeMeasurementDialog();
        if (this.tracksChangedListener) {
            EventManager.removeEventListener("tracksChanged", this.tracksChangedListener);
            this.tracksChangedListener = null;
        }
        for (const node of Object.values(this.list)) {
            if (NodeMan.exists(node.id)) NodeMan.disposeRemove(node.id);
        }
        this.list = {};
        this.drafts.clear();
        this.active = false;
        // The controllers themselves are destroyed with the rest of the per-sitch menu
        // (menuBar.destroy(false)). Only our references to them go here.
        this.addButton = null;
        this.menuButtons = [];
        this.nextId = 1;
    }

    // --- measurements -------------------------------------------------------

    createMeasurement(id, config) {
        if (!id) {
            do { id = "measurement_" + this.nextId++; } while (NodeMan.exists(id));
        }
        const match = /^measurement_(\d+)$/.exec(id);
        if (match) this.nextId = Math.max(this.nextId, parseInt(match[1], 10) + 1);

        const node = new CNodeMeasurement({
            id,
            config: normalizeMeasurementConfig(config),
            resolvePosition: (ref, f) => this.resolvePosition(ref, f),
        });
        this.list[id] = node;
        setRenderOne(true);
        return node;
    }

    removeMeasurement(id) {
        if (!this.list[id]) return;
        if (NodeMan.exists(id)) NodeMan.disposeRemove(id);
        delete this.list[id];
        this.rebuildMenu();
        setRenderOne(true);
    }

    // The new measurement is made at once, so every edit in the dialog shows live. Cancel
    // deletes it again.
    async addMeasurement() {
        // A new sitch loaded while the dialog is open (drag and drop still works behind it)
        // takes this measurement with it, and nothing more must be done here.
        const generation = Globals.loadGeneration;
        const node = this.createMeasurement(null, normalizeMeasurementConfig({type: "altitude", from: CAMERA}));
        this.rebuildMenu();
        this.drafts.set(node, null);
        const result = await openMeasurementDialog({
            config: normalizeMeasurementConfig(node.config),
            isNew: true,
            manager: this,
            onChange: (config) => this.previewConfig(node, config),
        });
        this.drafts.delete(node);
        if (Globals.loadGeneration !== generation || this.list[node.id] !== node) return;
        if (result?.action === "apply") {
            node.setConfig(normalizeMeasurementConfig(result.config));
            this.rebuildMenu();
        } else {
            this.removeMeasurement(node.id);
        }
    }

    // Edits show live. Cancel puts back the config the measurement had when the dialog opened.
    async editMeasurement(id) {
        const node = this.list[id];
        if (!node) return;
        const original = normalizeMeasurementConfig(node.config);
        this.drafts.set(node, original);
        const result = await openMeasurementDialog({
            config: original,
            isNew: false,
            manager: this,
            onChange: (config) => this.previewConfig(node, config),
        });
        this.drafts.delete(node);
        // The measurement may have gone while the dialog was open (a new sitch was loaded).
        if (this.list[id] !== node) return;
        if (result?.action === "delete") {
            this.removeMeasurement(id);
        } else if (result?.action === "apply") {
            node.setConfig(normalizeMeasurementConfig(result.config));
            this.rebuildMenu();
        } else {
            node.setConfig(original);
            this.refreshMenuNames();
        }
    }

    previewConfig(node, config) {
        if (this.list[node.id] !== node) return;
        node.setConfig(normalizeMeasurementConfig(config));
        this.refreshMenuNames();
    }

    // One button per measurement, after "Add Measurement". Rebuilt whenever one is added,
    // changed or deleted, so each name and the order are always current.
    rebuildMenu() {
        const folder = guiMenus.showhidemeasurements;
        if (!folder || !this.active) return;
        for (const {button} of this.menuButtons) button.destroy();
        this.menuButtons = [];
        for (const [id, node] of Object.entries(this.list)) {
            const button = folder.add({edit: () => this.editMeasurement(id)}, "edit")
                .name(this.menuName(node))
                .tooltip(t("measurements.entry.tooltip"));
            this.menuButtons.push({id, button});
        }
    }

    refreshMenuNames() {
        for (const {id, button} of this.menuButtons) {
            const node = this.list[id];
            if (!node) continue;
            const name = this.menuName(node);
            if (button._name !== name) button.name(name);
        }
    }

    menuName(node) {
        const name = this.describe(node.config);
        return node.visible ? name : name + " " + t("measurements.hiddenSuffix");
    }

    // The menu name: the label if there is one, otherwise what is measured.
    describe(config) {
        if (config.label) return config.label;
        const from = this.sourceName(config.from);
        if (config.type === "altitude") return t("measurements.describe.altitude", {from});
        return t("measurements.describe.distance", {from, to: this.sourceName(config.to)});
    }

    // --- sources ------------------------------------------------------------

    kindLabel(kind) {
        return t("measurements.kinds." + kind);
    }

    // Everything of one kind that a measurement can point at, as [{id, name}].
    listSources(kind) {
        const out = [];
        switch (kind) {
            case "camera":
                if (NodeMan.exists("lookCamera")) out.push({id: "lookCamera", name: this.kindLabel("camera")});
                break;
            case "traverse":
                if (NodeMan.exists("traverseSmoothedTrack")) {
                    out.push({id: "traverseSmoothedTrack", name: this.kindLabel("traverse")});
                }
                break;
            case "track":
                TrackManager.iterate((id, track) => {
                    if (!track.trackNode) return;
                    const name = track.displayTargetSphere?.menuName
                        ?? shortObjectName(track.menuText ?? track.trackNode.shortName ?? id);
                    out.push({id, name});
                });
                break;
            case "object":
                NodeMan.iterate((id, node) => {
                    if (node instanceof CNode3DObject) out.push({id, name: node.menuName ?? id});
                });
                break;
            case "pin":
                FeatureManager.iterate((id, pin) => out.push({id, name: pin.text || id}));
                break;
            case "building":
                Synth3DManager?.iterate((id, building) => out.push({id, name: building.name || id}));
                break;
        }
        return out;
    }

    sourceName(ref) {
        if (!ref) return "?";
        const found = this.listSources(ref.kind).find(source => source.id === ref.id);
        return found ? found.name : ref.id;
    }

    // The position of a reference at frame f, or null if it is not there (deleted, or a track
    // not loaded yet). Only the current frame is asked for, so an object or the camera, which
    // know only where they are now, are correct.
    resolvePosition(ref, f) {
        if (!ref) return null;
        try {
            switch (ref.kind) {
                case "track": {
                    const node = TrackManager.get(ref.id, false)?.trackNode;
                    return node?.validPoint(f) ? node.p(f) : null;
                }
                case "pin": {
                    const pin = FeatureManager.exists(ref.id) ? FeatureManager.get(ref.id) : null;
                    return pin ? pin.featurePosition.clone() : null;
                }
                case "building": {
                    const building = Synth3DManager?.getBuilding(ref.id);
                    return building ? buildingRoofCenter(building) : null;
                }
                default: {
                    // camera, traverse, object, node: a node that can report a position.
                    const node = NodeMan.get(ref.id, false);
                    return node?.validPoint(f) ? node.p(f) : null;
                }
            }
        } catch (e) {
            return null;
        }
    }

    // --- serialization ------------------------------------------------------

    // undefined when this sitch does not own measurements, so the key is left out of the save.
    serialize() {
        if (!this.active) return undefined;
        const out = [];
        for (const node of Object.values(this.list)) {
            // A measurement in its dialog is saved as it was before the dialog opened; one
            // still being added is not saved at all.
            const config = this.drafts.has(node) ? this.drafts.get(node) : node.config;
            if (config) out.push({id: node.id, ...config});
        }
        return out;
    }
}

// The middle of a building's roof: the mean of its top corners.
function buildingRoofCenter(building) {
    const top = building.vertices.filter(vertex => vertex.type === "top");
    if (top.length === 0) return null;
    const center = V3();
    for (const vertex of top) center.add(vertex.position);
    return center.multiplyScalar(1 / top.length);
}

export const MeasurementManager = new CMeasurementManager();

if (typeof window !== "undefined") {
    window.MeasurementManager = MeasurementManager;
}
