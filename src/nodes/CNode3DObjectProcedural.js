import {FileManager, Globals, NodeMan, markSitchDirty, setRenderOne, Sit} from "../Globals";
import {loadModelAsset} from "../ModelLoader";
import {disposeScene} from "../threeExt";
import {showError} from "../showError";
import {copyProceduralModel, copyVehicleRecipe, vehicleFileStem} from "../../tools/vehicles/recipeFormat.js";
import {exportProceduralVehicle, loadProceduralVehicle, openVehicleBrowser} from "../procedural/VehicleLoader";
import {refreshVehicleBakeUsage} from "../procedural/VehicleBakeAssets";
import {collectVehicleSpinners, poseVehicleSpinners} from "../procedural/VehicleAnimation";
import {applyVehicleLightOverrides, captureVehicleLightOverrides, vehicleLightState} from "../procedural/VehicleLightState";

export const proceduralObjectMethods = {
    setupVehicleControls(v) {
        this.proceduralModel = copyProceduralModel(v.proceduralModel);
        this.vehicleAnimation = v.vehicleAnimation ?? true;
        this.vehicleLightOverrides = v.vehicleLightOverrides ?? {};
        this.vehicleStatus = this.proceduralModel?.recipe.name ?? "File model";
        const actions = {
            browse: () => this.openVehicleDesigner(false),
            edit: () => this.openVehicleDesigner(true),
            freeze: () => this.freezeVehicle().catch(e => showError(`Could not freeze the model: ${e.message}`)),
            file: () => {this.proceduralModel = null; this.vehicleLightOverrides = {}; this._vehicleSpinParts = []; this.rebuild(); markSitchDirty();},
            retry: () => {this.currentModel = undefined; this.rebuild();},
        };
        this.vehicleControls = {};
        for (const [key, label] of Object.entries({browse:"Browse vehicles…", edit:"Edit design…", freeze:"Freeze as GLB", file:"Use file model", retry:"Retry model load"})) {
            const control = this.gui.add(actions, key).name(label);
            control.isCommon = true; this.vehicleControls[key] = control;
        }
        const animation = this.gui.add(this, "vehicleAnimation").name("Animate moving parts").onChange(() => {
            this.updateVehicleAnimation(0); markSitchDirty(); setRenderOne(true);
        });
        animation.isCommon = true; this.vehicleControls.animation = animation;
        const status = this.gui.add(this, "vehicleStatus").name("Vehicle").listen().disable();
        status.isCommon = true; this.vehicleControls.status = status;
    },

    updateVehicleControls() {
        refreshVehicleBakeUsage(FileManager?.list,NodeMan?.list);
        if (!this.vehicleControls) return;
        const model = this.modelOrGeometry === "model", source = model && this.proceduralModel;
        this.vehicleControls.browse.show();
        if (source) this.modelMenu?.hide();
        for (const key of ["edit", "animation", "status"]) this.vehicleControls[key][source ? "show" : "hide"]();
        this.vehicleControls.file[source ? "show" : "hide"]();
        this.vehicleControls.freeze[source?.mode === "procedural" ? "show" : "hide"]();
        this.vehicleControls.retry[this._vehicleLoadFailed && source ? "show" : "hide"]();
    },

    async openVehicleDesigner(edit) {
        const generation = Globals.loadGeneration, request = (this._vehicleDialogRequest ?? 0) + 1;
        this._vehicleDialogRequest = request;
        try {
            this._vehicleDialog?.dispose();
            const dialog = await openVehicleBrowser({
                initialRecipe: this.proceduralModel?.recipe, edit,
                isAlive: () => !this._vehicleDisposed && generation === Globals.loadGeneration && request === this._vehicleDialogRequest,
                onApply: (recipe,options) => this.applyVehicleRecipe(recipe,options),
            });
            if (this._vehicleDisposed || generation !== Globals.loadGeneration || request !== this._vehicleDialogRequest) dialog.dispose();
            else this._vehicleDialog = dialog;
        } catch (e) {showError(`Could not open Vehicle Designer: ${e.message}`);}
    },

    applyVehicleRecipe(value, {preserveObjectSettings = false} = {}) {
        const recipe = copyVehicleRecipe(value);
        if (this._vehicleDisposed) return;
        const sameDesign = Boolean(this.proceduralModel) && preserveObjectSettings;
        this.vehicleLightOverrides = sameDesign ? this.captureVehicleOverrides() : {};
        this.proceduralModel = {mode:"procedural", recipe};
        this.modelOrGeometry = "model";
        // Native design dimensions are metres. Explicit later Model Length edits
        // remain independent of the saved recipe and are retained while editing.
        if (!sameDesign) this.modelLengthNode?.setValue(0);
        if (!sameDesign) this.common.applyMaterial = false;
        this.vehicleStatus = recipe.name;
        this.rebuild(); markSitchDirty(); setRenderOne(true);
    },

    captureVehicleOverrides() {
        return captureVehicleLightOverrides(this.lights, this._vehicleLightBaseline, this.vehicleLightOverrides);
    },

    rebuildProceduralModel() {
        const source = copyProceduralModel(this.proceduralModel), key = JSON.stringify(source);
        if (this.currentModel?.vehicleKey === key) return;
        const request = {vehicleKey:key}, generation = Globals.loadGeneration;
        this.currentModel = request;
        this._vehicleLoadFailed = false;
        this.vehicleStatus = `Loading ${source.recipe.name}…`;
        Globals.pendingActions++;
        const promise = Promise.resolve().then(() => source.mode === "frozen" ? loadModelAsset(source.file) : loadProceduralVehicle(source.recipe));
        this._vehicleReady = promise.then(asset => {
            if (this._vehicleDisposed || generation !== Globals.loadGeneration || this.currentModel !== request || this.modelOrGeometry !== "model") {
                disposeScene(asset.scene); return;
            }
            // Frozen exports are already in native metres; a filename hint must
            // not overwrite a saved object-size override.
            if (source.mode === "frozen" && FileManager.list[source.file]) FileManager.list[source.file].proceduralBake = true;
            this.installModelAsset(asset, source.recipe.name, false);

            this.vehicleStatus = `${source.recipe.name}${source.mode === "frozen" ? " · frozen" : " · procedural"}`;
            this.updateVehicleAnimation(0);
        }).catch(error => {
            if (this._vehicleDisposed || generation !== Globals.loadGeneration || this.currentModel !== request) return;
            this._vehicleLoadFailed = true;
            this.vehicleStatus = `Could not load: ${error.message}`;
            console.error("Procedural model load failed", error);
        }).finally(() => {
            Globals.pendingActions--;
            if (!this._vehicleDisposed) {this.updateVehicleControls(); setRenderOne(true);}
        });
    },

    configureVehicleModel(asset) {
        // An imported frozen GLB can carry its original editable recipe in extras.
        if (!this.proceduralModel && asset.format === "glb" && this.currentModel?.file) {
            let embedded;
            this.model.traverse(part => {embedded ??= part.userData?.sitrecVehicleRecipe;});
            if (embedded) {
                try {
                    this.proceduralModel = {mode:"frozen",file:this.currentModel.file,recipe:copyVehicleRecipe(embedded,{allowFuture:true})};
                    this.currentModel.vehicleKey = JSON.stringify(this.proceduralModel);
                    this.vehicleStatus = `${this.proceduralModel.recipe.name} · frozen`;
                } catch (error) {console.warn("Ignoring invalid embedded vehicle recipe",error);}
            }
        }
        this._vehicleSpinParts = collectVehicleSpinners(this.model);
        if (this.proceduralModel) {
            this._vehicleLightBaseline = Object.fromEntries(this.lights.map(light => [light.light.name,vehicleLightState(light)]));
            applyVehicleLightOverrides(this.lights,this.vehicleLightOverrides);
        }
        const lamps = new Map(this.lights.map(light => [light.light.name,light]));
        this.model.traverse(part => {
            const light = lamps.get(part.userData.vehicleLightLens);
            if (light) light.vehicleLens = part;
        });
        this.updateVehicleControls();
    },

    updateVehicleAnimation(frame) {
        const seconds = frame * (Sit?.simSpeed ?? 1) / (Sit?.fps || 30);
        poseVehicleSpinners(this._vehicleSpinParts, seconds, this.vehicleAnimation);
    },

    async freezeVehicle() {
        if (!this.proceduralModel || this.proceduralModel.mode === "frozen") return;
        const source = copyProceduralModel(this.proceduralModel), key = JSON.stringify(source), generation = Globals.loadGeneration;
        this.vehicleLightOverrides = this.captureVehicleOverrides();
        this.vehicleControls.freeze.disable();
        try {
            const bytes = await exportProceduralVehicle(source.recipe);
            if (this._vehicleDisposed || generation !== Globals.loadGeneration || JSON.stringify(this.proceduralModel) !== key) return;
            const base = vehicleFileStem(source.recipe.name,60);
            const id = FileManager.UniqueName(`${base}-${Date.now()}.glb`);
            FileManager.add(id, bytes, bytes);
            Object.assign(FileManager.list[id], {filename:id, dynamicLink:true, dataType:"glb", proceduralBake:true});
            this.proceduralModel = {...source, mode:"frozen", file:id};
            this.rebuild(); markSitchDirty();
            await this._vehicleReady;
        } finally {if (!this._vehicleDisposed) this.vehicleControls.freeze.enable();}
    },
};
